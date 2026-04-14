/**
 * 身体重心計算モジュール
 * VBAのBSP(Body Segment Parameters)ロジックをJavaScriptに移植
 */

/**
 * 阿江14の身体セグメントパラメータ(BSP)
 * 23ポイントモデル用(胴体を1つのセグメントとして扱う)
 */
const BSP_AE14 = {
  segments: [
    {
      name: "右手",
      distal: 0,      // 右手先(0-indexed)
      proximal: 1,    // 右手首
      massRatioMale: 0.6,
      massRatioFemale: 0.6,
      comRatioMale: 89.1,
      comRatioFemale: 90.8
    },
    {
      name: "右前腕",
      distal: 1,      // 右手首
      proximal: 2,    // 右肘
      massRatioMale: 1.6,
      massRatioFemale: 1.5,
      comRatioMale: 41.5,
      comRatioFemale: 42.3
    },
    {
      name: "右上腕",
      distal: 2,      // 右肘
      proximal: 3,    // 右肩
      massRatioMale: 2.7,
      massRatioFemale: 2.6,
      comRatioMale: 52.9,
      comRatioFemale: 52.3
    },
    {
      name: "左手",
      distal: 4,      // 左手先
      proximal: 5,    // 左手首
      massRatioMale: 0.6,
      massRatioFemale: 0.6,
      comRatioMale: 89.1,
      comRatioFemale: 90.8
    },
    {
      name: "左前腕",
      distal: 5,      // 左手首
      proximal: 6,    // 左肘
      massRatioMale: 1.6,
      massRatioFemale: 1.5,
      comRatioMale: 41.5,
      comRatioFemale: 42.3
    },
    {
      name: "左上腕",
      distal: 6,      // 左肘
      proximal: 7,    // 左肩
      massRatioMale: 2.7,
      massRatioFemale: 2.6,
      comRatioMale: 52.9,
      comRatioFemale: 52.3
    },
    {
      name: "右足部",
      distal: 10,     // 右踵(右かかと)
      proximal: 8,    // 右つま先
      massRatioMale: 1.1,
      massRatioFemale: 1.1,
      comRatioMale: 59.5,
      comRatioFemale: 59.4
    },
    {
      name: "右下腿",
      distal: 11,     // 右足首
      proximal: 12,   // 右膝
      massRatioMale: 5.1,
      massRatioFemale: 5.3,
      comRatioMale: 40.6,
      comRatioFemale: 41.0
    },
    {
      name: "右大腿",
      distal: 12,     // 右膝
      proximal: 13,   // 右大転子
      massRatioMale: 11.0,
      massRatioFemale: 12.3,
      comRatioMale: 47.5,
      comRatioFemale: 45.8
    },
    {
      name: "左足部",
      distal: 16,     // 左踵(左かかと)
      proximal: 14,   // 左つま先
      massRatioMale: 1.1,
      massRatioFemale: 1.1,
      comRatioMale: 59.5,
      comRatioFemale: 59.4
    },
    {
      name: "左下腿",
      distal: 17,     // 左足首
      proximal: 18,   // 左膝
      massRatioMale: 5.1,
      massRatioFemale: 5.3,
      comRatioMale: 40.6,
      comRatioFemale: 41.0
    },
    {
      name: "左大腿",
      distal: 18,     // 左膝
      proximal: 19,   // 左大転子
      massRatioMale: 11.0,
      massRatioFemale: 12.3,
      comRatioMale: 47.5,
      comRatioFemale: 45.8
    },
    {
      name: "頭部",
      distal: 21,     // 耳珠点
      proximal: 20,   // 頭頂
      massRatioMale: 6.9,
      massRatioFemale: 7.5,
      comRatioMale: 82.1,
      comRatioFemale: 75.9
    },
    {
      name: "胴体",
      distal: -1,     // 大転子中点(仮想ポイント)
      proximal: 22,   // 胸骨上縁
      massRatioMale: 48.9,
      massRatioFemale: 45.7,
      comRatioMale: 49.3,
      comRatioFemale: 50.6
    }
  ]
};

/**
 * 阿江15の身体セグメントパラメータ(BSP)
 * 25ポイントモデル用(胴体を上胴と下胴に分割)
 */
const BSP_AE15 = {
  segments: [
    {
      name: "右手",
      distal: 0,
      proximal: 1,
      massRatioMale: 0.6,
      massRatioFemale: 0.6,
      comRatioMale: 89.1,
      comRatioFemale: 90.8
    },
    {
      name: "右前腕",
      distal: 1,
      proximal: 2,
      massRatioMale: 1.6,
      massRatioFemale: 1.5,
      comRatioMale: 41.5,
      comRatioFemale: 42.3
    },
    {
      name: "右上腕",
      distal: 2,
      proximal: 3,
      massRatioMale: 2.7,
      massRatioFemale: 2.6,
      comRatioMale: 52.9,
      comRatioFemale: 52.3
    },
    {
      name: "左手",
      distal: 4,
      proximal: 5,
      massRatioMale: 0.6,
      massRatioFemale: 0.6,
      comRatioMale: 89.1,
      comRatioFemale: 90.8
    },
    {
      name: "左前腕",
      distal: 5,
      proximal: 6,
      massRatioMale: 1.6,
      massRatioFemale: 1.5,
      comRatioMale: 41.5,
      comRatioFemale: 42.3
    },
    {
      name: "左上腕",
      distal: 6,
      proximal: 7,
      massRatioMale: 2.7,
      massRatioFemale: 2.6,
      comRatioMale: 52.9,
      comRatioFemale: 52.3
    },
    {
      name: "右足部",
      distal: 10,
      proximal: 8,
      massRatioMale: 1.1,
      massRatioFemale: 1.1,
      comRatioMale: 59.5,
      comRatioFemale: 59.4
    },
    {
      name: "右下腿",
      distal: 11,
      proximal: 12,
      massRatioMale: 5.1,
      massRatioFemale: 5.3,
      comRatioMale: 40.6,
      comRatioFemale: 41.0
    },
    {
      name: "右大腿",
      distal: 12,
      proximal: 13,
      massRatioMale: 11.0,
      massRatioFemale: 12.3,
      comRatioMale: 47.5,
      comRatioFemale: 45.8
    },
    {
      name: "左足部",
      distal: 16,
      proximal: 14,
      massRatioMale: 1.1,
      massRatioFemale: 1.1,
      comRatioMale: 59.5,
      comRatioFemale: 59.4
    },
    {
      name: "左下腿",
      distal: 17,
      proximal: 18,
      massRatioMale: 5.1,
      massRatioFemale: 5.3,
      comRatioMale: 40.6,
      comRatioFemale: 41.0
    },
    {
      name: "左大腿",
      distal: 18,
      proximal: 19,
      massRatioMale: 11.0,
      massRatioFemale: 12.3,
      comRatioMale: 47.5,
      comRatioFemale: 45.8
    },
    {
      name: "頭部",
      distal: 21,
      proximal: 20,
      massRatioMale: 6.9,
      massRatioFemale: 7.5,
      comRatioMale: 82.1,
      comRatioFemale: 75.9
    },
    {
      name: "上胴",
      distal: -2,     // 肋骨下端中点(仮想ポイント2)
      proximal: 22,   // 胸骨上縁
      massRatioMale: 30.2,
      massRatioFemale: 26.7,
      comRatioMale: 42.8,
      comRatioFemale: 43.8
    },
    {
      name: "下胴",
      distal: -1,     // 大転子中点(仮想ポイント1)
      proximal: -2,   // 肋骨下端中点(仮想ポイント2)
      massRatioMale: 18.7,
      massRatioFemale: 19.0,
      comRatioMale: 60.9,
      comRatioFemale: 59.7
    }
  ]
};

/**
 * 横井の身体セグメントパラメータ(BSP) - 子ども用
 * 年齢・体型別のパラメータ
 * 23ポイントモデル用
 */
const BSP_YOKOI_CHILD = {
  // 年齢別パラメータ（3～15歳）
  ageParams: {
    // 年齢をキーとした質量比と質量中心比の調整係数
    // 基準：阿江14を100%として、成長に伴う変化を反映
    headRatioByAge: {
      3: 1.5, 4: 1.45, 5: 1.4, 6: 1.35, 7: 1.3, 8: 1.25,
      9: 1.2, 10: 1.15, 11: 1.12, 12: 1.08, 13: 1.05, 14: 1.02, 15: 1.0
    },
    trunkRatioByAge: {
      3: 0.9, 4: 0.92, 5: 0.94, 6: 0.95, 7: 0.96, 8: 0.97,
      9: 0.98, 10: 0.99, 11: 0.995, 12: 1.0, 13: 1.0, 14: 1.0, 15: 1.0
    }
  },
  // 体型別の質量比調整係数
  bodyTypeFactors: {
    thin: { trunk: 0.95, limbs: 1.05 },      // 痩身：胴体軽い、四肢相対的に重い
    normal: { trunk: 1.0, limbs: 1.0 },      // 標準
    obese: { trunk: 1.05, limbs: 0.95 }      // 肥満：胴体重い、四肢相対的に軽い
  }
};

/**
 * 岡田の身体セグメントパラメータ(BSP) - 高齢者用（65歳以上）
 * 23ポイントモデル用
 */
const BSP_OKADA_ELDERLY = {
  segments: [
    {
      name: "右手",
      distal: 0,
      proximal: 1,
      massRatioMale: 0.6,
      massRatioFemale: 0.6,
      comRatioMale: 88.5,    // 高齢者は筋肉減少で中心が末梢寄りに
      comRatioFemale: 90.2
    },
    {
      name: "右前腕",
      distal: 1,
      proximal: 2,
      massRatioMale: 1.5,    // 筋肉量減少
      massRatioFemale: 1.4,
      comRatioMale: 41.0,
      comRatioFemale: 42.0
    },
    {
      name: "右上腕",
      distal: 2,
      proximal: 3,
      massRatioMale: 2.6,
      massRatioFemale: 2.5,
      comRatioMale: 52.5,
      comRatioFemale: 52.0
    },
    {
      name: "左手",
      distal: 4,
      proximal: 5,
      massRatioMale: 0.6,
      massRatioFemale: 0.6,
      comRatioMale: 88.5,
      comRatioFemale: 90.2
    },
    {
      name: "左前腕",
      distal: 5,
      proximal: 6,
      massRatioMale: 1.5,
      massRatioFemale: 1.4,
      comRatioMale: 41.0,
      comRatioFemale: 42.0
    },
    {
      name: "左上腕",
      distal: 6,
      proximal: 7,
      massRatioMale: 2.6,
      massRatioFemale: 2.5,
      comRatioMale: 52.5,
      comRatioFemale: 52.0
    },
    {
      name: "右足部",
      distal: 10,
      proximal: 8,
      massRatioMale: 1.0,
      massRatioFemale: 1.0,
      comRatioMale: 59.0,
      comRatioFemale: 59.0
    },
    {
      name: "右下腿",
      distal: 11,
      proximal: 12,
      massRatioMale: 4.9,
      massRatioFemale: 5.1,
      comRatioMale: 40.3,
      comRatioFemale: 40.7
    },
    {
      name: "右大腿",
      distal: 12,
      proximal: 13,
      massRatioMale: 10.5,
      massRatioFemale: 12.0,
      comRatioMale: 47.0,
      comRatioFemale: 45.5
    },
    {
      name: "左足部",
      distal: 16,
      proximal: 14,
      massRatioMale: 1.0,
      massRatioFemale: 1.0,
      comRatioMale: 59.0,
      comRatioFemale: 59.0
    },
    {
      name: "左下腿",
      distal: 17,
      proximal: 18,
      massRatioMale: 4.9,
      massRatioFemale: 5.1,
      comRatioMale: 40.3,
      comRatioFemale: 40.7
    },
    {
      name: "左大腿",
      distal: 18,
      proximal: 19,
      massRatioMale: 10.5,
      massRatioFemale: 12.0,
      comRatioMale: 47.0,
      comRatioFemale: 45.5
    },
    {
      name: "頭部",
      distal: 21,
      proximal: 20,
      massRatioMale: 7.2,    // 相対的に頭部が重くなる（筋肉減少のため）
      massRatioFemale: 7.8,
      comRatioMale: 81.5,
      comRatioFemale: 75.5
    },
    {
      name: "胴体",
      distal: -1,
      proximal: 22,
      massRatioMale: 51.0,   // 体幹部の相対的な増加（脂肪増加）
      massRatioFemale: 47.5,
      comRatioMale: 49.5,
      comRatioFemale: 51.0
    }
  ]
};

/**
 * 身体重心計算クラス
 */
class BodyCenterOfMass {
  /**
   * コンストラクタ
   * @param {Object} config - 設定オブジェクト
   *   {
   *     method: 'ae14'|'ae15',
   *     sex: 'male'|'female',
   *     ageGroup: 'adult'|'child'|'elderly',
   *     childAge: number (3-17),
   *     bodyType: 'thin'|'normal'|'obese'
   *   }
   */
  constructor(config = {}) {
    this.method = config.method || 'ae14';
    this.sex = config.sex || 'male';
    this.ageGroup = config.ageGroup || 'adult';
    this.childAge = config.childAge || 6;
    this.bodyType = config.bodyType || 'normal';
    
    // BSPデータを選択
    this.selectBSP();
  }

  /**
   * 年代・設定に応じたBSPを選択
   */
  selectBSP() {
    if (this.ageGroup === 'child') {
      // 子ども用：阿江14をベースに年齢・体型で調整
      this.bsp = this.createChildBSP();
    } else if (this.ageGroup === 'elderly') {
      // 高齢者用：岡田のパラメータ
      this.bsp = BSP_OKADA_ELDERLY;
    } else {
      // 大人用：阿江14または阿江15
      this.bsp = this.method === 'ae15' ? BSP_AE15 : BSP_AE14;
    }
  }

  /**
   * 子ども用のBSPを動的に生成（年齢・体型を考慮）
   * @returns {Object} BSPデータ
   */
  createChildBSP() {
    // 年齢を整数に丸める（3-15歳の範囲に制限）
    const age = Math.max(3, Math.min(15, Math.round(this.childAge)));
    
    // 年齢別の調整係数を取得
    const headRatio = BSP_YOKOI_CHILD.ageParams.headRatioByAge[age] || 1.0;
    const trunkRatio = BSP_YOKOI_CHILD.ageParams.trunkRatioByAge[age] || 1.0;
    
    // 体型別の調整係数を取得
    const bodyTypeFactor = BSP_YOKOI_CHILD.bodyTypeFactors[this.bodyType] || BSP_YOKOI_CHILD.bodyTypeFactors.normal;
    
    // 阿江14をベースに調整
    const adjustedSegments = BSP_AE14.segments.map(segment => {
      let massRatioMale = segment.massRatioMale;
      let massRatioFemale = segment.massRatioFemale;
      
      // 頭部の調整
      if (segment.name === '頭部') {
        massRatioMale *= headRatio;
        massRatioFemale *= headRatio;
      }
      // 胴体の調整
      else if (segment.name === '胴体') {
        massRatioMale *= trunkRatio * bodyTypeFactor.trunk;
        massRatioFemale *= trunkRatio * bodyTypeFactor.trunk;
      }
      // 四肢の調整
      else {
        massRatioMale *= bodyTypeFactor.limbs;
        massRatioFemale *= bodyTypeFactor.limbs;
      }
      
      return {
        ...segment,
        massRatioMale,
        massRatioFemale
      };
    });
    
    // 質量比の合計を100%に正規化
    const totalMassRatioMale = adjustedSegments.reduce((sum, seg) => sum + seg.massRatioMale, 0);
    const totalMassRatioFemale = adjustedSegments.reduce((sum, seg) => sum + seg.massRatioFemale, 0);
    
    const normalizedSegments = adjustedSegments.map(segment => ({
      ...segment,
      massRatioMale: (segment.massRatioMale / totalMassRatioMale) * 100,
      massRatioFemale: (segment.massRatioFemale / totalMassRatioFemale) * 100
    }));
    
    return {
      segments: normalizedSegments
    };
  }

  /**
   * 仮想ポイント(大転子中点)を計算
   * @param {Array} points - フレーム内の全ポイント座標 [[x,y,z], [x,y,z], ...]
   * @returns {Array} - 大転子中点の座標 [x, y, z]
   */
  calculateVirtualPoint1(points) {
    // 右大転子(13)と左大転子(19)の中点
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
   * 仮想ポイント(肋骨下端中点)を計算 - 25ポイントモデルのみ
   * @param {Array} points - フレーム内の全ポイント座標
   * @returns {Array} - 肋骨下端中点の座標 [x, y, z]
   */
  calculateVirtualPoint2(points) {
    // 右肋骨下端(23)と左肋骨下端(24)の中点
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
    if (this.method === 'ae15') {
      virtualPoint2 = this.calculateVirtualPoint2(points);
      if (!virtualPoint2) {
        return result;
      }
    }

    // 拡張ポイント配列(実測ポイント + 仮想ポイント)
    const extendedPoints = [...points];
    if (virtualPoint1) extendedPoints.push(virtualPoint1);  // index: 23 or 25
    if (virtualPoint2) extendedPoints.push(virtualPoint2);  // index: 26 (ae15のみ)

    let totalX = 0, totalY = 0, totalZ = 0;
    let totalMassRatio = 0;

    // 各セグメントの部分重心を計算
    for (const segment of this.bsp.segments) {
      // 末梢端と中枢端の座標を取得
      let distalPoint, proximalPoint;

      if (segment.distal === -1) {
        // 大転子中点(仮想ポイント1)
        distalPoint = virtualPoint1;
      } else if (segment.distal === -2) {
        // 肋骨下端中点(仮想ポイント2)
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
   *   [
   *     {frame: 0, points: [[x,y,z], [x,y,z], ...]},
   *     {frame: 1, points: [[x,y,z], [x,y,z], ...]},
   *     ...
   *   ]
   * @returns {Array} - 全フレームの身体重心データ
   *   [
   *     {frame: 0, bodyCOM: [x,y,z], segmentCOMs: [...], valid: boolean},
   *     ...
   *   ]
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
}

// エクスポート
export { BodyCenterOfMass, BSP_AE14, BSP_AE15, BSP_YOKOI_CHILD, BSP_OKADA_ELDERLY };
