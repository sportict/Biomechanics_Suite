# 身体重心計算モジュール統合ガイド

## 概要

このドキュメントは、VBAから移植した身体重心計算モジュール(`body-com.js`)を既存のElectronアプリ(`app.js`)に統合する方法を説明します。

## ファイル構成

```
/mnt/project/
├── app.js                    # 既存のメインアプリケーション
├── body-com.js               # 新規: 身体重心計算モジュール
├── body-com-examples.js      # 新規: 使用例
├── filter.js                 # 既存: フィルター処理
├── index.html                # 既存: メインHTML
└── ...
```

## 統合手順

### 1. ファイルの配置

`body-com.js`を既存のプロジェクトディレクトリにコピーします。

```bash
cp body-com.js /mnt/project/
```

### 2. app.jsへのインポート追加

`app.js`の先頭部分に以下のインポート文を追加します:

```javascript
// 既存のインポート
import * as THREE from './lib/three.module.js';
import { OrbitControls } from './lib/OrbitControls.js';
import { butterWinter, butterBryant, addPadding, removePadding, calculateWaWCutoff } from './filter.js';

// 新規追加: 身体重心計算モジュール
import { BodyCenterOfMass } from './body-com.js';
```

### 3. MotionViewerクラスへのプロパティ追加

`MotionViewer`クラスのコンストラクタに身体重心関連のプロパティを追加します:

```javascript
class MotionViewer {
  constructor() {
    // 既存のプロパティ...
    
    // 新規追加: 身体重心計算
    this.bodyCOMCalculator = null;  // BodyCenterOfMassインスタンス
    this.comResults = null;         // 計算結果
    this.comSphere = null;          // 身体重心表示用の球体
    this.comTrajectoryLine = null;  // 身体重心軌跡線
    this.showCOM = false;           // 身体重心表示ON/OFF
    this.showCOMTrajectory = false; // 軌跡表示ON/OFF
  }
}
```

### 4. 身体重心計算の初期化メソッド追加

データ読み込み後に身体重心を計算するメソッドを追加します:

```javascript
/**
 * 身体重心を計算
 * @param {string} method - 'ae14' or 'ae15'
 * @param {string} sex - 'male' or 'female'
 */
calculateBodyCOM(method = 'ae14', sex = 'male') {
  if (!this.motionData || !this.motionData.frames) {
    console.error('モーションデータが読み込まれていません');
    return;
  }

  console.log(`身体重心を計算中... (方法: ${method}, 性別: ${sex})`);

  // BodyCenterOfMassインスタンスを作成
  this.bodyCOMCalculator = new BodyCenterOfMass(method, sex);

  // モーションデータを変換
  const motionDataForCOM = this.motionData.frames.map((frame, index) => ({
    frame: index,
    points: frame.points
  }));

  // 全フレームの身体重心を計算
  this.comResults = this.bodyCOMCalculator.calculateAllFrames(motionDataForCOM);

  console.log(`身体重心計算完了: ${this.comResults.length}フレーム`);

  // Three.jsシーンに身体重心を追加
  this.setupCOMVisualization();
}

/**
 * 身体重心の可視化をセットアップ
 */
setupCOMVisualization() {
  // 身体重心表示用の球体を作成
  const comGeometry = new THREE.SphereGeometry(10, 16, 16);
  const comMaterial = new THREE.MeshBasicMaterial({ 
    color: 0xff0000,
    opacity: 0.8,
    transparent: true
  });
  this.comSphere = new THREE.Mesh(comGeometry, comMaterial);
  this.comSphere.visible = this.showCOM;
  this.scene.add(this.comSphere);

  // 身体重心軌跡線を作成
  const trajectory = this.bodyCOMCalculator.getCOMTrajectory(this.comResults);
  
  if (trajectory.length > 0) {
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
      color: 0xff0000,
      linewidth: 2
    });
    
    this.comTrajectoryLine = new THREE.Line(
      trajectoryGeometry, 
      trajectoryMaterial
    );
    this.comTrajectoryLine.visible = this.showCOMTrajectory;
    this.scene.add(this.comTrajectoryLine);
  }

  console.log('身体重心の可視化をセットアップしました');
}

/**
 * 身体重心の表示を更新
 */
updateCOMDisplay() {
  if (!this.comResults || !this.comSphere) return;

  const currentResult = this.comResults[this.currentFrame];
  
  if (currentResult && currentResult.valid && currentResult.bodyCOM) {
    this.comSphere.position.set(
      currentResult.bodyCOM[0],
      currentResult.bodyCOM[1],
      currentResult.bodyCOM[2]
    );
  }
}

/**
 * 身体重心の表示/非表示を切り替え
 */
toggleCOMDisplay() {
  this.showCOM = !this.showCOM;
  if (this.comSphere) {
    this.comSphere.visible = this.showCOM;
  }
  console.log(`身体重心表示: ${this.showCOM ? 'ON' : 'OFF'}`);
}

/**
 * 身体重心軌跡の表示/非表示を切り替え
 */
toggleCOMTrajectory() {
  this.showCOMTrajectory = !this.showCOMTrajectory;
  if (this.comTrajectoryLine) {
    this.comTrajectoryLine.visible = this.showCOMTrajectory;
  }
  console.log(`身体重心軌跡: ${this.showCOMTrajectory ? 'ON' : 'OFF'}`);
}
```

### 5. アニメーションループでの更新

既存の`animate()`メソッドまたはフレーム更新メソッドに身体重心の更新処理を追加します:

```javascript
animate() {
  // 既存のアニメーション処理...
  
  // 身体重心の位置を更新
  this.updateCOMDisplay();
  
  // レンダリング
  this.renderer.render(this.scene, this.camera);
  requestAnimationFrame(() => this.animate());
}
```

### 6. UIコントロールの追加

`index.html`に身体重心表示のためのコントロールを追加します:

```html
<!-- 身体重心コントロール -->
<div class="control-group">
  <h3>身体重心</h3>
  
  <div class="control-item">
    <label>計算方法:</label>
    <select id="comMethod">
      <option value="ae14">阿江14 (23点)</option>
      <option value="ae15">阿江15 (25点)</option>
    </select>
  </div>
  
  <div class="control-item">
    <label>性別:</label>
    <select id="comSex">
      <option value="male">男性</option>
      <option value="female">女性</option>
    </select>
  </div>
  
  <div class="control-item">
    <button id="calculateCOM">身体重心を計算</button>
  </div>
  
  <div class="control-item">
    <label>
      <input type="checkbox" id="showCOM">
      身体重心を表示
    </label>
  </div>
  
  <div class="control-item">
    <label>
      <input type="checkbox" id="showCOMTrajectory">
      軌跡を表示
    </label>
  </div>
</div>
```

### 7. イベントリスナーの追加

UIコントロールのイベントリスナーを設定します:

```javascript
setupEventListeners() {
  // 既存のイベントリスナー...
  
  // 身体重心計算ボタン
  document.getElementById('calculateCOM').addEventListener('click', () => {
    const method = document.getElementById('comMethod').value;
    const sex = document.getElementById('comSex').value;
    this.calculateBodyCOM(method, sex);
  });
  
  // 身体重心表示チェックボックス
  document.getElementById('showCOM').addEventListener('change', (e) => {
    this.showCOM = e.target.checked;
    if (this.comSphere) {
      this.comSphere.visible = this.showCOM;
    }
  });
  
  // 軌跡表示チェックボックス
  document.getElementById('showCOMTrajectory').addEventListener('change', (e) => {
    this.showCOMTrajectory = e.target.checked;
    if (this.comTrajectoryLine) {
      this.comTrajectoryLine.visible = this.showCOMTrajectory;
    }
  });
}
```

## 使用方法

### 基本的な使用フロー

1. モーションデータを読み込む
2. 「身体重心を計算」ボタンをクリック
3. 「身体重心を表示」チェックボックスをON
4. アニメーションを再生すると、赤い球体が身体重心の位置に表示される
5. 「軌跡を表示」チェックボックスをONにすると、身体重心の軌跡が赤い線で表示される

### プログラムからの使用例

```javascript
// モーションビューアのインスタンスを取得
const viewer = new MotionViewer();

// データ読み込み後に身体重心を計算
viewer.loadMotionData('data.csv').then(() => {
  // 阿江14、男性のパラメータで計算
  viewer.calculateBodyCOM('ae14', 'male');
  
  // 身体重心を表示
  viewer.toggleCOMDisplay();
  
  // 軌跡も表示
  viewer.toggleCOMTrajectory();
});
```

## 身体重心データのエクスポート

計算した身体重心データをCSVファイルとして保存する機能も追加できます:

```javascript
/**
 * 身体重心データをCSV形式でエクスポート
 */
exportCOMData() {
  if (!this.comResults) {
    console.error('身体重心が計算されていません');
    return;
  }

  let csv = 'Frame,COM_X,COM_Y,COM_Z\n';
  
  this.comResults.forEach(result => {
    if (result.valid && result.bodyCOM) {
      csv += `${result.frame},${result.bodyCOM[0]},${result.bodyCOM[1]},${result.bodyCOM[2]}\n`;
    }
  });

  // Blob作成してダウンロード
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'body_com_data.csv';
  a.click();
  URL.revokeObjectURL(url);
  
  console.log('身体重心データをエクスポートしました');
}
```

## トラブルシューティング

### 問題1: 身体重心が計算されない

**原因**: ポイント数がBSPモデルと一致していない

**解決策**: 
- 阿江14を使用する場合は23ポイント必要
- 阿江15を使用する場合は25ポイント必要
- データのポイント数を確認してください

### 問題2: 身体重心が表示されない

**原因**: 可視化オブジェクトが作成されていない

**解決策**:
1. `calculateBodyCOM()`を実行してから表示してください
2. `showCOM`プロパティがtrueになっているか確認してください
3. コンソールでエラーメッセージを確認してください

### 問題3: 軌跡が正しく表示されない

**原因**: 全フレームが有効でない可能性

**解決策**:
- 一部のフレームでポイントが欠損していないか確認
- `comResults`の`valid`プロパティを確認

## パフォーマンス最適化

大量のフレームデータを扱う場合、以下の最適化を検討してください:

```javascript
// 軌跡の間引き表示
getCOMTrajectoryOptimized(comResults, skipFrames = 5) {
  return comResults
    .filter((result, index) => 
      result.valid && result.bodyCOM && index % skipFrames === 0
    )
    .map(result => result.bodyCOM);
}
```

## 参考資料

- 阿江通良ほか「日本人アスリートの身体部分慣性特性の推定」(1992)
- 阿江通良ほか「日本人幼少年の身体部分慣性特性」(1996)
- 横井孝志ほか「日本人幼児の身体部分慣性係数」(2004)

## まとめ

このモジュールにより、VBAで実装されていた身体重心計算機能を、Electronアプリ内でリアルタイムに実行できるようになります。Three.jsとの統合により、3D空間での身体重心の可視化も可能です。
