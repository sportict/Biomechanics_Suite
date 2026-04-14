# Biomechanics Suite - Windows インストールマニュアル

対象: Windows 10/11 (x64)

---

## 共通の前提条件

### 1. Node.js (v20 LTS 推奨)

公式サイトからインストーラをダウンロード:
https://nodejs.org/

インストール時に「Automatically install the necessary tools」にチェックを入れると、
Chocolatey 経由で Python と Visual Studio Build Tools も一緒にインストールされます。

確認 (PowerShell):

```powershell
node -v   # v20.x.x
npm -v    # 10.x.x
```

### 2. Visual Studio Build Tools

Node.js のネイティブモジュール (node-gyp) のビルドに必要です。

Node.js インストーラで自動インストールされなかった場合:
https://visualstudio.microsoft.com/ja/visual-cpp-build-tools/

インストール時に「C++ によるデスクトップ開発」ワークロードを選択してください。

### 3. Python 3.11+ (HPE で使用)

公式サイトからインストーラをダウンロード:
https://www.python.org/downloads/

インストール時に「Add python.exe to PATH」にチェックを入れてください。

確認:

```powershell
python --version   # 3.11.x 以上
```

---

## MotionViewer

軽量モーションデータ 3D 可視化アプリ。追加の外部ツールは不要です。

### セットアップ

```powershell
cd MotionViewer
npm install
```

### 開発モードで実行

```powershell
npm run dev
```

### ビルド

```powershell
npm run build
```

出力: `dist\MotionViewer-Setup-*.exe`

---

## VideoSyncLab

二画面動画同期編集アプリ。ネイティブモジュール (canvas, sharp) を含みます。

### セットアップ

```powershell
cd VideoSyncLab
npm install
```

`postinstall` で `electron-builder install-app-deps` が自動実行され、ネイティブモジュールが Electron 向けにリビルドされます。

### 開発モードで実行

```powershell
npm run dev
```

### ビルド

```powershell
npm run build
```

出力: `dist\VideoSyncLab-Setup-*.exe`

---

## MotionDigitizer

3D モーションキャプチャ解析アプリ。C++ ネイティブモジュール (OpenCV) を使用します。

### 追加の前提条件: OpenCV (vcpkg)

```powershell
# vcpkg のインストール (初回のみ)
git clone https://github.com/microsoft/vcpkg.git C:\vcpkg
C:\vcpkg\bootstrap-vcpkg.bat

# OpenCV のインストール
C:\vcpkg\vcpkg install opencv4[aruco,contrib]:x64-windows
```

> binding.gyp は `C:\vcpkg\installed\x64-windows\` を参照します。
> 別の場所にインストールした場合は `native/binding.gyp` のパスを修正してください。

### セットアップ

```powershell
cd MotionDigitizer
npm install
```

### ネイティブモジュールのビルド

Visual Studio の「開発者コマンド プロンプト」または PowerShell から:

```powershell
npx node-gyp configure build --directory=native
```

正常終了すると `native\build\Release\opencv_module.node` が生成されます。

### OpenCV DLL の配置

開発時は `vendor\opencv\bin\` に OpenCV の DLL を配置してください。
vcpkg からコピーする場合:

```powershell
xcopy C:\vcpkg\installed\x64-windows\bin\opencv_*.dll vendor\opencv\bin\ /Y
```

ビルド時は `extraResources` として自動的にバンドルされます。

### 開発モードで実行

```powershell
npm run dev
```

### ビルド

```powershell
npm run build
```

出力: `dist\MotionDigitizer-Setup-*.exe`

---

## HPE (Human Pose Estimation)

姿勢推定アプリ。Python バックエンドと ONNX モデルを使用します。

### Python 仮想環境のセットアップ

```powershell
cd HPE
python -m venv .venv
.venv\Scripts\activate
```

### Python 依存パッケージのインストール

```powershell
pip install --upgrade pip

# rtmlib (ローカルパッケージ)
pip install ./rtmlib --no-deps

# その他の依存パッケージ
pip install fastapi uvicorn python-multipart "numpy>=1.24.0,<2.0.0" "opencv-python>=4.8.0" "Pillow>=10.0.0" "tqdm>=4.66.0" "scipy>=1.11.0" "filterpy>=1.4.0" "ffmpeg-python>=0.2.0" "norfair>=2.2.0"
```

### ONNX Runtime のインストール

NVIDIA GPU 搭載の場合 (CUDA 対応):

```powershell
pip install onnxruntime-gpu>=1.18.0
```

GPU なしの場合:

```powershell
pip install onnxruntime>=1.18.0
```

### NVIDIA GPU を使用する場合の追加要件

- NVIDIA ドライバ (最新版): https://www.nvidia.com/ja-jp/drivers/
- CUDA Toolkit 12.x: https://developer.nvidia.com/cuda-downloads
- cuDNN 9.x: https://developer.nvidia.com/cudnn

> cuDNN は `C:\Program Files\NVIDIA\CUDNN\v9.x\bin` にインストールされていれば
> アプリが自動的にパスを検出します。

### Node.js 依存パッケージのインストール

```powershell
deactivate   # venv を抜ける
npm install
```

### 開発モードで実行

```powershell
npm run dev
```

### ビルド (一括スクリプト)

```powershell
build.bat
```

または手動:

```powershell
npm run build
```

出力: `dist\HPE-Setup-*.exe`

### モデルファイル

`Models\` ディレクトリに以下のモデルが必要です:

| ファイル | 用途 |
|---|---|
| `yolo11x.onnx` | 人物検出 (高精度) |
| `yolo11s.onnx` | 人物検出 (高速) |
| `rtmpose-m.onnx` | 姿勢推定 (標準) |
| `rtmpose-x.onnx` | 姿勢推定 (高精度) |
| `synthpose-vitpose-huge-hf.onnx` | SynthPose (高精度) |

### GPU/CPU の動作

- **NVIDIA GPU 搭載**: CUDA を自動検出して GPU で推論を実行します
- GPU が検出されない場合は CPU にフォールバックします
- アプリ内のデバイスセレクタで GPU (CUDA) / CPU を手動切替できます

---

## トラブルシューティング

### node-gyp のビルドエラー

「MSBuild.exe が見つかりません」等のエラーの場合:

```powershell
# Visual Studio Build Tools の確認
npm config set msvs_version 2022
npx node-gyp configure build --directory=native
```

### Python が見つからない

PATH に Python が含まれていることを確認:

```powershell
python --version
```

表示されない場合は Python インストーラを再実行し「Add to PATH」を有効にしてください。

### CUDA/cuDNN が認識されない

1. NVIDIA ドライバが最新か確認: `nvidia-smi`
2. cuDNN の DLL パスが正しいか確認:

```powershell
dir "C:\Program Files\NVIDIA\CUDNN\v9.*\bin\cudnn*.dll"
```

3. 環境変数 PATH に cuDNN の bin ディレクトリが含まれているか確認

### ウイルス対策ソフトによるブロック

Windows Defender SmartScreen が未署名の exe をブロックする場合:
「詳細情報」>「実行」をクリックして許可してください。
