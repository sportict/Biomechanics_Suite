# Biomechanics Suite - macOS インストールマニュアル

対象: Apple Silicon (M1/M2/M3/M4) Mac

---

## 共通の前提条件

### 1. Xcode Command Line Tools

```bash
xcode-select --install
```

### 2. Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### 3. Node.js (v20 LTS 推奨)

```bash
brew install node@20
```

確認:

```bash
node -v   # v20.x.x
npm -v    # 10.x.x
```

### 4. Python 3.11+ (HPE で使用)

```bash
brew install python@3.11
```

確認:

```bash
python3 --version   # 3.11.x 以上
```

---

## 注意事項

- VS Code のターミナルから Electron アプリを起動する場合、環境変数 `ELECTRON_RUN_AS_NODE=1` が自動設定されます。Electron を起動する際は必ず先頭に `unset ELECTRON_RUN_AS_NODE &&` を付けてください。
- コード署名なしでビルドされるため、初回起動時は「右クリック > 開く」で実行してください。

---

## MotionViewer

軽量モーションデータ 3D 可視化アプリ。追加の外部ツールは不要です。

### セットアップ

```bash
cd MotionViewer
npm install
```

### 開発モードで実行

```bash
unset ELECTRON_RUN_AS_NODE && npm run dev
```

### ビルド

```bash
unset ELECTRON_RUN_AS_NODE && npm run build:mac
```

出力: `dist/MotionViewer-*-arm64.dmg`

---

## VideoSyncLab

二画面動画同期編集アプリ。ネイティブモジュール (canvas, sharp) を含みます。

### セットアップ

```bash
cd VideoSyncLab
npm install
```

`postinstall` で `electron-builder install-app-deps` が自動実行され、ネイティブモジュールが Electron 向けにリビルドされます。

### 開発モードで実行

```bash
unset ELECTRON_RUN_AS_NODE && npm run dev
```

### ビルド

```bash
unset ELECTRON_RUN_AS_NODE && npm run build:mac
```

出力: `dist/VideoSyncLab-*-arm64.dmg`

---

## MotionDigitizer

3D モーションキャプチャ解析アプリ。C++ ネイティブモジュール (OpenCV) を使用します。

### 追加の前提条件

```bash
brew install opencv pkg-config
```

確認:

```bash
pkg-config --modversion opencv4   # 4.x.x
```

### セットアップ

```bash
cd MotionDigitizer
npm install
```

### ネイティブモジュールのビルド

```bash
npx node-gyp configure build --directory=native
```

正常終了すると `native/build/Release/opencv_module.node` が生成されます。

### 開発モードで実行

```bash
unset ELECTRON_RUN_AS_NODE && npm run dev
```

### ビルド

```bash
unset ELECTRON_RUN_AS_NODE && npm run build:mac
```

出力: `dist/MotionDigitizer-*-arm64.dmg`

---

## HPE (Human Pose Estimation)

姿勢推定アプリ。Python バックエンドと ONNX モデルを使用します。

### Python 仮想環境のセットアップ

```bash
cd HPE
python3 -m venv .venv
source .venv/bin/activate
```

### Python 依存パッケージのインストール

```bash
pip install --upgrade pip

# rtmlib (ローカルパッケージ)
pip install ./rtmlib --no-deps

# その他の依存パッケージ
pip install \
  fastapi uvicorn python-multipart \
  "numpy>=1.24.0,<2.0.0" \
  "opencv-python>=4.8.0" \
  "Pillow>=10.0.0" \
  "tqdm>=4.66.0" \
  "scipy>=1.11.0" \
  "filterpy>=1.4.0" \
  "ffmpeg-python>=0.2.0" \
  "norfair>=2.2.0"
```

### ONNX Runtime のインストール (Apple Silicon)

```bash
pip install onnxruntime-silicon
```

> `onnxruntime-silicon` が失敗する場合は `pip install onnxruntime` にフォールバックしてください。CoreML アクセラレーションが利用できます。

### Node.js 依存パッケージのインストール

```bash
deactivate   # venv を抜ける
npm install
```

### 開発モードで実行

```bash
unset ELECTRON_RUN_AS_NODE && npm run dev
```

### ビルド (一括スクリプト)

```bash
bash build.sh
```

または手動:

```bash
unset ELECTRON_RUN_AS_NODE && npm run build:mac
```

出力: `dist/HPE-*-arm64.dmg`, `dist/HPE-*-arm64-mac.zip`

### モデルファイル

`Models/` ディレクトリに以下のモデルが必要です:

| ファイル | 用途 |
|---|---|
| `yolo11x.onnx` | 人物検出 (高精度) |
| `yolo11s.onnx` | 人物検出 (高速) |
| `rtmpose-m.onnx` | 姿勢推定 (標準) |
| `rtmpose-x.onnx` | 姿勢推定 (高精度) |
| `synthpose-vitpose-huge-hf.onnx` | SynthPose (高精度) |

### GPU/CPU の動作

- **Apple Silicon**: CoreML (Neural Engine/GPU) を自動検出して使用します
- CoreML が利用できない場合は CPU にフォールバックします
- アプリ内のデバイスセレクタで CoreML / CPU を手動切替できます

---

## トラブルシューティング

### `ELECTRON_RUN_AS_NODE` エラー

VS Code ターミナルで `app.requestSingleInstanceLock is not a function` 等のエラーが出る場合:

```bash
unset ELECTRON_RUN_AS_NODE
```

### node_modules のパーミッションエラー

Windows からコピーしたファイルで発生する場合があります:

```bash
chmod -R u+w .
rm -rf node_modules package-lock.json
npm install
```

### MotionDigitizer のネイティブモジュールビルドエラー

OpenCV が見つからない場合:

```bash
brew install opencv
export PKG_CONFIG_PATH="/opt/homebrew/opt/opencv/lib/pkgconfig:$PKG_CONFIG_PATH"
npx node-gyp configure build --directory=native
```
