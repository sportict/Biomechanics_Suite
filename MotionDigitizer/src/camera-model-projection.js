/**
 * ============================================================================
 * カメラモデルベース射影（レイキャスティング）
 * MotionDigitizer v1.0 拡張モジュール
 * ============================================================================
 * 
 * 【概要】
 * ChArUcoボードキャリブレーション結果（内部・外部パラメータ）を使用して、
 * 2D画像座標を矢状面（測定平面）上の実空間座標に変換する高精度手法。
 * 
 * 【数学的原理】
 * 
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  ステップ1: 歪み補正（Undistortion）                                │
 * │  ─────────────────────────────────────────────────                  │
 * │  レンズ歪み（放射歪み・接線歪み）を除去して理想的なピンホール       │
 * │  カメラモデルに変換する。                                           │
 * │                                                                     │
 * │  入力: (u, v) = 歪んだ画像座標（ピクセル）                          │
 * │  出力: (x', y') = 正規化カメラ座標（無次元）                        │
 * │                                                                     │
 * │  変換式:                                                            │
 * │    x' = (u - cx) / fx                                               │
 * │    y' = (v - cy) / fy                                               │
 * │  ※実際には歪み係数を考慮した反復計算で求める                       │
 * └─────────────────────────────────────────────────────────────────────┘
 * 
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  ステップ2: カメラレイの生成                                        │
 * │  ─────────────────────────────────────────────────                  │
 * │  正規化座標からカメラ原点を起点とする3D光線（レイ）を生成する。     │
 * │                                                                     │
 * │  カメラ座標系でのレイ方向:                                          │
 * │    d_cam = [x', y', 1]^T                                            │
 * │                                                                     │
 * │  世界座標系でのレイ方向（回転行列Rを適用）:                         │
 * │    d_world = R^T * d_cam                                            │
 * │                                                                     │
 * │  カメラ位置（世界座標系）:                                          │
 * │    C = -R^T * t                                                     │
 * │                                                                     │
 * │  ※R: 回転行列（3x3）、t: 並進ベクトル（3x1）                       │
 * │  ※rvecからRへの変換はロドリゲスの回転公式を使用                    │
 * └─────────────────────────────────────────────────────────────────────┘
 * 
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  ステップ3: 平面との交点計算（レイキャスティング）                  │
 * │  ─────────────────────────────────────────────────                  │
 * │  レイと測定平面（Z=0）の交点を求める。                              │
 * │                                                                     │
 * │  レイの方程式:                                                      │
 * │    P(λ) = C + λ * d_world                                          │
 * │                                                                     │
 * │  平面の方程式（Z=0平面、ChArUcoボード面）:                          │
 * │    n・P = 0  （n = [0, 0, 1]^T は平面の法線）                       │
 * │                                                                     │
 * │  交点のパラメータλ:                                                │
 * │    λ = -C_z / d_z                                                  │
 * │                                                                     │
 * │  交点の世界座標:                                                    │
 * │    X = C_x + λ * d_x                                               │
 * │    Y = C_y + λ * d_y                                               │
 * │    Z = 0（平面上）                                                  │
 * └─────────────────────────────────────────────────────────────────────┘
 * 
 * 【座標系の定義】
 * 
 *   世界座標系（ChArUcoボード基準）:
 *   
 *        Y (上方向)
 *        ↑
 *        │    
 *        │   ╔═══════════╗
 *        │   ║ ChArUco   ║
 *        │   ║  Board    ║
 *        │   ╚═══════════╝
 *        └──────────────────→ X (右方向)
 *       ／
 *      ↙ Z (カメラ方向、手前が正)
 * 
 *   ※ボード左下コーナーが原点
 *   ※ボード面がXY平面（Z=0）
 * 
 * 【精度特性】
 * 
 *   面内精度: 2-5mm（キャリブレーション品質に依存）
 *   面外誤差: ΔZ / Z × 100% の相対誤差
 *   
 *   例: 撮影距離3.8m、面外変位10cmの場合
 *       誤差 = 0.1m / 3.8m ≈ 2.6%
 *       1m測定時の絶対誤差 ≈ 26mm
 * 
 * 【依存関係】
 *   - projectData.calibration（ChArUcoキャリブレーション結果）
 */

// =============================================================================
// ロドリゲスの回転公式（rvec → 回転行列R）
// =============================================================================

/**
 * ロドリゲスの回転公式: 回転ベクトルから回転行列を計算
 * OpenCVのcv2.Rodrigues()と等価
 * 
 * @param {Array} rvec - 回転ベクトル [rx, ry, rz]（ラジアン）
 * @returns {Array} R - 3x3回転行列
 */
function rodrigues(rvec) {
    const rx = rvec[0], ry = rvec[1], rz = rvec[2];
    const theta = Math.sqrt(rx * rx + ry * ry + rz * rz);

    // 回転角が非常に小さい場合は単位行列を返す
    if (theta < 1e-10) {
        return [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1]
        ];
    }

    // 単位回転軸
    const kx = rx / theta;
    const ky = ry / theta;
    const kz = rz / theta;

    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const v = 1 - c;

    // ロドリゲスの公式による回転行列
    return [
        [kx * kx * v + c, kx * ky * v - kz * s, kx * kz * v + ky * s],
        [ky * kx * v + kz * s, ky * ky * v + c, ky * kz * v - kx * s],
        [kz * kx * v - ky * s, kz * ky * v + kx * s, kz * kz * v + c]
    ];
}

// =============================================================================
// 行列演算ユーティリティ
// =============================================================================

/**
 * 3x3行列の転置
 * @param {Array} M - 3x3行列
 * @returns {Array} M^T - 転置行列
 */
function transpose3x3(M) {
    return [
        [M[0][0], M[1][0], M[2][0]],
        [M[0][1], M[1][1], M[2][1]],
        [M[0][2], M[1][2], M[2][2]]
    ];
}

/**
 * 3x3行列とベクトルの積
 * @param {Array} M - 3x3行列
 * @param {Array} v - 3要素ベクトル
 * @returns {Array} M * v
 */
function matVec3(M, v) {
    return [
        M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
        M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
        M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]
    ];
}

// =============================================================================
// 歪み補正（Undistortion）
// =============================================================================

/**
 * カメラ行列を3x3配列に正規化
 * 1次元配列（9要素）の場合は3x3配列に変換
 * @param {Array} cameraMatrix - カメラ行列（1次元または2次元配列）
 * @returns {Array} 3x3配列
 */
function normalizeCameraMatrix(cameraMatrix) {
    if (!cameraMatrix || !Array.isArray(cameraMatrix)) {
        return null;
    }

    // 既に3x3配列の場合
    if (cameraMatrix.length === 3 && Array.isArray(cameraMatrix[0])) {
        return cameraMatrix;
    }

    // 1次元配列（9要素）の場合
    if (cameraMatrix.length === 9) {
        return [
            [cameraMatrix[0], cameraMatrix[1], cameraMatrix[2]],
            [cameraMatrix[3], cameraMatrix[4], cameraMatrix[5]],
            [cameraMatrix[6], cameraMatrix[7], cameraMatrix[8]]
        ];
    }

    return null;
}

/**
 * 歪み補正: 画像座標から正規化カメラ座標を計算
 * OpenCVのcv2.undistortPoints()と等価（P=Noneの場合）
 * 
 * @param {number} u - 画像x座標（ピクセル）
 * @param {number} v - 画像y座標（ピクセル）
 * @param {Array} cameraMatrix - 3x3カメラ内部行列 [[fx,0,cx],[0,fy,cy],[0,0,1]] または1次元配列（9要素）
 * @param {Array} distCoeffs - 歪み係数 [k1, k2, p1, p2, k3, ...]
 * @returns {Object} {x, y} - 正規化カメラ座標
 */
function undistortPoint(u, v, cameraMatrix, distCoeffs) {
    // カメラ行列を正規化
    const K = normalizeCameraMatrix(cameraMatrix);
    if (!K) {
        return null;
    }

    // カメラ内部パラメータの抽出
    const fx = K[0][0];
    const fy = K[1][1];
    const cx = K[0][2];
    const cy = K[1][2];

    // 歪み係数（不足分は0で埋める）
    const k1 = distCoeffs[0] || 0;
    const k2 = distCoeffs[1] || 0;
    const p1 = distCoeffs[2] || 0;
    const p2 = distCoeffs[3] || 0;
    const k3 = distCoeffs[4] || 0;

    // 正規化座標（歪みあり）
    let x = (u - cx) / fx;
    let y = (v - cy) / fy;

    // 歪み係数がすべて0なら補正不要
    if (k1 === 0 && k2 === 0 && p1 === 0 && p2 === 0 && k3 === 0) {
        return { x, y };
    }

    // 反復法で歪みを除去（Newton-Raphson法の簡略版）
    // 初期値は歪んだ座標
    let x0 = x, y0 = y;

    for (let iter = 0; iter < 10; iter++) {
        const r2 = x0 * x0 + y0 * y0;
        const r4 = r2 * r2;
        const r6 = r4 * r2;

        // 放射歪み係数
        const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;

        // 接線歪み
        const dx_tangent = 2 * p1 * x0 * y0 + p2 * (r2 + 2 * x0 * x0);
        const dy_tangent = p1 * (r2 + 2 * y0 * y0) + 2 * p2 * x0 * y0;

        // 補正後の座標を推定
        x0 = (x - dx_tangent) / radial;
        y0 = (y - dy_tangent) / radial;
    }

    return { x: x0, y: y0 };
}

/**
 * 複数点の一括歪み補正
 * @param {Array} points - 画像座標の配列 [{x, y}, ...]
 * @param {Array} cameraMatrix - カメラ内部行列
 * @param {Array} distCoeffs - 歪み係数
 * @returns {Array} 正規化座標の配列
 */
function undistortPoints(points, cameraMatrix, distCoeffs) {
    return points.map(pt => undistortPoint(pt.x, pt.y, cameraMatrix, distCoeffs));
}

// =============================================================================
// カメラモデルベース射影（メイン関数）
// =============================================================================

/**
 * 画像座標から実空間座標への変換（歪み補正なし版、検証用）
 * 
 * @param {Object} imagePoint - 画像座標 {x, y} (ピクセル)
 * @param {Array} cameraMatrix - カメラ内部行列
 * @param {Array} rvec - 回転ベクトル [rx, ry, rz]
 * @param {Array} tvec - 並進ベクトル [tx, ty, tz]
 * @param {number} planeZ - 測定平面のZ座標（通常は0）
 * @returns {Object|null} 実空間座標 {x, y, z} またはnull
 */
function imageToWorldCoordinateWithoutDistortion(imagePoint, cameraMatrix, rvec, tvec, planeZ = 0) {
    // カメラ行列を正規化
    const K = normalizeCameraMatrix(cameraMatrix);
    if (!K) {
        return null;
    }

    const fx = K[0][0];
    const fy = K[1][1];
    const cx = K[0][2];
    const cy = K[1][2];

    // 歪み補正をスキップして、直接正規化座標を計算
    const x_norm = (imagePoint.x - cx) / fx;
    const y_norm = (imagePoint.y - cy) / fy;

    // 回転ベクトルから回転行列を計算
    const R = rodrigues(rvec);
    const R_T = transpose3x3(R);

    // カメラ位置（世界座標系）
    const t = [tvec[0], tvec[1], tvec[2]];
    const C = matVec3(R_T, t).map(v => -v);

    // レイ方向（世界座標系）
    const ray_cam = [x_norm, y_norm, 1.0];
    const d = matVec3(R_T, ray_cam);

    if (Math.abs(d[2]) < 1e-10) {
        return null;
    }

    const lambda = (planeZ - C[2]) / d[2];

    if (lambda < 0) {
        return null;
    }

    const X = C[0] + lambda * d[0];
    const Y = C[1] + lambda * d[1];
    const Z = planeZ;

    return { x: X, y: Y, z: Z };
}

/**
 * 画像座標を世界座標（測定平面上）に変換
 * カメラモデルベース射影（レイキャスティング）の主要関数
 * 
 * @param {Object} imagePoint - 画像座標 {x, y}（ピクセル）
 * @param {Array} cameraMatrix - 3x3カメラ内部行列
 * @param {Array} distCoeffs - 歪み係数
 * @param {Array} rvec - 回転ベクトル [rx, ry, rz]
 * @param {Array} tvec - 並進ベクトル [tx, ty, tz]
 * @param {number} planeZ - 測定平面のZ座標（デフォルト: 0）
 * @returns {Object} 世界座標 {x, y, z} またはnull
 */
function imageToWorldCoordinate(imagePoint, cameraMatrix, distCoeffs, rvec, tvec, planeZ = 0) {
    // 入力検証
    if (!imagePoint || imagePoint.x == null || imagePoint.y == null) {
        return null;
    }

    // カメラ行列の検証と正規化
    const K = normalizeCameraMatrix(cameraMatrix);
    if (!K) {
        return null;
    }

    if (!rvec || !tvec) {
        return null;
    }

    // ステップ1: 歪み補正
    const normalized = undistortPoint(
        imagePoint.x,
        imagePoint.y,
        K,
        distCoeffs || []
    );

    if (!normalized) {
        return null;
    }

    // ステップ2: 回転行列の計算
    const R = rodrigues(rvec);
    const R_T = transpose3x3(R);  // R^T（カメラ→世界座標変換用）

    // ステップ3: カメラ位置（世界座標系）
    // C = -R^T * t
    const t = [tvec[0], tvec[1], tvec[2]];
    const C = matVec3(R_T, t).map(v => -v);

    // ステップ4: レイ方向（世界座標系）
    // カメラ座標系でのレイ: [x', y', 1]
    const ray_cam = [normalized.x, normalized.y, 1.0];
    // 世界座標系に変換: d = R^T * ray_cam
    const d = matVec3(R_T, ray_cam);

    // ステップ5: 平面との交点計算
    // レイ: P(λ) = C + λ * d
    // 平面: Z = planeZ
    // 交点条件: C_z + λ * d_z = planeZ

    if (Math.abs(d[2]) < 1e-10) {
        // レイが平面と平行（交点なし）
        console.warn('imageToWorldCoordinate: レイが測定平面と平行です');
        return null;
    }

    const lambda = (planeZ - C[2]) / d[2];

    // λが負の場合、交点はカメラの後方（物理的に無効）
    if (lambda < 0) {
        return null;
    }

    // ステップ6: 世界座標の計算
    const X = C[0] + lambda * d[0];
    const Y = C[1] + lambda * d[1];
    const Z = planeZ;  // 定義により平面上

    return { x: X, y: Y, z: Z };
}

/**
 * 複数点の一括変換
 * @param {Array} imagePoints - 画像座標の配列
 * @param {Array} cameraMatrix - カメラ内部行列
 * @param {Array} distCoeffs - 歪み係数
 * @param {Array} rvec - 回転ベクトル
 * @param {Array} tvec - 並進ベクトル
 * @param {number} planeZ - 測定平面のZ座標
 * @returns {Array} 世界座標の配列
 */
function imageToWorldCoordinates(imagePoints, cameraMatrix, distCoeffs, rvec, tvec, planeZ = 0) {
    return imagePoints.map(pt =>
        imageToWorldCoordinate(pt, cameraMatrix, distCoeffs, rvec, tvec, planeZ)
    );
}

// =============================================================================
// MotionDigitizer統合用ラッパー関数
// =============================================================================

/**
 * ChArUcoキャリブレーション結果を使用した2D座標変換
 * projectDataから直接パラメータを取得
 * 
 * @param {Object} imagePoint - 画像座標 {x, y}
 * @param {number} viewIndex - 使用するビューのインデックス（外部パラメータ選択用）
 * @returns {Object} 世界座標 {x, y} または null
 */
function transformWithCharucoCalibration(imagePoint, viewIndex = 0) {
    // projectDataからキャリブレーション結果を取得
    const calib = window.projectData?.calibration;

    if (!calib) {
        console.error('transformWithCharucoCalibration: キャリブレーションデータがありません');
        return null;
    }

    // 内部パラメータ
    const cameraMatrix = calib.cameraMatrix;
    const distCoeffs = calib.distCoeffs || [];

    // 外部パラメータ（指定されたビュー）
    const rvecs = calib.rvecs || [];
    const tvecs = calib.tvecs || [];

    if (viewIndex < 0 || viewIndex >= rvecs.length) {
        return null;
    }

    const rvec = rvecs[viewIndex];
    const tvec = tvecs[viewIndex];

    // 変換実行
    const result = imageToWorldCoordinate(
        imagePoint,
        cameraMatrix,
        distCoeffs,
        rvec,
        tvec,
        0  // Z=0平面（ChArUcoボード面）
    );

    if (!result) return null;

    // 2D座標として返す（矢状面解析用）
    return { x: result.x, y: result.y };
}

/**
 * 3D空間座標変換 P' = R * P + T
 * @param {Object} point {x,y,z}
 * @param {Array} R 3x3回転行列 または 9要素配列
 * @param {Array} T 3要素並進ベクトル
 * @returns {Object} {x,y,z}
 */
function transformPoint3D(point, R, T) {
    if (!point) return null;

    // Tの検証
    if (!T || T.length < 3) return null;

    const x = point.x, y = point.y, z = point.z;
    let rx, ry, rz;

    if (R.length === 9 && typeof R[0] === 'number') {
        // Flat 3x3 array [r11, r12, r13, r21, ...]
        rx = R[0] * x + R[1] * y + R[2] * z + T[0];
        ry = R[3] * x + R[4] * y + R[5] * z + T[1];
        rz = R[6] * x + R[7] * y + R[8] * z + T[2];
    } else if (R.length === 3 && Array.isArray(R[0])) {
        // Nested 3x3 array [[r11, r12, r13], ...]
        rx = R[0][0] * x + R[0][1] * y + R[0][2] * z + T[0];
        ry = R[1][0] * x + R[1][1] * y + R[1][2] * z + T[1];
        rz = R[2][0] * x + R[2][1] * y + R[2][2] * z + T[2];
    } else {
        return null;
    }

    return { x: rx, y: ry, z: rz };
}

// =============================================================================
// モジュールエクスポート
// =============================================================================

// ブラウザ環境（Electron Renderer）
if (typeof window !== 'undefined') {
    window.CameraModelProjection = {
        // コア関数
        rodrigues,
        undistortPoint,
        undistortPoints,
        imageToWorldCoordinate,
        imageToWorldCoordinates,
        transformWithCharucoCalibration,
        normalizeCameraMatrix,

        // ユーティリティ
        transpose3x3,
        matVec3
    };

    // 個別関数もグローバルに追加（利便性のため）
    window.transformWithCharucoCalibration = transformWithCharucoCalibration;
    window.imageToWorldCoordinate = imageToWorldCoordinate;
    window.imageToWorldCoordinateWithoutDistortion = imageToWorldCoordinateWithoutDistortion;
    window.transformPoint3D = transformPoint3D;
}


