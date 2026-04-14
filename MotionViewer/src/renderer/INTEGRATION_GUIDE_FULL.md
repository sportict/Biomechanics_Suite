# 身体重心計算モジュール統合ガイド(完全版)

## 概要

このドキュメントは、**成人・老人・子ども**のすべての年齢層に対応した身体重心計算モジュール(`body-com-full.js`)を既存のElectronアプリに統合する方法を説明します。

## 対応モデル一覧

### 成人モデル(阿江)
- **ae14**: 阿江14 (23ポイント、胴体1セグメント)
- **ae15**: 阿江15 (25ポイント、胴体2セグメント)

### 老人モデル(岡田)
- **okada14**: 岡田14 (23ポイント、胴体1セグメント)
- **okada15**: 岡田15 (25ポイント、胴体2セグメント)

### 子どもモデル(横井)

**3-5歳:**
- **yokoi_03_05_standard**: 標準体型
- **yokoi_03_05_thin**: 痩身体型
- **yokoi_03_05_obese**: 肥満体型

**6-8歳:**
- **yokoi_06_08_standard**: 標準体型
- **yokoi_06_08_thin**: 痩身体型
- **yokoi_06_08_obese**: 肥満体型

## ファイル構成

```
/mnt/project/
├── app.js                         # 既存のメインアプリケーション
├── body-com-full.js               # 新規: 完全版身体重心計算モジュール
├── body-com-examples-full.js      # 新規: 完全版使用例
├── filter.js                      # 既存: フィルター処理
├── index.html                     # 既存: メインHTML
└── ...
```

## 統合手順

### 1. ファイルの配置

`body-com-full.js`を既存のプロジェクトディレクトリにコピーします。

```bash
cp body-com-full.js /mnt/project/
```

### 2. app.jsへのインポート追加

```javascript
// 既存のインポート
import * as THREE from './lib/three.module.js';
import { OrbitControls } from './lib/OrbitControls.js';
import { butterWinter, butterBryant, addPadding, removePadding, calculateWaWCutoff } from './filter.js';

// 新規追加: 身体重心計算モジュール(完全版)
import { BodyCenterOfMass } from './body-com-full.js';
```

### 3. MotionViewerクラスへのプロパティ追加

```javascript
class MotionViewer {
  constructor() {
    // 既存のプロパティ...
    
    // 新規追加: 身体重心計算
    this.bodyCOMCalculator = null;
    this.comResults = null;
    this.comSphere = null;
    this.comTrajectoryLine = null;
    this.showCOM = false;
    this.showCOMTrajectory = false;
    
    // 新規追加: 年齢・体型情報
    this.userAge = null;
    this.userSex = 'male';
    this.userBodyType = 'standard';
  }
}
```

### 4. モデル自動選択メソッド

年齢に基づいて適切なBSPモデルを自動選択する機能を追加します:

```javascript
/**
 * 年齢と体型に基づいて適切なBSPモデルを選択
 * @param {number} age - 年齢
 * @param {string} bodyType - 体型 ('standard', 'thin', 'obese')
 * @param {number} pointCount - ポイント数 (23 or 25)
 * @returns {string} - BSPモデル名
 */
selectBSPModel(age, bodyType = 'standard', pointCount = 23) {
  // 3-5歳
  if (age >= 3 && age <= 5) {
    return `yokoi_03_05_${bodyType}`;
  }
  // 6-8歳
  else if (age >= 6 && age <= 8) {
    return `yokoi_06_08_${bodyType}`;
  }
  // 9-17歳(データがないため成人モデルを使用)
  else if (age >= 9 && age < 18) {
    console.warn('9-17歳のデータがないため、成人モデルを使用します');
    return pointCount === 25 ? 'ae15' : 'ae14';
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
    console.warn('年齢が範囲外のため、成人モデルを使用します');
    return 'ae14';
  }
}

/**
 * 身体重心を計算(年齢自動判定版)
 * @param {number} age - 年齢(省略時は成人モデル)
 * @param {string} sex - 性別 ('male' or 'female')
 * @param {string} bodyType - 体型 ('standard', 'thin', 'obese')
 */
calculateBodyCOMAuto(age = null, sex = 'male', bodyType = 'standard') {
  if (!this.motionData || !this.motionData.frames) {
    console.error('モーションデータが読み込まれていません');
    return;
  }

  // ポイント数を取得
  const pointCount = this.motionData.frames[0].points.length;

  // モデルを自動選択
  let method;
  if (age !== null) {
    method = this.selectBSPModel(age, bodyType, pointCount);
    console.log(`年齢 ${age}歳 → ${BodyCenterOfMass.getMethodDescription(method)}`);
  } else {
    // 年齢が指定されていない場合はデフォルト
    method = pointCount === 25 ? 'ae15' : 'ae14';
    console.log(`デフォルトモデル: ${BodyCenterOfMass.getMethodDescription(method)}`);
  }

  // 身体重心を計算
  this.calculateBodyCOM(method, sex);
}

/**
 * 身体重心を計算(モデル指定版)
 * @param {string} method - BSPモデル名
 * @param {string} sex - 性別 ('male' or 'female')
 */
calculateBodyCOM(method, sex = 'male') {
  if (!this.motionData || !this.motionData.frames) {
    console.error('モーションデータが読み込まれていません');
    return;
  }

  console.log(`身体重心を計算中... (モデル: ${method}, 性別: ${sex})`);

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
  console.log(`使用モデル: ${BodyCenterOfMass.getMethodDescription(method)}`);

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
  <h3>身体重心計算</h3>
  
  <!-- 年齢入力 -->
  <div class="control-item">
    <label>年齢:</label>
    <input type="number" id="userAge" min="3" max="100" placeholder="年齢を入力">
    <span class="hint">※3歳未満の場合は空欄</span>
  </div>
  
  <!-- 性別選択 -->
  <div class="control-item">
    <label>性別:</label>
    <select id="comSex">
      <option value="male">男性</option>
      <option value="female">女性</option>
    </select>
  </div>
  
  <!-- 体型選択(子どものみ) -->
  <div class="control-item" id="bodyTypeControl" style="display:none;">
    <label>体型:</label>
    <select id="comBodyType">
      <option value="standard">標準</option>
      <option value="thin">痩身</option>
      <option value="obese">肥満</option>
    </select>
  </div>
  
  <!-- または手動でモデル選択 -->
  <div class="control-item">
    <label>
      <input type="checkbox" id="manualModelSelection">
      手動でモデルを選択
    </label>
  </div>
  
  <div class="control-item" id="manualModelControl" style="display:none;">
    <label>モデル:</label>
    <select id="comMethod">
      <optgroup label="成人">
        <option value="ae14">阿江14 (23点)</option>
        <option value="ae15">阿江15 (25点)</option>
      </optgroup>
      <optgroup label="老人">
        <option value="okada14">岡田14 (23点)</option>
        <option value="okada15">岡田15 (25点)</option>
      </optgroup>
      <optgroup label="子ども(3-5歳)">
        <option value="yokoi_03_05_standard">標準体型</option>
        <option value="yokoi_03_05_thin">痩身体型</option>
        <option value="yokoi_03_05_obese">肥満体型</option>
      </optgroup>
      <optgroup label="子ども(6-8歳)">
        <option value="yokoi_06_08_standard">標準体型</option>
        <option value="yokoi_06_08_thin">痩身体型</option>
        <option value="yokoi_06_08_obese">肥満体型</option>
      </optgroup>
    </select>
  </div>
  
  <!-- 計算ボタン -->
  <div class="control-item">
    <button id="calculateCOM" class="primary-button">身体重心を計算</button>
  </div>
  
  <!-- 表示オプション -->
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
  
  <!-- 使用モデル表示 -->
  <div class="control-item" id="currentModelDisplay" style="display:none;">
    <div class="info-box">
      <strong>使用モデル:</strong>
      <span id="currentModelName"></span>
    </div>
  </div>
</div>
```

### 7. イベントリスナーの追加

```javascript
setupEventListeners() {
  // 既存のイベントリスナー...
  
  // 年齢入力で体型選択を表示/非表示
  document.getElementById('userAge').addEventListener('input', (e) => {
    const age = parseInt(e.target.value);
    const bodyTypeControl = document.getElementById('bodyTypeControl');
    
    // 3-8歳の場合のみ体型選択を表示
    if (age >= 3 && age <= 8) {
      bodyTypeControl.style.display = 'block';
    } else {
      bodyTypeControl.style.display = 'none';
    }
  });
  
  // 手動モデル選択の切り替え
  document.getElementById('manualModelSelection').addEventListener('change', (e) => {
    const manualControl = document.getElementById('manualModelControl');
    const autoControls = ['userAge', 'comBodyType'].map(id => 
      document.getElementById(id).closest('.control-item')
    );
    
    if (e.target.checked) {
      manualControl.style.display = 'block';
      autoControls.forEach(el => el.style.display = 'none');
    } else {
      manualControl.style.display = 'none';
      autoControls[0].style.display = 'block';
      // 体型選択は年齢に応じて表示
      const age = parseInt(document.getElementById('userAge').value);
      if (age >= 3 && age <= 8) {
        autoControls[1].style.display = 'block';
      }
    }
  });
  
  // 身体重心計算ボタン
  document.getElementById('calculateCOM').addEventListener('click', () => {
    const manualMode = document.getElementById('manualModelSelection').checked;
    const sex = document.getElementById('comSex').value;
    
    if (manualMode) {
      // 手動モード: モデルを直接指定
      const method = document.getElementById('comMethod').value;
      this.calculateBodyCOM(method, sex);
    } else {
      // 自動モード: 年齢から自動選択
      const ageInput = document.getElementById('userAge').value;
      const age = ageInput ? parseInt(ageInput) : null;
      const bodyType = document.getElementById('comBodyType').value;
      
      this.calculateBodyCOMAuto(age, sex, bodyType);
    }
    
    // 使用モデルを表示
    const modelDisplay = document.getElementById('currentModelDisplay');
    const modelName = document.getElementById('currentModelName');
    modelDisplay.style.display = 'block';
    modelName.textContent = BodyCenterOfMass.getMethodDescription(
      this.bodyCOMCalculator.method
    );
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

### 8. CSSスタイル追加

```css
/* 身体重心コントロールのスタイル */
.control-group {
  margin-bottom: 20px;
  padding: 15px;
  border: 1px solid #ddd;
  border-radius: 5px;
  background: #f9f9f9;
}

.control-item {
  margin-bottom: 10px;
}

.control-item label {
  display: inline-block;
  min-width: 80px;
  font-weight: bold;
}

.control-item input[type="number"],
.control-item select {
  padding: 5px;
  border: 1px solid #ccc;
  border-radius: 3px;
  min-width: 150px;
}

.control-item .hint {
  font-size: 0.85em;
  color: #666;
  margin-left: 10px;
}

.primary-button {
  background: #4CAF50;
  color: white;
  padding: 10px 20px;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 1em;
}

.primary-button:hover {
  background: #45a049;
}

.info-box {
  background: #e8f5e9;
  border: 1px solid #4CAF50;
  padding: 10px;
  border-radius: 5px;
  margin-top: 10px;
}
```

## 使用方法

### 基本的な使用フロー

#### 自動モード(推奨)

1. モーションデータを読み込む
2. 年齢を入力(3-100歳)
3. 性別を選択
4. 子どもの場合は体型を選択(標準/痩身/肥満)
5. 「身体重心を計算」ボタンをクリック
6. 自動的に最適なBSPモデルが選択される

#### 手動モード

1. 「手動でモデルを選択」チェックボックスをON
2. ドロップダウンから具体的なモデルを選択
3. 性別を選択
4. 「身体重心を計算」ボタンをクリック

### 年齢別モデル選択ガイド

| 年齢範囲 | 使用モデル | 備考 |
|---------|----------|------|
| 3-5歳 | 横井 03-05yr | 体型選択可能 |
| 6-8歳 | 横井 06-08yr | 体型選択可能 |
| 9-17歳 | 阿江 (成人) | ※データがないため成人モデルを使用 |
| 18-64歳 | 阿江 (成人) | 標準的な成人 |
| 65歳以上 | 岡田 (老人) | 高齢者専用パラメータ |

## 身体重心データのエクスポート

```javascript
/**
 * 身体重心データをCSV形式でエクスポート
 */
exportCOMData() {
  if (!this.comResults) {
    console.error('身体重心が計算されていません');
    return;
  }

  let csv = 'Frame,COM_X,COM_Y,COM_Z,Model,Sex\n';
  
  const model = BodyCenterOfMass.getMethodDescription(this.bodyCOMCalculator.method);
  const sex = this.bodyCOMCalculator.sex;
  
  this.comResults.forEach(result => {
    if (result.valid && result.bodyCOM) {
      csv += `${result.frame},${result.bodyCOM[0]},${result.bodyCOM[1]},${result.bodyCOM[2]},${model},${sex}\n`;
    }
  });

  // Blob作成してダウンロード
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `body_com_${model.replace(/\s+/g, '_')}_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  
  console.log('身体重心データをエクスポートしました');
}
```

## トラブルシューティング

### 問題1: 子どもの年齢に対応するモデルがない

**症状**: 9-17歳の身体重心が計算できない

**原因**: 横井のデータは3-8歳まで、阿江のデータは成人以降のみ

**解決策**: 
- 9-17歳は成人モデル(阿江)を使用する
- より正確な結果が必要な場合は、補間または別のデータソースを検討

### 問題2: 体型選択が表示されない

**症状**: 子どもの年齢を入力しても体型選択が出ない

**原因**: イベントリスナーが正しく設定されていない

**解決策**:
```javascript
// 年齢入力のイベントリスナーを確認
document.getElementById('userAge').addEventListener('input', (e) => {
  const age = parseInt(e.target.value);
  if (age >= 3 && age <= 8) {
    document.getElementById('bodyTypeControl').style.display = 'block';
  }
});
```

### 問題3: 老人モデルと成人モデルで結果が大きく異なる

**原因**: 老人は頭部の質量比が高く、下肢の質量比が低い

**説明**: 
- 老人(岡田): 頭部9.1%(男性)、大腿9.2%(男性)
- 成人(阿江): 頭部6.9%(男性)、大腿11.0%(男性)

これは生理学的に妥当な違いです。

## パフォーマンス最適化

### モデル選択のキャッシング

頻繁にモデルを切り替える場合は、インスタンスをキャッシュします:

```javascript
class MotionViewer {
  constructor() {
    // ...
    this.comCalculatorCache = new Map();
  }
  
  getOrCreateCalculator(method, sex) {
    const key = `${method}_${sex}`;
    if (!this.comCalculatorCache.has(key)) {
      this.comCalculatorCache.set(key, new BodyCenterOfMass(method, sex));
    }
    return this.comCalculatorCache.get(key);
  }
}
```

## 参考資料

### 学術論文

1. **阿江通良ほか (1992)**: "日本人アスリートの身体部分慣性特性の推定"
2. **阿江通良ほか (1996)**: "日本人幼少年の身体部分慣性特性"
3. **横井孝志ほか (2004)**: "日本人幼児の身体部分慣性係数"
4. **岡田英孝ほか (1996)**: "日本人高齢者の身体部分慣性特性"

### BSPパラメータの特徴

#### 年齢による変化
- **頭部**: 子ども(16%)→成人(7%)→老人(9%)
- **下肢**: 子ども(16%)→成人(22%)→老人(19%)
- **胴体**: 子ども(47%)→成人(49%)→老人(50%)

#### 体型による違い(子ども)
- **痩身**: 頭部の割合が大きい
- **標準**: バランスの取れた分布
- **肥満**: 胴体の割合が大きい

## まとめ

このモジュールにより、3歳から高齢者まで、すべての年齢層の身体重心を正確に計算できるようになります。年齢と体型に基づく自動モデル選択機能により、ユーザーは専門知識なしでも適切なパラメータを使用できます。
