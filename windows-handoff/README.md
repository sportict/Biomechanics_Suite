# Windows 引き継ぎ手順書

> **Claude Desktop (Windows版) 向け自動化手順書**
> このフォルダ `windows-handoff/` をそのまま Claude Desktop に渡せば、リポジトリの取得・依存セットアップ・ビルドまでを自動化できます。

## このフォルダの中身

| ファイル | 役割 |
|---|---|
| `README.md`(本ファイル) | 手順書(Claude Desktop に読ませる主文書) |
| `setup-windows.ps1` | 総合セットアップ(clone→モデル取得→全ビルドを1コマンド) |
| `build-all-windows.ps1` | 4アプリ一括ビルドのみ |
| `fetch-hpe-models.ps1` | HPE/Models/ のダウンロード |

---

## 0. この手順書の使い方(Claude Desktopへの指示)

Claude Desktop にこのフォルダ丸ごと or `README.md` を共有したら、次のプロンプトを渡してください:

> 「このドキュメント **windows-handoff/README.md** の手順 1〜6 を順番に実行してください。各ステップ終了後に検証コマンドの結果を確認し、成功していれば次に進んでください。エラーが出たら止まって、エラー内容を私に共有してください。」

**最速ルート**: PowerShell を開いて以下を実行すれば、上記の手順 2〜4 を自動で走らせます。
```powershell
iwr -useb https://raw.githubusercontent.com/sportict/Biomechanics_Suite/main/windows-handoff/setup-windows.ps1 | iex
```

---

## 1. 前提環境の確認と準備

### 1-A. 必須ツールの確認

PowerShell を管理者権限で起動し、以下を順番に実行:

```powershell
# バージョン確認(いずれも表示されればOK)
node --version          # 期待: v20.x 以上
npm --version           # 期待: 10.x 以上
git --version           # 期待: 任意
python --version        # 期待: 3.11.x(HPE用)
```

### 1-B. 足りないものをインストール

| ツール | 確認コマンド | インストール方法 |
|---|---|---|
| Node.js 20 | `node --version` | https://nodejs.org/ (LTS) から `.msi` を実行 |
| Python 3.11 | `python --version` | https://www.python.org/downloads/ (3.11.x) |
| Git | `git --version` | https://git-scm.com/download/win |
| Visual Studio Build Tools 2022 | `where msbuild` | 下記 1-C 参照 |
| vcpkg + OpenCV | `C:\vcpkg\vcpkg.exe version` | 下記 1-D 参照 |

### 1-C. Visual Studio Build Tools 2022(MotionDigitizer のC++ビルド用)

1. https://visualstudio.microsoft.com/visual-cpp-build-tools/ からインストーラーをダウンロード
2. インストール時に以下のワークロードを選択:
   - **C++ によるデスクトップ開発**
   - **Windows 11 SDK**(または 10 SDK)
3. インストール後、`Developer Command Prompt for VS 2022` が使えることを確認

自動化用(winget が利用可能な環境):
```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --silent --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --quiet"
```

### 1-D. vcpkg + OpenCV(MotionDigitizer)

MotionDigitizer の `native/opencv_module.cpp` は vcpkg 経由の OpenCV を前提にしています。既定のパスは `C:\vcpkg`。

```powershell
# vcpkg をクローン
cd C:\
git clone https://github.com/microsoft/vcpkg.git
cd C:\vcpkg
.\bootstrap-vcpkg.bat

# OpenCV をインストール(30分〜1時間かかる場合あり)
.\vcpkg install opencv:x64-windows

# 環境変数に追加(現在のセッションだけ)
$env:Path += ";C:\vcpkg\installed\x64-windows\bin"
# 恒久設定(ユーザ環境変数)
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\vcpkg\installed\x64-windows\bin", "User")
```

**検証**: `where opencv_world*` でDLLが見つかればOK。

---

## 2. リポジトリの取得

作業フォルダに移動してクローン:

```powershell
# 作業ディレクトリ(任意の場所でOK)
$WORK_DIR = "$HOME\dev"
New-Item -ItemType Directory -Force -Path $WORK_DIR | Out-Null
cd $WORK_DIR

# Clone
git clone https://github.com/sportict/Biomechanics_Suite.git
cd Biomechanics_Suite

# 最新化(既にcloneしている場合)
git pull origin main
```

**検証**:
```powershell
Test-Path ".\HPE\package.json"           # True
Test-Path ".\MotionDigitizer\package.json" # True
Test-Path ".\MotionViewer\package.json"    # True
Test-Path ".\VideoSyncLab\package.json"    # True
```

---

## 3. モデルファイルの取得(HPE用)

**重要**: `HPE/Models/` は git に含まれていません(容量が大きいため)。以下のいずれかで取得してください。

### 3-A. USB / クラウド転送(最も確実)

macOSマシンから `HPE/Models/` フォルダをそのままコピーして、Windows側の同じ相対パス `Biomechanics_Suite\HPE\Models\` に配置。必要な5ファイル(計1.6GB):

| ファイル名 | サイズ |
|---|---|
| `rtmpose-m.onnx` | 53MB |
| `rtmpose-m_hand.onnx` | 53MB |
| `rtmpose-x.onnx` | 191MB |
| `yolo26m.onnx` | 78MB |
| `synthpose-vitpose-huge-hf.onnx` | 1.2GB |

### 3-B. GitHub Releases(自動化可、要事前アップロード)

管理者が GitHub Releases にモデルをアップロードしてあれば、以下でダウンロード可能:

```powershell
.\windows-handoff\fetch-hpe-models.ps1
```

(公開URLが設定されている前提。詳細は同ファイル冒頭コメント参照)

### 3-C. HuggingFace(SynthPose のみ)

SynthPose ONNX を HuggingFace から自動生成:

```powershell
cd HPE
python server\convert_synthpose_to_onnx.py --size huge
cd ..
```

**検証**:
```powershell
Get-ChildItem .\HPE\Models\*.onnx | Select-Object Name, @{N='Size(MB)';E={[math]::Round($_.Length/1MB,0)}}
# 上記5ファイルがすべて表示されればOK
```

---

## 4. 全アプリ一括ビルド

リポジトリ直下で:

```powershell
.\windows-handoff\build-all-windows.ps1
```

このスクリプトは以下を順に実行します(下記「5. 個別ビルド」と等価):
1. MotionViewer(最も軽量なので最初に)
2. VideoSyncLab
3. MotionDigitizer(MSVC+vcpkg必要)
4. HPE(Python venv 構築込み、最も重い)

---

## 5. 個別ビルド(トラブルシュートや再実行用)

### 5-A. MotionViewer

```powershell
cd MotionViewer
npm install
npm run build
cd ..
```
**出力**: `MotionViewer\dist\MotionViewer-Setup-1.1.0.exe`(~97MB)

### 5-B. VideoSyncLab

```powershell
cd VideoSyncLab
npm install
npm run build
cd ..
```
**出力**: `VideoSyncLab\dist\VideoSyncLab-Setup-1.0.0.exe`(~420MB)

### 5-C. MotionDigitizer(MSVC+vcpkg必要)

```powershell
cd MotionDigitizer
npm install
# ネイティブC++モジュール(OpenCV連携)を先にビルド
cd native
npm run rebuild:native 2>$null   # または: ..\node_modules\.bin\node-gyp rebuild
cd ..
npm run build
cd ..
```
**出力**: `MotionDigitizer\dist\MotionDigitizer-Setup-1.1.0.exe`(~220MB)

**エラー時のヒント**:
- `binding.gyp` で OpenCV のパスが見つからない → `C:\vcpkg\installed\x64-windows\lib` が存在するか確認
- `MSB3073` や `cl.exe not found` → Visual Studio Build Tools の VCTools ワークロードがインストールされているか確認、`Developer Command Prompt for VS 2022` を試す

### 5-D. HPE(Python venv + ONNX Runtime 同梱)

HPE は既に整備された `build.bat` があるのでそれを実行:

```powershell
cd HPE
.\build.bat
cd ..
```

**出力**: `HPE\dist\HPE-Setup-1.1.0.exe`(~数GB、ONNX モデルを含むため大きい)

---

## 6. 成果物の確認

```powershell
Get-ChildItem .\*\dist\*.exe -Recurse | Select-Object FullName, @{N='Size(MB)';E={[math]::Round($_.Length/1MB,0)}}
```

**期待される出力**:
```
MotionViewer\dist\MotionViewer-Setup-1.1.0.exe         ≈ 97
VideoSyncLab\dist\VideoSyncLab-Setup-1.0.0.exe         ≈ 420
MotionDigitizer\dist\MotionDigitizer-Setup-1.1.0.exe   ≈ 220
HPE\dist\HPE-Setup-1.1.0.exe                           ≈ 数GB
```

---

## 7. トラブルシュート

### 共通
- `npm install` で失敗 → `npm cache clean --force` → 再実行
- `electron-builder` のキャッシュ破損 → `%LOCALAPPDATA%\electron-builder\Cache` を削除

### MotionDigitizer 固有
- `Error: Cannot find module '../shared/electron-utils'` → `npm run copy-shared` を実行してから再ビルド
- C++ビルドエラー → `MotionDigitizer/native/build/` を削除して再実行

### HPE 固有
- `onnxruntime-gpu` のインストール失敗 → CUDA Toolkit 11.8 が必要(GPUなし環境は `onnxruntime` で代替検討)
- Python venv 既存破損 → `HPE\.venv` を削除して `build.bat` を再実行

---

## 付録: GitHub Actions による完全自動ビルド

ローカル環境構築不要で Windows .exe を得たい場合:

1. 変更を push: `git push origin main`
2. https://github.com/sportict/Biomechanics_Suite/actions でワークフロー `Build All Apps` の進行を確認
3. 完了後、各 Job の **Artifacts** から .exe をダウンロード

ただし HPE の GitHub Actions ビルドは`Models/` が含まれないため、アプリ側で実行時にモデル読み込みエラーが出ます(配布時は別途モデルフォルダを添付してください)。
