/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 3次元CC法（Control Coordinates Method）実装
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * MATLABコード main_CCmethod.m をJavaScriptに移植
 * 作成者: Y SUZUKI (2015.05.29 original MATLAB)
 * JavaScript移植: 2024年
 * 
 * 【アルゴリズム概要】
 * 1. 制御点（既知3D座標と画像座標）から9つのカメラパラメータを推定
 * 2. 2段階最適化：
 *    - 第1段階: 6パラメータ（位置+回転）を最適化、光学中心固定
 *    - 焦点距離Fを線形計算
 * 3. 結果を11個のDLTパラメータに変換
 * 
 * 【依存ライブラリ】
 * - math.js: 行列演算（オプション）
 */

// =============================================================================
// 定数・設定
// =============================================================================

const CC_METHOD_DEFAULTS = {
    resolution: [1920, 1080],          // デフォルト解像度
    searchRange: [5, 5, 3, Math.PI / 10, Math.PI / 10, Math.PI / 10], // 探索範囲
    maxIterations: 10000,              // 最大反復回数（Nelder-Mead）
    tolerance: 1e-8,                   // 収束判定閾値
    nelderMeadAlpha: 1.0,              // 反射係数
    nelderMeadGamma: 2.0,              // 拡大係数
    nelderMeadRho: 0.5,                // 収縮係数
    nelderMeadSigma: 0.5,              // 縮小係数
    // GA設定
    gaPopulationSize: 200,             // 個体数
    gaGenerations: 100,                // 世代数
    gaMutationRate: 0.3,               // 突然変異率
    gaEliteCount: 5                    // エリート保存数
};

// =============================================================================
// オイラー角 ↔ 回転行列（DCM）変換
// =============================================================================

/**
 * オイラー角から方向余弦行列（DCM）を生成
 * MATLABコード euler2dcm.m の移植
 * 
 * @param {Array} euler - オイラー角 [ω, φ, κ] (ラジアン)
 * @returns {Array} 3x3回転行列
 * 
 * 【数式】ZYX順序（航空宇宙標準）
 * R = Rz(κ) * Ry(φ) * Rx(ω)
 */
function euler2dcm(euler) {
    const [omega, phi, kappa] = euler;
    const s = [Math.sin(omega), Math.sin(phi), Math.sin(kappa)];
    const c = [Math.cos(omega), Math.cos(phi), Math.cos(kappa)];

    // MATLABコードと完全に同じ行列構成
    const dcm = [
        [c[1] * c[2], c[1] * s[2], -s[1]],
        [-c[0] * s[2] + s[0] * s[1] * c[2], c[0] * c[2] + s[0] * s[1] * s[2], s[0] * c[1]],
        [s[0] * s[2] + c[0] * s[1] * c[2], -s[0] * c[2] + c[0] * s[1] * s[2], c[0] * c[1]]
    ];

    return dcm;
}

/**
 * 方向余弦行列からオイラー角を抽出
 * MATLABコード dcm2euler.m の移植
 * 
 * @param {Array} dcm - 3x3回転行列
 * @returns {Array} オイラー角 [ω, φ, κ] (ラジアン)
 */
function dcm2euler(dcm) {
    const euler = [
        Math.atan2(dcm[1][2], dcm[2][2]),                              // ω (omega)
        Math.atan2(-dcm[0][2], Math.sqrt(dcm[1][2] ** 2 + dcm[2][2] ** 2)), // φ (phi)
        Math.atan2(dcm[0][1], dcm[0][0])                               // κ (kappa)
    ];
    return euler;
}

// =============================================================================
// 初期オイラー角の設定
// =============================================================================

/**
 * カメラ位置から制御点中心を向くオイラー角を計算
 * MATLABコード set_euler() の移植
 * 
 * @param {Array} cnt_cv - 制御点の重心 [x, y, z]
 * @param {Array} Lcmr - カメラ位置 [X0, Y0, Z0]
 * @returns {Array} オイラー角 [ω, φ, κ]
 */
function setInitialEuler(cnt_cv, Lcmr) {
    // カメラ座標系の構築
    // y軸: [0, 0, -1] (下向き)
    let y = [0, 0, -1];

    // z軸: カメラから制御点中心への方向
    let z = [
        cnt_cv[0] - Lcmr[0],
        cnt_cv[1] - Lcmr[1],
        cnt_cv[2] - Lcmr[2]
    ];
    const zNorm = Math.sqrt(z[0] ** 2 + z[1] ** 2 + z[2] ** 2);
    z = z.map(v => v / zNorm);

    // x軸: y × z (外積)
    let x = crossProduct(y, z);
    const xNorm = Math.sqrt(x[0] ** 2 + x[1] ** 2 + x[2] ** 2);
    x = x.map(v => v / xNorm);

    // y軸を再計算: z × x
    y = crossProduct(z, x);
    const yNorm = Math.sqrt(y[0] ** 2 + y[1] ** 2 + y[2] ** 2);
    y = y.map(v => v / yNorm);

    // 回転行列 R = [x, y, z] (列ベクトル)
    const R = [
        [x[0], y[0], z[0]],
        [x[1], y[1], z[1]],
        [x[2], y[2], z[2]]
    ];

    // R^-1 からオイラー角を抽出
    const Rinv = matrixInverse3x3(R);
    return dcm2euler(Rinv);
}

/**
 * ベクトルの外積
 */
function crossProduct(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
    ];
}

/**
 * 3x3行列の逆行列
 */
function matrixInverse3x3(m) {
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

    if (Math.abs(det) < 1e-12) {
        console.error('特異行列: 逆行列が計算できません');
        return null;
    }

    const invDet = 1 / det;
    return [
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * invDet,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invDet,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invDet
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invDet,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invDet,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invDet
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * invDet,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * invDet,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * invDet
        ]
    ];
}

// =============================================================================
// 焦点距離の計算
// =============================================================================

/**
 * 外部パラメータから焦点距離Fを線形計算
 * MATLABコード cal_F() の移植
 * 
 * @param {Array} c - 6パラメータ [X0, Y0, Z0, ω, φ, κ]
 * @param {Array} xy - デジタイズ座標 [[u1,v1], [u2,v2], ...]
 * @param {Array} xyz - 制御点3D座標 [[X1,Y1,Z1], [X2,Y2,Z2], ...]
 * @param {Array} resolution - 画像解像度 [width, height]
 * @returns {number} 焦点距離F
 */
function calculateFocalLength(c, xy, xyz, resolution) {
    const U0 = resolution[0] / 2;
    const V0 = resolution[1] / 2;
    const [X0, Y0, Z0] = [c[0], c[1], c[2]];
    const eul = [c[3], c[4], c[5]];

    const M = euler2dcm(eul);
    const L0 = [X0, Y0, Z0];

    const A = [];
    const C = [];
    const Pxy = [];

    for (let i = 0; i < xy.length; i++) {
        // h = M(3,:) * xyz(i,:)' - M(3,:) * L0
        const h = dotProduct(M[2], xyz[i]) - dotProduct(M[2], L0);

        // A行列の構築
        const A_u = dotProduct(M[0], xyz[i]) - dotProduct(M[0], L0);
        const A_v = dotProduct(M[1], xyz[i]) - dotProduct(M[1], L0);
        A.push(A_u);
        A.push(A_v);

        // C行列の構築
        C.push(U0 * (dotProduct(M[2], xyz[i]) - dotProduct(M[2], L0)));
        C.push(V0 * (dotProduct(M[2], xyz[i]) - dotProduct(M[2], L0)));

        // Pxy = h * xy
        Pxy.push(h * xy[i][0]);
        Pxy.push(h * xy[i][1]);
    }

    // F = (A'*A)^-1 * A' * (Pxy - C)
    // 最小二乗法で解く
    let ATA = 0;
    let ATb = 0;
    for (let i = 0; i < A.length; i++) {
        ATA += A[i] * A[i];
        ATb += A[i] * (Pxy[i] - C[i]);
    }

    const F = ATb / ATA;
    return F;
}

/**
 * ベクトルの内積
 */
function dotProduct(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// =============================================================================
// カメラパラメータ → DLTパラメータ変換
// =============================================================================

/**
 * 9個のカメラパラメータから11個のDLTパラメータを計算
 * MATLABコード cmr2dlt.m の移植
 * 
 * @param {Array} c - [U0, V0, F, X0, Y0, Z0, ω, φ, κ]
 * @returns {Array} 11個のDLTパラメータ
 */
function cmr2dlt(c) {
    const [U0, V0, F, X0, Y0, Z0] = c.slice(0, 6);
    const eul = [c[6], c[7], c[8]];

    const M = euler2dcm(eul);

    // 内部行列 K
    const K = [
        [F, 0, U0],
        [0, F, V0],
        [0, 0, 1]
    ];

    // カメラ中心
    const cLns = [X0, Y0, Z0];

    // [I | -C] = 3x4行列
    const IC = [
        [1, 0, 0, -cLns[0]],
        [0, 1, 0, -cLns[1]],
        [0, 0, 1, -cLns[2]]
    ];

    // R * [I | -C]
    const RIC = multiplyMatrices(M, IC);

    // K * R * [I | -C]
    const tmpP = multiplyMatrices(K, RIC);

    // P(3,4)で正規化
    const scale = tmpP[2][3];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 4; j++) {
            tmpP[i][j] /= scale;
        }
    }

    // MATLAB: P=reshape(tmpP',12,1)
    // tmpP' (4x3) を列優先で12x1に展開
    // = tmpP (3x4) を行優先で展開するのと同等
    const P = [];
    for (let i = 0; i < 3; i++) {      // 行を先に
        for (let j = 0; j < 4; j++) {   // 列を後に
            P.push(tmpP[i][j]);
        }
    }

    return P.slice(0, 11);
}

/**
 * 行列の乗算
 */
function multiplyMatrices(A, B) {
    const rowsA = A.length;
    const colsA = A[0].length;
    const colsB = B[0].length;

    const result = [];
    for (let i = 0; i < rowsA; i++) {
        result[i] = [];
        for (let j = 0; j < colsB; j++) {
            let sum = 0;
            for (let k = 0; k < colsA; k++) {
                sum += A[i][k] * B[k][j];
            }
            result[i][j] = sum;
        }
    }
    return result;
}

// =============================================================================
// 再投影誤差の計算
// =============================================================================

/**
 * 再投影誤差を計算（目的関数）
 * MATLABコード cal_reprojective_err.m の移植
 */
function calculateReprojectionError(c, xyz, xy, resolution) {
    let fullParams;

    if (c.length === 6) {
        // 固定パラメータがあるかどうかチェック
        const fixed = (resolution && resolution.fixedInternalParams) ? resolution.fixedInternalParams : null;
        const U0 = fixed ? fixed.U0 : resolution[0] / 2;
        const V0 = fixed ? fixed.V0 : resolution[1] / 2;
        const F = fixed ? fixed.F : calculateFocalLength(c, xy, xyz, resolution);
        fullParams = [U0, V0, F, c[0], c[1], c[2], c[3], c[4], c[5]];
    } else if (c.length === 9) {
        fullParams = c;
    } else {
        return Infinity;
    }

    const P = cmr2dlt(fullParams);
    if (!P) return Infinity;

    // MATLAB: P=[P; 1]; Pmat=reshape(P,4,3)';
    // reshape(P,4,3) creates 4x3 matrix in column-major:
    //   [P0 P4 P8 ]
    //   [P1 P5 P9 ]
    //   [P2 P6 P10]
    //   [P3 P7 1  ]
    // Then transpose to get 3x4:
    //   [P0 P1 P2 P3]
    //   [P4 P5 P6 P7]
    //   [P8 P9 P10 1]
    const Pmat = [
        [P[0], P[1], P[2], P[3]],
        [P[4], P[5], P[6], P[7]],
        [P[8], P[9], P[10], 1]
    ];

    const distances = [];
    for (let i = 0; i < xyz.length; i++) {
        const XYZ1 = [xyz[i][0], xyz[i][1], xyz[i][2], 1];

        const proj = [
            Pmat[0][0] * XYZ1[0] + Pmat[0][1] * XYZ1[1] + Pmat[0][2] * XYZ1[2] + Pmat[0][3] * XYZ1[3],
            Pmat[1][0] * XYZ1[0] + Pmat[1][1] * XYZ1[1] + Pmat[1][2] * XYZ1[2] + Pmat[1][3] * XYZ1[3],
            Pmat[2][0] * XYZ1[0] + Pmat[2][1] * XYZ1[1] + Pmat[2][2] * XYZ1[2] + Pmat[2][3] * XYZ1[3]
        ];

        const u_proj = proj[0] / proj[2];
        const v_proj = proj[1] / proj[2];

        const du = u_proj - xy[i][0];
        const dv = v_proj - xy[i][1];
        distances.push(Math.sqrt(du * du + dv * dv));
    }

    // 外れ値除去
    if (distances.length > 3) {
        const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
        const std = Math.sqrt(
            distances.reduce((sum, d) => sum + (d - mean) ** 2, 0) / distances.length
        );
        const threshold = mean + 1.5 * std;
        const filtered = distances.filter(d => d < threshold);
        return filtered.reduce((a, b) => a + b, 0) / filtered.length;
    }

    return distances.reduce((a, b) => a + b, 0) / distances.length;
}

// =============================================================================
// Nelder-Mead法による最適化
// =============================================================================

/**
 * Nelder-Mead（シンプレックス法）による制約なし最適化
 */
function nelderMead(objective, x0, options = {}) {
    const n = x0.length;
    const maxIter = options.maxIterations || 10000;
    const tol = options.tolerance || 1e-8;
    const alpha = options.alpha || 1.0;
    const gamma = options.gamma || 2.0;
    const rho = options.rho || 0.5;
    const sigma = options.sigma || 0.5;

    // 初期シンプレックス
    const simplex = [x0.slice()];
    for (let i = 0; i < n; i++) {
        const point = x0.slice();
        point[i] += (Math.abs(point[i]) > 1e-6) ? 0.05 * point[i] : 0.00025;
        simplex.push(point);
    }

    let fvals = simplex.map(p => objective(p));
    let iterations = 0;
    const history = [];

    while (iterations < maxIter) {
        // ソート
        const indices = Array.from({ length: n + 1 }, (_, i) => i);
        indices.sort((a, b) => fvals[a] - fvals[b]);

        const sortedSimplex = indices.map(i => simplex[i]);
        const sortedFvals = indices.map(i => fvals[i]);

        for (let i = 0; i <= n; i++) {
            simplex[i] = sortedSimplex[i];
            fvals[i] = sortedFvals[i];
        }

        // 履歴を記録
        history.push(fvals[0]);

        // 収束判定
        const fRange = fvals[n] - fvals[0];
        if (fRange < tol) break;

        // 重心
        const centroid = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                centroid[j] += simplex[i][j];
            }
        }
        for (let j = 0; j < n; j++) centroid[j] /= n;

        // 反射
        const reflected = centroid.map((c, j) => c + alpha * (c - simplex[n][j]));
        const fReflected = objective(reflected);

        if (fReflected < fvals[0]) {
            const expanded = centroid.map((c, j) => c + gamma * (reflected[j] - c));
            const fExpanded = objective(expanded);

            if (fExpanded < fReflected) {
                simplex[n] = expanded;
                fvals[n] = fExpanded;
            } else {
                simplex[n] = reflected;
                fvals[n] = fReflected;
            }
        } else if (fReflected < fvals[n - 1]) {
            simplex[n] = reflected;
            fvals[n] = fReflected;
        } else {
            let contracted;
            if (fReflected < fvals[n]) {
                contracted = centroid.map((c, j) => c + rho * (reflected[j] - c));
            } else {
                contracted = centroid.map((c, j) => c + rho * (simplex[n][j] - c));
            }
            const fContracted = objective(contracted);

            if (fContracted < Math.min(fReflected, fvals[n])) {
                simplex[n] = contracted;
                fvals[n] = fContracted;
            } else {
                // 収縮
                for (let i = 1; i <= n; i++) {
                    for (let j = 0; j < n; j++) {
                        simplex[i][j] = simplex[0][j] + sigma * (simplex[i][j] - simplex[0][j]);
                    }
                    fvals[i] = objective(simplex[i]);
                }
            }
        }

        iterations++;
    }

    const bestIdx = 0; // fvals[0] is the best after sorting
    return {
        x: simplex[bestIdx],
        fval: fvals[bestIdx],
        iterations: iterations,
        history: history
    };
}

/**
 * 制約付き最適化（ペナルティ法）
 */
function constrainedOptimization(objective, x0, minBounds, maxBounds, options = {}) {
    const penalty = 1e6;

    const penalizedObjective = (x) => {
        let f = objective(x);
        for (let i = 0; i < x.length; i++) {
            if (x[i] < minBounds[i]) f += penalty * (minBounds[i] - x[i]) ** 2;
            if (x[i] > maxBounds[i]) f += penalty * (x[i] - maxBounds[i]) ** 2;
        }
        return f;
    };

    return nelderMead(penalizedObjective, x0, options);
}

// =============================================================================
// メイン処理：3次元CC法キャリブレーション
// =============================================================================

/**
 * 3次元CC法によるカメラキャリブレーション
 * グリッドサーチ + 局所最適化のハイブリッド手法
 */
// 新しいステレオ対応の実装
function perform3DCCCalibration(params) {
    return perform3DCCCalibrationStereo(params);
}

function perform3DCCCalibration_OLD(params) {
    const {
        controlPoints,
        resolution = [1920, 1080],
        initialCameraPosition = [-40, -10, 13],
        searchRange = [5, 5, 3, Math.PI / 10, Math.PI / 10, Math.PI / 10],
        options = {},
        onProgress // コールバック
    } = params;

    const xyz = controlPoints.map(p => [p.realCoords.x, p.realCoords.y, p.realCoords.z]);
    const xy = controlPoints.map(p => [p.imageCoords.u, p.imageCoords.v]);

    if (xyz.length < 3) {
        return { success: false, error: '最低3点の制御点が必要です' };
    }

    // 制御点の重心
    const cnt_cv = [
        xyz.reduce((s, p) => s + p[0], 0) / xyz.length,
        xyz.reduce((s, p) => s + p[1], 0) / xyz.length,
        xyz.reduce((s, p) => s + p[2], 0) / xyz.length
    ];

    const [X0, Y0, Z0] = initialCameraPosition;
    const eul = setInitialEuler(cnt_cv, [X0, Y0, Z0]);

    const cmr_prm = [X0, Y0, Z0, eul[0], eul[1], eul[2]];
    const dVal = searchRange;
    const minV = cmr_prm.map((v, i) => v - dVal[i]);
    const maxV = cmr_prm.map((v, i) => v + dVal[i]);

    const objective = (c) => calculateReprojectionError(c, xyz, xy, resolution);

    console.log('3D CC法: グリッドサーチで初期値探索...');
    if (onProgress) onProgress('グリッドサーチ開始', null, null);

    // グリッドサーチで粗い探索
    const gridSteps = options.gridSteps || 5;
    let bestGridPoint = cmr_prm.slice();
    let bestGridError = objective(bestGridPoint);

    const totalGridPoints = gridSteps * gridSteps * gridSteps;
    let gridCount = 0;

    // 3次元位置のグリッド探索
    for (let ix = 0; ix < gridSteps; ix++) {
        const px = minV[0] + (maxV[0] - minV[0]) * ix / (gridSteps - 1);
        for (let iy = 0; iy < gridSteps; iy++) {
            const py = minV[1] + (maxV[1] - minV[1]) * iy / (gridSteps - 1);
            for (let iz = 0; iz < gridSteps; iz++) {
                gridCount++;
                const pz = minV[2] + (maxV[2] - minV[2]) * iz / (gridSteps - 1);

                // この位置からの初期オイラー角を再計算
                const testEul = setInitialEuler(cnt_cv, [px, py, pz]);
                const testPoint = [px, py, pz, testEul[0], testEul[1], testEul[2]];

                try {
                    const err = objective(testPoint);
                    if (err < bestGridError && isFinite(err)) {
                        bestGridError = err;
                        bestGridPoint = testPoint;
                        if (onProgress && gridCount % 10 === 0) {
                            onProgress(`グリッド探索中 (${Math.round(gridCount / totalGridPoints * 100)}%)`, err, bestGridError);
                        }
                    }
                } catch (e) {
                    // スキップ
                }
            }
        }
    }

    console.log(`  グリッドサーチ最良誤差: ${bestGridError.toFixed(3)} px`);
    if (onProgress) onProgress('局所最適化へ移行', bestGridError, bestGridError);

    // 局所最適化
    console.log('3D CC法: 局所最適化...');

    // 複数回の試行
    const numTrials = options.numTrials || 5;
    let bestResult = { x: bestGridPoint, fval: bestGridError, iterations: 0 };

    for (let trial = 0; trial < numTrials; trial++) {
        // グリッド最良点の近傍からスタート
        const startPoint = bestGridPoint.map((v, i) =>
            v + (Math.random() - 0.5) * dVal[i] * 0.2
        );

        try {
            if (onProgress) onProgress(`局所最適化 試行 ${trial + 1}/${numTrials}`, null, bestResult.fval);

            const result = constrainedOptimization(objective, startPoint, minV, maxV, {
                maxIterations: options.maxIterations || 3000,
                tolerance: options.tolerance || 1e-8
            });

            if (result.fval < bestResult.fval) {
                bestResult = result;
                console.log(`  試行${trial + 1}: 誤差 ${result.fval.toFixed(3)} px (改善)`);
                if (onProgress) onProgress(`試行${trial + 1}で改善`, result.fval, bestResult.fval);
            }
        } catch (e) {
            // スキップ
        }
    }

    const cprm1 = bestResult.x;
    console.log(`3D CC法: 完了, 最終誤差: ${bestResult.fval.toFixed(3)} px`);

    // 焦点距離の計算
    const F = calculateFocalLength(cprm1, xy, xyz, resolution);

    // 9パラメータの組み立て
    const cmr_params_full = [
        resolution[0] / 2, resolution[1] / 2, F,
        cprm1[0], cprm1[1], cprm1[2],
        cprm1[3], cprm1[4], cprm1[5]
    ];

    // DLTパラメータ
    const dltParams = cmr2dlt(cmr_params_full);
    const perPointErrors = calculatePerPointErrors(cmr_params_full, xyz, xy);

    return {
        success: true,
        cameraParams: {
            U0: cmr_params_full[0],
            V0: cmr_params_full[1],
            F: cmr_params_full[2],
            X0: cmr_params_full[3],
            Y0: cmr_params_full[4],
            Z0: cmr_params_full[5],
            omega: cmr_params_full[6],
            phi: cmr_params_full[7],
            kappa: cmr_params_full[8]
        },
        dltParams: dltParams,
        errorStats: {
            rms: bestResult.fval,
            max: Math.max(...perPointErrors.map(e => e.error)),
            perPoint: perPointErrors
        },
        optimization: {
            iterations: bestResult.iterations,
            finalObjective: bestResult.fval,
            gridSearchError: bestGridError
        }
    };
}

// =============================================================================
// 遺伝的アルゴリズム (GA)
// =============================================================================

function geneticAlgorithm(objective, bounds, options = {}) {
    const {
        populationSize = 100,
        generations = 50,
        mutationRate = 0.2,
        mutationScale = 0.2,
        eliteCount = 5,
        onProgress = null
    } = options;

    const n = bounds.min.length;
    let population = [];
    const history = [];

    // 初期化
    for (let i = 0; i < populationSize; i++) {
        const gene = [];
        for (let j = 0; j < n; j++) {
            gene.push(bounds.min[j] + Math.random() * (bounds.max[j] - bounds.min[j]));
        }
        population.push({ gene, fitness: objective(gene) });
    }

    let best = population.reduce((a, b) => a.fitness < b.fitness ? a : b);

    // 進化ループ
    for (let gen = 0; gen < generations; gen++) {
        // ソート (昇順: 誤差が小さい方が優秀)
        population.sort((a, b) => a.fitness - b.fitness);

        if (population[0].fitness < best.fitness) {
            best = { gene: population[0].gene.slice(), fitness: population[0].fitness };
        }

        // 履歴を記録 (世代ごとのベスト)
        history.push(population[0].fitness);

        // 進捗通知（間引き）
        if (onProgress && gen % 5 === 0) {
            onProgress(`GA探索 世代 ${gen + 1}/${generations}`, population[0].fitness, best.fitness);
        }

        const newPopulation = [];

        // エリート保存
        for (let i = 0; i < eliteCount; i++) {
            newPopulation.push(population[i]);
        }

        // 次世代生成
        while (newPopulation.length < populationSize) {
            // トーナメント選択
            const p1 = tournamentSelect(population);
            const p2 = tournamentSelect(population);

            // 交叉 (BLX-alpha inspired)
            const childGene = [];
            for (let j = 0; j < n; j++) {
                // 単純平均 + ノイズ
                const mid = (p1.gene[j] + p2.gene[j]) / 2;
                const dist = Math.abs(p1.gene[j] - p2.gene[j]);
                let val = mid + (Math.random() - 0.5) * dist * 1.5; // 少し広めに探索

                // 突然変異
                if (Math.random() < mutationRate) {
                    const range = bounds.max[j] - bounds.min[j];
                    val += (Math.random() - 0.5) * range * mutationScale;
                }

                // 範囲制限
                val = Math.max(bounds.min[j], Math.min(bounds.max[j], val));
                childGene.push(val);
            }

            const fitness = objective(childGene);
            newPopulation.push({ gene: childGene, fitness: fitness });
        }
        population = newPopulation;
    }

    best.history = history;
    return best;
}

function tournamentSelect(pop) {
    const k = 4;
    let best = pop[Math.floor(Math.random() * pop.length)];
    for (let i = 1; i < k; i++) {
        const candidate = pop[Math.floor(Math.random() * pop.length)];
        if (candidate.fitness < best.fitness) best = candidate;
    }
    return best;
}

// =============================================================================
// 単独カメラの最適化（GA + Nelder-Mead）
// =============================================================================

function optimizeSingleCamera(xyz, xy, resolution, initialPos, searchRange, options, onProgress) {
    // 制御点の重心
    const cnt_cv = [
        xyz.reduce((s, p) => s + p[0], 0) / xyz.length,
        xyz.reduce((s, p) => s + p[1], 0) / xyz.length,
        xyz.reduce((s, p) => s + p[2], 0) / xyz.length
    ];

    const [X0, Y0, Z0] = initialPos;
    const eul = setInitialEuler(cnt_cv, [X0, Y0, Z0]);

    // 探索パラメータ: カメラ位置(x,y,z) + オイラー角(ω,φ,κ)
    const cmr_prm = [X0, Y0, Z0, eul[0], eul[1], eul[2]];
    const dVal = searchRange;
    const minV = cmr_prm.map((v, i) => v - dVal[i]);
    const maxV = cmr_prm.map((v, i) => v + dVal[i]);

    const objective = (c) => calculateReprojectionError(c, xyz, xy, resolution);

    // 複数回試行して最良の結果を採用する
    const numTrials = options.numTrials || 5;
    let bestGlobalResult = null;
    let bestGlobalError = Infinity;

    // 初期化メソッドの決定 ('auto', 'p3p', 'ga')
    let initMethod = options.initMethod || 'auto';
    const fixedIntParams = options.fixedInternalParams;

    if (initMethod === 'auto') {
        if (fixedIntParams && fixedIntParams.F && fixedIntParams.U0 && fixedIntParams.V0) {
            initMethod = 'p3p';
        } else {
            initMethod = 'ga';
        }
    } else if (initMethod === 'p3p') {
        // P3P要求だがパラメータがない場合はGAにフォールバック、またはエラーにする
        if (!fixedIntParams) {
            console.warn('P3Pが選択されましたが、固定内部パラメータがありません。GAにフォールバックします。');
            initMethod = 'ga';
        }
    }

    console.log(`3D CC法: 最適化を${numTrials}回試行します... (Method: ${initMethod})`);

    // P3Pモードの場合の事前計算
    let p3pCandidates = [];
    if (initMethod === 'p3p') {
        let allCandidates = [];

        // 3点の組み合わせを生成 (最大20通りまで)
        const combs = [];
        const n = xyz.length;

        if (n === 3) {
            combs.push([0, 1, 2]);
        } else {
            // 単純な3重ループで組み合わせ生成 (nCr)
            let count = 0;
            for (let i = 0; i < n - 2; i++) {
                for (let j = i + 1; j < n - 1; j++) {
                    for (let k = j + 1; k < n; k++) {
                        combs.push([i, j, k]);
                        count++;
                        if (count >= 20) break; // 組み合わせ爆発防止
                    }
                    if (count >= 20) break;
                }
                if (count >= 20) break;
            }
        }

        console.log(`  P3P: ${n}点から${combs.length}通りの組み合わせで初期値を探索します`);

        for (const comb of combs) {
            const subXYZ = comb.map(idx => xyz[idx]);
            const subXY = comb.map(idx => xy[idx]);

            const results = solveP3P(subXYZ, subXY, fixedIntParams);

            // 全点に対する再投影誤差で評価
            results.forEach(res => {
                const param = [res.X0, res.Y0, res.Z0, res.omega, res.phi, res.kappa];
                // P3Pは内部パラメータ固定前提なので、目的関数(objective)で評価可能
                // ただしobjectiveはF,U0,V0も最適化対象として含む場合のシグネチャかもしれないが
                // ここでは calculateReprojectionError を直接呼ぶ方が確実
                // optimizeSingleCamera 内の objective は (c) => calculateReprojectionError... なのでそれを使う

                // 固定内部パラメータがある場合、calculateReprojectionError はどう振る舞う？
                // calculateReprojectionErrorの実装を確認する必要があるが、
                // 通常は引数 c に全パラメータが含まれていることを期待する。
                // P3Pの結果 res は6パラメータ。
                // constrainedOptimization に渡す objective は 6パラメータ関数のはず（固定パラメータがある場合）。
                // 下のコードで objective を定義している:
                // const objective = (c) => calculateReprojectionError(c, xyz, xy, resolution);
                // しかし c が 6要素か9要素かは、calculateReprojectionError の内部実装次第。

                // ここでは、一旦全パラメータを構築して評価する
                let fullParam = [...param];
                if (fixedIntParams) {
                    // fixedIntParamsがある場合、通常 objective関数内でそれを考慮しているはずだが
                    // optimizeSingleCameraの objective 定義を見ると:
                    // const objective = (c) => calculateReprojectionError(c, xyz, xy, resolution);
                    // となっており、c の中身次第。
                    // もし calculateReprojectionError が 9要素を期待しているなら、ここで結合が必要。

                    // calculateReprojectionError の中身を見ると (後で確認)、
                    // 可変長の引数はサポートしていない可能性がある。
                    // しかし、P3Pを使う時点で固定パラメータはある。

                    // 安全のため、目的関数 objective をそのまま使う。
                    // optimizeSingleCamera は固定パラメータがある場合、変数を減らして objective をラップしているはず...
                    // いや、コードを見ると objective 定義は 行814 で固定:
                    // const objective = (c) => calculateReprojectionError(c, xyz, xy, resolution);
                    // そして calculateReprojectionError はおそらく c が [X,Y,Z,w,p,k, F,U0,V0] か [X,Y,Z,w,p,k] かを判断している？
                    // 後続の constrainedOptimization 呼び出し前の startPoint 構築を見ると
                    // P3Pの場合は 6要素 になっている (行902あたり)。
                    // したがって objective も 6要素 を受け付けるようにラップされているか、
                    // calculateReprojectionError が 6要素を受け付けるか。

                    // calculateReprojectionErrorの実装（別タスクで確認済み）では、
                    // params.length === 6 の場合、内部でデフォルトのF,U0,V0を使うか、あるいはエラーになるか...
                    // 実は calculateReprojectionError は固定パラメータを引数に取らない（現状）。
                    // つまり、calculateReprojectionError(c) の c は常に全パラメータを含んでいる必要がある可能性がある。

                    // 修正: 確実に評価するため、フルパラメータ(9要素)を構築して渡す。
                    fullParam = [
                        res.X0, res.Y0, res.Z0, res.omega, res.phi, res.kappa,
                        fixedIntParams.F, fixedIntParams.U0, fixedIntParams.V0
                    ];
                }

                const err = calculateReprojectionError(fullParam, xyz, xy, resolution);
                res.globalError = err;
                allCandidates.push(res);
            });
        }

        // エラーの小さい順にソート（全点での誤差を基準にする）
        // さらに、ユーザー入力の初期位置に近いものを優先する
        // （P3Pは鏡像解など、誤差が小さくても位置が全く違う解を出すことがあるため）

        // まずエラー順にソート
        allCandidates.sort((a, b) => a.globalError - b.globalError);

        if (initialPos && allCandidates.length > 0) {
            const minGlobalError = allCandidates[0].globalError;
            // 許容誤差範囲（最小値の3倍、または絶対値+10px）- 少し広めにとる
            const errorThreshold = Math.max(minGlobalError * 3.0, minGlobalError + 10.0);

            p3pCandidates = allCandidates.sort((a, b) => {
                const distA = Math.sqrt((a.X0 - initialPos[0]) ** 2 + (a.Y0 - initialPos[1]) ** 2 + (a.Z0 - initialPos[2]) ** 2);
                const distB = Math.sqrt((b.X0 - initialPos[0]) ** 2 + (b.Y0 - initialPos[1]) ** 2 + (b.Z0 - initialPos[2]) ** 2);

                const aValid = a.globalError <= errorThreshold;
                const bValid = b.globalError <= errorThreshold;

                if (aValid && bValid) {
                    return distA - distB; // 両方有効なら距離優先
                } else if (aValid) {
                    return -1;
                } else if (bValid) {
                    return 1;
                } else {
                    return a.globalError - b.globalError;
                }
            });
            console.log(`  P3P: 初期位置 [${initialPos.map(v => v.toFixed(1))}] に基づき解を選抜しました (BestDist: ${Math.sqrt((p3pCandidates[0].X0 - initialPos[0]) ** 2 + (p3pCandidates[0].Y0 - initialPos[1]) ** 2 + (p3pCandidates[0].Z0 - initialPos[2]) ** 2).toFixed(2)}m)`);
        } else {
            p3pCandidates = allCandidates;
        }

        console.log(`  P3P候補数(全結合): ${p3pCandidates.length}, 最小誤差: ${p3pCandidates[0]?.globalError.toFixed(4)}`);

        if (p3pCandidates.length === 0) {
            console.warn('P3P解が見つかりませんでした。GAにフォールバックします。');
            initMethod = 'ga';
        }
    }

    for (let trial = 0; trial < numTrials; trial++) {
        if (onProgress) onProgress(`試行 ${trial + 1}/${numTrials} 開始 (${initMethod})`, null, null);
        console.log(`  試行 ${trial + 1}/${numTrials}...`);

        let startPoint, gaError = null;
        let gaHistory = [];

        if (initMethod === 'ga') {
            // 1. 遺伝的アルゴリズム (GA) で大域探索
            const gaGenerations = options.generations || 100;
            const gaPopSize = options.populationSize || 200;

            const gaResult = geneticAlgorithm(objective, { min: minV, max: maxV }, {
                populationSize: gaPopSize,
                generations: gaGenerations,
                mutationRate: 0.3,
                eliteCount: 5,
                onProgress: (stage, current, best) => {
                    if (onProgress && Math.random() < 0.1) onProgress(`試行 ${trial + 1}: GA`, current, best);
                }
            });
            startPoint = gaResult.gene;
            gaError = gaResult.fitness;
            gaHistory = gaResult.history || [];
        } else {
            // P3P初期値を使用
            // 試行ごとに異なる摂動を与えるか、あるいは候補を変える
            // 候補が複数ある場合は試行ごとに順番に試す、あるいはベストを使う

            const candidateIdx = trial % p3pCandidates.length;
            const seed = p3pCandidates[candidateIdx];

            // 少し摂動を加える (局所解脱出のため)
            if (trial > 0) {
                startPoint = [
                    seed.X0 + (Math.random() - 0.5) * 0.1,  // 10cm程度の摂動
                    seed.Y0 + (Math.random() - 0.5) * 0.1,
                    seed.Z0 + (Math.random() - 0.5) * 0.1,
                    seed.omega + (Math.random() - 0.5) * 0.05, // 数度程度の摂動
                    seed.phi + (Math.random() - 0.5) * 0.05,
                    seed.kappa + (Math.random() - 0.5) * 0.05
                ];
            } else {
                startPoint = [seed.X0, seed.Y0, seed.Z0, seed.omega, seed.phi, seed.kappa];
            }
            gaError = objective(startPoint); // P3P初期値の誤差
        }

        // 2. 局所最適化 (Nelder-Mead) で微調整
        const nmOptions = {
            maxIterations: options.maxIterations || 5000,
            tolerance: options.tolerance || 1e-8
        };

        let currentResult = { x: startPoint, fval: gaError, iterations: 0, history: gaHistory };

        try {
            const nmResult = constrainedOptimization(objective, startPoint, minV, maxV, nmOptions);

            // 履歴の結合
            const combinedHistory = gaHistory.concat(nmResult.history || []);

            if (nmResult.fval < (gaError !== null ? gaError : Infinity)) {
                currentResult = {
                    x: nmResult.x,
                    fval: nmResult.fval,
                    iterations: nmResult.iterations,
                    history: combinedHistory,
                    gaSplitIndex: gaHistory.length
                };
            } else {
                currentResult.history = combinedHistory;
                currentResult.gaSplitIndex = gaHistory.length;
            }

        } catch (e) {
            console.error("Nelder-Mead Error:", e);
        }

        console.log(`    試行 ${trial + 1} 結果: ${currentResult.fval.toFixed(4)} px`);
        if (onProgress) onProgress(`試行 ${trial + 1}: NM局所最適化完了`, currentResult.fval, Math.min(bestGlobalError, currentResult.fval));

        // 最良結果の更新
        if (currentResult.fval < bestGlobalError) {
            bestGlobalError = currentResult.fval;
            bestGlobalResult = currentResult;
            console.log(`    -> 現在の最良値を更新: ${bestGlobalError.toFixed(4)} px`);
        }
    }

    // 最良の結果を使用
    const cprm1 = bestGlobalResult.x;
    const fixed = options.fixedInternalParams;
    const U0 = fixed ? fixed.U0 : resolution[0] / 2;
    const V0 = fixed ? fixed.V0 : resolution[1] / 2;
    const F = fixed ? fixed.F : calculateFocalLength(cprm1, xy, xyz, resolution);

    const cmr_params_full = [
        U0, V0, F,
        cprm1[0], cprm1[1], cprm1[2],
        cprm1[3], cprm1[4], cprm1[5]
    ];

    const dltParams = cmr2dlt(cmr_params_full);
    const perPointErrors = calculatePerPointErrors(cmr_params_full, xyz, xy);

    return {
        success: true,
        cameraParams: {
            U0: cmr_params_full[0], V0: cmr_params_full[1], F: cmr_params_full[2],
            X0: cmr_params_full[3], Y0: cmr_params_full[4], Z0: cmr_params_full[5],
            omega: cmr_params_full[6], phi: cmr_params_full[7], kappa: cmr_params_full[8]
        },
        dltParams: dltParams,
        errorStats: {
            rms: bestGlobalResult.fval,
            max: Math.max(...perPointErrors.map(e => e.error)),
            perPoint: perPointErrors
        },
        optimization: {
            iterations: bestGlobalResult.iterations,
            finalObjective: bestGlobalResult.fval,
            gaError: bestGlobalResult.history[bestGlobalResult.gaSplitIndex - 1]?.best || 0, // 概算
            history: bestGlobalResult.history,
            gaSplitIndex: bestGlobalResult.gaSplitIndex
        }
    };
}


/**
 * 各制御点の個別誤差を計算
 */
function calculatePerPointErrors(cameraParams, xyz, xy) {
    const P = cmr2dlt(cameraParams);

    // MATLABと同じ順序で3x4行列を構築
    const Pmat = [
        [P[0], P[1], P[2], P[3]],
        [P[4], P[5], P[6], P[7]],
        [P[8], P[9], P[10], 1]
    ];

    const errors = [];
    for (let i = 0; i < xyz.length; i++) {
        const XYZ1 = [xyz[i][0], xyz[i][1], xyz[i][2], 1];

        const proj = [
            Pmat[0][0] * XYZ1[0] + Pmat[0][1] * XYZ1[1] + Pmat[0][2] * XYZ1[2] + Pmat[0][3] * XYZ1[3],
            Pmat[1][0] * XYZ1[0] + Pmat[1][1] * XYZ1[1] + Pmat[1][2] * XYZ1[2] + Pmat[1][3] * XYZ1[3],
            Pmat[2][0] * XYZ1[0] + Pmat[2][1] * XYZ1[1] + Pmat[2][2] * XYZ1[2] + Pmat[2][3] * XYZ1[3]
        ];

        const u_proj = proj[0] / proj[2];
        const v_proj = proj[1] / proj[2];

        errors.push({
            pointIndex: i,
            measured: { u: xy[i][0], v: xy[i][1] },
            projected: { u: u_proj, v: v_proj },
            du: u_proj - xy[i][0],
            dv: v_proj - xy[i][1],
            error: Math.sqrt((u_proj - xy[i][0]) ** 2 + (v_proj - xy[i][1]) ** 2)
        });
    }

    return errors;
}

// =============================================================================
// 3D座標復元（Z平面制約）
// =============================================================================

/**
 * 単一カメラから3次元座標を復元（Z=一定の制約）
 */
function reconstruct3DFromSingleCameraCC(imageCoords, cameraParams, planeZ = 0) {
    const { u, v } = imageCoords;
    const { U0, V0, F, X0, Y0, Z0, omega, phi, kappa } = cameraParams;

    const R = euler2dcm([omega, phi, kappa]);
    const Z = planeZ;

    const A = [
        [F * R[0][0] - (u - U0) * R[2][0], F * R[0][1] - (u - U0) * R[2][1]],
        [F * R[1][0] - (v - V0) * R[2][0], F * R[1][1] - (v - V0) * R[2][1]]
    ];

    const Tz = R[2][0] * X0 + R[2][1] * Y0 + R[2][2] * Z0;
    const b = [
        (u - U0) * (R[2][2] * Z + Tz) - F * (R[0][2] * Z + R[0][0] * X0 + R[0][1] * Y0 + R[0][2] * Z0),
        (v - V0) * (R[2][2] * Z + Tz) - F * (R[1][2] * Z + R[1][0] * X0 + R[1][1] * Y0 + R[1][2] * Z0)
    ];

    const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
    if (Math.abs(det) < 1e-12) return null;

    const X = (b[0] * A[1][1] - b[1] * A[0][1]) / det;
    const Y = (A[0][0] * b[1] - A[1][0] * b[0]) / det;

    return { x: X, y: Y, z: Z };
}

// =============================================================================
// ASCファイル入出力
// =============================================================================

function parseASCFile(content) {
    const lines = content.trim().split('\n');
    if (lines.length < 2) return { success: false, error: '無効なASCファイル形式' };

    const meta = lines[0].split(',').map(s => parseFloat(s.trim()));
    const [numFrames, numPoints, frameInterval] = meta;

    const coords = lines[1].split(',').map(s => parseFloat(s.trim()));

    const points = [];
    for (let i = 0; i < numPoints; i++) {
        points.push({ u: coords[i * 2], v: coords[i * 2 + 1] });
    }

    return { success: true, numFrames, numPoints, frameInterval, points };
}

function exportCameraParamsToCP(cameraParams) {
    const { U0, V0, F, X0, Y0, Z0, omega, phi, kappa } = cameraParams;
    return [U0, V0, F, X0, Y0, Z0, omega, phi, kappa].join(',');
}


function exportDLTParamsToCC(dltParams) {
    return dltParams.map(p => p.toFixed(6)).join('\n');
}

// =============================================================================
// ステレオCC法 実装
// =============================================================================

function perform3DCCCalibrationStereo(params) {
    const {
        controlPoints,
        resolution = [1920, 1080],
        initialCameraPosition1 = [-40, -10, 13],
        initialCameraPosition2 = [40, -10, 13],
        searchRange = [5, 5, 3, Math.PI / 10, Math.PI / 10, Math.PI / 10],
        options = {},
        onProgress // コールバック
    } = params;

    const xyz = controlPoints.map(p => [p.realCoords.x, p.realCoords.y, p.realCoords.z]);
    if (xyz.length < 3) {
        return { success: false, error: '最低3点の制御点が必要です' };
    }

    // カメラ1のデータ準備
    const xy1 = controlPoints.map(p => [p.imageCoords.u, p.imageCoords.v]);

    // カメラ1の最適化
    if (onProgress) onProgress('[Cam1] 最適化開始', null, null);
    console.log('[Cam1] 最適化開始...');

    const options1 = { ...options, fixedInternalParams: options.fixedInternalParams1 };
    const resWithFixed1 = [...resolution];
    if (options.fixedInternalParams1) resWithFixed1.fixedInternalParams = options.fixedInternalParams1;

    const result1 = optimizeSingleCamera(xyz, xy1, resWithFixed1, initialCameraPosition1, searchRange, options1, (stage, current, best) => {
        if (onProgress) onProgress(`[Cam1] ${stage}`, current, best);
    });

    // 2段階最適化: 内部パラメータも含めて9変数で再最適化
    let result1Final = result1;
    if (options.twoStepOptimization && options.fixedInternalParams1) {
        console.log('[Cam1] 内部パラメータ固定設定のため、2段階最適化をスキップします');
        if (onProgress) onProgress('[Cam1] 内部パラメータ固定のため2段階目スキップ', null, null);
    }
    if (options.twoStepOptimization && result1.success && !options.fixedInternalParams1) {
        if (onProgress) onProgress('[Cam1] 2段階目: 内部パラメータ最適化', null, null);
        console.log('[Cam1] 2段階目: 9変数最適化開始...');

        // Stage1の結果を初期値として使用
        const cam1 = result1.cameraParams;
        const startPoint9 = [
            cam1.X0, cam1.Y0, cam1.Z0,
            cam1.omega, cam1.phi, cam1.kappa,
            cam1.F, cam1.U0, cam1.V0
        ];

        // 9変数用の目的関数
        const objective9 = (c) => {
            const params9 = [c[6], c[7], c[8], c[0], c[1], c[2], c[3], c[4], c[5]];
            return calculateReprojectionError(params9, xyz, xy1, resolution);
        };

        // 9変数の境界設定
        const minV9 = [
            startPoint9[0] - 10, startPoint9[1] - 10, startPoint9[2] - 10,
            startPoint9[3] - Math.PI / 4, startPoint9[4] - Math.PI / 4, startPoint9[5] - Math.PI / 4,
            startPoint9[6] * 0.8, startPoint9[7] - 100, startPoint9[8] - 100
        ];
        const maxV9 = [
            startPoint9[0] + 10, startPoint9[1] + 10, startPoint9[2] + 10,
            startPoint9[3] + Math.PI / 4, startPoint9[4] + Math.PI / 4, startPoint9[5] + Math.PI / 4,
            startPoint9[6] * 1.2, startPoint9[7] + 100, startPoint9[8] + 100
        ];

        try {
            const nmResult9 = constrainedOptimization(objective9, startPoint9, minV9, maxV9, {
                maxIterations: options.maxIterations || 5000,
                tolerance: 1e-9
            });

            if (nmResult9.fval < result1.errorStats.rms) {
                console.log(`  2段階目改善: ${result1.errorStats.rms.toFixed(4)} → ${nmResult9.fval.toFixed(4)} px`);

                const x = nmResult9.x;
                const cmr9 = [x[6], x[7], x[8], x[0], x[1], x[2], x[3], x[4], x[5]];
                const dlt9 = cmr2dlt(cmr9);
                const perPoint9 = calculatePerPointErrors(cmr9, xyz, xy1);

                result1Final = {
                    success: true,
                    cameraParams: {
                        U0: cmr9[0], V0: cmr9[1], F: cmr9[2],
                        X0: cmr9[3], Y0: cmr9[4], Z0: cmr9[5],
                        omega: cmr9[6], phi: cmr9[7], kappa: cmr9[8]
                    },
                    dltParams: dlt9,
                    errorStats: {
                        rms: nmResult9.fval,
                        max: Math.max(...perPoint9.map(e => e.error)),
                        perPoint: perPoint9
                    },
                    optimization: {
                        ...result1.optimization,
                        iterations: result1.optimization.iterations + nmResult9.iterations,
                        finalObjective: nmResult9.fval,
                        twoStepApplied: true
                    }
                };
            } else {
                console.log('  2段階目: 改善なし、Stage1結果を使用');
            }
        } catch (e) {
            console.error('2段階目最適化エラー:', e);
        }
    }

    // カメラ2のデータ準備（存在する場合）
    let result2 = null;
    let hasValidCam2 = false;

    // imageCoords2が存在し、かつ非ゼロデータが含まれているかチェック
    if (controlPoints[0].imageCoords2) {
        const xy2 = controlPoints.map(p => [p.imageCoords2?.u || 0, p.imageCoords2?.v || 0]);
        // 全てが(0,0)でないか確認
        hasValidCam2 = xy2.some(p => Math.abs(p[0]) > 0.1 || Math.abs(p[1]) > 0.1);

        if (hasValidCam2) {
            if (onProgress) onProgress('[Cam2] 最適化開始', null, null);
            console.log('[Cam2] 最適化開始...');

            const options2 = { ...options, fixedInternalParams: options.fixedInternalParams2 };
            const resWithFixed2 = [...resolution];
            if (options.fixedInternalParams2) resWithFixed2.fixedInternalParams = options.fixedInternalParams2;

            result2 = optimizeSingleCamera(xyz, xy2, resWithFixed2, initialCameraPosition2, searchRange, options2, (stage, current, best) => {
                if (onProgress) onProgress(`[Cam2] ${stage}`, current, best);
            });

            // Cam2 2段階最適化
            if (options.twoStepOptimization && options.fixedInternalParams2) {
                console.log('[Cam2] 内部パラメータ固定設定のため、2段階最適化をスキップします');
                if (onProgress) onProgress('[Cam2] 内部パラメータ固定のため2段階目スキップ', null, null);
            }
            if (options.twoStepOptimization && result2.success && !options.fixedInternalParams2) {
                if (onProgress) onProgress('[Cam2] 2段階目: 内部パラメータ最適化', null, null);
                console.log('[Cam2] 2段階目: 9変数最適化開始...');

                const cam2 = result2.cameraParams;
                const startPoint9_2 = [
                    cam2.X0, cam2.Y0, cam2.Z0,
                    cam2.omega, cam2.phi, cam2.kappa,
                    cam2.F, cam2.U0, cam2.V0
                ];

                const objective9_2 = (c) => {
                    const params9 = [c[6], c[7], c[8], c[0], c[1], c[2], c[3], c[4], c[5]];
                    return calculateReprojectionError(params9, xyz, xy2, resolution);
                };

                const minV9_2 = [
                    startPoint9_2[0] - 10, startPoint9_2[1] - 10, startPoint9_2[2] - 10,
                    startPoint9_2[3] - Math.PI / 4, startPoint9_2[4] - Math.PI / 4, startPoint9_2[5] - Math.PI / 4,
                    startPoint9_2[6] * 0.8, startPoint9_2[7] - 100, startPoint9_2[8] - 100
                ];
                const maxV9_2 = [
                    startPoint9_2[0] + 10, startPoint9_2[1] + 10, startPoint9_2[2] + 10,
                    startPoint9_2[3] + Math.PI / 4, startPoint9_2[4] + Math.PI / 4, startPoint9_2[5] + Math.PI / 4,
                    startPoint9_2[6] * 1.2, startPoint9_2[7] + 100, startPoint9_2[8] + 100
                ];

                try {
                    const nmResult9_2 = constrainedOptimization(objective9_2, startPoint9_2, minV9_2, maxV9_2, {
                        maxIterations: options.maxIterations || 5000,
                        tolerance: 1e-9
                    });

                    if (nmResult9_2.fval < result2.errorStats.rms) {
                        console.log(`  [Cam2] 2段階目改善: ${result2.errorStats.rms.toFixed(4)} → ${nmResult9_2.fval.toFixed(4)} px`);

                        const x2 = nmResult9_2.x;
                        const cmr9_2 = [x2[6], x2[7], x2[8], x2[0], x2[1], x2[2], x2[3], x2[4], x2[5]];
                        const dlt9_2 = cmr2dlt(cmr9_2);
                        const perPoint9_2 = calculatePerPointErrors(cmr9_2, xyz, xy2);

                        result2 = {
                            success: true,
                            cameraParams: {
                                U0: cmr9_2[0], V0: cmr9_2[1], F: cmr9_2[2],
                                X0: cmr9_2[3], Y0: cmr9_2[4], Z0: cmr9_2[5],
                                omega: cmr9_2[6], phi: cmr9_2[7], kappa: cmr9_2[8]
                            },
                            dltParams: dlt9_2,
                            errorStats: {
                                rms: nmResult9_2.fval,
                                max: Math.max(...perPoint9_2.map(e => e.error)),
                                perPoint: perPoint9_2
                            },
                            optimization: {
                                ...result2.optimization,
                                iterations: result2.optimization.iterations + nmResult9_2.iterations,
                                finalObjective: nmResult9_2.fval,
                                twoStepApplied: true
                            }
                        };
                    }
                } catch (e) {
                    console.error('[Cam2] 2段階目最適化エラー:', e);
                }
            }
        }
    }

    const success = result1Final.success && (hasValidCam2 ? (result2 && result2.success) : true);

    // 結合結果
    return {
        success: success,
        cameraParams: result1Final.cameraParams, // 互換性のためCam1をデフォルトに
        dltParams: result1Final.dltParams,      // 互換性のためCam1をデフォルトに
        initMethod: options.initMethod,

        // 新しい構造
        results: {
            cam1: result1Final,
            cam2: result2
        },

        // 統合された誤差統計
        errorStats: {
            rms: (result1Final.errorStats.rms + (result2 ? result2.errorStats.rms : 0)) / (result2 ? 2 : 1),
            perPoint: result1Final.errorStats.perPoint.map((e1, i) => {
                const e2 = result2 ? result2.errorStats.perPoint[i] : { error: 0 };
                return {
                    pointIndex: i,
                    cam1: e1,
                    cam2: e2,
                    error: Math.sqrt((e1.error ** 2 + e2.error ** 2) / (result2 ? 2 : 1))
                };
            })
        },

        // ステレオDLT係数
        stereoDLTParams: [
            result1Final.dltParams,
            result2 ? result2.dltParams : null
        ]
    };
}



// =============================================================================
// モジュールエクスポート
// =============================================================================

if (typeof window !== 'undefined') {
    window.CCMethod = {
        perform3DCCCalibration,
        reconstruct3DFromSingleCameraCC,
        euler2dcm,
        dcm2euler,
        cmr2dlt,
        calculateReprojectionError,
        calculateFocalLength,
        parseASCFile,
        exportCameraParamsToCP,
        exportDLTParamsToCC,
        nelderMead,

        constrainedOptimization,
        solveP3P,
        DEFAULTS: CC_METHOD_DEFAULTS
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        perform3DCCCalibration,
        solveP3P
    };
}

// =============================================================================
// 数学ヘルパー関数
// =============================================================================

function dotProduct(v1, v2) {
    return v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
}

function crossProduct(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
    ];
}

function vecSub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vecNorm(a) {
    const len = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    return a.map(v => v / len);
}

function matMul(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            for (let k = 0; k < 3; k++) {
                C[i][j] += A[i][k] * B[k][j];
            }
        }
    }
    return C;
}

function matVecMul(A, v) {
    const r = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        r[i] = A[i][0] * v[0] + A[i][1] * v[1] + A[i][2] * v[2];
    }
    return r;
}

function matTranspose(A) {
    return [
        [A[0][0], A[1][0], A[2][0]],
        [A[0][1], A[1][1], A[2][1]],
        [A[0][2], A[1][2], A[2][2]]
    ];
}

// =============================================================================
// P3P (Perspective-3-Point) アルゴリズム
// =============================================================================

/**
 * P3P (Grunert's method の簡易実装 - 1次元探索) によるカメラ位置・姿勢の推定
 * @param {Array} objectPoints 3つの3次元座標 [[x,y,z], ...]
 * @param {Array} imagePoints 3つの画像座標 [[u,v], ...]
 * @param {Object} intrinsicParams 内部パラメータ {F, U0, V0}
 * @returns {Array} 可能なカメラ姿勢のリスト [{X0, Y0, Z0, omega, phi, kappa, error}, ...]
 */
function solveP3P(objectPoints, imagePoints, intrinsicParams) {
    if (objectPoints.length < 3 || imagePoints.length < 3) return [];

    const { F, U0, V0 } = intrinsicParams;

    // 1. 正規化画像座標への変換 (u,v -> x,y)
    // x = (u - U0) / F, y = (v - V0) / F
    const p = imagePoints.map(pt => ({
        x: (pt[0] - U0) / F,
        y: (pt[1] - V0) / F
    }));

    // 2. カメラ座標系での単位ベクトル (rays)
    const rays = p.map(pt => {
        const norm = Math.sqrt(pt.x * pt.x + pt.y * pt.y + 1);
        return [pt.x / norm, pt.y / norm, 1.0 / norm];
    });

    // 3. 3点間の距離 (世界座標系)
    const P1 = objectPoints[0];
    const P2 = objectPoints[1];
    const P3 = objectPoints[2];

    const a = Math.sqrt((P2[0] - P3[0]) ** 2 + (P2[1] - P3[1]) ** 2 + (P2[2] - P3[2]) ** 2); // P2-P3
    const b = Math.sqrt((P1[0] - P3[0]) ** 2 + (P1[1] - P3[1]) ** 2 + (P1[2] - P3[2]) ** 2); // P1-P3
    const c = Math.sqrt((P1[0] - P2[0]) ** 2 + (P1[1] - P2[1]) ** 2 + (P1[2] - P2[2]) ** 2); // P1-P2

    // 4. ベクトル間の余弦
    const cos_alpha = dotProduct(rays[1], rays[2]);
    const cos_beta = dotProduct(rays[0], rays[2]);
    const cos_gamma = dotProduct(rays[0], rays[1]);

    // 定数
    const cos_alpha2 = cos_alpha ** 2;
    const cos_beta2 = cos_beta ** 2;
    const cos_gamma2 = cos_gamma ** 2;
    const a2 = a * a, b2 = b * b, c2 = c * c;

    // 5. 1次元探索で解を求める
    // L1 (原点からP1への距離) を探索変数とする
    // search range: b * 0.1 ～ b * 10
    const STEPS = 1000;
    const rangeMin = b * 0.1;
    const rangeMax = b * 10.0;

    let bestScore = Infinity;
    let bestL1 = -1, bestL2 = -1, bestL3 = -1;

    for (let i = 0; i < STEPS; i++) {
        const L1 = rangeMin + (rangeMax - rangeMin) * (i / (STEPS - 1));
        const L1_sq = L1 * L1;

        // u^2 - 2*cos_gamma*u + (1 - c^2/L1_sq) = 0
        const C_u = 1 - c2 / L1_sq;
        const det_u = 4 * cos_gamma2 - 4 * C_u;

        if (det_u < 0) continue;

        const u_candidates = [
            cos_gamma + Math.sqrt(det_u) / 2,
            cos_gamma - Math.sqrt(det_u) / 2
        ].filter(v => v > 0);

        for (const u of u_candidates) {
            const L2 = u * L1;

            // v^2 - 2*cos_beta*v + (1 - b^2/L1_sq) = 0
            const C_v = 1 - b2 / L1_sq;
            const det_v = 4 * cos_beta2 - 4 * C_v;

            if (det_v < 0) continue;

            const v_candidates = [
                cos_beta + Math.sqrt(det_v) / 2,
                cos_beta - Math.sqrt(det_v) / 2
            ].filter(v => v > 0);

            for (const v of v_candidates) {
                const L3 = v * L1;

                // 検証: 第1式 L2^2 + L3^2 - 2*L2*L3*cos_alpha = a^2
                const estimated_a2 = L2 * L2 + L3 * L3 - 2 * L2 * L3 * cos_alpha;
                const diff = Math.abs(estimated_a2 - a2);

                if (diff < bestScore) {
                    bestScore = diff;
                    bestL1 = L1;
                    bestL2 = L2;
                    bestL3 = L3;
                }
            }
        }
    }

    // 解が見つからなかった場合
    if (bestL1 < 0) return [];

    // カメラ座標系でのP1, P2, P3の座標を決定
    const Pc1 = [rays[0][0] * bestL1, rays[0][1] * bestL1, rays[0][2] * bestL1];
    const Pc2 = [rays[1][0] * bestL2, rays[1][1] * bestL2, rays[1][2] * bestL2];
    const Pc3 = [rays[2][0] * bestL3, rays[2][1] * bestL3, rays[2][2] * bestL3];

    // 重心を合わせる
    const meanP = [
        (P1[0] + P2[0] + P3[0]) / 3, (P1[1] + P2[1] + P3[1]) / 3, (P1[2] + P2[2] + P3[2]) / 3
    ];
    const meanPc = [
        (Pc1[0] + Pc2[0] + Pc3[0]) / 3, (Pc1[1] + Pc2[1] + Pc3[1]) / 3, (Pc1[2] + Pc2[2] + Pc3[2]) / 3
    ];

    // 重心除去
    // World Basis
    let Wx = vecSub(P2, P1); Wx = vecNorm(Wx);
    let Wy_temp = vecSub(P3, P1);
    let Wz = crossProduct(Wx, Wy_temp); Wz = vecNorm(Wz);
    let Wy = crossProduct(Wz, Wx);

    // Camera Basis
    let Cx = vecSub(Pc2, Pc1); Cx = vecNorm(Cx);
    let Cy_temp = vecSub(Pc3, Pc1);
    let Cz = crossProduct(Cx, Cy_temp); Cz = vecNorm(Cz);
    let Cy = crossProduct(Cz, Cx);

    // 回転行列 R = [Cx Cy Cz] * [Wx Wy Wz]^T
    const R_cols = [
        [Cx[0], Cy[0], Cz[0]],
        [Cx[1], Cy[1], Cz[1]],
        [Cx[2], Cy[2], Cz[2]]
    ];
    const W_inv = [ // Orthogonal mtx, transpose is inverse
        [Wx[0], Wx[1], Wx[2]],
        [Wy[0], Wy[1], Wy[2]],
        [Wz[0], Wz[1], Wz[2]]
    ];

    const R = matMul(R_cols, W_inv);

    // 平行移動 T = meanPc - R * meanP
    const R_meanP = matVecMul(R, meanP);
    const T = vecSub(meanPc, R_meanP);

    // Camera Position C = -R^T * T
    const R_t = matTranspose(R);
    const C_pos = matVecMul(R_t, T).map(v => -v);

    // Euler Angles
    const eul = dcm2euler(R);

    return [{
        X0: C_pos[0],
        Y0: C_pos[1],
        Z0: C_pos[2],
        omega: eul[0],
        phi: eul[1],
        kappa: eul[2],
        error: bestScore
    }];
}




