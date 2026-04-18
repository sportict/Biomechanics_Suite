# VideoSyncLab

二画面動画同期編集アプリ。異なるタイミング・フレームレートで撮影された2本の動画を同期再生・切り出し・スローモーション出力する。

## 主な機能

### 動画同期

- **二画面同時再生**: 左右2本の動画をフレーム精度で同期
- **親子制御**: 左画面の操作で両動画が連動(再生・停止・コマ送り)
- **オフセット調整**: 任意の秒数/フレーム数でタイミング補正(0.5秒以上のズレを自動補正)
- **一画面/二画面切替**: 同期せず単独で扱うモード

### 切り出し・変換

| モード | 処理時間 | 画質 | 用途 |
|---|---|---|---|
| **高速カット** ✂️ | 数秒 | 無劣化(ストリームコピー) | フレーム指定で素早く切り出し |
| **再エンコード** 🎥 | 数分 | 高品質 | MP4/AVI 変換・スローモーション生成 |

### 全フレーム保持スローモーション

高フレームレート素材を低フレームレートにフレーム間引きなしで出力:

| 入力 | 出力 | 倍速 |
|---|---|---|
| 30fps  | 30fps | 等速 |
| 60fps  | 60fps | 等速 |
| 120fps | 30fps | 4倍スロー(全フレーム保持) |
| 240fps | 30fps | 8倍スロー(全フレーム保持) |

### 人物セグメンテーション(ストロボ合成)

- **YOLOv11x-seg(ONNX)** で人物マスクを生成
- 複数フレームの人物領域を合成した**ストロボ・モーション画像**を生成
- 背景静止・人物のみ重畳する表現が可能

## ディレクトリ構成

```
VideoSyncLab/
├── main.js                   # Electron メインプロセス + ffmpeg 呼び出し
├── preview.html              # プレビューウィンドウ(二画面表示)
├── index.html                # メイン UI
├── renderer.js
├── styles.css
├── strobe-motion.js / .css   # ストロボモーション合成
├── onnx-segmentation.js      # ONNX Runtime による人物セグメンテーション
├── Models/
│   └── yolo11x_segment.onnx  # YOLOv11x セグメンテーションモデル
├── shared/                   # ビルド時に /shared からコピー(.gitignore)
├── build/                    # electron-builder リソース
├── build-portable.js
├── CHANGELOG.md
└── README.md
```

## 開発・ビルド

### 前提
- Node.js 20+
- ネイティブ依存パッケージ(`canvas`, `sharp`, `onnxruntime-node`)がプリビルド済みバイナリをダウンロード

### 起動

```bash
npm install
npm start            # 通常起動
npm run dev-tools    # DevTools 自動起動
```

### ビルド

**macOS:**
```bash
npm run build:mac
# → VideoSyncLab/dist/VideoSyncLab-1.0.0-arm64.dmg
```

**Windows:**
```powershell
npm run build          # NSIS インストーラ(.exe)
npm run build:portable # ポータブル(.exe、インストール不要)
# → VideoSyncLab\dist\VideoSyncLab-Setup-1.0.0.exe
```

## ファイル関連付け

`.vsl` 拡張子はプロジェクトファイルとして関連付けされます(動画パス + 同期オフセット + 切り出し範囲を保存)。

## サードパーティライセンス表記

本アプリは以下のライブラリを利用しています。**配布時はライセンス表記の同梱が必要**です。

### FFmpeg (LGPL v2.1+)

動画の読み込み・エンコード・フレーム抽出の全工程で **ffmpeg-static** / **ffprobe-static** + **fluent-ffmpeg** 経由で FFmpeg バイナリを呼び出します。

> This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the [LGPLv2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) and its source can be downloaded [here](https://ffmpeg.org/download.html).

**重要**: 配布パッケージには FFmpeg バイナリと同じディレクトリに以下を含めてください:
- LGPLv2.1 ライセンス全文(`COPYING.LGPLv2.1` / `LICENSE`)
- FFmpeg ソースコードの入手方法(URL)

### YOLOv11 / ultralytics (AGPL v3.0)

`Models/yolo11x_segment.onnx` は [Ultralytics YOLOv11](https://github.com/ultralytics/ultralytics) の ONNX エクスポート。

> **AGPL v3.0** ライセンス。商用利用する場合は Ultralytics の Enterprise License が必要です。詳細は https://www.ultralytics.com/license を参照。

### その他

- **fluent-ffmpeg** (MIT) — ffmpeg コマンドビルダ
- **ffmpeg-static** / **ffprobe-static** (MIT) — バイナリ同梱(内部は LGPL FFmpeg)
- **onnxruntime-node** (MIT) — ONNX 推論エンジン
- **sharp** (Apache License 2.0) — 画像処理(libvips)
- **canvas** (MIT) — Node 側 Canvas 描画
- **uuid** (MIT)

本アプリ本体: MIT License
