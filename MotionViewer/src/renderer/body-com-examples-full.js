/**
 * 身体重心計算モジュール(完全版)の使用例
 * 成人・老人・子どものすべてのモデルを網羅
 */

import { BodyCenterOfMass } from './body-com-full.js';

/**
 * サンプルの23ポイントデータを生成
 */
function generateSample23Points() {
  return [
    [100, 200, 50],   // 0: 右手先
    [110, 210, 55],   // 1: 右手首
    [120, 220, 60],   // 2: 右肘
    [130, 240, 70],   // 3: 右肩
    [90, 200, 50],    // 4: 左手先
    [80, 210, 55],    // 5: 左手首
    [70, 220, 60],    // 6: 左肘
    [60, 240, 70],    // 7: 左肩
    [140, 50, 20],    // 8: 右つま先
    [130, 40, 15],    // 9: 右母指球
    [120, 30, 10],    // 10: 右かかと
    [125, 100, 30],   // 11: 右足首
    [130, 200, 60],   // 12: 右膝
    [135, 300, 90],   // 13: 右大転子
    [50, 50, 20],     // 14: 左つま先
    [60, 40, 15],     // 15: 左母指球
    [70, 30, 10],     // 16: 左かかと
    [65, 100, 30],    // 17: 左足首
    [60, 200, 60],    // 18: 左膝
    [55, 300, 90],    // 19: 左大転子
    [95, 450, 150],   // 20: 頭頂
    [95, 430, 140],   // 21: 耳珠点
    [95, 380, 120]    // 22: 胸骨上縁
  ];
}

/**
 * サンプルの25ポイントデータを生成
 */
function generateSample25Points() {
  const points23 = generateSample23Points();
  return [
    ...points23,
    [140, 330, 100],  // 23: 右肋骨下端
    [50, 330, 100]    // 24: 左肋骨下端
  ];
}

/**
 * 例1: 成人モデル(阿江14/15)の比較
 */
function example1_AdultModels() {
  console.log('=== 例1: 成人モデル(阿江14 vs 阿江15) ===\n');
  
  const points23 = generateSample23Points();
  const points25 = generateSample25Points();
  
  // 阿江14(23ポイント)
  const ae14 = new BodyCenterOfMass('ae14', 'male');
  const result14 = ae14.calculateFrameCOM(points23);
  
  console.log('阿江14(男性):');
  console.log(`  身体重心: [${result14.bodyCOM.map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  セグメント数: ${result14.segmentCOMs.length}`);
  
  // 阿江15(25ポイント)
  const ae15 = new BodyCenterOfMass('ae15', 'male');
  const result15 = ae15.calculateFrameCOM(points25);
  
  console.log('\n阿江15(男性):');
  console.log(`  身体重心: [${result15.bodyCOM.map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  セグメント数: ${result15.segmentCOMs.length}`);
  
  // 胴体セグメントの違いを確認
  const ae14Trunk = result14.segmentCOMs.find(s => s.name === '胴体');
  const ae15Upper = result15.segmentCOMs.find(s => s.name === '上胴');
  const ae15Lower = result15.segmentCOMs.find(s => s.name === '下胴');
  
  console.log('\n胴体セグメントの比較:');
  console.log(`  阿江14 胴体: 質量比 ${(ae14Trunk.massRatio * 100).toFixed(1)}%`);
  console.log(`  阿江15 上胴: 質量比 ${(ae15Upper.massRatio * 100).toFixed(1)}%`);
  console.log(`  阿江15 下胴: 質量比 ${(ae15Lower.massRatio * 100).toFixed(1)}%`);
}

/**
 * 例2: 老人モデル(岡田14/15)
 */
function example2_ElderlyModels() {
  console.log('\n\n=== 例2: 老人モデル(岡田14/15) ===\n');
  
  const points23 = generateSample23Points();
  const points25 = generateSample25Points();
  
  // 岡田14(23ポイント)
  const okada14Male = new BodyCenterOfMass('okada14', 'male');
  const okada14Female = new BodyCenterOfMass('okada14', 'female');
  
  const result14Male = okada14Male.calculateFrameCOM(points23);
  const result14Female = okada14Female.calculateFrameCOM(points23);
  
  console.log('岡田14 老人モデル:');
  console.log(`  男性 身体重心: [${result14Male.bodyCOM.map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  女性 身体重心: [${result14Female.bodyCOM.map(v => v.toFixed(2)).join(', ')}]`);
  
  // 岡田15(25ポイント)
  const okada15 = new BodyCenterOfMass('okada15', 'male');
  const result15 = okada15.calculateFrameCOM(points25);
  
  console.log(`\n岡田15(男性):');
  console.log(`  身体重心: [${result15.bodyCOM.map(v => v.toFixed(2)).join(', ')}]`);
  
  // 成人(阿江14)との比較
  const ae14 = new BodyCenterOfMass('ae14', 'male');
  const resultAe14 = ae14.calculateFrameCOM(points23);
  
  console.log('\n成人 vs 老人(男性):');
  console.log(`  阿江14(成人): [${resultAe14.bodyCOM.map(v => v.toFixed(2)).join(', ')}]`);
  console.log(`  岡田14(老人): [${result14Male.bodyCOM.map(v => v.toFixed(2)).join(', ')}]`);
}

/**
 * 例3: 子どもモデル(横井 3-5歳)の体型比較
 */
function example3_ChildModels_3_5() {
  console.log('\n\n=== 例3: 子どもモデル(3-5歳)の体型比較 ===\n');
  
  const points = generateSample23Points();
  
  const bodyTypes = ['standard', 'thin', 'obese'];
  const bodyTypeNames = {
    'standard': '標準体型',
    'thin': '痩身体型',
    'obese': '肥満体型'
  };
  
  console.log('3-5歳児の体型別身体重心:');
  
  for (const bodyType of bodyTypes) {
    const method = `yokoi_03_05_${bodyType}`;
    const calculator = new BodyCenterOfMass(method, 'male');
    const result = calculator.calculateFrameCOM(points);
    
    console.log(`\n${bodyTypeNames[bodyType]}:`);
    console.log(`  身体重心: [${result.bodyCOM.map(v => v.toFixed(2)).join(', ')}]`);
    
    // 頭部の質量比を確認(子どもは頭部が大きい)
    const head = result.segmentCOMs.find(s => s.name === '頭部');
    console.log(`  頭部質量比: ${(head.massRatio * 100).toFixed(1)}%`);
    
    // 胴体の質量比を確認
    const trunk = result.segmentCOMs.find(s => s.name === '胴体');
    console.log(`  胴体質量比: ${(trunk.massRatio * 100).toFixed(1)}%`);
  }
}

/**
 * 例4: 子どもモデル(横井 6-8歳)の体型比較
 */
function example4_ChildModels_6_8() {
  console.log('\n\n=== 例4: 子どもモデル(6-8歳)の体型比較 ===\n');
  
  const points = generateSample23Points();
  
  const bodyTypes = ['standard', 'thin', 'obese'];
  const bodyTypeNames = {
    'standard': '標準体型',
    'thin': '痩身体型',
    'obese': '肥満体型'
  };
  
  console.log('6-8歳児の体型別身体重心:');
  
  for (const bodyType of bodyTypes) {
    const method = `yokoi_06_08_${bodyType}`;
    const calculator = new BodyCenterOfMass(method, 'male');
    const result = calculator.calculateFrameCOM(points);
    
    console.log(`\n${bodyTypeNames[bodyType]}:`);
    console.log(`  身体重心: [${result.bodyCOM.map(v => v.toFixed(2)).join(', ')}]`);
    
    // 頭部の質量比を確認
    const head = result.segmentCOMs.find(s => s.name === '頭部');
    console.log(`  頭部質量比: ${(head.massRatio * 100).toFixed(1)}%`);
  }
}

/**
 * 例5: 年齢による頭部質量比の変化
 */
function example5_HeadMassRatioByAge() {
  console.log('\n\n=== 例5: 年齢による頭部質量比の変化 ===\n');
  
  const points23 = generateSample23Points();
  
  const ageGroups = [
    { method: 'yokoi_03_05_standard', age: '3-5歳' },
    { method: 'yokoi_06_08_standard', age: '6-8歳' },
    { method: 'ae14', age: '成人' },
    { method: 'okada14', age: '老人' }
  ];
  
  console.log('標準体型における年齢別頭部質量比:');
  
  for (const group of ageGroups) {
    const calculator = new BodyCenterOfMass(group.method, 'male');
    const result = calculator.calculateFrameCOM(points23);
    const head = result.segmentCOMs.find(s => s.name === '頭部');
    
    console.log(`  ${group.age}: ${(head.massRatio * 100).toFixed(1)}%`);
  }
  
  console.log('\n→ 子どもは頭部の質量比が大きく、成長とともに減少');
}

/**
 * 例6: 利用可能なすべてのモデルを列挙
 */
function example6_ListAllModels() {
  console.log('\n\n=== 例6: 利用可能なすべてのBSPモデル ===\n');
  
  const methods = BodyCenterOfMass.getAvailableMethods();
  
  console.log('成人モデル:');
  methods.filter(m => m.startsWith('ae')).forEach(m => {
    console.log(`  ${m}: ${BodyCenterOfMass.getMethodDescription(m)}`);
  });
  
  console.log('\n老人モデル:');
  methods.filter(m => m.startsWith('okada')).forEach(m => {
    console.log(`  ${m}: ${BodyCenterOfMass.getMethodDescription(m)}`);
  });
  
  console.log('\n子どもモデル(3-5歳):');
  methods.filter(m => m.includes('03_05')).forEach(m => {
    console.log(`  ${m}: ${BodyCenterOfMass.getMethodDescription(m)}`);
  });
  
  console.log('\n子どもモデル(6-8歳):');
  methods.filter(m => m.includes('06_08')).forEach(m => {
    console.log(`  ${m}: ${BodyCenterOfMass.getMethodDescription(m)}`);
  });
}

/**
 * 例7: モデル選択のヘルパー関数
 */
function example7_ModelSelectionHelper() {
  console.log('\n\n=== 例7: モデル選択ヘルパー ===\n');
  
  /**
   * 年齢と体型に基づいて適切なBSPモデルを選択
   */
  function selectBSPModel(age, bodyType = 'standard', pointCount = 23) {
    // 3-5歳
    if (age >= 3 && age <= 5) {
      return `yokoi_03_05_${bodyType}`;
    }
    // 6-8歳
    else if (age >= 6 && age <= 8) {
      return `yokoi_06_08_${bodyType}`;
    }
    // 成人(18-64歳)
    else if (age >= 18 && age < 65) {
      return pointCount === 25 ? 'ae15' : 'ae14';
    }
    // 老人(65歳以上)
    else if (age >= 65) {
      return pointCount === 25 ? 'okada15' : 'okada14';
    }
    // デフォルト
    else {
      return 'ae14';
    }
  }
  
  // テスト
  const testCases = [
    { age: 4, bodyType: 'standard', points: 23 },
    { age: 7, bodyType: 'thin', points: 23 },
    { age: 30, bodyType: 'standard', points: 23 },
    { age: 30, bodyType: 'standard', points: 25 },
    { age: 70, bodyType: 'standard', points: 23 },
    { age: 70, bodyType: 'standard', points: 25 }
  ];
  
  console.log('年齢・体型・ポイント数に基づくモデル選択:');
  testCases.forEach(test => {
    const model = selectBSPModel(test.age, test.bodyType, test.points);
    const desc = BodyCenterOfMass.getMethodDescription(model);
    console.log(`  ${test.age}歳, ${test.bodyType}, ${test.points}点 → ${model} (${desc})`);
  });
}

/**
 * 例8: 全年齢層の身体重心軌跡比較
 */
function example8_TrajectoryComparison() {
  console.log('\n\n=== 例8: 全年齢層の身体重心軌跡 ===\n');
  
  // 10フレーム分のモーションデータを生成
  const motionData = [];
  for (let frame = 0; frame < 10; frame++) {
    const points = generateSample23Points().map(point => 
      point.map((coord, idx) => coord + Math.sin(frame * 0.3) * (idx === 1 ? 10 : 5))
    );
    motionData.push({ frame, points });
  }
  
  const models = [
    { method: 'yokoi_03_05_standard', label: '幼児(3-5歳)' },
    { method: 'yokoi_06_08_standard', label: '児童(6-8歳)' },
    { method: 'ae14', label: '成人' },
    { method: 'okada14', label: '老人' }
  ];
  
  console.log('各年齢層の身体重心軌跡(最初の3フレーム):');
  
  for (const model of models) {
    const calculator = new BodyCenterOfMass(model.method, 'male');
    const results = calculator.calculateAllFrames(motionData);
    const trajectory = calculator.getCOMTrajectory(results);
    
    console.log(`\n${model.label}:`);
    trajectory.slice(0, 3).forEach((point, i) => {
      console.log(`  Frame ${i}: [${point.map(v => v.toFixed(2)).join(', ')}]`);
    });
  }
}

// すべての例を実行
console.log('身体重心計算モジュール(完全版) - 使用例\n');
console.log('対応モデル: 成人(阿江)・老人(岡田)・子ども(横井)\n');

example1_AdultModels();
example2_ElderlyModels();
example3_ChildModels_3_5();
example4_ChildModels_6_8();
example5_HeadMassRatioByAge();
example6_ListAllModels();
example7_ModelSelectionHelper();
example8_TrajectoryComparison();

console.log('\n\n=== すべての例が完了しました ===');
console.log('\n利用可能なBSPモデル数:', BodyCenterOfMass.getAvailableMethods().length);
