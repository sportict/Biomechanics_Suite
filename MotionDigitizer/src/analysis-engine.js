/**
 * MotionDigitizer v1.0 - Analysis Engine Module
 * 解析機能（DLT・座標変換・誤差計算）を担当
 * 
 * 主な機能:
 * - 2次元DLT法による座標変換
 * - キャリブレーション計算
 * - 誤差解析・検証
 * - 実長換算処理
 * 
 * 依存関係: mathjs（行列計算ライブラリ）
 */

const mathjsRef = (typeof window !== 'undefined' && window.math) ? window.math : null;
const math = mathjsRef || (typeof require === 'function' ? require('mathjs') : null);

if (!math) {
    throw new Error('mathjs が読み込まれていません。index.html で math.min.js を先に読み込んでください。');
}

// =============================================================================
// 2次元DLT法による座標変換機能
// =============================================================================

/**
 * 2次元DLT法のカメラ定数計算（VBAコードに基づく修正版）
 * @param {Array} calibrationPoints - キャリブレーションポイント配列
 * @returns {Object|null} - カメラ係数オブジェクト（A,B,C,D,E,F,G,H）またはnull
 */
function calculate2DDLTCoefficients(calibrationPoints) {
    // 4点以上の較正点が必要
    if (calibrationPoints.length < 4) {
        console.warn('2次元DLT法: 4点以上のキャリブレーションポイントが必要です');
        return null;
    }

    // デジタイズ済みの較正点のみを抽出
    const validPoints = calibrationPoints.filter(point =>
        point.digitizedCoords &&
        point.digitizedCoords.cam1 &&
        point.digitizedCoords.cam1.x !== null &&
        point.digitizedCoords.cam1.y !== null &&
        point.realCoords &&
        point.realCoords.x !== null &&
        point.realCoords.y !== null
    );

    if (validPoints.length < 4) {
        console.warn(`2次元DLT法: デジタイズ済み較正点が不足しています（${validPoints.length}点）`);
        return null;
    }

    // 行列Aとベクトルbを構築
    const A = [];
    const b = [];

    validPoints.forEach(point => {
        const X = point.realCoords.x;
        const Y = point.realCoords.y;
        const U = point.digitizedCoords.cam1.x;
        const V = point.digitizedCoords.cam1.y;

        // VBAコードと同じ行列構築
        // 1行目: u座標用
        A.push([X, Y, 1, 0, 0, 0, -U * X, -U * Y]);
        b.push(U);

        // 2行目: v座標用
        A.push([0, 0, 0, X, Y, 1, -V * X, -V * Y]);
        b.push(V);
    });

    try {
        // 最小二乗法で解を求める
        const A_matrix = math.matrix(A);

        // ベクトルbを列ベクトルとして作成
        // mathjs公式ドキュメントに基づく方法：2次元配列として作成
        const b_2d = b.map(val => [val]);
        const b_vector = math.matrix(b_2d);

        // 疑似逆行列を使用して解を求める
        let coefficients;
        try {
            const A_transpose = math.transpose(A_matrix);
            const ATA = math.multiply(A_transpose, A_matrix);
            const ATb = math.multiply(A_transpose, b_vector);

            coefficients = math.multiply(math.inv(ATA), ATb);
        } catch (error) {
            console.error('2次元DLT法: 行列計算エラー', error);
            return null;
        }

        // 結果をオブジェクトとして返す
        const result = {
            A: coefficients.get([0, 0]),
            B: coefficients.get([1, 0]),
            C: coefficients.get([2, 0]),
            D: coefficients.get([3, 0]),
            E: coefficients.get([4, 0]),
            F: coefficients.get([5, 0]),
            G: coefficients.get([6, 0]),
            H: coefficients.get([7, 0])
        };

        console.log('2次元DLT法: カメラ係数計算成功', result);
        return result;

    } catch (error) {
        console.error('2次元DLT法: 係数計算エラー', error);
        return null;
    }
}

/**
 * 2次元DLT法による座標変換（画像座標 → 実空間座標）
 * @param {Object} imageCoords - 画像座標 {x, y}
 * @param {Object} cameraCoefficients - カメラ係数
 * @returns {Object|null} - 実空間座標 {x, y} またはnull
 */
function transform2DDLT(imageCoords, cameraCoefficients) {
    if (!cameraCoefficients) {
        console.error('transform2DDLT: カメラ係数が設定されていません');
        return null;
    }

    const { A, B, C, D, E, F, G, H } = cameraCoefficients;
    const { x: U, y: V } = imageCoords;

    // 2次元DLT法の逆変換
    // U = (A + BX + CY) / (1 + GX + HY)
    // V = (D + EX + FY) / (1 + GX + HY)

    // 線形方程式系を解く
    // U(1 + GX + HY) = A + BX + CY
    // V(1 + GX + HY) = D + EX + FY

    // 整理すると:
    // (B - UG)X + (C - UH)Y = U - A
    // (E - VG)X + (F - VH)Y = V - D

    const a11 = B - U * G;
    const a12 = C - U * H;
    const b1 = U - A;

    const a21 = E - V * G;
    const a22 = F - V * H;
    const b2 = V - D;

    const det = a11 * a22 - a12 * a21;

    if (Math.abs(det) < 1e-10) {
        console.error('transform2DDLT: 行列式が0に近い値です', det);
        return null;
    }

    const X = (b1 * a22 - b2 * a12) / det;
    const Y = (a11 * b2 - a21 * b1) / det;

    return { x: X, y: Y };
}

/**
 * 2次元DLT法による座標変換（実空間座標 → 画像座標）
 * @param {Object} realCoords - 実空間座標 {x, y}
 * @param {Object} cameraCoefficients - カメラ係数
 * @returns {Object|null} - 画像座標 {x, y} またはnull
 */
function transform2DDLTReverse(realCoords, cameraCoefficients) {
    if (!cameraCoefficients) {
        console.error('transform2DDLTReverse: カメラ係数が設定されていません');
        return null;
    }

    const { A, B, C, D, E, F, G, H } = cameraCoefficients;
    const { x: X, y: Y } = realCoords;

    // 2次元DLT法の順変換
    const U = (A + B * X + C * Y) / (1 + G * X + H * Y);
    const V = (D + E * X + F * Y) / (1 + G * X + H * Y);

    return { x: U, y: V };
}

// =============================================================================
// 3次元DLT法（カメラ定数・3D再構成）
// =============================================================================

/**
 * 3次元DLT: キャリブレーションポイントから各カメラの11係数を最小二乗で算出
 * VBA cam_const3d 相当の処理を mathjs で実装
 * @param {Array} calibrationPoints - { digitizedCoords.cam1.{x,y}, digitizedCoords.cam2.{x,y}, realCoords.{x,y,z} }
 * @returns {{cam1:Object, cam2:Object, pointCount:number}|null}
 */
function calculate3DDLTCoefficients(calibrationPoints) {
    const points = Array.isArray(calibrationPoints) ? calibrationPoints : [];

    const valid = points.filter(p => p && p.digitizedCoords && p.realCoords &&
        p.digitizedCoords.cam1 && isFinite(p.digitizedCoords.cam1.x) && isFinite(p.digitizedCoords.cam1.y) &&
        p.digitizedCoords.cam2 && isFinite(p.digitizedCoords.cam2.x) && isFinite(p.digitizedCoords.cam2.y) &&
        isFinite(p.realCoords.x) && isFinite(p.realCoords.y) && isFinite(p.realCoords.z));

    if (valid.length < 6) {
        console.warn('3次元DLT: 最低6点以上の較正点が必要です');
        return null;
    }

    const U1 = [];
    const U2 = [];
    const X1 = [];
    const X2 = [];

    valid.forEach(p => {
        const x = Number(p.realCoords.x);
        const y = Number(p.realCoords.y);
        const z = Number(p.realCoords.z);
        const u1 = Number(p.digitizedCoords.cam1.x);
        const v1 = Number(p.digitizedCoords.cam1.y);
        const u2 = Number(p.digitizedCoords.cam2.x);
        const v2 = Number(p.digitizedCoords.cam2.y);

        // カメラ1: u 行
        U1.push([u1]);
        X1.push([x, y, z, 1, 0, 0, 0, 0, -u1 * x, -u1 * y, -u1 * z]);
        // カメラ1: v 行
        U1.push([v1]);
        X1.push([0, 0, 0, 0, x, y, z, 1, -v1 * x, -v1 * y, -v1 * z]);

        // カメラ2: u 行
        U2.push([u2]);
        X2.push([x, y, z, 1, 0, 0, 0, 0, -u2 * x, -u2 * y, -u2 * z]);
        // カメラ2: v 行
        U2.push([v2]);
        X2.push([0, 0, 0, 0, x, y, z, 1, -v2 * x, -v2 * y, -v2 * z]);
    });

    const solveCoeffs = (X, U) => {
        const Xt = math.transpose(X);
        const XtX = math.multiply(Xt, X);
        const XtU = math.multiply(Xt, U);
        const C = math.multiply(math.inv(XtX), XtU);
        const out = [];
        for (let i = 0; i < 11; i++) out.push(C.get([i, 0]));
        return {
            L1: out[0], L2: out[1], L3: out[2], L4: out[3],
            L5: out[4], L6: out[5], L7: out[6], L8: out[7],
            L9: out[8], L10: out[9], L11: out[10]
        };
    };

    const C1 = solveCoeffs(math.matrix(X1), math.matrix(U1));
    const C2 = solveCoeffs(math.matrix(X2), math.matrix(U2));
    console.info('[3D-DLT] cam1 coefficients (11):', C1);
    console.info('[3D-DLT] cam2 coefficients (11):', C2);

    return { cam1: C1, cam2: C2, pointCount: valid.length };
}

/**
 * 3次元DLT: 2台カメラの(u,v)と各カメラ係数から 3D(X,Y,Z) を再構成
 * VBA dlt_cal3d の A(4x3),b(4x1) を最小二乗で解く
 */
function reconstruct3DPointFromPixels(u1, v1, u2, v2, C1, C2) {
    if (!C1 || !C2) return null;
    const A = [
        [C1.L1 - C1.L9 * u1, C1.L2 - C1.L10 * u1, C1.L3 - C1.L11 * u1],
        [C1.L5 - C1.L9 * v1, C1.L6 - C1.L10 * v1, C1.L7 - C1.L11 * v1],
        [C2.L1 - C2.L9 * u2, C2.L2 - C2.L10 * u2, C2.L3 - C2.L11 * u2],
        [C2.L5 - C2.L9 * v2, C2.L6 - C2.L10 * v2, C2.L7 - C2.L11 * v2]
    ];
    const b = [[u1 - C1.L4], [v1 - C1.L8], [u2 - C2.L4], [v2 - C2.L8]];

    // Use Matrix consistently
    const A_m = math.matrix(A);
    const b_m = math.matrix(b);
    const At = math.transpose(A_m);
    const AtA = math.multiply(At, A_m);
    const Atb = math.multiply(At, b_m);
    // 精度向上のため直接逆行列を計算せず、LU分解で解く
    let M;
    try {
        M = math.lusolve(AtA, Atb);
    } catch (e) {
        // 特異行列などで失敗した場合は従来の逆行列計算を試行
        try {
            M = math.multiply(math.inv(AtA), Atb);
        } catch (e2) {
            return null;
        }
    }

    const getVal = (m, r, c) => (typeof m.get === 'function' ? m.get([r, c]) : m[r][c]);
    return { x: getVal(M, 0, 0), y: getVal(M, 1, 0), z: getVal(M, 2, 0) };
}

/**
 * 3次元DLT 較正実行（係数保存＋簡易SE計算）
 * @param {Array} calibrationPoints
 * @param {Object} projectData
 */
function perform3DDLTCalibration(calibrationPoints, projectData) {
    const res = calculate3DDLTCoefficients(calibrationPoints);
    if (!res) {
        return { success: false, error: '3D較正に必要なデータが不足しています' };
    }

    if (projectData) {
        if (!projectData.cameraCoefficients3D) {
            projectData.cameraCoefficients3D = { cam1: null, cam2: null };
        }
        projectData.cameraCoefficients3D.cam1 = res.cam1;
        projectData.cameraCoefficients3D.cam2 = res.cam2;
    }

    // 各ポイントの推定3Dと誤差(dx,dy,dz)を保存
    const perPointErrors = [];
    (calibrationPoints || []).forEach(p => {
        if (!p) return;
        // 初期化
        if (!p.errors) p.errors = { x: null, y: null, z: null };
        // 入力が揃っていない場合はクリア
        const u1 = p?.digitizedCoords?.cam1?.x;
        const v1 = p?.digitizedCoords?.cam1?.y;
        const u2 = p?.digitizedCoords?.cam2?.x;
        const v2 = p?.digitizedCoords?.cam2?.y;
        if ([u1, v1, u2, v2].some(v => !isFinite(v)) || !p.realCoords) {
            p.errors.x = p.errors.y = p.errors.z = null;
            return;
        }
        const est = reconstruct3DPointFromPixels(u1, v1, u2, v2, res.cam1, res.cam2);
        if (!est) { p.errors.x = p.errors.y = p.errors.z = null; return; }
        const dx = est.x - Number(p.realCoords.x);
        const dy = est.y - Number(p.realCoords.y);
        const dz = est.z - Number(p.realCoords.z);
        p.errors.x = dx;
        p.errors.y = dy;
        p.errors.z = dz;
        // 保存用（SE算出）
        perPointErrors.push({ dx, dy, dz });
        // 推定値も格納（必要に応じてUIで使用可能）
        p.estimated3D = { x: est.x, y: est.y, z: est.z };
    });

    const nPoints = perPointErrors.length;
    // 標準偏差 (SD) の計算
    const calcSD = (arr, key) => {
        if (!nPoints || nPoints < 2) return 0;
        const mean = arr.reduce((s, e) => s + e[key], 0) / nPoints;
        const ss = arr.reduce((s, e) => { const d = e[key] - mean; return s + d * d; }, 0);
        return Math.sqrt(ss / (nPoints - 1));
    };
    const standardError = { seX: calcSD(perPointErrors, 'dx'), seY: calcSD(perPointErrors, 'dy'), seZ: calcSD(perPointErrors, 'dz') };

    // 平均誤差（Mean Euclidean Error）と最大誤差の計算（2D DLTと統一）
    let sumMag = 0;
    let maxMag = 0;
    perPointErrors.forEach(e => {
        const mag = Math.sqrt(e.dx * e.dx + e.dy * e.dy + e.dz * e.dz);
        sumMag += mag;
        if (mag > maxMag) maxMag = mag;
    });
    const meanError = nPoints > 0 ? (sumMag / nPoints) : 0;

    return {
        success: true,
        coefficients: res,
        standardError,
        meanError,
        maxError: maxMag,
        pointCount: res.pointCount
    };
}

// =============================================================================
// 誤差解析・検証機能
// =============================================================================

/**
 * キャリブレーション誤差検証（VBAコードに基づく修正版）
 * @param {Object} cameraCoefficients - カメラ係数
 * @param {Array} validPoints - 有効なキャリブレーションポイント
 * @returns {Object} - 誤差解析結果
 */
function calculateCalibrationError(cameraCoefficients, validPoints) {
    // validPointsが配列でない場合の処理
    if (!Array.isArray(validPoints)) {
        console.warn('calculateCalibrationError: validPointsが配列ではありません');
        return {
            stdErrorX: 0,
            stdErrorY: 0,
            meanError: 0,
            maxError: 0,
            errors: []
        };
    }

    if (validPoints.length === 0) {
        console.warn('calculateCalibrationError: 有効なポイントがありません');
        return {
            stdErrorX: 0,
            stdErrorY: 0,
            meanError: 0,
            maxError: 0,
            errors: []
        };
    }

    const errors = [];
    let totalErrorX = 0, totalErrorY = 0;
    let maxError = 0;

    validPoints.forEach((point, index) => {
        const U = point.digitizedCoords.cam1.x;
        const V = point.digitizedCoords.cam1.y;
        const realX = point.realCoords.x;
        const realY = point.realCoords.y;

        // VBAコードと同じ計算式
        // 2x2行列Aの構築
        const A11 = cameraCoefficients.A - cameraCoefficients.G * U;
        const A12 = cameraCoefficients.B - cameraCoefficients.H * U;
        const A21 = cameraCoefficients.D - cameraCoefficients.G * V;
        const A22 = cameraCoefficients.E - cameraCoefficients.H * V;

        // ベクトルbの構築
        const b1 = U - cameraCoefficients.C;
        const b2 = V - cameraCoefficients.F;

        // 行列式の計算
        const det = A11 * A22 - A12 * A21;

        if (Math.abs(det) < 1e-10) {
            console.warn(`calculateCalibrationError: ポイント${index}で行列式が0に近い値です`);
            errors.push({ x: 0, y: 0, calculatedX: 0, calculatedY: 0, magnitude: 0 });
            return;
        }

        // 逆行列による解の計算
        const invA11 = A22 / det;
        const invA12 = -A12 / det;
        const invA21 = -A21 / det;
        const invA22 = A11 / det;

        // 計算された実空間座標
        const calculatedX = invA11 * b1 + invA12 * b2;
        const calculatedY = invA21 * b1 + invA22 * b2;

        // 誤差の計算
        const errorX = calculatedX - realX;
        const errorY = calculatedY - realY;
        const errorMagnitude = Math.sqrt(errorX * errorX + errorY * errorY);

        errors.push({
            x: errorX,
            y: errorY,
            calculatedX: calculatedX,
            calculatedY: calculatedY,
            magnitude: errorMagnitude
        });

        totalErrorX += errorX;
        totalErrorY += errorY;
        maxError = Math.max(maxError, errorMagnitude);
    });

    // 統計情報の計算
    const n = errors.length;
    const meanErrorX = totalErrorX / n;
    const meanErrorY = totalErrorY / n;

    // 標準誤差の計算
    let sumSquaredErrorX = 0, sumSquaredErrorY = 0;
    errors.forEach(error => {
        sumSquaredErrorX += (error.x - meanErrorX) * (error.x - meanErrorX);
        sumSquaredErrorY += (error.y - meanErrorY) * (error.y - meanErrorY);
    });

    const stdErrorX = Math.sqrt(sumSquaredErrorX / (n - 1));
    const stdErrorY = Math.sqrt(sumSquaredErrorY / (n - 1));
    // 平均誤差 = 各ポイントのユークリッド距離誤差（magnitude）の平均
    const meanError = errors.reduce((sum, e) => sum + e.magnitude, 0) / n;

    const result = {
        stdErrorX,
        stdErrorY,
        meanError,
        maxError,
        errors
    };

    console.log('キャリブレーション誤差解析完了:', {
        pointCount: n,
        stdErrorX: stdErrorX.toFixed(6),
        stdErrorY: stdErrorY.toFixed(6),
        meanError: meanError.toFixed(6),
        maxError: maxError.toFixed(6)
    });

    return result;
}

/**
 * 標準誤差の計算（既存の関数を保持）
 * @param {Array} measuredCoords - 実測座標配列
 * @param {Array} calculatedCoords - 計算座標配列
 * @returns {Object|null} - 標準誤差解析結果
 */
function calculateStandardError(measuredCoords, calculatedCoords) {
    if (measuredCoords.length !== calculatedCoords.length) {
        console.error('calculateStandardError: 座標配列の長さが一致しません');
        return null;
    }

    const errors = [];
    let sumX = 0, sumY = 0, sumSquaredX = 0, sumSquaredY = 0;

    for (let i = 0; i < measuredCoords.length; i++) {
        const measured = measuredCoords[i];
        const calculated = calculatedCoords[i];

        const errorX = measured.x - calculated.x;
        const errorY = measured.y - calculated.y;

        errors.push({ x: errorX, y: errorY });

        sumX += errorX;
        sumY += errorY;
        sumSquaredX += errorX * errorX;
        sumSquaredY += errorY * errorY;
    }

    const n = measuredCoords.length;
    const meanX = sumX / n;
    const meanY = sumY / n;

    // 標準誤差の計算
    const stdErrorX = Math.sqrt((sumSquaredX - n * meanX * meanX) / (n - 1));
    const stdErrorY = Math.sqrt((sumSquaredY - n * meanY * meanY) / (n - 1));

    // 平均誤差と最大誤差
    const meanError = Math.sqrt(meanX * meanX + meanY * meanY);
    const maxError = Math.max(...errors.map(e => Math.sqrt(e.x * e.x + e.y * e.y)));

    return {
        stdErrorX,
        stdErrorY,
        meanError,
        maxError,
        errors
    };
}

// =============================================================================
// キャリブレーション実行機能
// =============================================================================

/**
 * 2次元DLT法の較正実行
 * @param {Array} calibrationPoints - キャリブレーションポイント配列
 * @param {Object} projectData - プロジェクトデータ（カメラ係数保存用）
 * @returns {Object} - 較正結果 {success, coefficients, errorAnalysis}
 */
function perform2DDLTCalibration(calibrationPoints, projectData) {
    console.log('2次元DLT法較正開始');

    // カメラ定数を計算
    const cameraCoefficients = calculate2DDLTCoefficients(calibrationPoints);

    if (!cameraCoefficients) {
        console.error('2次元DLT法較正失敗: カメラ定数の計算に失敗');
        return {
            success: false,
            error: 'カメラ定数の計算に失敗しました',
            coefficients: null,
            errorAnalysis: null
        };
    }

    // キャリブレーションデータの存在チェック
    if (!calibrationPoints || !Array.isArray(calibrationPoints)) {
        console.error('2次元DLT法較正失敗: キャリブレーションポイントが無効');
        return {
            success: false,
            error: 'キャリブレーションポイントが無効です',
            coefficients: null,
            errorAnalysis: null
        };
    }

    // デジタイズ済みの較正点を抽出
    const validPoints = calibrationPoints.filter(point =>
        point.digitizedCoords &&
        point.digitizedCoords.cam1 &&
        point.digitizedCoords.cam1.x !== null &&
        point.digitizedCoords.cam1.y !== null &&
        point.realCoords &&
        point.realCoords.x !== null &&
        point.realCoords.y !== null
    );

    // 誤差検証（VBAコードに基づく修正版）
    const errorAnalysis = calculateCalibrationError(cameraCoefficients, validPoints);

    // 各ポイントの個別誤差を保存
    if (errorAnalysis && errorAnalysis.errors && Array.isArray(validPoints)) {
        validPoints.forEach((point, index) => {
            const error = errorAnalysis.errors[index];
            if (error) {
                if (!point.errors) {
                    point.errors = { x: null, y: null, z: null };
                }
                point.errors.x = error.x;
                point.errors.y = error.y;
            }
        });
    }

    // カメラ係数をプロジェクトデータに保存
    if (projectData) {
        if (!projectData.cameraCoefficients) {
            projectData.cameraCoefficients = {
                cam1: null,
                cam2: null
            };
        }

        // 現在のカメラに係数を保存（グローバル関数を使用）
        if (typeof getCurrentCamera === 'function') {
            const currentCamera = getCurrentCamera();
            if (currentCamera === 'cam1') {
                projectData.cameraCoefficients.cam1 = cameraCoefficients;
            } else if (currentCamera === 'cam2') {
                projectData.cameraCoefficients.cam2 = cameraCoefficients;
            }
        }

        // DLT係数も保存（後方互換性のため）
        projectData.dltCoefficients = cameraCoefficients;
    }

    console.log('2次元DLT法較正完了:', {
        pointCount: validPoints.length,
        meanError: errorAnalysis.meanError.toFixed(6) + 'm',
        maxError: errorAnalysis.maxError.toFixed(6) + 'm'
    });

    return {
        success: true,
        coefficients: cameraCoefficients,
        errorAnalysis: errorAnalysis,
        validPointCount: validPoints.length
    };
}

// =============================================================================
// 実長換算処理機能
// =============================================================================

/**
 * ピクセル座標から実長座標を計算（VBAコードに基づく修正版）
 * @param {number} pixelX - ピクセルX座標
 * @param {number} pixelY - ピクセルY座標
 * @param {Object} cameraCoefficients - カメラ係数（オプション、未指定時はprojectDataから取得）
 * @returns {Object} - 実長座標 {x, y}
 */
function calculateRealCoordinates(pixelX, pixelY, cameraCoefficients = null) {
    if (typeof window !== 'undefined' && window.__DEBUG__) {
        console.debug('[RL] calc coords in', { x: pixelX, y: pixelY });
    }
    // カメラ係数が指定されていない場合はグローバルから取得
    let coeffs = cameraCoefficients;
    if (!coeffs && typeof projectData !== 'undefined' && projectData.dltCoefficients) {
        coeffs = projectData.dltCoefficients;
    }

    if (!coeffs) {
        console.error('calculateRealCoordinates: カメラ係数が設定されていません');
        return { x: 0, y: 0 };
    }

    // VBAコードと同じ計算式
    // A(1, 1) = cam1_const(1) - cam1_const(7) * U1
    // A(1, 2) = cam1_const(2) - cam1_const(8) * U1
    // A(2, 1) = cam1_const(4) - cam1_const(7) * v1
    // A(2, 2) = cam1_const(5) - cam1_const(8) * v1

    const A11 = coeffs.A - coeffs.G * pixelX;
    const A12 = coeffs.B - coeffs.H * pixelX;
    const A21 = coeffs.D - coeffs.G * pixelY;
    const A22 = coeffs.E - coeffs.H * pixelY;

    // b(1, 1) = U1 - cam1_const(3)
    // b(2, 1) = v1 - cam1_const(6)
    const b1 = pixelX - coeffs.C;
    const b2 = pixelY - coeffs.F;

    // 2x2行列の逆行列を求める
    const det = A11 * A22 - A12 * A21;

    if (Math.abs(det) < 1e-10) {
        console.error('calculateRealCoordinates: 行列式が0に近い値です', det);
        return { x: 0, y: 0 };
    }

    // 逆行列の計算
    const invA11 = A22 / det;
    const invA12 = -A12 / det;
    const invA21 = -A21 / det;
    const invA22 = A11 / det;

    // 解の計算: M = A^-1 * b
    const realX = invA11 * b1 + invA12 * b2;
    const realY = invA21 * b1 + invA22 * b2;

    const out = { x: realX, y: realY };
    if (typeof window !== 'undefined' && window.__DEBUG__) {
        console.debug('[RL] calc coords out', out);
    }
    return out;
}

/**
 * キャリブレーション誤差を計算
 * @param {number} pixelX - ピクセルX座標
 * @param {number} pixelY - ピクセルY座標
 * @param {Object} realCoords - 実空間座標
 * @returns {number} - 誤差（m単位）
 */
function calculateCalibrationErrorSimple(pixelX, pixelY, realCoords) {
    // 簡易的な誤差計算（実際のキャリブレーションポイントとの比較）
    // より正確な誤差計算が必要な場合は、キャリブレーションデータとの比較を行う

    // 現在は固定値として0.0005m（0.5mm）を返す（実際の実装では適切な誤差計算を行う）
    return 0.0005;
}

// =============================================================================
// ユーティリティ関数
// =============================================================================

/**
 * 数値かどうかを判定
 * @param {*} value - 判定する値
 * @returns {boolean} - 数値かどうか
 */
function isNumeric(value) {
    return !isNaN(parseFloat(value)) && isFinite(value);
}

/**
 * 座標の妥当性をチェック
 * @param {Object} coords - 座標オブジェクト {x, y}
 * @returns {boolean} - 妥当性
 */
function isValidCoordinates(coords) {
    return coords &&
        typeof coords.x === 'number' &&
        typeof coords.y === 'number' &&
        !isNaN(coords.x) &&
        !isNaN(coords.y);
}

/**
 * カメラ係数の妥当性をチェック
 * @param {Object} coefficients - カメラ係数
 * @returns {boolean} - 妥当性
 */
function isValidCameraCoefficients(coefficients) {
    if (!coefficients) return false;

    const requiredKeys = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    return requiredKeys.every(key =>
        key in coefficients &&
        typeof coefficients[key] === 'number' &&
        !isNaN(coefficients[key])
    );
}

// =============================================================================
// Vicon XCP + デジタイズ座標 → 三角測量復元
// =============================================================================

/**
 * 四元数を回転行列へ変換（OpenCV公式ドキュメントに準拠）
 * @param {Array<number>} quaternion [w,x,y,z]
 * @returns {Array<Array<number>>|null}
 */
function quaternionToRotationMatrix(quaternion) {
    if (!Array.isArray(quaternion) || quaternion.length < 4) return null;
    let [w, x, y, z] = quaternion.map(Number);
    const norm = Math.sqrt(w * w + x * x + y * y + z * z);
    if (norm === 0) return null;
    w /= norm; x /= norm; y /= norm; z /= norm;
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
    ];
}

/**
 * カメラ行列Kと姿勢から射影行列Pを生成
 * @param {Array<Array<number>>} cameraMatrix 3x3
 * @param {Array<number>} quaternion [w,x,y,z]
 * @param {Array<number>} position [X,Y,Z] mm
 * @returns {Array<Array<number>>|null} 3x4
 */
function buildProjectionMatrix(cameraMatrix, quaternion, position) {
    if (!Array.isArray(cameraMatrix) || cameraMatrix.length !== 3) return null;
    if (!Array.isArray(position) || position.length < 3) return null;
    const R = quaternionToRotationMatrix(quaternion);
    if (!R) return null;
    const cx = Number(position[0]);
    const cy = Number(position[1]);
    const cz = Number(position[2]);
    const t = [
        -(R[0][0] * cx + R[0][1] * cy + R[0][2] * cz),
        -(R[1][0] * cx + R[1][1] * cy + R[1][2] * cz),
        -(R[2][0] * cx + R[2][1] * cy + R[2][2] * cz)
    ];
    const RT = [
        [R[0][0], R[0][1], R[0][2], t[0]],
        [R[1][0], R[1][1], R[1][2], t[1]],
        [R[2][0], R[2][1], R[2][2], t[2]]
    ];
    const P = [];
    for (let r = 0; r < 3; r++) {
        const row = [];
        for (let c = 0; c < 4; c++) {
            const val = cameraMatrix[r][0] * RT[0][c] +
                cameraMatrix[r][1] * RT[1][c] +
                cameraMatrix[r][2] * RT[2][c];
            row.push(val);
        }
        P.push(row);
    }
    return P;
}

function buildEquationRowsForPoint(P, point) {
    const rows = [];
    const row0 = P[0], row1 = P[1], row2 = P[2];
    const u = Number(point.x);
    const v = Number(point.y);
    rows.push({
        coeffs: [
            u * row2[0] - row0[0],
            u * row2[1] - row0[1],
            u * row2[2] - row0[2]
        ],
        rhs: row0[3] - u * row2[3]
    });
    rows.push({
        coeffs: [
            v * row2[0] - row1[0],
            v * row2[1] - row1[1],
            v * row2[2] - row1[2]
        ],
        rhs: row1[3] - v * row2[3]
    });
    return rows;
}

function triangulatePointLinear(P1, P2, point1, point2) {
    const equations = [
        ...buildEquationRowsForPoint(P1, point1),
        ...buildEquationRowsForPoint(P2, point2)
    ];
    const A = equations.map(eq => eq.coeffs);
    const b = equations.map(eq => [eq.rhs]);
    try {
        const A_m = math.matrix(A);
        const b_m = math.matrix(b);
        const At = math.transpose(A_m);
        const AtA = math.multiply(At, A_m);
        const Atb = math.multiply(At, b_m);
        const X = math.multiply(math.inv(AtA), Atb);
        return {
            x: X.get([0, 0]),
            y: X.get([1, 0]),
            z: X.get([2, 0])
        };
    } catch (error) {
        console.error('triangulatePointLinear: 解の計算に失敗しました', error);
        return null;
    }
}

function projectPoint(P, point3d) {
    const row0 = P[0], row1 = P[1], row2 = P[2];
    const x = point3d.x, y = point3d.y, z = point3d.z;
    const w = row2[0] * x + row2[1] * y + row2[2] * z + row2[3];
    if (Math.abs(w) < 1e-9) return null;
    const u = (row0[0] * x + row0[1] * y + row0[2] * z + row0[3]) / w;
    const v = (row1[0] * x + row1[1] * y + row1[2] * z + row1[3]) / w;
    return { x: u, y: v };
}

/**
 * 内部パラメータと歪み係数を使用して3D点を画像平面に投影（OpenCV projectPoints相当）
 * @param {Object} point3d {x, y, z}
 * @param {Array<Array<number>>} cameraMatrix 3x3 [[fx, 0, cx], [0, fy, cy], [0, 0, 1]]
 * @param {Array<number>} distCoeffs [k1, k2, p1, p2, k3]
 * @returns {Object|null} {u, v}
 */
function projectPointWithIntrinsics(point3d, cameraMatrix, distCoeffs) {
    if (!point3d || typeof point3d.z !== 'number' || point3d.z === 0) return null;
    if (!cameraMatrix) return null;

    // カメラ行列の要素取得
    let fx, fy, cx, cy;

    if (cameraMatrix.length === 9 && typeof cameraMatrix[0] === 'number') {
        // フラット配列 [fx, 0, cx, 0, fy, cy, 0, 0, 1]
        fx = cameraMatrix[0];
        cx = cameraMatrix[2];
        fy = cameraMatrix[4];
        cy = cameraMatrix[5];
    } else if (cameraMatrix.length === 3 && Array.isArray(cameraMatrix[0])) {
        // 3x3配列
        fx = cameraMatrix[0][0];
        cx = cameraMatrix[0][2];
        fy = cameraMatrix[1][1];
        cy = cameraMatrix[1][2];
    } else {
        return null;
    }

    const x = point3d.x / point3d.z;
    const y = point3d.y / point3d.z;

    const r2 = x * x + y * y;
    const r4 = r2 * r2;
    const r6 = r4 * r2;

    const D = distCoeffs || [0, 0, 0, 0, 0];
    const k1 = D[0] || 0;
    const k2 = D[1] || 0;
    const p1 = D[2] || 0;
    const p2 = D[3] || 0;
    const k3 = D[4] || 0;

    // 放射状歪み
    const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;

    // 接線歪み
    const tanX = 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
    const tanY = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;

    // 歪み補正後の正規化座標
    const xDist = x * radial + tanX;
    const yDist = y * radial + tanY;

    // 画像座標へ変換
    const u = fx * xDist + cx;
    const v = fy * yDist + cy;

    return { u, v };
}

function resolveCamera(calibration, cameraKey) {
    if (!calibration || !Array.isArray(calibration.cameras)) return null;
    return calibration.cameras.find(cam => {
        return String(cam.userId) === String(cameraKey) || String(cam.deviceId) === String(cameraKey);
    }) || null;
}


function computeErrorStats(errors) {
    if (!errors.length) return { mean: null, max: null };
    const mean = errors.reduce((sum, v) => sum + v, 0) / errors.length;
    const max = Math.max(...errors);
    return { mean, max };
}

/**
 * XCP較正 + デジタイズ座標から3D復元
 * @param {Object} payload
 *  - calibration: parseViconXcp結果
 *  - cameraAId: string | number
 *  - cameraBId: string | number
 *  - samples: [{ frame, cam1:{x,y}, cam2:{x,y} }]
 * @returns {Object}
 */
function triangulateWithViconCalibration(payload) {
    if (!payload || !payload.calibration) {
        return { success: false, error: 'キャリブレーション情報が指定されていません' };
    }
    const camA = resolveCamera(payload.calibration, payload.cameraAId);
    const camB = resolveCamera(payload.calibration, payload.cameraBId);
    if (!camA || !camB) {
        return { success: false, error: '指定されたカメラ情報をXCPから取得できませんでした' };
    }
    const P1 = buildProjectionMatrix(camA.cameraMatrix, camA.quaternion, camA.position);
    const P2 = buildProjectionMatrix(camB.cameraMatrix, camB.quaternion, camB.position);
    if (!P1 || !P2) {
        return { success: false, error: '射影行列の構築に失敗しました' };
    }
    const results = [];
    const errorsCam1 = [];
    const errorsCam2 = [];
    const sampleErrors = [];
    const skipped = [];
    (payload.samples || []).forEach(sample => {
        const pt1 = sample && sample.cam1;
        const pt2 = sample && sample.cam2;
        if (!pt1 || !pt2 || !isFinite(pt1.x) || !isFinite(pt1.y) || !isFinite(pt2.x) || !isFinite(pt2.y)) {
            skipped.push(sample?.frame);
            return;
        }
        const point3d = triangulatePointLinear(P1, P2, pt1, pt2);
        if (!point3d) {
            skipped.push(sample.frame);
            return;
        }
        const repro1 = projectPoint(P1, point3d);
        const repro2 = projectPoint(P2, point3d);
        const err1 = repro1 ? Math.hypot(repro1.x - pt1.x, repro1.y - pt1.y) : null;
        const err2 = repro2 ? Math.hypot(repro2.x - pt2.x, repro2.y - pt2.y) : null;
        if (err1 != null) errorsCam1.push(err1);
        if (err2 != null) errorsCam2.push(err2);
        sampleErrors.push({
            frame: sample.frame,
            pointId: sample.pointId || null,
            original: { cam1: pt1, cam2: pt2 },
            reprojection: { cam1: repro1, cam2: repro2 },
            error: { cam1: err1, cam2: err2 }
        });
        results.push({
            frame: sample.frame,
            pointId: sample.pointId || null,
            x: point3d.x,
            y: point3d.y,
            z: point3d.z
        });
    });
    const stats = {
        cam1: computeErrorStats(errorsCam1),
        cam2: computeErrorStats(errorsCam2)
    };
    return {
        success: true,
        points: results,
        stats,
        skippedFrames: skipped,
        samples: sampleErrors
    };
}

// =============================================================================
// モジュールエクスポート
// =============================================================================

// Electronレンダラープロセス（Browser環境）でのエクスポート
if (typeof window !== 'undefined') {
    // グローバルオブジェクトに関数を追加
    window.AnalysisEngine = {
        // DLT法関連
        calculate2DDLTCoefficients,
        transform2DDLT,
        transform2DDLTReverse,
        perform2DDLTCalibration,
        // 3D DLT
        calculate3DDLTCoefficients,
        reconstruct3DPointFromPixels,
        perform3DDLTCalibration,

        // 誤差解析関連
        calculateCalibrationError,
        calculateStandardError,

        // 実長換算関連
        calculateRealCoordinates,
        calculateCalibrationErrorSimple,

        // Vicon XCP 三角測量
        quaternionToRotationMatrix,
        buildProjectionMatrix,
        triangulateWithViconCalibration,
        projectPointWithIntrinsics,

        // ユーティリティ
        isNumeric,
        isValidCoordinates,
        isValidCameraCoefficients
    };

    // 個別の関数もグローバルに追加（後方互換性のため）
    window.calculate2DDLTCoefficients = calculate2DDLTCoefficients;
    window.transform2DDLT = transform2DDLT;
    window.transform2DDLTReverse = transform2DDLTReverse;
    window.perform2DDLTCalibration = perform2DDLTCalibration;
    window.calculate3DDLTCoefficients = calculate3DDLTCoefficients;
    window.reconstruct3DPointFromPixels = reconstruct3DPointFromPixels;
    window.perform3DDLTCalibration = perform3DDLTCalibration;
    window.calculateCalibrationError = calculateCalibrationError;
    window.calculateStandardError = calculateStandardError;
    window.calculateRealCoordinates = calculateRealCoordinates;
    window.quaternionToRotationMatrix = quaternionToRotationMatrix;
    window.buildProjectionMatrix = buildProjectionMatrix;
    window.triangulateWithViconCalibration = triangulateWithViconCalibration;
    window.projectPointWithIntrinsics = projectPointWithIntrinsics;
}

// Node.js環境でのエクスポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // DLT法関連
        calculate2DDLTCoefficients,
        transform2DDLT,
        transform2DDLTReverse,
        perform2DDLTCalibration,
        calculate3DDLTCoefficients,
        reconstruct3DPointFromPixels,
        perform3DDLTCalibration,

        // 誤差解析関連
        calculateCalibrationError,
        calculateStandardError,

        // 実長換算関連
        calculateRealCoordinates,
        calculateCalibrationErrorSimple,
        quaternionToRotationMatrix,
        buildProjectionMatrix,
        triangulateWithViconCalibration,
        projectPointWithIntrinsics,

        // ユーティリティ
        isNumeric,
        isValidCoordinates,
        isValidCameraCoefficients
    };
}

// ログ出力なしの方針に合わせ削除