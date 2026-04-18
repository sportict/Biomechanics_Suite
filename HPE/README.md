# HPE - Human Pose Estimation

[rtmlib](https://github.com/Tau-J/rtmlib) をベースに、**RTMPose / RTMDet / SynthPose** を利用する人体姿勢推定デスクトップアプリ。

## 主な機能

- 画像・動画からの人体姿勢推定
- 複数の計測プリセット
  - **高速**: RTMDet + RTMPose-M(23点、軽量・リアルタイム向け)
  - **高精度**: RTMDet + RTMPose-X(23点、精度優先)
  - **SynthPose (52点)**: RTMDet + SynthPose-Huge(バイオメカニクス用52キーポイント、[Stanford MIMI / OpenCapBench](https://github.com/StanfordMIMI/OpenCapBench) の派生モデル)
- 人物追跡(Norfair ベース)による一貫したID付与
- バッチ処理(複数動画の一括推定)
- 外れ値フィルタ(Z-score / 速度 / 加速度)
- CSV / JSON / 骨格描画付き動画 エクスポート
- デバイス自動選択
  - **CoreML** (Apple Silicon / mps)
  - **CUDA** (NVIDIA GPU)
  - **CPU** (フォールバック)

## モデル構成(ONNX)

`Models/` フォルダに以下のファイルを配置します(計約 **1.6GB**):

| ファイル | 用途 | サイズ |
|---|---|---|
| `yolo26m.onnx` | 人物検出器(全プリセット共通) | 78MB |
| `rtmpose-m.onnx` | 高速プリセットの身体姿勢推定 | 53MB |
| `rtmpose-x.onnx` | 高精度プリセットの身体姿勢推定 | 191MB |
| `rtmpose-m_hand.onnx` | 手の姿勢推定(RTMPose系) | 53MB |
| `synthpose-vitpose-huge-hf.onnx` | **SynthPose 52点推定**(バイオメカニクス特化の Transformer 系モデル) | 1.2GB |

モデルファイルは容量が大きいため、このリポジトリには含まれていません(`.gitignore` 済み)。取得方法は [../windows-handoff/README.md 3章](../windows-handoff/README.md#3-モデルファイルの取得hpe用) を参照。

### モデルの入手先

- **RTMPose / RTMDet(yolo26m)**: [rtmlib](https://github.com/Tau-J/rtmlib) 配布の ONNX を利用
- **SynthPose**: [Stanford MIMI / OpenCapBench](https://github.com/StanfordMIMI/OpenCapBench) の HuggingFace モデル(バイオメカニクス用52キーポイント向けに再学習された Transformer 姿勢推定モデル)を ONNX に変換して利用
  - 自前変換: `python server/convert_synthpose_to_onnx.py --size huge`

## 開発環境での起動

### 1. Python 環境

Python 3.11 推奨。リポジトリ直下で:

**macOS:**
```bash
cd HPE
python3.11 -m venv .venv
source .venv/bin/activate
pip install ./rtmlib --no-deps
pip install -r server/requirements.txt
```

**Windows (PowerShell):**
```powershell
cd HPE
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install .\rtmlib --no-deps
pip install -r server\requirements.txt
```

### 2. Node.js 依存パッケージ

```bash
cd HPE
npm install
```

### 3. アプリ起動

```bash
npm start          # 通常起動
npm run dev        # DevTools 自動起動(開発用)
```

Python サーバー(`server/ipc_handler.py`)は Electron の子プロセスとして自動起動するので、別ターミナルで走らせる必要はありません。

## 配布用ビルド

### 前提

- Python 3.11(venv 生成に使用)
- Node.js 20+
- macOS: Xcode Command Line Tools
- Windows: Visual Studio Build Tools(ONNX Runtime のネイティブ依存)

### ビルド実行

**macOS:**
```bash
npm run build:mac
# → HPE/dist/HPE-1.1.0-arm64.dmg
```

**Windows:**
```powershell
.\build.bat
# → HPE\dist\HPE-Setup-1.1.0.exe
```

`build.bat` は `.venv` 作成 → Python パッケージインストール → `npm install` → `electron-builder --win` までを自動実行します。

## ディレクトリ構成

```
HPE/
├── main.js                     # Electron メインプロセス
├── preload.js                  # プリロード
├── package.json
├── renderer/                   # レンダラプロセス(Electron UI)
│   ├── index.html
│   ├── app.js                  # UI 制御 + IPC
│   ├── style.css
│   ├── skeleton-renderer.js    # 骨格描画
│   └── skeleton-worker.js
├── server/                     # Python バックエンド
│   ├── ipc_handler.py          # stdin/stdout JSON IPC
│   ├── rtmpose_estimator.py    # RTMPose 推定器ラッパー
│   ├── synthpose_onnx_estimator.py
│   ├── synthpose_torch_estimator.py
│   ├── onnx_vitpose_integration.py
│   ├── filtering.py            # 外れ値 & ID統合
│   ├── utils.py                # キーポイント定義 + Norfair tracker
│   ├── convert_synthpose_to_onnx.py
│   └── requirements.txt
├── rtmlib/                     # rtmlib (ローカル同梱、--no-deps でインストール)
├── Models/                     # ONNX モデル配置先(.gitignore)
├── shared/                     # 他アプリ共通 Electron ユーティリティ(ビルド時に
│   └── electron-utils.js       # リポジトリ /shared からコピー)
├── build.bat                   # Windows ビルド
└── README.md
```

## キーポイント形式

| プリセット | 出力点数 | スキーム | 主用途 |
|---|---|---|---|
| 高速 / 高精度 | 23点 | COCO17 + 足6点(HALPE26派生) | 一般動作解析 |
| SynthPose (52点) | 52点 | COCO17 + 解剖学的ランドマーク35点 | OpenSim / バイオメカニクス |

SynthPose の52点定義は [server/utils.py `KEYPOINT_NAMES_SYNTHPOSE`](server/utils.py) を参照。

## サードパーティライセンス表記

### FFmpeg (LGPL v2.1+)

動画フレーム抽出に Python 側で **ffmpeg-python** 経由で FFmpeg を呼び出しています(システム/同梱 FFmpeg バイナリ利用)。

> This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the [LGPLv2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) and its source can be downloaded [here](https://ffmpeg.org/download.html).

配布パッケージには LGPLv2.1 全文とソース入手先を同梱してください。

### 推論エンジン・モデル

- **ONNX Runtime** (MIT) — Microsoft
- **[rtmlib](https://github.com/Tau-J/rtmlib)** (Apache License 2.0)
- **RTMPose / RTMDet** (Apache License 2.0) — OpenMMLab
- **SynthPose** (Stanford MIMI / OpenCapBench) — モデル重みの配布元ライセンスに従う(リポジトリには同梱しない)
- **Norfair** (BSD-3-Clause) — 人物追跡

### その他 Python パッケージ

- **numpy** (BSD-3-Clause)
- **opencv-python** (Apache License 2.0、内部は FFmpeg 連携あり → 上記 LGPL 注意事項参照)
- **Pillow** (HPND)
- **scipy** (BSD-3-Clause)
- **filterpy** (MIT)
- **tqdm** (MIT)

本アプリ本体: MIT License
