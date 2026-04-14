# HPE - Human Pose Estimation

easy-ViTPose を使用したポーズ推定デスクトップアプリケーション

## 機能

- 画像・動画からの人体ポーズ推定
- 23点キーポイント検出
- 骨格・バウンディングボックス表示
- CSV/JSON形式でのエクスポート
- 骨格付き動画のエクスポート
- GPU (CUDA) / CPU 両対応

## 必要なモデルファイル

`Models/` フォルダに以下のファイルを配置してください：

```
Models/
├── yolo11x.pt                          # YOLOv11 人物検出モデル
└── vitpose-h-wholebody/
    └── vitpose-h-wholebody.onnx        # ViTPose ONNX モデル
```

## 開発環境での実行

### 1. Python環境のセットアップ

```powershell
cd server
py -3.11 -m pip install -r requirements.txt
```

### 2. Node.js依存関係のインストール

```powershell
cd app
npm install
```

### 3. 起動

**ターミナル1 (APIサーバー):**
```powershell
cd server
py -3.11 main.py
```

**ターミナル2 (Electronアプリ):**
```powershell
cd app
npm run dev
```

## 配布用ビルド

### 前提条件

- Python 3.11
- Node.js 18+
- PyInstaller (`pip install pyinstaller`)
- electron-builder (`npm install`)

### ビルド実行

```powershell
build.bat
```

ビルド完了後、`dist/win-unpacked/` フォルダが生成されます。

### 配布

1. `dist/win-unpacked/` フォルダをZIP化
2. ユーザーは解凍して `HPE - Human Pose Estimation.exe` を実行

## ディレクトリ構成

```
HPE/
├── app/                    # Electronアプリ
│   ├── main.js            # メインプロセス
│   ├── preload.js         # プリロードスクリプト
│   ├── renderer/          # レンダラープロセス
│   │   ├── index.html
│   │   ├── app.js
│   │   └── style.css
│   └── package.json
├── server/                 # Python APIサーバー
│   ├── main.py            # FastAPI サーバー
│   ├── requirements.txt
│   └── hpe-server.spec    # PyInstaller設定
├── Models/                 # モデルファイル
├── easy_ViTPose/          # ViTPoseライブラリ
├── build.bat              # ビルドスクリプト
└── README.md
```

## ライセンス

MIT License
