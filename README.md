# Biomechanics Suite

4つの Electron アプリで構成されるバイオメカニクス解析ツール群。

| アプリ | 役割 |
|---|---|
| **HPE** | 姿勢推定 (RTMPose / SynthPose 52点 / ONNX Runtime + CoreML) |
| **MotionDigitizer** | 手動デジタイズ・ChArUcoキャリブレーション・3D復元 (C++ OpenCVネイティブ) |
| **MotionViewer** | モーションデータの3D可視化 (Three.js) |
| **VideoSyncLab** | 2画面動画同期編集 |

---

## macOS ビルド(開発マシン向け)

各アプリディレクトリで:

```bash
cd <アプリ名>
npm install
npm run build:mac
```

出力: `<アプリ名>/dist/<アプリ名>-*-arm64.dmg`

## Windows ビルド

引き継ぎ資材は **[`windows-handoff/`](./windows-handoff/)** フォルダにまとまっています。Claude Desktop に `windows-handoff/README.md` を読み込ませるだけで自動セットアップが完了します。

ワンコマンド版:
```powershell
# 空のフォルダで PowerShell を開いて
iwr -useb https://raw.githubusercontent.com/sportict/Biomechanics_Suite/main/windows-handoff/setup-windows.ps1 | iex
```

## GitHub Actions による完全自動ビルド

`main` ブランチへのプッシュで `.github/workflows/build.yml` が Windows + macOS 両方の .exe / .dmg を自動生成します。Artifacts からダウンロード可能。

---

## ディレクトリ構成

```
Biomechanics_Suite/
├── HPE/                    # 姿勢推定アプリ
├── MotionDigitizer/        # デジタイズアプリ(C++ネイティブ)
├── MotionViewer/           # ビューワアプリ
├── VideoSyncLab/           # 動画同期アプリ
├── shared/                 # 4アプリ共通の Electron ユーティリティ
│   └── electron-utils.js
├── windows-handoff/        # Windows 引き継ぎ資材一式
│   ├── README.md           # 手順書(Claude Desktop に読ませる)
│   ├── setup-windows.ps1   # 総合セットアップ
│   ├── build-all-windows.ps1
│   └── fetch-hpe-models.ps1
├── .github/workflows/      # CI/CD
│   └── build.yml
└── README.md               # このファイル
```

## モデルファイルについて

`HPE/Models/` はサイズが大きいため git に含まれません(`.gitignore`済)。実行時に必要な ONNX は計 1.6GB:

- rtmpose-m.onnx (53MB)
- rtmpose-m_hand.onnx (53MB)
- rtmpose-x.onnx (191MB)
- yolo26m.onnx (78MB)
- synthpose-vitpose-huge-hf.onnx (1.2GB)

取得方法は [windows-handoff/README.md 3章](./windows-handoff/README.md#3-モデルファイルの取得hpe用) を参照。
