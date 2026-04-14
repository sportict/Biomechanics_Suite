/**
 * Butterworth型ローパス（4次）フィルタ実装と補助関数
 * 実装方針:
 * - 4次Butterworth = 2次のBiquadを2段カスケード
 * - 係数はRBJ Audio EQ Cookbookに基づくローパス設計式を使用
 *   参照: https://webaudio.github.io/Audio-EQ-Cookbook/audio-eq-cookbook.html
 * - ゼロ位相化のため forward/backward（二方向）を適用（filtfilt相当）
 *   参照: SciPy signal.filtfilt ドキュメント
 */

/**
 * 2次ローパスBiquad係数を計算（RBJ式）
 * @param {number} fs サンプリング周波数(Hz)
 * @param {number} fc 遮断周波数(Hz)
 * @param {number} Q Q値
 */
function designBiquadLPF(fs, fc, Q) {
  const omega = 2 * Math.PI * (fc / fs);
  const sin = Math.sin(omega);
  const cos = Math.cos(omega);
  const alpha = sin / (2 * Q);

  const b0 = (1 - cos) / 2;
  const b1 = 1 - cos;
  const b2 = (1 - cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;

  // 正規化（a0=1）
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

/**
 * 1本のBiquadを前方向に適用
 * Direct Form I 実装
 * DC初期化: 入力データの最初の値でフィルタ状態を初期化し、
 * 端点でのトランジェント（振動）を防止
 */
function biquadFilterForward(x, coeff) {
  const { b0, b1, b2, a1, a2 } = coeff;
  const n = x.length;
  if (n === 0) return [];

  const y = new Array(n);

  // DC初期化: 最初の値で定常状態を仮定
  // フィルタの定常状態応答: y_ss = x_ss * (b0+b1+b2) / (1+a1+a2)
  const dcGain = (b0 + b1 + b2) / (1 + a1 + a2);
  const x0 = x[0];
  const y0 = x0 * dcGain;

  let x1 = x0, x2 = x0;
  let y1 = y0, y2 = y0;

  for (let i = 0; i < n; i++) {
    const xn = x[i];
    const yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    y[i] = yn;
    x2 = x1; x1 = xn;
    y2 = y1; y1 = yn;
  }
  return y;
}

/**
 * 1本のBiquadを後方向（時間反転）に適用
 */
function biquadFilterBackward(x, coeff) {
  const xr = [...x].reverse();
  const yr = biquadFilterForward(xr, coeff);
  return yr.reverse();
}

/**
 * 4次Butterworthローパス（2次×2段）を前方向に適用
 * 4次ButterworthのQ値（2次節のQ）:
 *   Q1 ≈ 0.5411961, Q2 ≈ 1.306563（既知の極配置に基づく）
 */
function butterworth4Forward(x, fs, fc) {
  // 安全域: fc は (0, fs/2) に制限
  const nyq = fs / 2;
  const fcClamped = Math.max(1e-6, Math.min(fc, nyq - 1e-6));
  const Q1 = 0.5411961;
  const Q2 = 1.306563;
  const s1 = designBiquadLPF(fs, fcClamped, Q1);
  const s2 = designBiquadLPF(fs, fcClamped, Q2);
  const y1 = biquadFilterForward(x, s1);
  const y2 = biquadFilterForward(y1, s2);
  return y2;
}

/**
 * 4次Butterworthローパス（二方向: forward/backward）
 */
function butterworth4ZeroPhase(x, fs, fc) {
  const yFwd = butterworth4Forward(x, fs, fc);
  const yRev = butterworth4Forward([...yFwd].reverse(), fs, fc).reverse();
  return yRev;
}

/**
 * Winterの方法（構造は同一。ゼロ位相4次Butterworth）
 */
export function butterWinter(series, fs, fc) {
  if (!Array.isArray(series) || series.length === 0) return series;
  return butterworth4ZeroPhase(series, fs, fc);
}

/**
 * Bryantの方法（フィルタ構造はButterworthで同一。遮断周波数の選択手法が異なる前提）
 * ここではフィルタ構造は共通実装を利用します。
 */
export function butterBryant(series, fs, fc) {
  if (!Array.isArray(series) || series.length === 0) return series;
  return butterworth4ZeroPhase(series, fs, fc);
}

/**
 * データ前後に定値パディング（両端補正）
 */
export function addPadding(series, padLength) {
  const n = series.length;
  if (!padLength || padLength <= 0 || n === 0) return series.slice();
  if (n === 1) {
    const head = new Array(padLength).fill(series[0]);
    const tail = new Array(padLength).fill(series[0]);
    return head.concat(series, tail);
  }
  // VBA実装に合わせた反射パディング（端点で線形外挿）
  const padded = new Array(n + 2 * padLength);
  // 先頭側
  for (let i = 0; i < padLength; i++) {
    const srcIdx = Math.min(1 + i, n - 1); // series[i+1]
    padded[padLength - 1 - i] = 2 * series[0] - series[srcIdx];
  }
  // 中央（元データ）
  for (let i = 0; i < n; i++) padded[padLength + i] = series[i];
  // 末尾側
  for (let i = 0; i < padLength; i++) {
    const srcIdx = Math.max(n - 2 - i, 0); // series[n-2-i]
    padded[padLength + n + i] = 2 * series[n - 1] - series[srcIdx];
  }
  return padded;
}

/**
 * パディング除去
 */
export function removePadding(series, padLength) {
  if (!padLength || padLength <= 0) return series.slice();
  return series.slice(padLength, series.length - padLength);
}

/**
 * Yu et al.(1999) / Wells & Winter(1980) の最適遮断周波数推定については、
 * 公式アルゴリズム仕様の一次情報（論文内の定義手順）が必要です。
 * 本実装では推測での数値最適化は行わず、呼び出し時にエラーを投げます。
 * 参考:
 * - Yu, B., et al., 1999
 * - Wells, R. P., & Winter, D. A., 1980
 */
export function calculateYuCutoff(/* framesByChannel, fs */) {
  throw new Error('公式情報が見つからないため、Yu法の自動遮断周波数は未実装です。');
}

/**
 * Wells & Winter(1980) の Residual Analysis に基づく最適遮断周波数推定
 * 各チャンネルごとに候補fcで残差R(fc)=RMS(x - x_filtered)を計算し、
 * 高域側の直線部を回帰して得たY切片aとR(fc)曲線の交点のfcを選択。
 * @param {number[][]} framesByChannel 形状: [channel][frame]
 * @param {number} fs サンプリング周波数
 * @param {{fcCandidates?: number[], tailCount?: number}} options オプション
 * @returns {number[]} 各チャンネルの最適fc
 */
export function calculateWaWCutoff(framesByChannel, fs, options = {}) {
  if (!Array.isArray(framesByChannel) || framesByChannel.length === 0) return [];
  const nyq = fs / 2;
  const fcList = (options.fcCandidates && options.fcCandidates.length > 0)
    ? options.fcCandidates.filter(fc => fc > 0 && fc < nyq)
    : generateDefaultFcList(nyq);
  // tailCountをfc候補数に応じて動的に設定（20%、最低5、最大20）
  const dynamicTailCount = Math.max(5, Math.min(20, Math.floor(fcList.length * 0.2)));
  const tailCount = options.tailCount || dynamicTailCount;

  const cutoffs = new Array(framesByChannel.length);
  for (let ch = 0; ch < framesByChannel.length; ch++) {
    const series = framesByChannel[ch];
    // 残差カーブ
    const residuals = fcList.map(fc => rmsResidual(series, fs, fc));

    // 高域 tailCount 点で直線当てはめ y = m x + b
    const start = Math.max(0, fcList.length - tailCount);
    const xs = fcList.slice(start);
    const ys = residuals.slice(start);
    const { m, b } = linearFit(xs, ys);
    const a = b; // Y切片

    // a と R(fc) の交点を探索（最近傍もしくは補間）
    let bestFc = fcList[0];
    let bestDiff = Math.abs(residuals[0] - a);
    for (let i = 1; i < fcList.length; i++) {
      const f1 = fcList[i - 1], f2 = fcList[i];
      const y1 = residuals[i - 1], y2 = residuals[i];
      // 区間内に交差がある場合は線形補間
      if ((y1 - a) * (y2 - a) <= 0 && y1 !== y2) {
        const t = (a - y1) / (y2 - y1);
        bestFc = f1 + t * (f2 - f1);
        bestDiff = 0;
        break;
      }
      const d2 = Math.abs(y2 - a);
      if (d2 < bestDiff) { bestDiff = d2; bestFc = f2; }
    }

    const eps = 1e-6;
    cutoffs[ch] = Math.max(0.1, Math.min(bestFc, nyq - eps));
  }
  return cutoffs;
}

function generateDefaultFcList(nyq) {
  // 高速運動（スプリント、投球等）にも対応するため最大50Hzまで探索
  const maxHz = Math.max(1, Math.min(50, nyq * 0.8));
  const list = [];
  // 低周波数域は細かく、高周波数域は粗く探索
  for (let f = 0.1; f <= 10 + 1e-9; f += 0.1) list.push(+f.toFixed(3));
  for (let f = 10.5; f <= maxHz + 1e-9; f += 0.5) list.push(+f.toFixed(3));
  return list;
}

function rmsResidual(series, fs, fc) {
  const y = butterworth4ZeroPhase(series, fs, fc);
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    const d = series[i] - y[i];
    sum += d * d;
  }
  return Math.sqrt(sum / series.length);
}

function linearFit(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx || 1e-12;
  const m = (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  return { m, b };
}

/**
 * 位置時系列から速度時系列を計算（Frame-DIAS6の3点中央差分法）
 * @param {number[]} position 位置の時系列データ
 * @param {number} dt フレーム間隔（秒）
 * @returns {number[]} 速度の時系列データ
 */
export function calculateVelocitySeries(position, dt) {
  const n = position.length;
  if (n < 3) return new Array(n).fill(0);

  const velocity = new Array(n);

  // 最初のフレーム: S'(t1) = (-3S(t1) + 4S(t2) - S(t3)) / (2Δt)
  velocity[0] = (-3 * position[0] + 4 * position[1] - position[2]) / (2 * dt);

  // 中間のフレーム: S'(ti) = (-S(ti-1) + S(ti+1)) / (2Δt)
  for (let i = 1; i < n - 1; i++) {
    velocity[i] = (position[i + 1] - position[i - 1]) / (2 * dt);
  }

  // 最後のフレーム: S'(tn) = (S(tn-2) - 4S(tn-1) + 3S(tn)) / (2Δt)
  velocity[n - 1] = (position[n - 3] - 4 * position[n - 2] + 3 * position[n - 1]) / (2 * dt);

  return velocity;
}

/**
 * 3次スプライン補間による微分計算（S.KOIKE 2003.12.25のアルゴリズムに基づく）
 *
 * 手順:
 * 1. データをアップサンプリング（2倍）してスプライン補間
 * 2. スプライン係数から解析的に微分係数を計算
 * 3. 元のサンプリングレートに戻して出力
 *
 * @param {number[]} data 入力データ
 * @param {number} dt フレーム間隔（秒）
 * @returns {number[]} 微分値（速度または加速度）
 */
export function differentiateSpline(data, dt) {
  const n = data.length;
  if (n < 4) {
    // データが短い場合は中央差分にフォールバック
    return calculateVelocitySeries(data, dt);
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
  const splineCoeffs = computeCubicSplineCoeffs(tt, data);

  // アップサンプリングデータを評価
  const divData = evaluateSpline(splineCoeffs, tt, ttDiv);

  // アップサンプリングデータのスプライン係数を計算
  const divSplineCoeffs = computeCubicSplineCoeffs(ttDiv, divData);

  // 微分係数を計算（3次スプラインの微分は2次多項式）
  // f(x) = a(x-xi)³ + b(x-xi)² + c(x-xi) + d
  // f'(x) = 3a(x-xi)² + 2b(x-xi) + c
  const derivCoeffs = [];
  for (let i = 0; i < divSplineCoeffs.length; i++) {
    const { a, b, c } = divSplineCoeffs[i];
    derivCoeffs.push({
      a: 0,        // 2次多項式
      b: 3 * a,    // 3a → 係数
      c: 2 * b,    // 2b → 係数
      d: c         // c → 定数項
    });
  }

  // 微分値をアップサンプリング点で評価
  const divDiff = evaluateSplineDerivative(derivCoeffs, ttDiv);

  // 元のサンプリングレートに戻す
  const derivSplineCoeffs = computeCubicSplineCoeffs(ttDiv, divDiff);
  const diff = evaluateSpline(derivSplineCoeffs, ttDiv, tt);

  return diff;
}

/**
 * 3次スプライン係数を計算（Natural Spline）
 * @param {number[]} x x座標（時間）
 * @param {number[]} y y座標（データ値）
 * @returns {Array} 各区間の係数 [{a, b, c, d, x0}, ...]
 */
function computeCubicSplineCoeffs(x, y) {
  const n = x.length;
  if (n < 2) return [];

  // 区間幅
  const h = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = x[i + 1] - x[i];
  }

  // 三重対角行列の係数を設定
  const alpha = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    alpha[i] = (3 / h[i]) * (y[i + 1] - y[i]) - (3 / h[i - 1]) * (y[i] - y[i - 1]);
  }

  // 三重対角行列を解く（Thomas algorithm）
  const l = new Array(n).fill(1);
  const mu = new Array(n).fill(0);
  const z = new Array(n).fill(0);

  for (let i = 1; i < n - 1; i++) {
    l[i] = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1];
    mu[i] = h[i] / l[i];
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
  }

  // 2次導関数係数
  const c = new Array(n).fill(0);
  const b = new Array(n - 1);
  const d = new Array(n - 1);
  const a = new Array(n - 1);

  for (let j = n - 2; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1];
    b[j] = (y[j + 1] - y[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3;
    d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
    a[j] = y[j];
  }

  // 係数を格納
  const coeffs = [];
  for (let i = 0; i < n - 1; i++) {
    coeffs.push({
      a: d[i],   // 3次係数
      b: c[i],   // 2次係数
      c: b[i],   // 1次係数
      d: a[i],   // 定数項
      x0: x[i]   // 区間開始点
    });
  }

  return coeffs;
}

/**
 * スプラインを指定点で評価
 * @param {Array} coeffs スプライン係数
 * @param {number[]} xKnots ノット点
 * @param {number[]} xEval 評価点
 * @returns {number[]} 評価値
 */
function evaluateSpline(coeffs, xKnots, xEval) {
  const result = new Array(xEval.length);

  for (let i = 0; i < xEval.length; i++) {
    const xe = xEval[i];

    // 対応する区間を探す
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

    // f(x) = a*dx³ + b*dx² + c*dx + d
    result[i] = a * dx * dx * dx + b * dx * dx + c * dx + d;
  }

  return result;
}

/**
 * スプライン微分を指定点で評価（係数が既に微分済みの場合）
 * @param {Array} derivCoeffs 微分スプライン係数
 * @param {number[]} xEval 評価点
 * @returns {number[]} 微分値
 */
function evaluateSplineDerivative(derivCoeffs, xEval) {
  const result = new Array(xEval.length);
  const nCoeffs = derivCoeffs.length;

  for (let i = 0; i < xEval.length; i++) {
    // 区間インデックス（等間隔と仮定）
    const idx = Math.min(Math.floor(i * nCoeffs / xEval.length), nCoeffs - 1);
    const coeff = derivCoeffs[idx];

    // 区間内での相対位置
    const localT = (i % Math.ceil(xEval.length / nCoeffs)) *
      (xEval[1] - xEval[0]);

    // f'(x) = b*dx² + c*dx + d （微分係数で評価）
    result[i] = coeff.b * localT * localT + coeff.c * localT + coeff.d;
  }

  return result;
}

/**
 * スプライン微分による加速度計算（2階微分）
 * @param {number[]} data 位置データ
 * @param {number} dt フレーム間隔（秒）
 * @returns {number[]} 加速度
 */
export function differentiateSpline2nd(data, dt) {
  // 1階微分（速度）を計算
  const velocity = differentiateSpline(data, dt);
  // 2階微分（加速度）を計算
  const acceleration = differentiateSpline(velocity, dt);
  return acceleration;
}

/**
 * 速度時系列にButterworthフィルタを適用（FDF法の第2段階）
 * @param {number[]} velocity 速度の時系列データ
 * @param {number} fs サンプリング周波数(Hz)
 * @param {number} fc 遮断周波数(Hz)
 * @param {number} [padLength] パディング長（省略時は自動計算）
 * @returns {number[]} フィルタ後の速度時系列
 */
export function filterVelocity(velocity, fs, fc, padLength) {
  if (!Array.isArray(velocity) || velocity.length < 3) return velocity;

  const n = velocity.length;
  // パディング長の自動計算（端部トランジェント抑制用）
  const autoPad = Math.max(20, Math.min(Math.floor(n / 3), Math.ceil(3 * fs / Math.max(fc, 0.1))));
  const pad = padLength || autoPad;

  let proc = addPadding(velocity, pad);
  proc = butterworth4ZeroPhase(proc, fs, fc);
  proc = removePadding(proc, pad);

  return proc;
}

/**
 * Wells & Winter法による速度データの最適遮断周波数推定
 * 速度データは位置データより高い周波数成分を含むため、
 * 位置データとは別に最適fcを決定する
 * @param {number[][]} velocityByChannel 形状: [channel][frame]
 * @param {number} fs サンプリング周波数
 * @param {{fcCandidates?: number[], tailCount?: number}} options オプション
 * @returns {number[]} 各チャンネルの最適fc
 */
export function calculateVelocityCutoff(velocityByChannel, fs, options = {}) {
  if (!Array.isArray(velocityByChannel) || velocityByChannel.length === 0) return [];

  const nyq = fs / 2;
  // 速度用のfc候補リスト（位置より広い範囲を探索）
  const fcList = (options.fcCandidates && options.fcCandidates.length > 0)
    ? options.fcCandidates.filter(fc => fc > 0 && fc < nyq)
    : generateVelocityFcList(nyq);
  const tailCount = Math.max(5, options.tailCount || 10);

  const cutoffs = new Array(velocityByChannel.length);
  for (let ch = 0; ch < velocityByChannel.length; ch++) {
    const series = velocityByChannel[ch];
    const residuals = fcList.map(fc => rmsResidual(series, fs, fc));

    const start = Math.max(0, fcList.length - tailCount);
    const xs = fcList.slice(start);
    const ys = residuals.slice(start);
    const { m, b } = linearFit(xs, ys);
    const a = b;

    let bestFc = fcList[0];
    let bestDiff = Math.abs(residuals[0] - a);
    for (let i = 1; i < fcList.length; i++) {
      const f1 = fcList[i - 1], f2 = fcList[i];
      const y1 = residuals[i - 1], y2 = residuals[i];
      if ((y1 - a) * (y2 - a) <= 0 && y1 !== y2) {
        const t = (a - y1) / (y2 - y1);
        bestFc = f1 + t * (f2 - f1);
        bestDiff = 0;
        break;
      }
      const d2 = Math.abs(y2 - a);
      if (d2 < bestDiff) { bestDiff = d2; bestFc = f2; }
    }

    const eps = 1e-6;
    cutoffs[ch] = Math.max(0.1, Math.min(bestFc, nyq - eps));
  }
  return cutoffs;
}

function generateVelocityFcList(nyq) {
  // 速度は位置より広い周波数帯域を探索（最大30Hzまたはナイキスト周波数の80%）
  const maxHz = Math.max(1, Math.min(30, nyq * 0.8));
  const list = [];
  for (let f = 0.5; f <= maxHz + 1e-9; f += 0.5) list.push(+f.toFixed(3));
  return list;
}

/**
 * Wells & Winter法の残差分析データを取得（グラフ表示用）
 * @param {number[]} series 時系列データ
 * @param {number} fs サンプリング周波数
 * @param {Object} options オプション
 * @returns {Object} { fcList, residuals, optimalFc, noiseLine: {m, b, a} }
 */
export function calculateResidualCurve(series, fs, options = {}) {
  if (!Array.isArray(series) || series.length === 0) {
    return { fcList: [], residuals: [], optimalFc: 0, noiseLine: { m: 0, b: 0, a: 0 } };
  }

  const nyq = fs / 2;
  const fcList = (options.fcCandidates && options.fcCandidates.length > 0)
    ? options.fcCandidates.filter(fc => fc > 0 && fc < nyq)
    : generateDefaultFcList(nyq);

  const dynamicTailCount = Math.max(5, Math.min(20, Math.floor(fcList.length * 0.2)));
  const tailCount = options.tailCount || dynamicTailCount;

  // 残差カーブを計算
  const residuals = fcList.map(fc => rmsResidual(series, fs, fc));

  // 高域 tailCount 点で直線当てはめ y = m x + b
  const start = Math.max(0, fcList.length - tailCount);
  const xs = fcList.slice(start);
  const ys = residuals.slice(start);
  const { m, b } = linearFit(xs, ys);
  const a = b; // Y切片（ノイズレベル）

  // a と R(fc) の交点を探索（最適fc）
  let optimalFc = fcList[0];
  for (let i = 1; i < fcList.length; i++) {
    const f1 = fcList[i - 1], f2 = fcList[i];
    const y1 = residuals[i - 1], y2 = residuals[i];
    // 区間内に交差がある場合は線形補間
    if ((y1 - a) * (y2 - a) <= 0 && y1 !== y2) {
      const t = (a - y1) / (y2 - y1);
      optimalFc = f1 + t * (f2 - f1);
      break;
    }
    if (Math.abs(y2 - a) < Math.abs(residuals[fcList.indexOf(optimalFc)] - a)) {
      optimalFc = f2;
    }
  }

  const eps = 1e-6;
  optimalFc = Math.max(0.1, Math.min(optimalFc, nyq - eps));

  return {
    fcList,
    residuals,
    optimalFc,
    noiseLine: { m, b, a },
    tailStartIndex: start
  };
}

/**
 * 欠損値（NaN）を含む時系列データを3次スプラインで補間する
 * 端の欠損は直近の有効値でパディングされる
 * @param {number[]} data 欠損値を含む可能性のある1次元配列
 * @returns {number[]} 欠損値を補間した新しい配列
 */
export function interpolateMissingData(data) {
  if (!Array.isArray(data) || data.length === 0) return [];

  const n = data.length;
  const result = new Array(n);

  // 有効なデータ点のインデックスと値を収集
  const validIndices = [];
  const validValues = [];

  for (let i = 0; i < n; i++) {
    if (!isNaN(data[i])) {
      validIndices.push(i);
      validValues.push(data[i]);
    }
    result[i] = data[i]; // 一旦元の値をコピー
  }

  // 全てがNaN、または有効データが1点しかない場合は補間できない
  if (validIndices.length < 2) {
    if (validIndices.length === 1) {
      // 1点だけ有効ならその値で全て埋める
      return new Array(n).fill(validValues[0]);
    }
    return result;
  }

  // 端の欠損をパディング（最寄り値外挿）
  const firstValidIndex = validIndices[0];
  const lastValidIndex = validIndices[validIndices.length - 1];

  if (firstValidIndex > 0) {
    const val = validValues[0];
    for (let i = 0; i < firstValidIndex; i++) {
      result[i] = val;
    }
  }

  if (lastValidIndex < n - 1) {
    const val = validValues[validValues.length - 1];
    for (let i = lastValidIndex + 1; i < n; i++) {
      result[i] = val;
    }
  }

  // 有効データが3点以上の場合は3次スプライン補間、2点の場合は線形補間
  if (validIndices.length >= 3) {
    // 3次スプライン係数を計算
    const coeffs = computeCubicSplineCoeffs(validIndices, validValues);

    // 中間の欠損を補間
    for (let i = firstValidIndex + 1; i < lastValidIndex; i++) {
      if (isNaN(data[i])) {
        // 欠損部分のみスプライン評価
        const evalResult = evaluateSpline(coeffs, validIndices, [i]);
        result[i] = evalResult[0];
      }
    }
  } else {
    // データが2点しかない場合は線形補間
    const x0 = validIndices[0], y0 = validValues[0];
    const x1 = validIndices[1], y1 = validValues[1];
    const slope = (y1 - y0) / (x1 - x0);

    for (let i = firstValidIndex + 1; i < lastValidIndex; i++) {
      if (isNaN(data[i])) {
        result[i] = y0 + slope * (i - x0);
      }
    }
  }

  return result;
}
