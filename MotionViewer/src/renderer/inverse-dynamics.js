/**
 * 逆動力学（Inverse Dynamics）計算モジュール
 *
 * 地面反力とキネマティックデータから関節トルク・パワーを算出
 *
 * 参考文献:
 * - Winter, D. A. (2009). Biomechanics and Motor Control of Human Movement
 * - de Leva, P. (1996). Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters
 */

class InverseDynamics {
  constructor(config = {}) {
    // 設定
    this.bodyMass = config.bodyMass || 70.0;  // 体重 [kg]
    this.sex = config.sex || 'male';           // 'male' or 'female'
    this.gravity = 9.80665;                    // 重力加速度 [m/s^2]

    // ポイントマッピング（マーカー名またはインデックス）
    // config.pointMappingが指定されている場合はそれを使用
    // なければデフォルトの23点モデルインデックスを使用
    if (config.pointMapping) {
      this.pointMapping = config.pointMapping;
      this.useMarkerNames = true;
      console.log('[InverseDynamics] マーカー名によるポイントマッピングを使用');
    } else {
      // デフォルトの23点モデル（HPE用）
      this.pointMapping = {
        rightHip: 12,
        rightKnee: 13,
        rightAnkle: 14,
        rightToe: 15,
        rightHeel: 16,
        leftHip: 17,
        leftKnee: 18,
        leftAnkle: 19,
        leftToe: 20,
        leftHeel: 21
      };
      this.useMarkerNames = false;
    }

    // 身体セグメントパラメータ（de Leva, 1996）
    this.segmentParams = this._getSegmentParams();

    // 計算結果
    this.results = null;
  }

  /**
   * 身体セグメントパラメータを取得（de Leva, 1996）
   * 3D解析用に3軸回転半径（gyrationRatioX/Y/Z）を追加
   * - X軸: セグメント長軸周り（捻転）
   * - Y軸: 前後軸周り（矢状面内回転）
   * - Z軸: 側方軸周り（前額面内回転）
   */
  _getSegmentParams() {
    const params = {
      male: {
        foot: {
          massRatio: 0.0137,      // 体重に対する質量比
          comRatio: 0.4415,       // セグメント長に対する重心位置（近位端から）
          gyrationRatio: 0.245,   // 回転半径比率（2D互換用）
          // 3D回転半径比率（de Leva, 1996 Table 4）
          gyrationRatioX: 0.124,  // 長軸周り（捻転）
          gyrationRatioY: 0.245,  // 前後軸周り（矢状面）
          gyrationRatioZ: 0.257   // 側方軸周り（前額面）
        },
        shank: {
          massRatio: 0.0433,
          comRatio: 0.4459,
          gyrationRatio: 0.302,
          gyrationRatioX: 0.102,
          gyrationRatioY: 0.275,
          gyrationRatioZ: 0.302
        },
        thigh: {
          massRatio: 0.1416,
          comRatio: 0.4095,
          gyrationRatio: 0.329,
          gyrationRatioX: 0.149,
          gyrationRatioY: 0.329,
          gyrationRatioZ: 0.329
        }
      },
      female: {
        foot: {
          massRatio: 0.0129,
          comRatio: 0.4014,
          gyrationRatio: 0.257,
          gyrationRatioX: 0.139,
          gyrationRatioY: 0.257,
          gyrationRatioZ: 0.268
        },
        shank: {
          massRatio: 0.0435,
          comRatio: 0.4416,
          gyrationRatio: 0.271,
          gyrationRatioX: 0.093,
          gyrationRatioY: 0.267,
          gyrationRatioZ: 0.271
        },
        thigh: {
          massRatio: 0.1478,
          comRatio: 0.3612,
          gyrationRatio: 0.369,
          gyrationRatioX: 0.162,
          gyrationRatioY: 0.369,
          gyrationRatioZ: 0.364
        }
      }
    };

    return params[this.sex] || params.male;
  }

  /**
   * セグメントの質量を計算
   */
  _getSegmentMass(segmentName) {
    return this.bodyMass * this.segmentParams[segmentName].massRatio;
  }

  /**
   * セグメントの慣性モーメントを計算（2D用、後方互換性）
   * @param {string} segmentName - セグメント名
   * @param {number} segmentLength - セグメント長 [m]
   */
  _getSegmentInertia(segmentName, segmentLength) {
    const mass = this._getSegmentMass(segmentName);
    const rg = this.segmentParams[segmentName].gyrationRatio;
    return mass * Math.pow(rg * segmentLength, 2);
  }

  // ============================================================
  // 3D数学ユーティリティ（Phase 1）
  // ============================================================

  /**
   * 3×3対角慣性テンソルを計算（ローカル座標系）
   * @param {string} segmentName - セグメント名
   * @param {number} segmentLength - セグメント長 [m]
   * @returns {Array<Array<number>>} 3×3慣性テンソル [[Ixx,0,0],[0,Iyy,0],[0,0,Izz]]
   */
  _getSegmentInertiaTensor3D(segmentName, segmentLength) {
    const mass = this._getSegmentMass(segmentName);
    const params = this.segmentParams[segmentName];

    // 各軸周りの慣性モーメント: I = m × (k × L)^2
    const Ixx = mass * Math.pow(params.gyrationRatioX * segmentLength, 2);
    const Iyy = mass * Math.pow(params.gyrationRatioY * segmentLength, 2);
    const Izz = mass * Math.pow(params.gyrationRatioZ * segmentLength, 2);

    return [
      [Ixx, 0, 0],
      [0, Iyy, 0],
      [0, 0, Izz]
    ];
  }

  /**
   * セグメント座標系の回転行列を計算（Gram-Schmidt直交化）
   *
   * セグメントローカル座標系:
   * - Z軸: セグメント長軸（近位→遠位）
   * - X軸: 側方（右方向が正）
   * - Y軸: 前後方向（前方が正）
   *
   * @param {Object} proximal - 近位端座標 {x, y, z}
   * @param {Object} distal - 遠位端座標 {x, y, z}
   * @param {Object} referencePoint - 参照点（前方向決定用、オプション）
   * @returns {Array<Array<number>>} 3×3回転行列 [X | Y | Z]（列ベクトル）
   */
  _computeSegmentRotationMatrix(proximal, distal, referencePoint = null) {
    // Z軸: セグメント長軸（近位→遠位）
    let zAxis = {
      x: distal.x - proximal.x,
      y: distal.y - proximal.y,
      z: distal.z - proximal.z
    };
    const zLen = Math.sqrt(zAxis.x ** 2 + zAxis.y ** 2 + zAxis.z ** 2);
    if (zLen < 1e-10) {
      // セグメント長がほぼ0の場合は単位行列を返す
      return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    }
    zAxis = { x: zAxis.x / zLen, y: zAxis.y / zLen, z: zAxis.z / zLen };

    // 仮のY軸（前方向）を決定
    let yTemp;
    if (referencePoint) {
      // 参照点がある場合、セグメント中点→参照点のベクトルを使用
      const midpoint = {
        x: (proximal.x + distal.x) / 2,
        y: (proximal.y + distal.y) / 2,
        z: (proximal.z + distal.z) / 2
      };
      yTemp = {
        x: referencePoint.x - midpoint.x,
        y: referencePoint.y - midpoint.y,
        z: referencePoint.z - midpoint.z
      };
    } else {
      // 参照点がない場合、グローバルY軸を使用（進行方向がY軸の場合）
      // または、Z軸とほぼ平行でない方向を選択
      if (Math.abs(zAxis.y) < 0.9) {
        yTemp = { x: 0, y: 1, z: 0 };  // グローバルY軸
      } else {
        yTemp = { x: 1, y: 0, z: 0 };  // グローバルX軸
      }
    }

    // X軸 = Y_temp × Z（右手系）
    let xAxis = {
      x: yTemp.y * zAxis.z - yTemp.z * zAxis.y,
      y: yTemp.z * zAxis.x - yTemp.x * zAxis.z,
      z: yTemp.x * zAxis.y - yTemp.y * zAxis.x
    };
    const xLen = Math.sqrt(xAxis.x ** 2 + xAxis.y ** 2 + xAxis.z ** 2);
    if (xLen < 1e-10) {
      // Y_tempとZ軸が平行な場合、別の方向を試す
      yTemp = { x: 0, y: 0, z: 1 };
      xAxis = {
        x: yTemp.y * zAxis.z - yTemp.z * zAxis.y,
        y: yTemp.z * zAxis.x - yTemp.x * zAxis.z,
        z: yTemp.x * zAxis.y - yTemp.y * zAxis.x
      };
      const xLen2 = Math.sqrt(xAxis.x ** 2 + xAxis.y ** 2 + xAxis.z ** 2);
      xAxis = { x: xAxis.x / xLen2, y: xAxis.y / xLen2, z: xAxis.z / xLen2 };
    } else {
      xAxis = { x: xAxis.x / xLen, y: xAxis.y / xLen, z: xAxis.z / xLen };
    }

    // Y軸 = Z × X（直交化）
    const yAxis = {
      x: zAxis.y * xAxis.z - zAxis.z * xAxis.y,
      y: zAxis.z * xAxis.x - zAxis.x * xAxis.z,
      z: zAxis.x * xAxis.y - zAxis.y * xAxis.x
    };

    // 回転行列: 列ベクトルとして格納 [X | Y | Z]
    // R[row][col] = 行row、列col
    return [
      [xAxis.x, yAxis.x, zAxis.x],
      [xAxis.y, yAxis.y, zAxis.y],
      [xAxis.z, yAxis.z, zAxis.z]
    ];
  }

  /**
   * 回転行列から回転行列への変換クォータニオンを計算
   * @param {Array<Array<number>>} R - 3×3回転行列
   * @returns {Object} クォータニオン {w, x, y, z}
   */
  _rotationMatrixToQuaternion(R) {
    const trace = R[0][0] + R[1][1] + R[2][2];
    let w, x, y, z;

    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      w = 0.25 / s;
      x = (R[2][1] - R[1][2]) * s;
      y = (R[0][2] - R[2][0]) * s;
      z = (R[1][0] - R[0][1]) * s;
    } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
      const s = 2.0 * Math.sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]);
      w = (R[2][1] - R[1][2]) / s;
      x = 0.25 * s;
      y = (R[0][1] + R[1][0]) / s;
      z = (R[0][2] + R[2][0]) / s;
    } else if (R[1][1] > R[2][2]) {
      const s = 2.0 * Math.sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]);
      w = (R[0][2] - R[2][0]) / s;
      x = (R[0][1] + R[1][0]) / s;
      y = 0.25 * s;
      z = (R[1][2] + R[2][1]) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]);
      w = (R[1][0] - R[0][1]) / s;
      x = (R[0][2] + R[2][0]) / s;
      y = (R[1][2] + R[2][1]) / s;
      z = 0.25 * s;
    }

    // 正規化
    const len = Math.sqrt(w * w + x * x + y * y + z * z);
    return { w: w / len, x: x / len, y: y / len, z: z / len };
  }

  /**
   * クォータニオンから3D角速度を計算
   * ω = 2 × dq/dt × q*
   *
   * @param {Array<Object>} quaternions - クォータニオン配列 [{w, x, y, z}, ...]
   * @param {number} dt - 時間間隔 [s]
   * @returns {Array<Object>} 角速度配列 [{x, y, z}, ...] [rad/s]
   */
  _computeAngularVelocityFromQuaternions(quaternions, dt) {
    const n = quaternions.length;
    const omega = new Array(n);

    for (let i = 0; i < n; i++) {
      if (i === 0) {
        // 前進差分
        omega[i] = this._quaternionAngularVelocity(quaternions[i], quaternions[i + 1], dt);
      } else if (i === n - 1) {
        // 後退差分
        omega[i] = this._quaternionAngularVelocity(quaternions[i - 1], quaternions[i], dt);
      } else {
        // 中央差分
        omega[i] = this._quaternionAngularVelocity(quaternions[i - 1], quaternions[i + 1], 2 * dt);
      }
    }

    return omega;
  }

  /**
   * 2つのクォータニオン間の角速度を計算
   * @param {Object} q1 - 開始クォータニオン
   * @param {Object} q2 - 終了クォータニオン
   * @param {number} dt - 時間間隔
   * @returns {Object} 角速度 {x, y, z}
   */
  _quaternionAngularVelocity(q1, q2, dt) {
    // クォータニオンの符号を揃える（短い経路を選択）
    let dot = q1.w * q2.w + q1.x * q2.x + q1.y * q2.y + q1.z * q2.z;
    if (dot < 0) {
      q2 = { w: -q2.w, x: -q2.x, y: -q2.y, z: -q2.z };
    }

    // dq/dt = (q2 - q1) / dt
    const dq = {
      w: (q2.w - q1.w) / dt,
      x: (q2.x - q1.x) / dt,
      y: (q2.y - q1.y) / dt,
      z: (q2.z - q1.z) / dt
    };

    // q* (共役クォータニオン)
    const qConj = { w: q1.w, x: -q1.x, y: -q1.y, z: -q1.z };

    // ω = 2 × dq × q*（クォータニオン積）
    const result = this._quaternionMultiply(dq, qConj);

    return {
      x: 2 * result.x,
      y: 2 * result.y,
      z: 2 * result.z
    };
  }

  /**
   * クォータニオン積を計算
   */
  _quaternionMultiply(a, b) {
    return {
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w
    };
  }

  /**
   * 回転行列配列から3D角速度を計算（数値微分）
   * 歪対称行列 Ω = dR/dt × R^T から角速度を抽出
   *
   * @param {Array<Array<Array<number>>>} rotationMatrices - 回転行列配列
   * @param {number} dt - 時間間隔 [s]
   * @returns {Array<Object>} 角速度配列 [{x, y, z}, ...] [rad/s]
   */
  _computeAngularVelocity3D(rotationMatrices, dt) {
    // クォータニオンに変換してから角速度を計算（より安定）
    const quaternions = rotationMatrices.map(R => this._rotationMatrixToQuaternion(R));
    return this._computeAngularVelocityFromQuaternions(quaternions, dt);
  }

  /**
   * 3D角加速度を計算（角速度の時間微分）
   * @param {Array<Object>} angularVelocities - 角速度配列 [{x, y, z}, ...]
   * @param {number} dt - 時間間隔 [s]
   * @returns {Array<Object>} 角加速度配列 [{x, y, z}, ...] [rad/s^2]
   */
  _computeAngularAcceleration3D(angularVelocities, dt) {
    const n = angularVelocities.length;
    const alpha = new Array(n);

    for (let i = 0; i < n; i++) {
      if (i === 0) {
        // 前進差分
        alpha[i] = {
          x: (angularVelocities[i + 1].x - angularVelocities[i].x) / dt,
          y: (angularVelocities[i + 1].y - angularVelocities[i].y) / dt,
          z: (angularVelocities[i + 1].z - angularVelocities[i].z) / dt
        };
      } else if (i === n - 1) {
        // 後退差分
        alpha[i] = {
          x: (angularVelocities[i].x - angularVelocities[i - 1].x) / dt,
          y: (angularVelocities[i].y - angularVelocities[i - 1].y) / dt,
          z: (angularVelocities[i].z - angularVelocities[i - 1].z) / dt
        };
      } else {
        // 中央差分
        alpha[i] = {
          x: (angularVelocities[i + 1].x - angularVelocities[i - 1].x) / (2 * dt),
          y: (angularVelocities[i + 1].y - angularVelocities[i - 1].y) / (2 * dt),
          z: (angularVelocities[i + 1].z - angularVelocities[i - 1].z) / (2 * dt)
        };
      }
    }

    return alpha;
  }

  /**
   * 慣性テンソルを座標変換
   * I_global = R × I_local × R^T
   *
   * @param {Array<Array<number>>} I_local - ローカル座標系での慣性テンソル (3×3)
   * @param {Array<Array<number>>} R - 回転行列 (3×3)
   * @returns {Array<Array<number>>} グローバル座標系での慣性テンソル (3×3)
   */
  _transformInertiaTensor(I_local, R) {
    // R × I_local
    const RI = this._matrixMultiply3x3(R, I_local);
    // R^T
    const RT = this._transposeMatrix3x3(R);
    // (R × I_local) × R^T
    return this._matrixMultiply3x3(RI, RT);
  }

  /**
   * 3×3行列の積
   */
  _matrixMultiply3x3(A, B) {
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

  /**
   * 3×3行列の転置
   */
  _transposeMatrix3x3(M) {
    return [
      [M[0][0], M[1][0], M[2][0]],
      [M[0][1], M[1][1], M[2][1]],
      [M[0][2], M[1][2], M[2][2]]
    ];
  }

  /**
   * 行列とベクトルの積 (3×3 × 3×1)
   * @param {Array<Array<number>>} M - 3×3行列
   * @param {Object} v - ベクトル {x, y, z}
   * @returns {Object} 結果ベクトル {x, y, z}
   */
  _matrixVectorMultiply3(M, v) {
    return {
      x: M[0][0] * v.x + M[0][1] * v.y + M[0][2] * v.z,
      y: M[1][0] * v.x + M[1][1] * v.y + M[1][2] * v.z,
      z: M[2][0] * v.x + M[2][1] * v.y + M[2][2] * v.z
    };
  }

  /**
   * 3Dベクトルの外積
   * @param {Object} a - ベクトル {x, y, z}
   * @param {Object} b - ベクトル {x, y, z}
   * @returns {Object} 外積ベクトル {x, y, z}
   */
  _cross3D(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    };
  }

  /**
   * 3Dベクトルの加算
   */
  _add3D(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  }

  /**
   * 3Dベクトルのスカラー倍
   */
  _scale3D(v, s) {
    return { x: v.x * s, y: v.y * s, z: v.z * s };
  }

  /**
   * 完全な3Dオイラー方程式による慣性トルク計算
   * τ_inertial = I × α + ω × (I × ω)
   *
   * 項1: I × α - 角加速度による慣性トルク
   * 項2: ω × (I × ω) - ジャイロスコープ効果（遠心力トルク）
   *
   * @param {Array<Array<number>>} I - 慣性テンソル (3×3)
   * @param {Object} omega - 角速度 {x, y, z} [rad/s]
   * @param {Object} alpha - 角加速度 {x, y, z} [rad/s^2]
   * @returns {Object} 慣性トルク {x, y, z} [Nm]
   */
  _computeInertialTorque3D(I, omega, alpha) {
    // 項1: I × α
    const term1 = this._matrixVectorMultiply3(I, alpha);

    // 項2: ω × (I × ω)
    const I_omega = this._matrixVectorMultiply3(I, omega);
    const term2 = this._cross3D(omega, I_omega);

    // 合計: τ = I × α + ω × (I × ω)
    return this._add3D(term1, term2);
  }

  /**
   * ベクトルをローカル座標系からグローバル座標系に変換
   * v_global = R × v_local
   */
  _transformToGlobal(R, v_local) {
    return this._matrixVectorMultiply3(R, v_local);
  }

  /**
   * ベクトルをグローバル座標系からローカル座標系に変換
   * v_local = R^T × v_global
   */
  _transformToLocal(R, v_global) {
    const RT = this._transposeMatrix3x3(R);
    return this._matrixVectorMultiply3(RT, v_global);
  }

  /**
   * セグメント重心位置を計算
   * @param {Object} proximal - 近位端座標 {x, y, z}
   * @param {Object} distal - 遠位端座標 {x, y, z}
   * @param {string} segmentName - セグメント名
   */
  _getSegmentCOM(proximal, distal, segmentName) {
    const ratio = this.segmentParams[segmentName].comRatio;
    return {
      x: proximal.x + ratio * (distal.x - proximal.x),
      y: proximal.y + ratio * (distal.y - proximal.y),
      z: proximal.z + ratio * (distal.z - proximal.z)
    };
  }

  /**
   * 2点間の距離を計算
   */
  _distance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dz = p2.z - p1.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * セグメント角度を計算（2D矢状面）
   * 座標系に応じて適切な平面を使用：
   * - Y-up座標系: X-Z平面（床がXZ）
   * - Z-up座標系: Y-Z平面（床がXY、進行方向がY）または X-Z平面
   * @param {Object} proximal - 近位端座標
   * @param {Object} distal - 遠位端座標
   * @returns {number} 角度 [rad]
   */
  _getSegmentAngle2D(proximal, distal) {
    // 矢状面の設定に基づいて計算
    if (this.sagittalPlane === 'YZ') {
      // Z-up座標系、進行方向がY軸の場合
      return Math.atan2(distal.z - proximal.z, distal.y - proximal.y);
    } else {
      // Y-up座標系、または進行方向がX軸の場合（デフォルト）
      return Math.atan2(distal.z - proximal.z, distal.x - proximal.x);
    }
  }

  /**
   * 座標系を検出し、矢状面を決定
   * @param {Array} frames - フレームデータ
   * @param {Object} positions - フィルタ済み位置データ
   */
  _detectCoordinateSystem(frames, positions) {
    // フレーム中央のデータを使用
    const midFrame = Math.floor(frames.length / 2);
    const sampleFrame = frames[midFrame];
    if (!sampleFrame || !Array.isArray(sampleFrame)) {
      this.sagittalPlane = 'XZ'; // デフォルト
      this.verticalAxis = 'Z';
      return;
    }

    // 最大Z値を確認（立位の頭頂）
    let maxZ = 0, maxY = 0;
    for (const p of sampleFrame) {
      if (p && isFinite(p.z) && p.z > maxZ) maxZ = p.z;
      if (p && isFinite(p.y) && p.y > maxY) maxY = p.y;
    }

    // 足位置の動きから進行方向を検出
    if (positions && positions.ankle) {
      const firstAnkle = positions.ankle[0];
      const lastAnkle = positions.ankle[positions.ankle.length - 1];
      const dxTotal = Math.abs(lastAnkle.x - firstAnkle.x);
      const dyTotal = Math.abs(lastAnkle.y - firstAnkle.y);

      // 進行方向がY軸の場合（dyTotal > dxTotal）はY-Z平面が矢状面
      if (dyTotal > dxTotal * 1.5) {
        this.sagittalPlane = 'YZ';
        this.verticalAxis = 'Z';
        console.log(`[InvDyn] 座標系検出: Z-up、進行方向Y軸 → 矢状面=Y-Z平面 (dY=${dyTotal.toFixed(3)}, dX=${dxTotal.toFixed(3)})`);
      } else {
        this.sagittalPlane = 'XZ';
        this.verticalAxis = maxZ > maxY ? 'Z' : 'Y';
        console.log(`[InvDyn] 座標系検出: 進行方向X軸 → 矢状面=X-Z平面 (dX=${dxTotal.toFixed(3)}, dY=${dyTotal.toFixed(3)})`);
      }
    } else {
      // フォールバック: Z値が大きければZ-up
      if (maxZ > maxY) {
        this.sagittalPlane = 'XZ';
        this.verticalAxis = 'Z';
      } else {
        this.sagittalPlane = 'XZ';
        this.verticalAxis = 'Y';
      }
      console.log(`[InvDyn] 座標系検出（フォールバック）: 矢状面=${this.sagittalPlane}平面`);
    }
  }

  /**
   * スプライン補間による速度を計算（S.KOIKE 2003.12.25アルゴリズム）
   * @param {Array} data - データ配列
   * @param {number} dt - 時間間隔 [s]
   * @returns {Array} 速度配列
   */
  _centralDifferenceVelocity(data, dt) {
    return this._splineDifferentiate(data, dt);
  }

  /**
   * スプライン補間による加速度を計算（2階微分）
   * @param {Array} data - データ配列
   * @param {number} dt - 時間間隔 [s]
   * @returns {Array} 加速度配列
   */
  _centralDifferenceAcceleration(data, dt) {
    // 1階微分（速度）を計算
    const velocity = this._splineDifferentiate(data, dt);
    // 2階微分（加速度）を計算
    const acceleration = this._splineDifferentiate(velocity, dt);
    return acceleration;
  }

  /**
   * 3次スプライン補間による微分計算
   * 手順:
   * 1. データをアップサンプリング（2倍）してスプライン補間
   * 2. スプライン係数から解析的に微分係数を計算
   * 3. 元のサンプリングレートに戻して出力
   * @param {Array} data - 入力データ
   * @param {number} dt - 時間間隔 [s]
   * @returns {Array} 微分値
   */
  _splineDifferentiate(data, dt) {
    const n = data.length;
    if (n < 4) {
      // データが短い場合は中央差分にフォールバック
      return this._simpleCentralDiff(data, dt);
    }

    // アップサンプリング倍率
    const nDiv = 2;
    const dtDiv = dt / nDiv;

    // 元の時間軸
    const tt = new Array(n);
    for (let i = 0; i < n; i++) tt[i] = i * dt;

    // アップサンプリング後の時間軸
    const nDivPts = (n - 1) * nDiv + 1;
    const ttDiv = new Array(nDivPts);
    for (let i = 0; i < nDivPts; i++) ttDiv[i] = i * dtDiv;

    // スプライン係数を計算
    const splineCoeffs = this._computeCubicSplineCoeffs(tt, data);

    // アップサンプリングデータを評価
    const divData = this._evaluateSpline(splineCoeffs, tt, ttDiv);

    // アップサンプリングデータのスプライン係数を計算
    const divSplineCoeffs = this._computeCubicSplineCoeffs(ttDiv, divData);

    // 微分係数を計算（3次スプラインの微分は2次多項式）
    const derivCoeffs = [];
    for (let i = 0; i < divSplineCoeffs.length; i++) {
      const { a, b, c } = divSplineCoeffs[i];
      derivCoeffs.push({
        a: 0,
        b: 3 * a,
        c: 2 * b,
        d: c
      });
    }

    // 微分値をアップサンプリング点で評価
    const divDiff = this._evaluateSplineDerivative(derivCoeffs, ttDiv, dtDiv);

    // 元のサンプリングレートに戻す
    const derivSplineCoeffs = this._computeCubicSplineCoeffs(ttDiv, divDiff);
    const diff = this._evaluateSpline(derivSplineCoeffs, ttDiv, tt);

    return diff;
  }

  /**
   * 単純な中央差分（フォールバック用）
   */
  _simpleCentralDiff(data, dt) {
    const n = data.length;
    const result = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      result[i] = (data[i + 1] - data[i - 1]) / (2 * dt);
    }
    result[0] = (data[1] - data[0]) / dt;
    result[n - 1] = (data[n - 1] - data[n - 2]) / dt;
    return result;
  }

  /**
   * 3次スプライン係数を計算（Natural Spline）
   */
  _computeCubicSplineCoeffs(x, y) {
    const n = x.length;
    if (n < 2) return [];

    const h = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      h[i] = x[i + 1] - x[i];
    }

    const alpha = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      alpha[i] = (3 / h[i]) * (y[i + 1] - y[i]) - (3 / h[i - 1]) * (y[i] - y[i - 1]);
    }

    const l = new Array(n).fill(1);
    const mu = new Array(n).fill(0);
    const z = new Array(n).fill(0);

    for (let i = 1; i < n - 1; i++) {
      l[i] = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1];
      mu[i] = h[i] / l[i];
      z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
    }

    const c = new Array(n).fill(0);
    const b = new Array(n - 1);
    const d = new Array(n - 1);
    const aCoeffs = new Array(n - 1);

    for (let j = n - 2; j >= 0; j--) {
      c[j] = z[j] - mu[j] * c[j + 1];
      b[j] = (y[j + 1] - y[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3;
      d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
      aCoeffs[j] = y[j];
    }

    const coeffs = [];
    for (let i = 0; i < n - 1; i++) {
      coeffs.push({
        a: d[i],
        b: c[i],
        c: b[i],
        d: aCoeffs[i],
        x0: x[i]
      });
    }

    return coeffs;
  }

  /**
   * スプラインを指定点で評価
   */
  _evaluateSpline(coeffs, xKnots, xEval) {
    const result = new Array(xEval.length);

    for (let i = 0; i < xEval.length; i++) {
      const xe = xEval[i];

      let idx = 0;
      for (let j = 0; j < coeffs.length - 1; j++) {
        if (xe >= xKnots[j] && xe < xKnots[j + 1]) {
          idx = j;
          break;
        }
        if (xe >= xKnots[j + 1]) idx = j + 1;
      }
      idx = Math.min(idx, coeffs.length - 1);

      const { a, b, c, d, x0 } = coeffs[idx];
      const dx = xe - x0;

      result[i] = a * dx * dx * dx + b * dx * dx + c * dx + d;
    }

    return result;
  }

  /**
   * スプライン微分を指定点で評価
   */
  _evaluateSplineDerivative(derivCoeffs, xEval, dt) {
    const result = new Array(xEval.length);
    const nCoeffs = derivCoeffs.length;

    for (let i = 0; i < xEval.length; i++) {
      const idx = Math.min(Math.floor(i * nCoeffs / xEval.length), nCoeffs - 1);
      const coeff = derivCoeffs[idx];
      const localT = (i % Math.max(1, Math.ceil(xEval.length / nCoeffs))) * dt;

      result[i] = coeff.b * localT * localT + coeff.c * localT + coeff.d;
    }

    return result;
  }

  /**
   * 2Dクロス積を計算（矢状面内）
   * 矢状面に垂直な軸周りのモーメントを計算
   * @param {Object} r - 位置ベクトル {h, v} 水平・垂直成分
   * @param {Object} f - 力ベクトル {h, v} 水平・垂直成分
   * @returns {number} クロス積（モーメント）
   */
  _cross2D(r, f) {
    // r × f = r_h * f_v - r_v * f_h
    // 正の値 = 反時計回り（屈曲モーメント）
    return r.h * f.v - r.v * f.h;
  }

  /**
   * 3D座標から矢状面座標（水平h, 垂直v）を取得
   * @param {Object} p - 3D座標 {x, y, z}
   * @returns {Object} 矢状面座標 {h, v}
   */
  _getSagittalCoords(p) {
    if (this.sagittalPlane === 'YZ') {
      return { h: p.y, v: p.z };
    } else {
      return { h: p.x, v: p.z };
    }
  }

  /**
   * 力ベクトルから矢状面成分を取得
   * @param {number} fx - X方向力
   * @param {number} fy - Y方向力
   * @param {number} fz - Z方向力
   * @returns {Object} 矢状面力成分 {h, v}
   */
  _getSagittalForce(fx, fy, fz) {
    if (this.sagittalPlane === 'YZ') {
      return { h: fy, v: fz };
    } else {
      return { h: fx, v: fz };
    }
  }

  /**
   * Butterworthローパスフィルタを適用
   * DC初期化対応版: 入力データの最初の値でフィルタ状態を初期化
   * @param {Array} data - データ配列
   * @param {number} cutoffHz - カットオフ周波数 [Hz]
   * @param {number} samplingHz - サンプリング周波数 [Hz]
   * @param {number} order - フィルタ次数（デフォルト: 2）
   */
  _butterworthFilter(data, cutoffHz, samplingHz, order = 2) {
    const n = data.length;
    if (n < 10) return [...data];

    // 端点効果を軽減するためにパディング
    const padLen = Math.min(50, Math.floor(n / 4));
    const padded = new Array(n + 2 * padLen);

    // 先頭パディング（反射）
    for (let i = 0; i < padLen; i++) {
      padded[i] = 2 * data[0] - data[padLen - i];
    }
    // 元データ
    for (let i = 0; i < n; i++) {
      padded[padLen + i] = data[i];
    }
    // 末尾パディング（反射）
    for (let i = 0; i < padLen; i++) {
      padded[n + padLen + i] = 2 * data[n - 1] - data[n - 2 - i];
    }

    // 双方向フィルタリング（ゼロ位相）
    const wc = Math.tan(Math.PI * cutoffHz / samplingHz);
    const k1 = Math.sqrt(2) * wc;
    const k2 = wc * wc;
    const a0 = k2 / (1 + k1 + k2);
    const a1 = 2 * a0;
    const a2 = a0;
    const b1 = 2 * a0 * (1 / k2 - 1);
    const b2 = 1 - (a0 + a1 + a2 + b1);

    // DC初期化: フィルタの定常状態応答を計算
    // y_ss = x_ss * (a0+a1+a2) / (1-b1-b2)
    const dcGain = (a0 + a1 + a2) / (1 - b1 - b2);
    const x0 = padded[0];
    const y0 = x0 * dcGain;

    const filtered = [...padded];
    // DC初期化で最初の2点を設定
    filtered[0] = y0;
    filtered[1] = y0;

    // 順方向フィルタ
    for (let i = 2; i < filtered.length; i++) {
      filtered[i] = a0 * padded[i] + a1 * padded[i - 1] + a2 * padded[i - 2]
        + b1 * filtered[i - 1] + b2 * filtered[i - 2];
    }

    // 逆方向フィルタ（末尾をDC初期化）
    const result = [...filtered];
    const xEnd = filtered[filtered.length - 1];
    const yEnd = xEnd * dcGain;
    result[filtered.length - 1] = yEnd;
    result[filtered.length - 2] = yEnd;

    for (let i = filtered.length - 3; i >= 0; i--) {
      result[i] = a0 * filtered[i] + a1 * filtered[i + 1] + a2 * filtered[i + 2]
        + b1 * result[i + 1] + b2 * result[i + 2];
    }

    // パディングを除去して返す
    return result.slice(padLen, padLen + n);
  }

  /**
   * 全フレームの逆動力学を計算
   * @param {Object} motionData - モーションデータ { frames: [{x, y, z}, ...], header: {...} }
   * @param {Object} forceData - 地面反力データ { plates: [{ forceData: [{fx, fy, fz}, ...], corners: [...] }] }
   * @param {Object} options - オプション
   *   - mode: '2D' | '3D' | 'auto' (デフォルト: 'auto')
   *   - side: 'right' | 'left'
   *   - filterCutoff: カットオフ周波数 [Hz]
   *   - positionScale: 位置単位スケール
   * @returns {Object} 計算結果
   */
  calculate(motionData, forceData, options = {}) {
    const frames = motionData.frames;
    const dt = motionData.header.frameInterval;
    const numFrames = frames.length;

    // モード選択: 'auto', '2D', '3D'
    const mode = options.mode || 'auto';
    const dimension = motionData.header?.dimension || 3;
    const use3D = mode === '3D' || (mode === 'auto' && dimension === 3);

    console.log('[InverseDynamics] 計算開始');
    console.log(`  - フレーム数: ${numFrames}`);
    console.log(`  - dt: ${dt}s (${(1 / dt).toFixed(1)} Hz)`);
    console.log(`  - 体重: ${this.bodyMass} kg`);
    console.log(`  - 性別: ${this.sex}`);
    console.log(`  - 計算モード: ${use3D ? '3D (完全Newton-Euler)' : '2D (矢状面)'}`);

    // 位置データのスケール（単位変換）を自動検出または指定
    // options.positionScale: 1.0 = データがすでにm単位、0.001 = データがmm単位
    this.positionScale = options.positionScale || this._detectPositionScale(frames);
    console.log(`  - 位置スケール: ${this.positionScale} (1.0=m, 0.001=mm→m変換)`);

    // オプション
    const filterCutoff = options.filterCutoff || 6.0;  // カットオフ周波数 [Hz]
    const side = options.side || 'right';              // 'right' or 'left'
    console.log(`  - 解析脚: ${side}`);
    console.log(`  - フィルタ: ${filterCutoff} Hz`);

    // フォースプレートデータの確認
    if (forceData && forceData.plates && forceData.plates.length > 0) {
      console.log(`  - フォースプレート: ${forceData.plates.length}枚`);
      const plate = forceData.plates[side === 'right' ? 0 : Math.min(1, forceData.plates.length - 1)];
      if (plate.forceData && plate.forceData.length > 0) {
        const mid = Math.floor(plate.forceData.length / 2);
        const f = plate.forceData[mid];
        console.log(`  - 力データ中央値(frame ${mid}): fx=${f.fx.toFixed(1)}, fy=${f.fy.toFixed(1)}, fz=${f.fz.toFixed(1)}`);
      }
    } else {
      console.log('  - フォースプレート: なし（力=0で計算）');
    }

    // ポイントマッピングの取得
    const mapping = side === 'right' ? {
      hip: this.pointMapping.rightHip,
      knee: this.pointMapping.rightKnee,
      ankle: this.pointMapping.rightAnkle,
      toe: this.pointMapping.rightToe,
      heel: this.pointMapping.rightHeel
    } : {
      hip: this.pointMapping.leftHip,
      knee: this.pointMapping.leftKnee,
      ankle: this.pointMapping.leftAnkle,
      toe: this.pointMapping.leftToe,
      heel: this.pointMapping.leftHeel
    };

    console.log(`  - ポイントマッピング:`, mapping);

    // 1. 位置データを抽出・補間・フィルタリング
    const positions = this._extractPositions(frames, mapping, motionData.pointLabels);
    const interpolatedPositions = this._interpolatePositions(positions);
    const filteredPositions = this._filterPositions(interpolatedPositions, filterCutoff, 1 / dt);

    // 1.5. 座標系を検出して矢状面を決定
    this._detectCoordinateSystem(frames, filteredPositions);
    console.log(`  - 矢状面: ${this.sagittalPlane}平面`);

    // 3. 地面反力を準備（足の位置に基づいて自動選択）
    const grf = this._prepareGRF(forceData, numFrames, side, filteredPositions);

    let kinematics, dynamics, power;
    let kinematics3D = null, dynamics3D = null, power3D = null;

    if (use3D) {
      // ===== 3D計算パス =====
      console.log('[InverseDynamics] 3D Newton-Euler法で計算中...');

      // 2. 3Dセグメントキネマティクスを計算
      kinematics3D = this._calculateKinematics3D(filteredPositions, dt, {
        filterCutoffAngle: filterCutoff,
        filterCutoffAccel: 10.0
      });

      // kinematics3Dは2D互換データも含むので、そのまま使用可能
      kinematics = kinematics3D;

      // 4. 3D逆動力学を計算
      dynamics3D = this._calculateDynamics3D(kinematics3D, grf, dt);

      // 5. 3D関節パワーを計算
      power3D = this._calculatePower3D(dynamics3D, kinematics3D);

      // 2D互換形式に変換（グラフ表示用）
      dynamics = this._extractSagittalMoments(dynamics3D);
      power = power3D;

    } else {
      // ===== 2D計算パス（従来の矢状面解析） =====
      console.log('[InverseDynamics] 2D矢状面解析で計算中...');

      // 2. セグメントキネマティクスを計算
      kinematics = this._calculateKinematics(filteredPositions, dt);

      // 4. 逆動力学を計算
      dynamics = this._calculateDynamics(kinematics, grf, dt);

      // 5. 関節パワーを計算
      power = this._calculatePower(dynamics, kinematics);
    }

    // 6. 中間計算（キネマティクス）の端点を補正（微分の不安定性を除去）
    const trimFrames = Math.min(15, Math.floor(numFrames * 0.02));
    this._trimEdgeEffects(kinematics.thigh.comAcceleration, trimFrames);
    this._trimEdgeEffects(kinematics.shank.comAcceleration, trimFrames);
    this._trimEdgeEffects(kinematics.foot.comAcceleration, trimFrames);
    this._trimEdgeEffects(kinematics.thigh.angularAcceleration, trimFrames);
    this._trimEdgeEffects(kinematics.shank.angularAcceleration, trimFrames);
    this._trimEdgeEffects(kinematics.foot.angularAcceleration, trimFrames);

    // 7. 最終結果の端点の異常値をクリップ
    this._trimEdgeEffects(dynamics, trimFrames);
    this._trimEdgeEffects(power, trimFrames);

    // 8. 外れ値をクリップ（物理的に妥当な範囲）
    this._clipExtremeValues(dynamics, power);

    // 結果を格納
    this.results = {
      time: Array.from({ length: numFrames }, (_, i) => i * dt),
      kinematics,
      dynamics,
      power,
      grf,
      side,
      dt,
      mode: use3D ? '3D' : '2D',
      // 3Dモードの場合、完全な3Dデータも保存
      kinematics3D,
      dynamics3D,
      power3D
    };

    // デバッグ出力
    const calcStats = (arr) => {
      const valid = arr.filter(v => isFinite(v));
      if (valid.length === 0) return { min: 0, max: 0 };
      return { min: Math.min(...valid), max: Math.max(...valid) };
    };
    console.log('[InverseDynamics] 計算完了');
    console.log(`  - 足関節トルク: ${calcStats(dynamics.ankle.moment).min.toFixed(1)} ~ ${calcStats(dynamics.ankle.moment).max.toFixed(1)} Nm`);
    console.log(`  - 膝関節トルク: ${calcStats(dynamics.knee.moment).min.toFixed(1)} ~ ${calcStats(dynamics.knee.moment).max.toFixed(1)} Nm`);
    console.log(`  - 股関節トルク: ${calcStats(dynamics.hip.moment).min.toFixed(1)} ~ ${calcStats(dynamics.hip.moment).max.toFixed(1)} Nm`);

    return this.results;
  }

  /**
   * 端点効果を軽減（端点の値を隣接値で置換）
   */
  _trimEdgeEffects(data, trimFrames) {
    const processArray = (arr) => {
      const n = arr.length;
      if (n < trimFrames * 2 + 10) return;

      // 先頭フレームを補正
      const startVal = arr[trimFrames];
      for (let i = 0; i < trimFrames; i++) {
        arr[i] = startVal;
      }

      // 末尾フレームを補正
      const endVal = arr[n - trimFrames - 1];
      for (let i = n - trimFrames; i < n; i++) {
        arr[i] = endVal;
      }
    };

    // 関節ごとに処理
    for (const joint of Object.values(data)) {
      if (Array.isArray(joint)) {
        processArray(joint);
      } else if (joint.moment) {
        processArray(joint.moment);
      }
    }
  }

  /**
   * 極端な外れ値をクリップ
   */
  _clipExtremeValues(dynamics, power) {
    // 関節トルクの妥当な範囲（Nm）
    const maxTorque = 500;  // 最大500Nm
    // 関節パワーの妥当な範囲（W）
    const maxPower = 2000;  // 最大2000W

    const clipArray = (arr, maxVal) => {
      for (let i = 0; i < arr.length; i++) {
        if (Math.abs(arr[i]) > maxVal) {
          arr[i] = Math.sign(arr[i]) * maxVal;
        }
        if (!isFinite(arr[i])) {
          arr[i] = 0;
        }
      }
    };

    // トルクをクリップ
    clipArray(dynamics.ankle.moment, maxTorque);
    clipArray(dynamics.knee.moment, maxTorque);
    clipArray(dynamics.hip.moment, maxTorque);

    // パワーをクリップ
    clipArray(power.ankle, maxPower);
    clipArray(power.knee, maxPower);
    clipArray(power.hip, maxPower);
  }

  /**
   * 位置データのスケールを自動検出
   * C3Dデータは通常mm単位だが、一部のソフトウェアはm単位で出力
   * 人体の典型的な寸法から単位を推定
   */
  _detectPositionScale(frames) {
    if (!frames || frames.length === 0) return 0.001; // デフォルト: mm→m

    // サンプルフレームで代表的なZ座標（高さ）を確認
    const sampleFrame = frames[Math.floor(frames.length / 2)];
    if (!sampleFrame || !Array.isArray(sampleFrame)) return 0.001;

    // 最大Z値を取得（立位の頭頂付近を想定）
    let maxZ = 0;
    for (const p of sampleFrame) {
      if (p && isFinite(p.z) && p.z > maxZ) {
        maxZ = p.z;
      }
    }

    // 人体の高さで判定:
    // - maxZ > 100 なら mm単位（典型的な身長1700mmくらい）
    // - maxZ < 10 なら m単位（典型的な身長1.7mくらい）
    if (maxZ > 100) {
      console.log(`[InverseDynamics] 位置単位自動検出: mm (maxZ=${maxZ.toFixed(1)})`);
      return 0.001; // mm → m
    } else if (maxZ > 0.5 && maxZ < 3.0) {
      console.log(`[InverseDynamics] 位置単位自動検出: m (maxZ=${maxZ.toFixed(3)})`);
      return 1.0; // すでにm
    } else {
      console.warn(`[InverseDynamics] 位置単位が不明 (maxZ=${maxZ}), mm単位と仮定`);
      return 0.001;
    }
  }

  /**
   * 位置データを抽出
   * @param {Array} frames - フレームデータ
   * @param {Object} mapping - ポイントマッピング（マーカー名またはインデックス）
   * @param {Array} pointLabels - ポイントラベル配列（C3Dの場合）
   */
  _extractPositions(frames, mapping, pointLabels) {
    const n = frames.length;

    // マーカー名からインデックスを解決
    const resolveIndex = (markerNameOrIndex) => {
      if (typeof markerNameOrIndex === 'number') {
        return markerNameOrIndex;
      }
      if (typeof markerNameOrIndex === 'string' && pointLabels) {
        // マーカー名でインデックスを検索
        const idx = pointLabels.findIndex(label =>
          label && label.toUpperCase() === markerNameOrIndex.toUpperCase()
        );
        if (idx >= 0) {
          return idx;
        }
        console.warn(`[InverseDynamics] マーカー "${markerNameOrIndex}" が見つかりません`);
      }
      return -1;
    };

    // インデックスを解決
    const indices = {
      hip: resolveIndex(mapping.hip),
      knee: resolveIndex(mapping.knee),
      ankle: resolveIndex(mapping.ankle),
      toe: resolveIndex(mapping.toe),
      heel: resolveIndex(mapping.heel)
    };

    console.log(`[InverseDynamics] 解決されたインデックス:`, indices);

    // ポイントが存在するか確認（自動検出された単位変換を適用）
    const scale = this.positionScale || 0.001;
    const validatePoint = (frame, idx) => {
      if (idx < 0 || !frame || !frame[idx]) {
        return { x: NaN, y: NaN, z: NaN };
      }
      const p = frame[idx];
      // 無効な値をチェック
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) {
        return { x: NaN, y: NaN, z: NaN };
      }
      // 単位変換（検出されたスケールを適用）
      return { x: p.x * scale, y: p.y * scale, z: p.z * scale };
    };

    return {
      hip: frames.map(f => validatePoint(f, indices.hip)),
      knee: frames.map(f => validatePoint(f, indices.knee)),
      ankle: frames.map(f => validatePoint(f, indices.ankle)),
      toe: frames.map(f => validatePoint(f, indices.toe)),
      heel: frames.map(f => validatePoint(f, indices.heel))
    };
  }

  /**
   * 1次元配列の欠損値（NaN）を3次スプライン補間する
   */
  _interpolate1D(data) {
    const n = data.length;
    const result = new Array(n);
    const validIndices = [];
    const validValues = [];

    for (let i = 0; i < n; i++) {
      if (isFinite(data[i])) {
        validIndices.push(i);
        validValues.push(data[i]);
      }
      result[i] = data[i];
    }

    if (validIndices.length < 2) {
      if (validIndices.length === 1) {
        return new Array(n).fill(validValues[0]);
      }
      return new Array(n).fill(0); // どうしようもない場合は0で埋める
    }

    const firstValid = validIndices[0];
    const lastValid = validIndices[validIndices.length - 1];

    if (firstValid > 0) {
      const val = validValues[0];
      for (let i = 0; i < firstValid; i++) result[i] = val;
    }
    if (lastValid < n - 1) {
      const val = validValues[validValues.length - 1];
      for (let i = lastValid + 1; i < n; i++) result[i] = val;
    }

    if (validIndices.length >= 3) {
      const coeffs = this._computeCubicSplineCoeffs(validIndices, validValues);
      for (let i = firstValid + 1; i < lastValid; i++) {
        if (!isFinite(data[i])) {
          const evalResult = this._evaluateSpline(coeffs, validIndices, [i]);
          result[i] = evalResult[0];
        }
      }
    } else {
      const x0 = validIndices[0], y0 = validValues[0];
      const x1 = validIndices[1], y1 = validValues[1];
      const slope = (y1 - y0) / (x1 - x0);
      for (let i = firstValid + 1; i < lastValid; i++) {
        if (!isFinite(data[i])) {
          result[i] = y0 + slope * (i - x0);
        }
      }
    }
    return result;
  }

  /**
   * 各関節の位置データ（x, y, z）の欠損を補間する
   */
  _interpolatePositions(positions) {
    const interpolated = {};
    for (const [key, data] of Object.entries(positions)) {
      interpolated[key] = {
        x: this._interpolate1D(data.map(p => p.x)),
        y: this._interpolate1D(data.map(p => p.y)),
        z: this._interpolate1D(data.map(p => p.z))
      };

      // オブジェクト形式に戻す
      interpolated[key] = interpolated[key].x.map((_, i) => ({
        x: interpolated[key].x[i],
        y: interpolated[key].y[i],
        z: interpolated[key].z[i]
      }));
    }
    return interpolated;
  }

  /**
   * 位置データにフィルタを適用
   */
  _filterPositions(positions, cutoffHz, samplingHz) {
    const filtered = {};

    for (const [key, data] of Object.entries(positions)) {
      filtered[key] = {
        x: this._butterworthFilter(data.map(p => p.x), cutoffHz, samplingHz),
        y: this._butterworthFilter(data.map(p => p.y), cutoffHz, samplingHz),
        z: this._butterworthFilter(data.map(p => p.z), cutoffHz, samplingHz)
      };

      // オブジェクト形式に戻す
      filtered[key] = filtered[key].x.map((_, i) => ({
        x: filtered[key].x[i],
        y: filtered[key].y[i],
        z: filtered[key].z[i]
      }));
    }

    return filtered;
  }

  /**
   * セグメントキネマティクスを計算
   */
  _calculateKinematics(positions, dt) {
    const n = positions.hip.length;
    const fs = 1.0 / dt;                // サンプリング周波数
    const fcAngle = 6.0;                // 角度用カットオフ周波数 [Hz]
    const fcAccel = 10.0;               // 加速度用カットオフ周波数 [Hz]

    // セグメント定義
    const segments = {
      thigh: { proximal: 'hip', distal: 'knee' },
      shank: { proximal: 'knee', distal: 'ankle' },
      foot: { proximal: 'heel', distal: 'toe' }
    };

    const kinematics = {};

    for (const [segName, seg] of Object.entries(segments)) {
      const proxPos = positions[seg.proximal];
      const distPos = positions[seg.distal];

      // セグメント長（平均値を使用）
      let avgLength = 0;
      for (let i = 0; i < n; i++) {
        avgLength += this._distance(proxPos[i], distPos[i]);
      }
      avgLength /= n;

      // セグメント重心位置
      const com = [];
      for (let i = 0; i < n; i++) {
        com.push(this._getSegmentCOM(proxPos[i], distPos[i], segName));
      }

      // セグメント角度（矢状面）
      let angle = [];
      for (let i = 0; i < n; i++) {
        angle.push(this._getSegmentAngle2D(proxPos[i], distPos[i]));
      }

      // 角度データを微分前にフィルタリング（スパイク抑制）
      angle = this._butterworthFilter(angle, fcAngle, fs);

      // 角速度・角加速度
      let angularVelocity = this._centralDifferenceVelocity(angle, dt);
      let angularAcceleration = this._centralDifferenceAcceleration(angle, dt);

      // 加速度にもフィルタリング適用（数値微分によるノイズ増幅を抑制）
      angularAcceleration = this._butterworthFilter(angularAcceleration, fcAccel, fs);

      // 重心加速度（矢状面: h=水平、v=垂直）
      let comAccelH, comAccelV;
      if (this.sagittalPlane === 'YZ') {
        comAccelH = this._centralDifferenceAcceleration(com.map(c => c.y), dt);
      } else {
        comAccelH = this._centralDifferenceAcceleration(com.map(c => c.x), dt);
      }
      comAccelV = this._centralDifferenceAcceleration(com.map(c => c.z), dt);

      // 重心加速度にもフィルタリング適用
      comAccelH = this._butterworthFilter(comAccelH, fcAccel, fs);
      comAccelV = this._butterworthFilter(comAccelV, fcAccel, fs);

      // セグメント質量・慣性モーメント
      const mass = this._getSegmentMass(segName);
      const inertia = this._getSegmentInertia(segName, avgLength);

      kinematics[segName] = {
        proximalPos: proxPos,
        distalPos: distPos,
        com,
        length: avgLength,
        angle,
        angularVelocity,
        angularAcceleration,
        comAcceleration: { h: comAccelH, v: comAccelV },  // 矢状面座標
        mass,
        inertia
      };
    }

    return kinematics;
  }

  /**
   * 3Dセグメントキネマティクスを計算
   * 各セグメントの回転行列、3D角速度、3D角加速度、慣性テンソルを計算
   *
   * @param {Object} positions - フィルタ済み位置データ
   * @param {number} dt - 時間間隔 [s]
   * @param {Object} options - オプション
   * @returns {Object} 3Dキネマティクスデータ
   */
  _calculateKinematics3D(positions, dt, options = {}) {
    const n = positions.hip.length;
    const fs = 1.0 / dt;
    const fcAngle = options.filterCutoffAngle || 6.0;
    const fcAccel = options.filterCutoffAccel || 10.0;

    // セグメント定義
    const segments = {
      thigh: { proximal: 'hip', distal: 'knee' },
      shank: { proximal: 'knee', distal: 'ankle' },
      foot: { proximal: 'heel', distal: 'toe' }
    };

    const kinematics3D = {};

    for (const [segName, seg] of Object.entries(segments)) {
      const proxPos = positions[seg.proximal];
      const distPos = positions[seg.distal];

      // セグメント長（平均値を使用）
      let avgLength = 0;
      for (let i = 0; i < n; i++) {
        avgLength += this._distance(proxPos[i], distPos[i]);
      }
      avgLength /= n;

      // セグメント重心位置（3D）
      const com = [];
      for (let i = 0; i < n; i++) {
        com.push(this._getSegmentCOM(proxPos[i], distPos[i], segName));
      }

      // 各フレームで回転行列を計算
      const rotationMatrices = [];
      for (let i = 0; i < n; i++) {
        // 参照点を決定（前方向を定義するため）
        // 足の場合はつま先方向、脚の場合は前方向のマーカーがあれば使用
        let referencePoint = null;
        // シンプルな実装: グローバルY軸を前方向とする
        const R = this._computeSegmentRotationMatrix(proxPos[i], distPos[i], referencePoint);
        rotationMatrices.push(R);
      }

      // 回転行列から3D角速度を計算
      let angularVelocity3D = this._computeAngularVelocity3D(rotationMatrices, dt);

      // 角速度にフィルタを適用（各成分）
      const omegaX = angularVelocity3D.map(w => w.x);
      const omegaY = angularVelocity3D.map(w => w.y);
      const omegaZ = angularVelocity3D.map(w => w.z);
      const filteredOmegaX = this._butterworthFilter(omegaX, fcAngle, fs);
      const filteredOmegaY = this._butterworthFilter(omegaY, fcAngle, fs);
      const filteredOmegaZ = this._butterworthFilter(omegaZ, fcAngle, fs);
      angularVelocity3D = filteredOmegaX.map((x, i) => ({
        x: x,
        y: filteredOmegaY[i],
        z: filteredOmegaZ[i]
      }));

      // 3D角加速度を計算
      let angularAcceleration3D = this._computeAngularAcceleration3D(angularVelocity3D, dt);

      // 角加速度にフィルタを適用
      const alphaX = angularAcceleration3D.map(a => a.x);
      const alphaY = angularAcceleration3D.map(a => a.y);
      const alphaZ = angularAcceleration3D.map(a => a.z);
      const filteredAlphaX = this._butterworthFilter(alphaX, fcAccel, fs);
      const filteredAlphaY = this._butterworthFilter(alphaY, fcAccel, fs);
      const filteredAlphaZ = this._butterworthFilter(alphaZ, fcAccel, fs);
      angularAcceleration3D = filteredAlphaX.map((x, i) => ({
        x: x,
        y: filteredAlphaY[i],
        z: filteredAlphaZ[i]
      }));

      // 3D重心加速度を計算
      const comX = com.map(c => c.x);
      const comY = com.map(c => c.y);
      const comZ = com.map(c => c.z);

      let comAccelX = this._centralDifferenceAcceleration(comX, dt);
      let comAccelY = this._centralDifferenceAcceleration(comY, dt);
      let comAccelZ = this._centralDifferenceAcceleration(comZ, dt);

      // フィルタ適用
      comAccelX = this._butterworthFilter(comAccelX, fcAccel, fs);
      comAccelY = this._butterworthFilter(comAccelY, fcAccel, fs);
      comAccelZ = this._butterworthFilter(comAccelZ, fcAccel, fs);

      const comAcceleration3D = comAccelX.map((x, i) => ({
        x: x,
        y: comAccelY[i],
        z: comAccelZ[i]
      }));

      // セグメント質量
      const mass = this._getSegmentMass(segName);

      // ローカル座標系での慣性テンソル（定数）
      const inertiaTensorLocal = this._getSegmentInertiaTensor3D(segName, avgLength);

      // 各フレームでグローバル座標系に変換した慣性テンソル
      const inertiaTensors = rotationMatrices.map(R =>
        this._transformInertiaTensor(inertiaTensorLocal, R)
      );

      // 2D互換用のスカラー慣性モーメント（矢状面軸周り）
      const inertia = this._getSegmentInertia(segName, avgLength);

      // 2D互換用の角度（矢状面）
      let angle = [];
      for (let i = 0; i < n; i++) {
        angle.push(this._getSegmentAngle2D(proxPos[i], distPos[i]));
      }
      angle = this._butterworthFilter(angle, fcAngle, fs);

      // 2D互換用の角速度・角加速度
      let angularVelocity = this._centralDifferenceVelocity(angle, dt);
      let angularAcceleration = this._centralDifferenceAcceleration(angle, dt);
      angularAcceleration = this._butterworthFilter(angularAcceleration, fcAccel, fs);

      // 2D互換用の矢状面重心加速度
      let comAccelH, comAccelV;
      if (this.sagittalPlane === 'YZ') {
        comAccelH = comAccelY;
      } else {
        comAccelH = comAccelX;
      }
      comAccelV = comAccelZ;

      kinematics3D[segName] = {
        // 位置データ
        proximalPos: proxPos,
        distalPos: distPos,
        com,
        length: avgLength,
        mass,

        // 3Dデータ
        rotationMatrices,
        angularVelocity3D,
        angularAcceleration3D,
        comAcceleration3D,
        inertiaTensorLocal,
        inertiaTensors,

        // 2D互換データ
        angle,
        angularVelocity,
        angularAcceleration,
        comAcceleration: { h: comAccelH, v: comAccelV },
        inertia
      };
    }

    return kinematics3D;
  }

  /**
   * 地面反力データを準備
   */
  _prepareGRF(forceData, numFrames, side, positions) {
    // 戻り値の初期化
    const grf = {
      fx: new Array(numFrames).fill(0),
      fy: new Array(numFrames).fill(0),
      fz: new Array(numFrames).fill(0),
      copX: new Array(numFrames).fill(0),
      copY: new Array(numFrames).fill(0),  // Z-up座標系用
      copZ: new Array(numFrames).fill(0),
      mFree: new Array(numFrames).fill(0)
    };

    if (!forceData || !forceData.plates || forceData.plates.length === 0) {
      console.warn('[InvDyn] forceData is empty or has no plates!');
      return grf;
    }

    // 各プレートの最大Fzを確認
    console.log('[InvDyn] _prepareGRF: フォースプレートデータの検証');
    forceData.plates.forEach((plate, idx) => {
      let maxFz = 0, maxFzFrame = 0;
      const dataLen = plate.forceData?.length || 0;
      for (let i = 0; i < dataLen; i++) {
        const fz = Math.abs(plate.forceData[i]?.fz || 0);
        if (fz > maxFz) {
          maxFz = fz;
          maxFzFrame = i;
        }
      }
      console.log(`[InvDyn] Plate ${idx}: forceData.length=${dataLen}, 最大Fz=${maxFz.toFixed(1)}N at frame ${maxFzFrame}`);
    });

    // デバッグ: プレートのコーナー座標を出力
    forceData.plates.forEach((plate, idx) => {
      if (plate.corners && plate.corners.length >= 4) {
        const cx = plate.corners.map(c => (c[0] / 1000).toFixed(3));
        const cz = plate.corners.map(c => (c[2] / 1000).toFixed(3));
        console.log(`[InvDyn] Plate ${idx} corners: X=[${cx.join(', ')}], Z=[${cz.join(', ')}]`);
      }
    });

    // 各フレームで最適なプレートを選択
    for (let i = 0; i < numFrames; i++) {
      // 足の位置（Heel と Toe の中間点を使用）
      const footPos = {
        x: (positions.heel[i].x + positions.toe[i].x) / 2,
        y: (positions.heel[i].y + positions.toe[i].y) / 2, // 水平面 Y（C3Dの標準的な床面）
        z: (positions.heel[i].z + positions.toe[i].z) / 2
      };

      // デバッグ: 最初のフレームで足位置を出力
      if (i === 0) {
        console.log(`[InvDyn] Frame 0 footPos: x=${footPos.x.toFixed(3)}, y=${footPos.y.toFixed(3)}, z=${footPos.z.toFixed(3)}`);
      }

      // 足が載っているプレートを探す
      let activePlate = null;
      for (const plate of forceData.plates) {
        if (this._isPointInPlate(footPos, plate.corners)) {
          activePlate = plate;
          break;
        }
      }

      // もし見つからなければ、サイドに基づいてデフォルトを選択（予備判定）
      if (!activePlate) {
        const defaultIdx = side === 'right' ? 0 : Math.min(1, forceData.plates.length - 1);
        const p = forceData.plates[defaultIdx];
        // デフォルトプレートの近くにあれば採用（バッファを大きく）
        if (this._isPointNearPlate(footPos, p.corners, 0.2)) { // 20cmのバッファ
          activePlate = p;
        }
      }

      // フォールバック: 幾何学的判定が失敗した場合、最大の力を持つプレートを使用
      if (!activePlate) {
        let maxForce = 0;
        for (const plate of forceData.plates) {
          if (plate.forceData && plate.forceData[i]) {
            const fz = Math.abs(plate.forceData[i].fz || 0);
            if (fz > maxForce && fz > 20.0) { // 20N以上の力がある場合のみ
              maxForce = fz;
              activePlate = plate;
            }
          }
        }
        if (i === 0 && activePlate) {
          console.log(`[InvDyn] Frame 0: 幾何学的判定失敗、力ベースでプレート選択 (Fz=${maxForce.toFixed(1)}N)`);
        }
      }

      if (activePlate && activePlate.forceData[i]) {
        const f = activePlate.forceData[i];

        // 垂直抗力がしきい値(20N)以上の場合のみ力を採用
        if (Math.abs(f.fz) > 20.0) {
          // デバッグ: 使用プレートを確認
          if (i === 0 || i === 150) {
            const plateIdx = forceData.plates.indexOf(activePlate);
            console.log(`[InvDyn] Frame ${i}: Plate ${plateIdx} を使用, fz=${f.fz.toFixed(1)}N`);
          }

          grf.fx[i] = f.fx;
          grf.fy[i] = f.fy;
          // 表示用に負の値で保存されているFzを、計算用に正の値（上向きGRF）に変換
          grf.fz[i] = -f.fz;

          // COPの計算（Type 2フォースプレート）
          const origin = activePlate.origin || [0, 0, 0];

          // プレート座標系を判定（Y範囲 vs Z範囲）
          let yRange = 0, zRange = 0;
          let plateCenterX = 0, plateCenterY = 0, plateCenterZ = 0;
          if (activePlate.corners) {
            let minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
            activePlate.corners.forEach(c => {
              plateCenterX += c[0] / 4000;
              plateCenterY += c[1] / 4000;
              plateCenterZ += c[2] / 4000;
              if (c[1] / 1000 < minY) minY = c[1] / 1000;
              if (c[1] / 1000 > maxY) maxY = c[1] / 1000;
              if (c[2] / 1000 < minZ) minZ = c[2] / 1000;
              if (c[2] / 1000 > maxZ) maxZ = c[2] / 1000;
            });
            yRange = maxY - minY;
            zRange = maxZ - minZ;
          }
          const useXYPlane = yRange > zRange; // Z-up座標系（床がXY平面）

          // デバッグ: 最初のフレームで座標系を出力
          if (i === 0) {
            console.log(`[InvDyn] Frame 0 モーメントデータ確認: mx=${f.mx}, my=${f.my}, mz=${f.mz}`);
            console.log(`  座標系: ${useXYPlane ? 'Z-up (XY床面)' : 'Y-up (XZ床面)'}`);
            console.log(`  プレート中心: X=${plateCenterX.toFixed(4)}, Y=${plateCenterY.toFixed(4)}, Z=${plateCenterZ.toFixed(4)}`);
          }

          // モーメントデータが存在するかチェック
          const hasMomentData = f.mx !== undefined && f.my !== undefined;
          if (hasMomentData) {
            // Type 2 COP式: 生データ(f.fz)を使用（モーメントと力は同じ符号規約）
            // COPの第1成分（前後方向）: -My/Fz
            const copXFromMoment = -f.my / f.fz;
            // COPの第2成分（左右方向）: Mx/Fz
            const copYFromMoment = f.mx / f.fz;

            grf.copX[i] = (copXFromMoment + origin[0]) / 1000 + plateCenterX;
            if (useXYPlane) {
              // Z-up座標系: COPはXY平面上、copZには高さ（床面=0）を使用
              grf.copY[i] = (copYFromMoment + origin[1]) / 1000 + plateCenterY;
              grf.copZ[i] = 0; // 床面
            } else {
              // Y-up座標系: COPはXZ平面上
              grf.copZ[i] = (copYFromMoment + origin[2]) / 1000 + plateCenterZ;
            }

            if (i === 0 || i === Math.floor(numFrames / 2)) {
              console.log(`[InvDyn] Frame ${i} COP計算: mx=${f.mx.toFixed(1)}, my=${f.my.toFixed(1)}, 生Fz=${f.fz.toFixed(1)}`);
              console.log(`  -> copXFromMoment=${copXFromMoment.toFixed(2)}mm, copYFromMoment=${copYFromMoment.toFixed(2)}mm`);
              console.log(`  -> COPx=${grf.copX[i].toFixed(4)}m, COP2=${useXYPlane ? grf.copY[i].toFixed(4) : grf.copZ[i].toFixed(4)}m`);
            }
          } else {
            grf.copX[i] = plateCenterX;
            grf.copZ[i] = useXYPlane ? 0 : plateCenterZ;
            if (useXYPlane) {
              grf.copY[i] = plateCenterY;
            }
            if (i === 0) {
              console.log(`[InvDyn] Frame ${i}: モーメントデータなし、プレート中心をCOPとして使用`);
            }
          }
        }
      }
    }

    // フィルタリング前のGRF統計
    const preFilterMaxFz = Math.max(...grf.fz.map(v => Math.abs(v)));
    console.log(`[InvDyn] フィルタ前 GRF最大Fz: ${preFilterMaxFz.toFixed(1)}N`);

    // 接地フレームを記録（フィルタ適用前）
    const contactThreshold = 20.0; // N
    const wasInContact = grf.fz.map(v => Math.abs(v) > contactThreshold);

    // フィルタリング: GRFデータに対してローパスフィルタを適用
    // 接地/離地の遷移を保持するため、高めのカットオフ周波数を使用
    const fs = 1.0 / (this.results?.dt || 0.004);
    const fc = 50.0; // 50Hz（10Hzから変更）
    grf.fx = this._butterworthFilter(grf.fx, fc, fs);
    grf.fy = this._butterworthFilter(grf.fy, fc, fs);
    grf.fz = this._butterworthFilter(grf.fz, fc, fs);
    grf.copX = this._butterworthFilter(grf.copX, fc, fs);
    grf.copY = this._butterworthFilter(grf.copY, fc, fs);  // Z-up座標系用
    grf.copZ = this._butterworthFilter(grf.copZ, fc, fs);

    // 非接地フレームではGRFを0に戻す（フィルタによるスムージングを修正）
    for (let i = 0; i < grf.fz.length; i++) {
      if (!wasInContact[i]) {
        grf.fx[i] = 0;
        grf.fy[i] = 0;
        grf.fz[i] = 0;
      }
    }

    // フィルタリング後のGRF統計
    const postFilterMaxFz = Math.max(...grf.fz.map(v => Math.abs(v)));
    console.log(`[InvDyn] フィルタ後 GRF最大Fz: ${postFilterMaxFz.toFixed(1)}N`);

    // Fzが最大のフレームを特定
    let maxFzFrame = 0;
    for (let i = 0; i < grf.fz.length; i++) {
      if (Math.abs(grf.fz[i]) > Math.abs(grf.fz[maxFzFrame])) {
        maxFzFrame = i;
      }
    }
    console.log(`[InvDyn] 最大Fzフレーム: ${maxFzFrame} (${(maxFzFrame * 0.004167).toFixed(2)}s), Fz=${grf.fz[maxFzFrame]?.toFixed(1)}N`);

    return grf;
  }

  /**
   * ポイントがプレートの範囲内にあるか判定
   * C3Dファイルの座標系に応じてXY平面またはXZ平面で判定
   */
  _isPointInPlate(p, corners) {
    if (!corners || corners.length < 4) return false;

    // コーナー座標を取得 (mm -> m)
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    corners.forEach(c => {
      const cx = c[0] / 1000;
      const cy = c[1] / 1000;
      const cz = c[2] / 1000;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;
    });

    // Y範囲とZ範囲のどちらが大きいかで判定平面を決定
    const yRange = maxY - minY;
    const zRange = maxZ - minZ;

    if (yRange > zRange) {
      // XY平面で判定（Z-up座標系、床がXY平面）
      return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
    } else {
      // XZ平面で判定（Y-up座標系、床がXZ平面）
      return p.x >= minX && p.x <= maxX && p.z >= minZ && p.z <= maxZ;
    }
  }

  /**
   * ポイントがプレートの近くにあるか判定
   */
  _isPointNearPlate(p, corners, buffer) {
    if (!corners || corners.length < 4) return false;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    corners.forEach(c => {
      const cx = c[0] / 1000;
      const cy = c[1] / 1000;
      const cz = c[2] / 1000;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;
    });

    const yRange = maxY - minY;
    const zRange = maxZ - minZ;

    if (yRange > zRange) {
      return p.x >= minX - buffer && p.x <= maxX + buffer &&
        p.y >= minY - buffer && p.y <= maxY + buffer;
    } else {
      return p.x >= minX - buffer && p.x <= maxX + buffer &&
        p.z >= minZ - buffer && p.z <= maxZ + buffer;
    }
  }

  /**
   * 逆動力学を計算（遠位から近位へ）
   * Winter式7.9に基づく：近位モーメントは遠位モーメントを含む
   * 矢状面座標系（h=水平方向, v=垂直方向）を使用
   */
  _calculateDynamics(kinematics, grf, dt) {
    const n = kinematics.foot.com.length;
    const g = this.gravity;

    // デバッグ用：最大GRFフレームを特定
    let maxGRFFrame = 0;
    let maxGRF = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(grf.fz[i]) > maxGRF) {
        maxGRF = Math.abs(grf.fz[i]);
        maxGRFFrame = i;
      }
    }

    // 結果配列の初期化（h=矢状面水平、v=矢状面垂直）
    const ankle = {
      forceH: new Array(n).fill(0),
      forceV: new Array(n).fill(0),
      moment: new Array(n).fill(0)
    };

    const knee = {
      forceH: new Array(n).fill(0),
      forceV: new Array(n).fill(0),
      moment: new Array(n).fill(0)
    };

    const hip = {
      forceH: new Array(n).fill(0),
      forceV: new Array(n).fill(0),
      moment: new Array(n).fill(0)
    };

    console.log(`[InvDyn] 矢状面: ${this.sagittalPlane}平面で計算`);

    // 各フレームで計算
    for (let i = 0; i < n; i++) {
      // ===== 足部 =====
      const foot = kinematics.foot;
      const footMass = foot.mass;
      const footInertia = foot.inertia;
      const footCOM = foot.com[i];
      const footAccelH = foot.comAcceleration.h[i];
      const footAccelV = foot.comAcceleration.v[i];
      const footAlpha = foot.angularAcceleration[i];

      // 足関節位置（矢状面座標）
      const anklePos = kinematics.shank.distalPos[i];
      const ankleSag = this._getSagittalCoords(anklePos);
      const footCOMSag = this._getSagittalCoords(footCOM);

      // 地面反力（矢状面成分）
      const grfSag = this._getSagittalForce(grf.fx[i], grf.fy ? grf.fy[i] : 0, grf.fz[i]);

      // COP（矢状面座標）
      let copSag;
      if (this.sagittalPlane === 'YZ' && grf.copY) {
        copSag = { h: grf.copY[i], v: grf.copZ[i] };
      } else {
        copSag = { h: grf.copX[i], v: grf.copZ[i] };
      }

      // 足関節力（Newton方程式）
      // F_ankle = m * a - GRF
      ankle.forceH[i] = footMass * footAccelH - grfSag.h;
      ankle.forceV[i] = footMass * (footAccelV + g) - grfSag.v;

      // 足関節モーメント（Euler方程式）
      // M_ankle = I * alpha - (r_ankle × F_ankle) + (r_COP × GRF)
      const rAnkleFoot = {
        h: ankleSag.h - footCOMSag.h,
        v: ankleSag.v - footCOMSag.v
      };
      const rCOP = {
        h: copSag.h - footCOMSag.h,
        v: copSag.v - footCOMSag.v
      };
      const fAnkle = { h: ankle.forceH[i], v: ankle.forceV[i] };

      // 足関節モーメント（Euler方程式）
      const term1 = footInertia * footAlpha;
      const term2 = -this._cross2D(rAnkleFoot, fAnkle);
      const term3 = this._cross2D(rCOP, grfSag);
      ankle.moment[i] = term1 + term2 + term3;

      // デバッグ: 最大GRFフレーム付近で詳細出力
      if (i === maxGRFFrame) {
        console.log(`[InvDyn Debug] ========== 足部キネマティクス (frame ${i}) ==========`);
        console.log(`  矢状面: ${this.sagittalPlane}平面`);
        console.log(`  足部質量: ${footMass.toFixed(4)} kg`);
        console.log(`  足部慣性モーメント: ${footInertia.toFixed(6)} kg*m^2`);
        console.log(`  足部角度: ${foot.angle[i].toFixed(4)} rad (${(foot.angle[i] * 180 / Math.PI).toFixed(1)}°)`);
        console.log(`  足部角速度: ${foot.angularVelocity[i].toFixed(4)} rad/s (${(foot.angularVelocity[i] * 180 / Math.PI).toFixed(1)}°/s)`);
        console.log(`  足部角加速度 (α): ${footAlpha.toFixed(2)} rad/s^2 (${(footAlpha * 180 / Math.PI).toFixed(1)}°/s^2)`);
        console.log(`  足部重心加速度: h=${footAccelH.toFixed(2)} m/s^2, v=${footAccelV.toFixed(2)} m/s^2`);
        console.log(`[InvDyn Debug] 足関節モーメント計算:`);
        console.log(`  footCOM(矢状面): h=${footCOMSag.h.toFixed(4)}, v=${footCOMSag.v.toFixed(4)}`);
        console.log(`  anklePos(矢状面): h=${ankleSag.h.toFixed(4)}, v=${ankleSag.v.toFixed(4)}`);
        console.log(`  COP(矢状面): h=${copSag.h.toFixed(4)}, v=${copSag.v.toFixed(4)}`);
        console.log(`  GRF(矢状面): h=${grfSag.h.toFixed(1)}N, v=${grfSag.v.toFixed(1)}N`);
        console.log(`  rAnkleFoot: h=${rAnkleFoot.h.toFixed(4)}, v=${rAnkleFoot.v.toFixed(4)}`);
        console.log(`  rCOP: h=${rCOP.h.toFixed(4)}, v=${rCOP.v.toFixed(4)}`);
        console.log(`  F_ankle: h=${fAnkle.h.toFixed(1)}N, v=${fAnkle.v.toFixed(1)}N`);
        console.log(`  項1 (I*α): ${term1.toFixed(4)} Nm`);
        console.log(`  項2 (-r_ankle×F_ankle): ${term2.toFixed(2)} Nm`);
        console.log(`  項3 (r_COP×GRF): ${term3.toFixed(2)} Nm`);
        console.log(`  合計 (足関節モーメント): ${ankle.moment[i].toFixed(2)} Nm`);
      }

      // ===== 下腿 =====
      const shank = kinematics.shank;
      const shankMass = shank.mass;
      const shankInertia = shank.inertia;
      const shankCOM = shank.com[i];
      const shankAccelH = shank.comAcceleration.h[i];
      const shankAccelV = shank.comAcceleration.v[i];
      const shankAlpha = shank.angularAcceleration[i];

      // 膝関節位置（矢状面座標）
      const kneePos = kinematics.thigh.distalPos[i];
      const kneeSag = this._getSagittalCoords(kneePos);
      const shankCOMSag = this._getSagittalCoords(shankCOM);

      // 膝関節力（作用・反作用の法則より、遠位端には-F_ankleが作用）
      knee.forceH[i] = shankMass * shankAccelH + ankle.forceH[i];
      knee.forceV[i] = shankMass * (shankAccelV + g) + ankle.forceV[i];

      // 膝関節モーメント
      const rKneeShank = {
        h: kneeSag.h - shankCOMSag.h,
        v: kneeSag.v - shankCOMSag.v
      };
      const rAnkleShank = {
        h: ankleSag.h - shankCOMSag.h,
        v: ankleSag.v - shankCOMSag.v
      };
      const fKnee = { h: knee.forceH[i], v: knee.forceV[i] };
      const fAnkleReaction = { h: -ankle.forceH[i], v: -ankle.forceV[i] };

      // 膝関節モーメント（Winter式7.9: 遠位モーメントを含む）
      // M_knee = I*α - r_knee×F_knee + r_ankle×F_ankle_reaction + M_ankle
      const kneeTerm1 = shankInertia * shankAlpha;
      const kneeTerm2 = -this._cross2D(rKneeShank, fKnee);
      const kneeTerm3 = this._cross2D(rAnkleShank, fAnkleReaction);
      const kneeTerm4 = ankle.moment[i];
      knee.moment[i] = kneeTerm1 + kneeTerm2 + kneeTerm3 + kneeTerm4;

      // デバッグ: 下腿キネマティクスと膝モーメント内訳
      if (i === maxGRFFrame) {
        console.log(`[InvDyn Debug] ========== 下腿キネマティクス (frame ${i}) ==========`);
        console.log(`  下腿質量: ${shankMass.toFixed(4)} kg`);
        console.log(`  下腿長: ${shank.length.toFixed(4)} m`);
        console.log(`  下腿慣性モーメント: ${shankInertia.toFixed(6)} kg*m^2`);
        console.log(`  下腿角度: ${shank.angle[i].toFixed(4)} rad (${(shank.angle[i] * 180 / Math.PI).toFixed(1)}°)`);
        console.log(`  下腿角速度: ${shank.angularVelocity[i].toFixed(4)} rad/s (${(shank.angularVelocity[i] * 180 / Math.PI).toFixed(1)}°/s)`);
        console.log(`  下腿角加速度 (α): ${shankAlpha.toFixed(2)} rad/s^2 (${(shankAlpha * 180 / Math.PI).toFixed(1)}°/s^2)`);
        console.log(`  下腿重心加速度: h=${shankAccelH.toFixed(2)} m/s^2, v=${shankAccelV.toFixed(2)} m/s^2`);
        console.log(`[InvDyn Debug] 膝関節モーメント計算:`);
        console.log(`  shankCOM(矢状面): h=${shankCOMSag.h.toFixed(4)}, v=${shankCOMSag.v.toFixed(4)}`);
        console.log(`  kneePos(矢状面): h=${kneeSag.h.toFixed(4)}, v=${kneeSag.v.toFixed(4)}`);
        console.log(`  rKneeShank: h=${rKneeShank.h.toFixed(4)}, v=${rKneeShank.v.toFixed(4)}`);
        console.log(`  rAnkleShank: h=${rAnkleShank.h.toFixed(4)}, v=${rAnkleShank.v.toFixed(4)}`);
        console.log(`  F_knee: h=${fKnee.h.toFixed(1)}N, v=${fKnee.v.toFixed(1)}N`);
        console.log(`  F_ankle_reaction: h=${fAnkleReaction.h.toFixed(1)}N, v=${fAnkleReaction.v.toFixed(1)}N`);
        console.log(`  項1 (I*α): ${kneeTerm1.toFixed(4)} Nm (下腿の回転慣性)`);
        console.log(`  項2 (-r_knee×F_knee): ${kneeTerm2.toFixed(2)} Nm`);
        console.log(`  項3 (r_ankle×F_ankle_reaction): ${kneeTerm3.toFixed(2)} Nm`);
        console.log(`  項4 (M_ankle): ${kneeTerm4.toFixed(2)} Nm (足関節から伝達)`);
        console.log(`  合計 (膝関節モーメント): ${knee.moment[i].toFixed(2)} Nm`);
        console.log(`  下腿の純寄与 (項1+項2+項3): ${(kneeTerm1 + kneeTerm2 + kneeTerm3).toFixed(2)} Nm`);
      }

      // ===== 大腿 =====
      const thigh = kinematics.thigh;
      const thighMass = thigh.mass;
      const thighInertia = thigh.inertia;
      const thighCOM = thigh.com[i];
      const thighAccelH = thigh.comAcceleration.h[i];
      const thighAccelV = thigh.comAcceleration.v[i];
      const thighAlpha = thigh.angularAcceleration[i];

      // 股関節位置（矢状面座標）
      const hipPos = thigh.proximalPos[i];
      const hipSag = this._getSagittalCoords(hipPos);
      const thighCOMSag = this._getSagittalCoords(thighCOM);

      // 股関節力
      hip.forceH[i] = thighMass * thighAccelH + knee.forceH[i];
      hip.forceV[i] = thighMass * (thighAccelV + g) + knee.forceV[i];

      // 股関節モーメント
      const rHipThigh = {
        h: hipSag.h - thighCOMSag.h,
        v: hipSag.v - thighCOMSag.v
      };
      const rKneeThigh = {
        h: kneeSag.h - thighCOMSag.h,
        v: kneeSag.v - thighCOMSag.v
      };
      const fHip = { h: hip.forceH[i], v: hip.forceV[i] };
      const fKneeReaction = { h: -knee.forceH[i], v: -knee.forceV[i] };

      // 股関節モーメント（Winter式7.9: 遠位モーメントを含む）
      // M_hip = I*α - r_hip×F_hip + r_knee×F_knee_reaction + M_knee
      const hipTerm1 = thighInertia * thighAlpha;
      const hipTerm2 = -this._cross2D(rHipThigh, fHip);
      const hipTerm3 = this._cross2D(rKneeThigh, fKneeReaction);
      const hipTerm4 = knee.moment[i];
      hip.moment[i] = hipTerm1 + hipTerm2 + hipTerm3 + hipTerm4;

      // デバッグ: 大腿キネマティクスと股関節モーメント内訳
      if (i === maxGRFFrame) {
        console.log(`[InvDyn Debug] ========== 大腿キネマティクス (frame ${i}) ==========`);
        console.log(`  大腿質量: ${thighMass.toFixed(4)} kg`);
        console.log(`  大腿長: ${thigh.length.toFixed(4)} m`);
        console.log(`  大腿慣性モーメント: ${thighInertia.toFixed(6)} kg*m^2`);
        console.log(`  大腿角度: ${thigh.angle[i].toFixed(4)} rad (${(thigh.angle[i] * 180 / Math.PI).toFixed(1)}°)`);
        console.log(`  大腿角速度: ${thigh.angularVelocity[i].toFixed(4)} rad/s (${(thigh.angularVelocity[i] * 180 / Math.PI).toFixed(1)}°/s)`);
        console.log(`  大腿角加速度 (α): ${thighAlpha.toFixed(2)} rad/s^2 (${(thighAlpha * 180 / Math.PI).toFixed(1)}°/s^2)`);
        console.log(`  大腿重心加速度: h=${thighAccelH.toFixed(2)} m/s^2, v=${thighAccelV.toFixed(2)} m/s^2`);
        console.log(`[InvDyn Debug] 股関節モーメント計算:`);
        console.log(`  thighCOM(矢状面): h=${thighCOMSag.h.toFixed(4)}, v=${thighCOMSag.v.toFixed(4)}`);
        console.log(`  hipPos(矢状面): h=${hipSag.h.toFixed(4)}, v=${hipSag.v.toFixed(4)}`);
        console.log(`  rHipThigh: h=${rHipThigh.h.toFixed(4)}, v=${rHipThigh.v.toFixed(4)}`);
        console.log(`  rKneeThigh: h=${rKneeThigh.h.toFixed(4)}, v=${rKneeThigh.v.toFixed(4)}`);
        console.log(`  F_hip: h=${fHip.h.toFixed(1)}N, v=${fHip.v.toFixed(1)}N`);
        console.log(`  F_knee_reaction: h=${fKneeReaction.h.toFixed(1)}N, v=${fKneeReaction.v.toFixed(1)}N`);
        console.log(`  項1 (I*α): ${hipTerm1.toFixed(4)} Nm (大腿の回転慣性)`);
        console.log(`  項2 (-r_hip×F_hip): ${hipTerm2.toFixed(2)} Nm`);
        console.log(`  項3 (r_knee×F_knee_reaction): ${hipTerm3.toFixed(2)} Nm`);
        console.log(`  項4 (M_knee): ${hipTerm4.toFixed(2)} Nm (膝関節から伝達)`);
        console.log(`  合計 (股関節モーメント): ${hip.moment[i].toFixed(2)} Nm`);
        console.log(`  大腿の純寄与 (項1+項2+項3): ${(hipTerm1 + hipTerm2 + hipTerm3).toFixed(2)} Nm`);
        console.log(`[InvDyn Debug] ========== 各セグメント純寄与まとめ ==========`);
        console.log(`  足部寄与 (GRF×COP + 足部慣性): ${ankle.moment[i].toFixed(2)} Nm`);
        console.log(`  下腿純寄与: ${(kneeTerm1 + kneeTerm2 + kneeTerm3).toFixed(2)} Nm`);
        console.log(`  大腿純寄与: ${(hipTerm1 + hipTerm2 + hipTerm3).toFixed(2)} Nm`);
      }
    }

    // デバッグ出力：最大GRFフレームでの各項の寄与を表示
    const f = maxGRFFrame;
    console.log(`[InvDyn] 最大GRFフレーム(${f})での計算内訳:`);
    console.log(`  GRF: Fx=${grf.fx[f]?.toFixed(1)}N, Fz=${grf.fz[f]?.toFixed(1)}N`);
    console.log(`  足関節モーメント: ${ankle.moment[f]?.toFixed(2)} Nm (${(ankle.moment[f] / this.bodyMass)?.toFixed(3)} Nm/kg)`);
    console.log(`  膝関節モーメント: ${knee.moment[f]?.toFixed(2)} Nm (${(knee.moment[f] / this.bodyMass)?.toFixed(3)} Nm/kg)`);
    console.log(`  股関節モーメント: ${hip.moment[f]?.toFixed(2)} Nm (${(hip.moment[f] / this.bodyMass)?.toFixed(3)} Nm/kg)`);

    return { ankle, knee, hip };
  }

  /**
   * 3D逆動力学を計算（完全な3D Newton-Euler法）
   *
   * 遠位から近位への再帰計算:
   * - Newton方程式: F = m × a
   * - Euler方程式: τ = I × α + ω × (I × ω)
   *
   * @param {Object} kinematics3D - 3Dキネマティクスデータ
   * @param {Object} grf - 地面反力データ
   * @param {number} dt - 時間間隔 [s]
   * @returns {Object} 3D関節力・モーメントデータ
   */
  _calculateDynamics3D(kinematics3D, grf, dt) {
    const n = kinematics3D.foot.com.length;
    const g = this.gravity;

    // 重力ベクトル（グローバル座標系、Z軸が上向き）
    const gravityVec = { x: 0, y: 0, z: -g };

    // 結果配列の初期化（3D力とモーメント）
    const ankle = {
      force: new Array(n).fill(null).map(() => ({ x: 0, y: 0, z: 0 })),
      moment: new Array(n).fill(null).map(() => ({ x: 0, y: 0, z: 0 }))
    };

    const knee = {
      force: new Array(n).fill(null).map(() => ({ x: 0, y: 0, z: 0 })),
      moment: new Array(n).fill(null).map(() => ({ x: 0, y: 0, z: 0 }))
    };

    const hip = {
      force: new Array(n).fill(null).map(() => ({ x: 0, y: 0, z: 0 })),
      moment: new Array(n).fill(null).map(() => ({ x: 0, y: 0, z: 0 }))
    };

    // 最大GRFフレームを特定（デバッグ用）
    let maxGRFFrame = 0;
    let maxGRF = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(grf.fz[i]) > maxGRF) {
        maxGRF = Math.abs(grf.fz[i]);
        maxGRFFrame = i;
      }
    }

    // 各フレームで計算
    for (let i = 0; i < n; i++) {
      // GRFベクトル（3D）
      const grfVec = {
        x: grf.fx[i],
        y: grf.fy ? grf.fy[i] : 0,
        z: grf.fz[i]
      };

      // COPベクトル（3D）
      const copVec = {
        x: grf.copX[i],
        y: grf.copY ? grf.copY[i] : 0,
        z: grf.copZ[i]
      };

      // ===== 足部 =====
      const foot = kinematics3D.foot;
      const footMass = foot.mass;
      const footCOM = foot.com[i];
      const footAccel = foot.comAcceleration3D[i];
      const footOmega = foot.angularVelocity3D[i];
      const footAlpha = foot.angularAcceleration3D[i];
      const footI = foot.inertiaTensors[i];

      // 足関節位置
      const anklePos = kinematics3D.shank.distalPos[i];

      // Newton方程式: F_ankle = m × (a - g) - GRF
      const maFoot = this._scale3D(footAccel, footMass);
      const mgFoot = this._scale3D(gravityVec, -footMass); // m × (-g)
      const fAnkle = this._add3D(this._add3D(maFoot, mgFoot), this._scale3D(grfVec, -1));
      ankle.force[i] = fAnkle;

      // Euler方程式: M_ankle = I×α + ω×(I×ω) - r_ankle×F_ankle + r_cop×GRF
      const inertialTorqueFoot = this._computeInertialTorque3D(footI, footOmega, footAlpha);

      // r_ankle = anklePos - footCOM
      const rAnkle = {
        x: anklePos.x - footCOM.x,
        y: anklePos.y - footCOM.y,
        z: anklePos.z - footCOM.z
      };

      // r_cop = copVec - footCOM
      const rCOP = {
        x: copVec.x - footCOM.x,
        y: copVec.y - footCOM.y,
        z: copVec.z - footCOM.z
      };

      // モーメント計算
      const rAnkleCrossFAnkle = this._cross3D(rAnkle, fAnkle);
      const rCOPCrossGRF = this._cross3D(rCOP, grfVec);

      ankle.moment[i] = this._add3D(
        this._add3D(inertialTorqueFoot, this._scale3D(rAnkleCrossFAnkle, -1)),
        rCOPCrossGRF
      );

      // ===== 下腿 =====
      const shank = kinematics3D.shank;
      const shankMass = shank.mass;
      const shankCOM = shank.com[i];
      const shankAccel = shank.comAcceleration3D[i];
      const shankOmega = shank.angularVelocity3D[i];
      const shankAlpha = shank.angularAcceleration3D[i];
      const shankI = shank.inertiaTensors[i];

      // 膝関節位置
      const kneePos = kinematics3D.thigh.distalPos[i];

      // Newton方程式: F_knee = m × (a - g) + F_ankle（作用反作用）
      const maShank = this._scale3D(shankAccel, shankMass);
      const mgShank = this._scale3D(gravityVec, -shankMass);
      const fKnee = this._add3D(this._add3D(maShank, mgShank), fAnkle);
      knee.force[i] = fKnee;

      // Euler方程式
      const inertialTorqueShank = this._computeInertialTorque3D(shankI, shankOmega, shankAlpha);

      // r_knee = kneePos - shankCOM
      const rKnee = {
        x: kneePos.x - shankCOM.x,
        y: kneePos.y - shankCOM.y,
        z: kneePos.z - shankCOM.z
      };

      // r_ankle_shank = anklePos - shankCOM
      const rAnkleShank = {
        x: anklePos.x - shankCOM.x,
        y: anklePos.y - shankCOM.y,
        z: anklePos.z - shankCOM.z
      };

      // 作用反作用
      const fAnkleReaction = this._scale3D(fAnkle, -1);

      const rKneeCrossFKnee = this._cross3D(rKnee, fKnee);
      const rAnkleShankCrossFAnkleReaction = this._cross3D(rAnkleShank, fAnkleReaction);

      knee.moment[i] = this._add3D(
        this._add3D(
          this._add3D(inertialTorqueShank, this._scale3D(rKneeCrossFKnee, -1)),
          rAnkleShankCrossFAnkleReaction
        ),
        ankle.moment[i]
      );

      // ===== 大腿 =====
      const thigh = kinematics3D.thigh;
      const thighMass = thigh.mass;
      const thighCOM = thigh.com[i];
      const thighAccel = thigh.comAcceleration3D[i];
      const thighOmega = thigh.angularVelocity3D[i];
      const thighAlpha = thigh.angularAcceleration3D[i];
      const thighI = thigh.inertiaTensors[i];

      // 股関節位置
      const hipPos = thigh.proximalPos[i];

      // Newton方程式: F_hip = m × (a - g) + F_knee
      const maThigh = this._scale3D(thighAccel, thighMass);
      const mgThigh = this._scale3D(gravityVec, -thighMass);
      const fHip = this._add3D(this._add3D(maThigh, mgThigh), fKnee);
      hip.force[i] = fHip;

      // Euler方程式
      const inertialTorqueThigh = this._computeInertialTorque3D(thighI, thighOmega, thighAlpha);

      // r_hip = hipPos - thighCOM
      const rHip = {
        x: hipPos.x - thighCOM.x,
        y: hipPos.y - thighCOM.y,
        z: hipPos.z - thighCOM.z
      };

      // r_knee_thigh = kneePos - thighCOM
      const rKneeThigh = {
        x: kneePos.x - thighCOM.x,
        y: kneePos.y - thighCOM.y,
        z: kneePos.z - thighCOM.z
      };

      const fKneeReaction = this._scale3D(fKnee, -1);

      const rHipCrossFHip = this._cross3D(rHip, fHip);
      const rKneeThighCrossFKneeReaction = this._cross3D(rKneeThigh, fKneeReaction);

      hip.moment[i] = this._add3D(
        this._add3D(
          this._add3D(inertialTorqueThigh, this._scale3D(rHipCrossFHip, -1)),
          rKneeThighCrossFKneeReaction
        ),
        knee.moment[i]
      );

      // デバッグ出力
      if (i === maxGRFFrame) {
        console.log(`[InvDyn3D Debug] ========== 3D計算 (frame ${i}) ==========`);
        console.log(`  GRF(3D): x=${grfVec.x.toFixed(1)}, y=${grfVec.y.toFixed(1)}, z=${grfVec.z.toFixed(1)} N`);
        console.log(`  足関節力(3D): x=${fAnkle.x.toFixed(1)}, y=${fAnkle.y.toFixed(1)}, z=${fAnkle.z.toFixed(1)} N`);
        console.log(`  足関節モーメント(3D): x=${ankle.moment[i].x.toFixed(2)}, y=${ankle.moment[i].y.toFixed(2)}, z=${ankle.moment[i].z.toFixed(2)} Nm`);
        console.log(`  膝関節モーメント(3D): x=${knee.moment[i].x.toFixed(2)}, y=${knee.moment[i].y.toFixed(2)}, z=${knee.moment[i].z.toFixed(2)} Nm`);
        console.log(`  股関節モーメント(3D): x=${hip.moment[i].x.toFixed(2)}, y=${hip.moment[i].y.toFixed(2)}, z=${hip.moment[i].z.toFixed(2)} Nm`);

        // ジャイロスコープ項の寄与を表示
        const gyroFoot = this._cross3D(footOmega, this._matrixVectorMultiply3(footI, footOmega));
        const gyroShank = this._cross3D(shankOmega, this._matrixVectorMultiply3(shankI, shankOmega));
        const gyroThigh = this._cross3D(thighOmega, this._matrixVectorMultiply3(thighI, thighOmega));
        console.log(`  ジャイロ項 (ω×Iω):`);
        console.log(`    足部: x=${gyroFoot.x.toFixed(4)}, y=${gyroFoot.y.toFixed(4)}, z=${gyroFoot.z.toFixed(4)} Nm`);
        console.log(`    下腿: x=${gyroShank.x.toFixed(4)}, y=${gyroShank.y.toFixed(4)}, z=${gyroShank.z.toFixed(4)} Nm`);
        console.log(`    大腿: x=${gyroThigh.x.toFixed(4)}, y=${gyroThigh.y.toFixed(4)}, z=${gyroThigh.z.toFixed(4)} Nm`);
      }
    }

    return { ankle, knee, hip };
  }

  /**
   * 3Dモーメントから矢状面成分を抽出
   * グラフ表示用に2D互換形式に変換
   *
   * @param {Object} dynamics3D - 3D逆動力学結果
   * @returns {Object} 2D互換形式の逆動力学結果
   */
  _extractSagittalMoments(dynamics3D) {
    // 矢状面軸（内外反軸）のインデックスを決定
    // 通常はY軸（前後軸）が矢状面軸
    const extractAxis = this.sagittalPlane === 'YZ' ? 'x' : 'y';

    return {
      ankle: {
        moment: dynamics3D.ankle.moment.map(m => m[extractAxis]),
        forceH: dynamics3D.ankle.force.map(f => this.sagittalPlane === 'YZ' ? f.y : f.x),
        forceV: dynamics3D.ankle.force.map(f => f.z)
      },
      knee: {
        moment: dynamics3D.knee.moment.map(m => m[extractAxis]),
        forceH: dynamics3D.knee.force.map(f => this.sagittalPlane === 'YZ' ? f.y : f.x),
        forceV: dynamics3D.knee.force.map(f => f.z)
      },
      hip: {
        moment: dynamics3D.hip.moment.map(m => m[extractAxis]),
        forceH: dynamics3D.hip.force.map(f => this.sagittalPlane === 'YZ' ? f.y : f.x),
        forceV: dynamics3D.hip.force.map(f => f.z)
      }
    };
  }

  /**
   * 3D関節パワーを計算
   * P = M · ω (ドット積)
   *
   * @param {Object} dynamics3D - 3D逆動力学結果
   * @param {Object} kinematics3D - 3Dキネマティクスデータ
   * @returns {Object} 3D関節パワー
   */
  _calculatePower3D(dynamics3D, kinematics3D) {
    const n = kinematics3D.foot.angularVelocity3D.length;

    const anklePower = new Array(n).fill(0);
    const kneePower = new Array(n).fill(0);
    const hipPower = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      // 相対角速度を計算
      const omegaFoot = kinematics3D.foot.angularVelocity3D[i];
      const omegaShank = kinematics3D.shank.angularVelocity3D[i];
      const omegaThigh = kinematics3D.thigh.angularVelocity3D[i];

      // 足関節: 足部 - 下腿 の相対角速度
      const omegaAnkleRel = {
        x: omegaFoot.x - omegaShank.x,
        y: omegaFoot.y - omegaShank.y,
        z: omegaFoot.z - omegaShank.z
      };

      // 膝関節: 下腿 - 大腿 の相対角速度
      const omegaKneeRel = {
        x: omegaShank.x - omegaThigh.x,
        y: omegaShank.y - omegaThigh.y,
        z: omegaShank.z - omegaThigh.z
      };

      // 股関節: 大腿の角速度（骨盤固定と仮定）
      const omegaHipRel = omegaThigh;

      // パワー = モーメント · 角速度（ドット積）
      const mAnkle = dynamics3D.ankle.moment[i];
      const mKnee = dynamics3D.knee.moment[i];
      const mHip = dynamics3D.hip.moment[i];

      anklePower[i] = mAnkle.x * omegaAnkleRel.x + mAnkle.y * omegaAnkleRel.y + mAnkle.z * omegaAnkleRel.z;
      kneePower[i] = mKnee.x * omegaKneeRel.x + mKnee.y * omegaKneeRel.y + mKnee.z * omegaKneeRel.z;
      hipPower[i] = mHip.x * omegaHipRel.x + mHip.y * omegaHipRel.y + mHip.z * omegaHipRel.z;
    }

    return { ankle: anklePower, knee: kneePower, hip: hipPower };
  }

  /**
   * 関節パワーを計算
   * P = M * omega_relative
   */
  _calculatePower(dynamics, kinematics) {
    const n = kinematics.foot.angle.length;

    const anklePower = new Array(n).fill(0);
    const kneePower = new Array(n).fill(0);
    const hipPower = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      // 足関節パワー = 足関節モーメント × (足部角速度 - 下腿角速度)
      const omegaAnkle = kinematics.foot.angularVelocity[i] - kinematics.shank.angularVelocity[i];
      anklePower[i] = dynamics.ankle.moment[i] * omegaAnkle;

      // 膝関節パワー = 膝関節モーメント × (下腿角速度 - 大腿角速度)
      const omegaKnee = kinematics.shank.angularVelocity[i] - kinematics.thigh.angularVelocity[i];
      kneePower[i] = dynamics.knee.moment[i] * omegaKnee;

      // 股関節パワー = 股関節モーメント × 大腿角速度（骨盤は固定と仮定）
      const omegaHip = kinematics.thigh.angularVelocity[i];
      hipPower[i] = dynamics.hip.moment[i] * omegaHip;
    }

    return { ankle: anklePower, knee: kneePower, hip: hipPower };
  }

  /**
   * 結果を体重で正規化（Nm/kg, W/kg）
   */
  normalizeByBodyWeight() {
    if (!this.results) return null;

    const normalized = {
      ...this.results,
      dynamicsNormalized: {
        ankle: {
          moment: this.results.dynamics.ankle.moment.map(m => m / this.bodyMass)
        },
        knee: {
          moment: this.results.dynamics.knee.moment.map(m => m / this.bodyMass)
        },
        hip: {
          moment: this.results.dynamics.hip.moment.map(m => m / this.bodyMass)
        }
      },
      powerNormalized: {
        ankle: this.results.power.ankle.map(p => p / this.bodyMass),
        knee: this.results.power.knee.map(p => p / this.bodyMass),
        hip: this.results.power.hip.map(p => p / this.bodyMass)
      }
    };

    return normalized;
  }

  /**
   * 関節角度を計算（解剖学的定義）
   */
  getJointAngles() {
    if (!this.results) return null;

    const kinematics = this.results.kinematics;
    const n = kinematics.foot.angle.length;

    const angles = {
      ankle: new Array(n).fill(0),
      knee: new Array(n).fill(0),
      hip: new Array(n).fill(0)
    };

    for (let i = 0; i < n; i++) {
      // 足関節角度 = 下腿角度 - 足部角度 + 90°
      // 背屈が正、底屈が負
      angles.ankle[i] = (kinematics.shank.angle[i] - kinematics.foot.angle[i] + Math.PI / 2) * 180 / Math.PI;

      // 膝関節角度 = 大腿角度 - 下腿角度 + 180°
      // 完全伸展が0°、屈曲が正
      angles.knee[i] = (Math.PI - (kinematics.thigh.angle[i] - kinematics.shank.angle[i])) * 180 / Math.PI;

      // 股関節角度 = 大腿角度 - 90°
      // 屈曲が正、伸展が負
      angles.hip[i] = (kinematics.thigh.angle[i] - Math.PI / 2) * 180 / Math.PI;
    }

    return angles;
  }

  /**
   * サマリー統計を取得
   */
  getSummary() {
    if (!this.results) return null;

    const calcStats = (arr) => {
      const valid = arr.filter(v => !isNaN(v) && isFinite(v));
      if (valid.length === 0) return { min: 0, max: 0, mean: 0 };

      const min = Math.min(...valid);
      const max = Math.max(...valid);
      const mean = valid.reduce((a, b) => a + b, 0) / valid.length;

      return { min, max, mean };
    };

    return {
      ankle: {
        moment: calcStats(this.results.dynamics.ankle.moment),
        power: calcStats(this.results.power.ankle)
      },
      knee: {
        moment: calcStats(this.results.dynamics.knee.moment),
        power: calcStats(this.results.power.knee)
      },
      hip: {
        moment: calcStats(this.results.dynamics.hip.moment),
        power: calcStats(this.results.power.hip)
      }
    };
  }
}

// グローバルに公開
window.InverseDynamics = InverseDynamics;
