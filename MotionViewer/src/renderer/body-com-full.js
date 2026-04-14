/**
 * 身体重心計算モジュール - 完全版
 * VBAのBSP(Body Segment Parameters)ロジックをJavaScriptに移植
 * 
 * 対応モデル:
 * - 阿江14/15 (成人: 23/25ポイント)
 * - 岡田14/15 (老人: 23/25ポイント)  
 * - 横井 (子ども: 3-8歳, 23ポイント)
 */

/**
 * セグメント定義の基本構造を生成するヘルパー関数
 */
function createSegment(name, distal, proximal, massRatioMale, massRatioFemale, comRatioMale, comRatioFemale) {
  return {
    name,
    distal,
    proximal,
    massRatioMale,
    massRatioFemale,
    comRatioMale,
    comRatioFemale
  };
}

/**
 * 阿江14の身体セグメントパラメータ(BSP)
 * 成人用・23ポイントモデル(胴体を1つのセグメントとして扱う)
 */
const BSP_AE14 = {
  segments: [
    createSegment("右手", 0, 1, 0.6, 0.6, 89.1, 90.8),
    createSegment("右前腕", 1, 2, 1.6, 1.5, 41.5, 42.3),
    createSegment("右上腕", 2, 3, 2.7, 2.6, 52.9, 52.3),
    createSegment("左手", 4, 5, 0.6, 0.6, 89.1, 90.8),
    createSegment("左前腕", 5, 6, 1.6, 1.5, 41.5, 42.3),
    createSegment("左上腕", 6, 7, 2.7, 2.6, 52.9, 52.3),
    createSegment("右足部", 10, 8, 1.1, 1.1, 59.5, 59.4),
    createSegment("右下腿", 11, 12, 5.1, 5.3, 40.6, 41.0),
    createSegment("右大腿", 12, 13, 11.0, 12.3, 47.5, 45.8),
    createSegment("左足部", 16, 14, 1.1, 1.1, 59.5, 59.4),
    createSegment("左下腿", 17, 18, 5.1, 5.3, 40.6, 41.0),
    createSegment("左大腿", 18, 19, 11.0, 12.3, 47.5, 45.8),
    createSegment("頭部", 21, 20, 6.9, 7.5, 82.1, 75.9),
    createSegment("胴体", -1, 22, 48.9, 45.7, 49.3, 50.6)
  ]
};

/**
 * 阿江15の身体セグメントパラメータ(BSP)
 * 成人用・25ポイントモデル(胴体を上胴と下胴に分割)
 */
const BSP_AE15 = {
  segments: [
    createSegment("右手", 0, 1, 0.6, 0.6, 89.1, 90.8),
    createSegment("右前腕", 1, 2, 1.6, 1.5, 41.5, 42.3),
    createSegment("右上腕", 2, 3, 2.7, 2.6, 52.9, 52.3),
    createSegment("左手", 4, 5, 0.6, 0.6, 89.1, 90.8),
    createSegment("左前腕", 5, 6, 1.6, 1.5, 41.5, 42.3),
    createSegment("左上腕", 6, 7, 2.7, 2.6, 52.9, 52.3),
    createSegment("右足部", 10, 8, 1.1, 1.1, 59.5, 59.4),
    createSegment("右下腿", 11, 12, 5.1, 5.3, 40.6, 41.0),
    createSegment("右大腿", 12, 13, 11.0, 12.3, 47.5, 45.8),
    createSegment("左足部", 16, 14, 1.1, 1.1, 59.5, 59.4),
    createSegment("左下腿", 17, 18, 5.1, 5.3, 40.6, 41.0),
    createSegment("左大腿", 18, 19, 11.0, 12.3, 47.5, 45.8),
    createSegment("頭部", 21, 20, 6.9, 7.5, 82.1, 75.9),
    createSegment("上胴", -2, 22, 30.2, 26.7, 42.8, 43.8),
    createSegment("下胴", -1, -2, 18.7, 19.0, 60.9, 59.7)
  ]
};

/**
 * 岡田14の身体セグメントパラメータ(BSP)
 * 老人用・23ポイントモデル
 */
const BSP_OKADA14 = {
  segments: [
    createSegment("右手", 0, 1, 0.8, 0.6, 82.0, 76.3),
    createSegment("右前腕", 1, 2, 1.7, 1.6, 42.7, 42.3),
    createSegment("右上腕", 2, 3, 2.5, 2.5, 54.9, 56.9),
    createSegment("左手", 4, 5, 0.8, 0.6, 82.0, 76.3),
    createSegment("左前腕", 5, 6, 1.7, 1.6, 42.7, 42.3),
    createSegment("左上腕", 6, 7, 2.5, 2.5, 54.9, 56.9),
    createSegment("右足部", 10, 8, 1.7, 1.5, 58.1, 59.1),
    createSegment("右下腿", 11, 12, 4.7, 4.8, 42.3, 42.4),
    createSegment("右大腿", 12, 13, 9.2, 9.8, 48.1, 47.4),
    createSegment("左足部", 16, 14, 1.7, 1.5, 58.1, 59.1),
    createSegment("左下腿", 17, 18, 4.7, 4.8, 42.3, 42.4),
    createSegment("左大腿", 18, 19, 9.2, 9.8, 48.1, 47.4),
    createSegment("頭部", 21, 20, 9.1, 8.8, 86.9, 83.8),
    createSegment("胴体", -1, 22, 49.7, 49.3, 49.8, 51.5)
  ]
};

/**
 * 岡田15の身体セグメントパラメータ(BSP)
 * 老人用・25ポイントモデル
 */
const BSP_OKADA15 = {
  segments: [
    createSegment("右手", 0, 1, 0.8, 0.6, 82.0, 76.3),
    createSegment("右前腕", 1, 2, 1.7, 1.6, 42.7, 42.3),
    createSegment("右上腕", 2, 3, 2.5, 2.5, 54.9, 56.9),
    createSegment("左手", 4, 5, 0.8, 0.6, 82.0, 76.3),
    createSegment("左前腕", 5, 6, 1.7, 1.6, 42.7, 42.3),
    createSegment("左上腕", 6, 7, 2.5, 2.5, 54.9, 56.9),
    createSegment("右足部", 10, 8, 1.7, 1.5, 58.1, 59.1),
    createSegment("右下腿", 11, 12, 4.7, 4.8, 42.3, 42.4),
    createSegment("右大腿", 12, 13, 9.2, 9.8, 48.1, 47.4),
    createSegment("左足部", 16, 14, 1.7, 1.5, 58.1, 59.1),
    createSegment("左下腿", 17, 18, 4.7, 4.8, 42.3, 42.4),
    createSegment("左大腿", 18, 19, 9.2, 9.8, 48.1, 47.4),
    createSegment("頭部", 21, 20, 9.1, 8.8, 86.9, 83.8),
    createSegment("上胴", -2, 22, 28.8, 26.0, 40.9, 41.7),
    createSegment("下胴", -1, -2, 20.9, 23.4, 60.5, 58.7)
  ]
};

/**
 * 横井03-05yr標準の身体セグメントパラメータ(BSP)
 * 子ども用(3-5歳・標準体型)・23ポイントモデル
 */
const BSP_YOKOI_03_05_STANDARD = {
  segments: [
    createSegment("右手", 0, 1, 0.7, 0.7, 81.6, 81.6),
    createSegment("右前腕", 1, 2, 1.5, 1.5, 44.0, 44.0),
    createSegment("右上腕", 2, 3, 2.4, 2.4, 54.1, 54.1),
    createSegment("左手", 4, 5, 0.7, 0.7, 81.6, 81.6),
    createSegment("左前腕", 5, 6, 1.5, 1.5, 44.0, 44.0),
    createSegment("左上腕", 6, 7, 2.4, 2.4, 54.1, 54.1),
    createSegment("右足部", 10, 8, 1.7, 1.7, 55.8, 55.8),
    createSegment("右下腿", 11, 12, 3.9, 3.9, 43.6, 43.6),
    createSegment("右大腿", 12, 13, 8.0, 8.0, 49.8, 49.8),
    createSegment("左足部", 16, 14, 1.7, 1.7, 55.8, 55.8),
    createSegment("左下腿", 17, 18, 3.9, 3.9, 43.6, 43.6),
    createSegment("左大腿", 18, 19, 8.0, 8.0, 49.8, 49.8),
    createSegment("頭部", 21, 20, 16.4, 16.4, 73.4, 73.4),
    createSegment("胴体", -1, 22, 47.3, 47.3, 52.3, 52.3)
  ]
};

/**
 * 横井03-05yr痩身の身体セグメントパラメータ(BSP)
 * 子ども用(3-5歳・痩身体型)・23ポイントモデル
 */
const BSP_YOKOI_03_05_THIN = {
  segments: [
    createSegment("右手", 0, 1, 0.7, 0.7, 81.9, 81.9),
    createSegment("右前腕", 1, 2, 1.5, 1.5, 43.9, 43.9),
    createSegment("右上腕", 2, 3, 2.4, 2.4, 53.1, 53.1),
    createSegment("左手", 4, 5, 0.7, 0.7, 81.9, 81.9),
    createSegment("左前腕", 5, 6, 1.5, 1.5, 43.9, 43.9),
    createSegment("左上腕", 6, 7, 2.4, 2.4, 53.1, 53.1),
    createSegment("右足部", 10, 8, 1.6, 1.6, 59.0, 59.0),
    createSegment("右下腿", 11, 12, 3.7, 3.7, 43.6, 43.6),
    createSegment("右大腿", 12, 13, 7.6, 7.6, 48.6, 48.6),
    createSegment("左足部", 16, 14, 1.6, 1.6, 59.0, 59.0),
    createSegment("左下腿", 17, 18, 3.7, 3.7, 43.6, 43.6),
    createSegment("左大腿", 18, 19, 7.6, 7.6, 48.6, 48.6),
    createSegment("頭部", 21, 20, 17.2, 17.2, 73.2, 73.2),
    createSegment("胴体", -1, 22, 47.7, 47.7, 50.6, 50.6)
  ]
};

/**
 * 横井03-05yr肥満の身体セグメントパラメータ(BSP)
 * 子ども用(3-5歳・肥満体型)・23ポイントモデル
 */
const BSP_YOKOI_03_05_OBESE = {
  segments: [
    createSegment("右手", 0, 1, 0.7, 0.7, 81.1, 81.1),
    createSegment("右前腕", 1, 2, 1.6, 1.6, 43.2, 43.2),
    createSegment("右上腕", 2, 3, 2.4, 2.4, 53.9, 53.9),
    createSegment("左手", 4, 5, 0.7, 0.7, 81.1, 81.1),
    createSegment("左前腕", 5, 6, 1.6, 1.6, 43.2, 43.2),
    createSegment("左上腕", 6, 7, 2.4, 2.4, 53.9, 53.9),
    createSegment("右足部", 10, 8, 1.6, 1.6, 58.3, 58.3),
    createSegment("右下腿", 11, 12, 4.0, 4.0, 43.5, 43.5),
    createSegment("右大腿", 12, 13, 8.1, 8.1, 49.2, 49.2),
    createSegment("左足部", 16, 14, 1.6, 1.6, 58.3, 58.3),
    createSegment("左下腿", 17, 18, 4.0, 4.0, 43.5, 43.5),
    createSegment("左大腿", 18, 19, 8.1, 8.1, 49.2, 49.2),
    createSegment("頭部", 21, 20, 15.6, 15.6, 73.1, 73.1),
    createSegment("胴体", -1, 22, 47.5, 47.5, 51.9, 51.9)
  ]
};

/**
 * 横井06-08yr標準の身体セグメントパラメータ(BSP)
 * 子ども用(6-8歳・標準体型)・23ポイントモデル
 */
const BSP_YOKOI_06_08_STANDARD = {
  segments: [
    createSegment("右手", 0, 1, 0.9, 0.9, 82.3, 82.3),
    createSegment("右前腕", 1, 2, 1.4, 1.4, 42.9, 42.9),
    createSegment("右上腕", 2, 3, 2.4, 2.4, 53.1, 53.1),
    createSegment("左手", 4, 5, 0.9, 0.9, 82.3, 82.3),
    createSegment("左前腕", 5, 6, 1.4, 1.4, 42.9, 42.9),
    createSegment("左上腕", 6, 7, 2.4, 2.4, 53.1, 53.1),
    createSegment("右足部", 10, 8, 2.0, 2.0, 54.1, 54.1),
    createSegment("右下腿", 11, 12, 4.2, 4.2, 42.7, 42.7),
    createSegment("右大腿", 12, 13, 9.5, 9.5, 48.9, 48.9),
    createSegment("左足部", 16, 14, 2.0, 2.0, 54.1, 54.1),
    createSegment("左下腿", 17, 18, 4.2, 4.2, 42.7, 42.7),
    createSegment("左大腿", 18, 19, 9.5, 9.5, 48.9, 48.9),
    createSegment("頭部", 21, 20, 14.0, 14.0, 75.7, 75.7),
    createSegment("胴体", -1, 22, 45.0, 45.0, 51.1, 51.1)
  ]
};

/**
 * 横井06-08yr痩身の身体セグメントパラメータ(BSP)
 * 子ども用(6-8歳・痩身体型)・23ポイントモデル
 */
const BSP_YOKOI_06_08_THIN = {
  segments: [
    createSegment("右手", 0, 1, 0.9, 0.9, 81.3, 81.3),
    createSegment("右前腕", 1, 2, 1.4, 1.4, 42.5, 42.5),
    createSegment("右上腕", 2, 3, 2.3, 2.3, 53.0, 53.0),
    createSegment("左手", 4, 5, 0.9, 0.9, 81.3, 81.3),
    createSegment("左前腕", 5, 6, 1.4, 1.4, 42.5, 42.5),
    createSegment("左上腕", 6, 7, 2.3, 2.3, 53.0, 53.0),
    createSegment("右足部", 10, 8, 1.7, 1.7, 54.1, 54.1),
    createSegment("右下腿", 11, 12, 4.2, 4.2, 43.2, 43.2),
    createSegment("右大腿", 12, 13, 9.1, 9.1, 48.5, 48.5),
    createSegment("左足部", 16, 14, 1.7, 1.7, 54.1, 54.1),
    createSegment("左下腿", 17, 18, 4.2, 4.2, 43.2, 43.2),
    createSegment("左大腿", 18, 19, 9.1, 9.1, 48.5, 48.5),
    createSegment("頭部", 21, 20, 14.3, 14.3, 75.3, 75.3),
    createSegment("胴体", -1, 22, 46.2, 46.2, 50.7, 50.7)
  ]
};

/**
 * 横井06-08yr肥満の身体セグメントパラメータ(BSP)
 * 子ども用(6-8歳・肥満体型)・23ポイントモデル
 */
const BSP_YOKOI_06_08_OBESE = {
  segments: [
    createSegment("右手", 0, 1, 0.9, 0.9, 83.8, 83.8),
    createSegment("右前腕", 1, 2, 1.5, 1.5, 42.7, 42.7),
    createSegment("右上腕", 2, 3, 2.5, 2.5, 54.4, 54.4),
    createSegment("左手", 4, 5, 0.9, 0.9, 83.8, 83.8),
    createSegment("左前腕", 5, 6, 1.5, 1.5, 42.7, 42.7),
    createSegment("左上腕", 6, 7, 2.5, 2.5, 54.4, 54.4),
    createSegment("右足部", 10, 8, 1.8, 1.8, 55.0, 55.0),
    createSegment("右下腿", 11, 12, 4.3, 4.3, 42.2, 42.2),
    createSegment("右大腿", 12, 13, 10.3, 10.3, 47.9, 47.9),
    createSegment("左足部", 16, 14, 1.8, 1.8, 55.0, 55.0),
    createSegment("左下腿", 17, 18, 4.3, 4.3, 42.2, 42.2),
    createSegment("左大腿", 18, 19, 10.3, 10.3, 47.9, 47.9),
    createSegment("頭部", 21, 20, 11.7, 11.7, 76.6, 76.6),
    createSegment("胴体", -1, 22, 46.0, 46.0, 51.9, 51.9)
  ]
};

/**
 * BSPデータマップ
 */
const BSP_MAP = {
  'ae14': BSP_AE14,
  'ae15': BSP_AE15,
  'okada14': BSP_OKADA14,
  'okada15': BSP_OKADA15,
  'yokoi_03_05_standard': BSP_YOKOI_03_05_STANDARD,
  'yokoi_03_05_thin': BSP_YOKOI_03_05_THIN,
  'yokoi_03_05_obese': BSP_YOKOI_03_05_OBESE,
  'yokoi_06_08_standard': BSP_YOKOI_06_08_STANDARD,
  'yokoi_06_08_thin': BSP_YOKOI_06_08_THIN,
  'yokoi_06_08_obese': BSP_YOKOI_06_08_OBESE
};

/**
 * 身体重心計算クラス
 */
class BodyCenterOfMass {
  /**
   * コンストラクタ
   * @param {string} method - 使用するBSP方法
   *   成人: 'ae14', 'ae15'
   *   老人: 'okada14', 'okada15'
   *   子ども: 'yokoi_03_05_standard', 'yokoi_03_05_thin', 'yokoi_03_05_obese',
   *           'yokoi_06_08_standard', 'yokoi_06_08_thin', 'yokoi_06_08_obese'
   * @param {string} sex - 性別 ('male' or 'female')
   */
  constructor(method = 'ae14', sex = 'male') {
    this.method = method;
    this.sex = sex;
    
    if (!BSP_MAP[method]) {
      throw new Error(`不明なBSP方法: ${method}`);
    }
    
    this.bsp = BSP_MAP[method];
    this.is25Point = method.includes('15');
  }

  /**
   * 仮想ポイント1(大転子中点)を計算
   * @param {Array} points - フレーム内の全ポイント座標 [[x,y,z], [x,y,z], ...]
   * @returns {Array} - 大転子中点の座標 [x, y, z]
   */
  calculateVirtualPoint1(points) {
    const rightTrochanter = points[13];
    const leftTrochanter = points[19];
    
    if (!rightTrochanter || !leftTrochanter) {
      return null;
    }

    return [
      (rightTrochanter[0] + leftTrochanter[0]) / 2,
      (rightTrochanter[1] + leftTrochanter[1]) / 2,
      (rightTrochanter[2] + leftTrochanter[2]) / 2
    ];
  }

  /**
   * 仮想ポイント2(肋骨下端中点)を計算 - 25ポイントモデルのみ
   * @param {Array} points - フレーム内の全ポイント座標
   * @returns {Array} - 肋骨下端中点の座標 [x, y, z]
   */
  calculateVirtualPoint2(points) {
    const rightRib = points[23];
    const leftRib = points[24];
    
    if (!rightRib || !leftRib) {
      return null;
    }

    return [
      (rightRib[0] + leftRib[0]) / 2,
      (rightRib[1] + leftRib[1]) / 2,
      (rightRib[2] + leftRib[2]) / 2
    ];
  }

  /**
   * 部分重心を計算
   * @param {Array} distalPoint - 末梢端の座標 [x, y, z]
   * @param {Array} proximalPoint - 中枢端の座標 [x, y, z]
   * @param {number} comRatio - 質量中心比(%)
   * @returns {Array} - 部分重心の座標 [x, y, z]
   */
  calculateSegmentCOM(distalPoint, proximalPoint, comRatio) {
    const ratio = comRatio / 100;
    
    return [
      distalPoint[0] * ratio + proximalPoint[0] * (1 - ratio),
      distalPoint[1] * ratio + proximalPoint[1] * (1 - ratio),
      distalPoint[2] * ratio + proximalPoint[2] * (1 - ratio)
    ];
  }

  /**
   * 1フレーム分の身体重心を計算
   * @param {Array} points - フレーム内の全ポイント座標 [[x,y,z], [x,y,z], ...]
   * @returns {Object} - {bodyCOM: [x,y,z], segmentCOMs: [[x,y,z], ...], valid: boolean}
   */
  calculateFrameCOM(points) {
    const result = {
      bodyCOM: null,
      segmentCOMs: [],
      valid: false
    };

    // 仮想ポイントを計算
    const virtualPoint1 = this.calculateVirtualPoint1(points);
    if (!virtualPoint1) {
      return result;
    }

    let virtualPoint2 = null;
    if (this.is25Point) {
      virtualPoint2 = this.calculateVirtualPoint2(points);
      if (!virtualPoint2) {
        return result;
      }
    }

    let totalX = 0, totalY = 0, totalZ = 0;
    let totalMassRatio = 0;

    // 各セグメントの部分重心を計算
    for (const segment of this.bsp.segments) {
      // 末梢端と中枢端の座標を取得
      let distalPoint, proximalPoint;

      if (segment.distal === -1) {
        distalPoint = virtualPoint1;
      } else if (segment.distal === -2) {
        distalPoint = virtualPoint2;
      } else {
        distalPoint = points[segment.distal];
      }

      if (segment.proximal === -1) {
        proximalPoint = virtualPoint1;
      } else if (segment.proximal === -2) {
        proximalPoint = virtualPoint2;
      } else {
        proximalPoint = points[segment.proximal];
      }

      if (!distalPoint || !proximalPoint) {
        continue;
      }

      // 性別に応じたパラメータを選択
      const massRatio = this.sex === 'male' ? 
        segment.massRatioMale / 100 : segment.massRatioFemale / 100;
      const comRatio = this.sex === 'male' ? 
        segment.comRatioMale : segment.comRatioFemale;

      // 部分重心を計算
      const segmentCOM = this.calculateSegmentCOM(distalPoint, proximalPoint, comRatio);
      result.segmentCOMs.push({
        name: segment.name,
        com: segmentCOM,
        massRatio: massRatio
      });

      // 身体重心の計算に加算
      totalX += segmentCOM[0] * massRatio;
      totalY += segmentCOM[1] * massRatio;
      totalZ += segmentCOM[2] * massRatio;
      totalMassRatio += massRatio;
    }

    // 身体重心を計算
    if (totalMassRatio > 0) {
      result.bodyCOM = [totalX, totalY, totalZ];
      result.valid = true;
    }

    return result;
  }

  /**
   * 全フレームの身体重心を計算
   * @param {Array} motionData - 全フレームのモーションデータ
   * @returns {Array} - 全フレームの身体重心データ
   */
  calculateAllFrames(motionData) {
    const results = [];

    for (const frameData of motionData) {
      const comResult = this.calculateFrameCOM(frameData.points);
      results.push({
        frame: frameData.frame,
        ...comResult
      });
    }

    return results;
  }

  /**
   * 身体重心の移動軌跡を取得
   * @param {Array} comResults - calculateAllFramesの結果
   * @returns {Array} - 身体重心の軌跡 [[x,y,z], [x,y,z], ...]
   */
  getCOMTrajectory(comResults) {
    return comResults
      .filter(result => result.valid && result.bodyCOM)
      .map(result => result.bodyCOM);
  }

  /**
   * 特定のセグメントの重心軌跡を取得
   * @param {Array} comResults - calculateAllFramesの結果
   * @param {string} segmentName - セグメント名
   * @returns {Array} - セグメント重心の軌跡
   */
  getSegmentCOMTrajectory(comResults, segmentName) {
    const trajectory = [];

    for (const result of comResults) {
      if (!result.valid) continue;

      const segment = result.segmentCOMs.find(seg => seg.name === segmentName);
      if (segment) {
        trajectory.push(segment.com);
      }
    }

    return trajectory;
  }

  /**
   * 利用可能なBSP方法のリストを取得
   * @returns {Array} - BSP方法の配列
   */
  static getAvailableMethods() {
    return Object.keys(BSP_MAP);
  }

  /**
   * BSP方法の説明を取得
   * @param {string} method - BSP方法
   * @returns {string} - 説明文
   */
  static getMethodDescription(method) {
    const descriptions = {
      'ae14': '阿江14 (成人・23ポイント)',
      'ae15': '阿江15 (成人・25ポイント)',
      'okada14': '岡田14 (老人・23ポイント)',
      'okada15': '岡田15 (老人・25ポイント)',
      'yokoi_03_05_standard': '横井 3-5歳 標準体型',
      'yokoi_03_05_thin': '横井 3-5歳 痩身体型',
      'yokoi_03_05_obese': '横井 3-5歳 肥満体型',
      'yokoi_06_08_standard': '横井 6-8歳 標準体型',
      'yokoi_06_08_thin': '横井 6-8歳 痩身体型',
      'yokoi_06_08_obese': '横井 6-8歳 肥満体型'
    };
    return descriptions[method] || '不明な方法';
  }
}

// エクスポート
export { 
  BodyCenterOfMass, 
  BSP_AE14, 
  BSP_AE15, 
  BSP_OKADA14, 
  BSP_OKADA15,
  BSP_YOKOI_03_05_STANDARD,
  BSP_YOKOI_03_05_THIN,
  BSP_YOKOI_03_05_OBESE,
  BSP_YOKOI_06_08_STANDARD,
  BSP_YOKOI_06_08_THIN,
  BSP_YOKOI_06_08_OBESE
};
