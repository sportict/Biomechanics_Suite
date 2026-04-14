/**
 * 身体重心計算モジュールの使用例
 */

import { BodyCenterOfMass } from './body-com.js';

/**
 * 使用例1: 基本的な身体重心計算
 */
function example1_BasicUsage() {
  console.log('=== 例1: 基本的な使用方法 ===');
  
  // 阿江14、男性のパラメータで初期化
  const bodyCOM = new BodyCenterOfMass('ae14', 'male');
  
  // サンプルの1フレーム分のポイントデータ(23ポイント)
  const samplePoints = [
    [100, 200, 50],   // 0: 右手先
    [110, 210, 55],   // 1: 右手首
    [120, 220, 60],   // 2: 右肘
    [130, 240, 70],   // 3: 右肩
    [90, 200, 50],    // 4: 左手先
    [80, 210, 55],    // 5: 左手首
    [70, 220, 60],    // 6: 左肘
    [60, 240, 70],    // 7: 左肩
    [140, 50, 20],    // 8: 右つま先
    [130, 40, 15],    // 9: 右母指球(未使用)
    [120, 30, 10],    // 10: 右かかと
    [125, 100, 30],   // 11: 右足首
    [130, 200, 60],   // 12: 右膝
    [135, 300, 90],   // 13: 右大転子
    [50, 50, 20],     // 14: 左つま先
    [60, 40, 15],     // 15: 左母指球(未使用)
    [70, 30, 10],     // 16: 左かかと
    [65, 100, 30],    // 17: 左足首
    [60, 200, 60],    // 18: 左膝
    [55, 300, 90],    // 19: 左大転子
    [95, 450, 150],   // 20: 頭頂
    [95, 430, 140],   // 21: 耳珠点
    [95, 380, 120]    // 22: 胸骨上縁
  ];
  
  // 1フレーム分の身体重心を計算
  const result = bodyCOM.calculateFrameCOM(samplePoints);
  
  console.log('身体重心:', result.bodyCOM);
  console.log('有効:', result.valid);
  console.log('セグメント数:', result.segmentCOMs.length);
  
  // 各セグメントの部分重心を表示
  console.log('\n部分重心:');
  result.segmentCOMs.forEach(segment => {
    console.log(`  ${segment.name}: [${segment.com.map(v => v.toFixed(2)).join(', ')}] (質量比: ${(segment.massRatio * 100).toFixed(1)}%)`);
  });
}

/**
 * 使用例2: 全フレームの身体重心計算
 */
function example2_AllFrames() {
  console.log('\n=== 例2: 全フレームの計算 ===');
  
  const bodyCOM = new BodyCenterOfMass('ae14', 'male');
  
  // モーションデータのサンプル(実際にはCSVファイルなどから読み込む)
  const motionData = [];
  
  // 10フレーム分のダミーデータを生成
  for (let frame = 0; frame < 10; frame++) {
    const points = [];
    for (let i = 0; i < 23; i++) {
      points.push([
        100 + Math.sin(frame * 0.1) * 10,
        200 + i * 20,
        50 + Math.cos(frame * 0.1) * 5
      ]);
    }
    motionData.push({ frame, points });
  }
  
  // 全フレームの身体重心を計算
  const results = bodyCOM.calculateAllFrames(motionData);
  
  console.log('計算フレーム数:', results.length);
  console.log('\n最初の3フレームの身体重心:');
  results.slice(0, 3).forEach(result => {
    if (result.valid) {
      console.log(`  Frame ${result.frame}: [${result.bodyCOM.map(v => v.toFixed(2)).join(', ')}]`);
    }
  });
  
  // 身体重心の軌跡を取得
  const trajectory = bodyCOM.getCOMTrajectory(results);
  console.log('\n身体重心軌跡のポイント数:', trajectory.length);
}

/**
 * 使用例3: 阿江15(25ポイントモデル)の使用
 */
function example3_AE15Model() {
  console.log('\n=== 例3: 阿江15(25ポイント)モデル ===');
  
  // 阿江15、女性のパラメータで初期化
  const bodyCOM = new BodyCenterOfMass('ae15', 'female');
  
  // 25ポイントのサンプルデータ
  const samplePoints = [
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
    [95, 380, 120],   // 22: 胸骨上縁
    [140, 330, 100],  // 23: 右肋骨下端
    [50, 330, 100]    // 24: 左肋骨下端
  ];
  
  const result = bodyCOM.calculateFrameCOM(samplePoints);
  
  console.log('身体重心:', result.bodyCOM);
  console.log('セグメント数:', result.segmentCOMs.length);
  
  // 上胴と下胴の部分重心を確認
  const upperTrunk = result.segmentCOMs.find(s => s.name === '上胴');
  const lowerTrunk = result.segmentCOMs.find(s => s.name === '下胴');
  
  if (upperTrunk) {
    console.log(`上胴: [${upperTrunk.com.map(v => v.toFixed(2)).join(', ')}]`);
  }
  if (lowerTrunk) {
    console.log(`下胴: [${lowerTrunk.com.map(v => v.toFixed(2)).join(', ')}]`);
  }
}

/**
 * 使用例4: 特定のセグメント重心軌跡の取得
 */
function example4_SegmentTrajectory() {
  console.log('\n=== 例4: セグメント重心軌跡 ===');
  
  const bodyCOM = new BodyCenterOfMass('ae14', 'male');
  
  // サンプルモーションデータ
  const motionData = [];
  for (let frame = 0; frame < 5; frame++) {
    const points = [];
    for (let i = 0; i < 23; i++) {
      points.push([
        100 + frame * 10,
        200 + i * 20,
        50 + frame * 5
      ]);
    }
    motionData.push({ frame, points });
  }
  
  const results = bodyCOM.calculateAllFrames(motionData);
  
  // 右大腿の重心軌跡を取得
  const rightThighTrajectory = bodyCOM.getSegmentCOMTrajectory(results, '右大腿');
  
  console.log('右大腿の重心軌跡:');
  rightThighTrajectory.forEach((point, index) => {
    console.log(`  Frame ${index}: [${point.map(v => v.toFixed(2)).join(', ')}]`);
  });
}

/**
 * 使用例5: Three.jsとの統合例
 */
function example5_ThreeJsIntegration() {
  console.log('\n=== 例5: Three.jsとの統合 ===');
  
  // Three.jsで身体重心を可視化する例
  console.log(`
  // Three.jsシーンに身体重心を追加する例:
  
  import * as THREE from 'three';
  import { BodyCenterOfMass } from './body-com.js';
  
  // 身体重心計算オブジェクトを作成
  const bodyCOM = new BodyCenterOfMass('ae14', 'male');
  
  // モーションデータから身体重心を計算
  const results = bodyCOM.calculateAllFrames(motionData);
  
  // Three.jsで身体重心を表示
  const comGeometry = new THREE.SphereGeometry(10, 16, 16);
  const comMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const comSphere = new THREE.Mesh(comGeometry, comMaterial);
  
  // アニメーションループ内で更新
  function animate() {
    const currentResult = results[currentFrame];
    if (currentResult.valid) {
      comSphere.position.set(
        currentResult.bodyCOM[0],
        currentResult.bodyCOM[1],
        currentResult.bodyCOM[2]
      );
    }
    renderer.render(scene, camera);
  }
  
  // 身体重心の軌跡を線として表示
  const trajectory = bodyCOM.getCOMTrajectory(results);
  const trajectoryGeometry = new THREE.BufferGeometry();
  const positions = new Float32Array(trajectory.length * 3);
  
  trajectory.forEach((point, i) => {
    positions[i * 3] = point[0];
    positions[i * 3 + 1] = point[1];
    positions[i * 3 + 2] = point[2];
  });
  
  trajectoryGeometry.setAttribute('position', 
    new THREE.BufferAttribute(positions, 3));
  
  const trajectoryMaterial = new THREE.LineBasicMaterial({ 
    color: 0xff0000 
  });
  const trajectoryLine = new THREE.Line(
    trajectoryGeometry, 
    trajectoryMaterial
  );
  
  scene.add(trajectoryLine);
  `);
}

// すべての例を実行
console.log('身体重心計算モジュール - 使用例\n');
example1_BasicUsage();
example2_AllFrames();
example3_AE15Model();
example4_SegmentTrajectory();
example5_ThreeJsIntegration();

console.log('\n=== すべての例が完了しました ===');
