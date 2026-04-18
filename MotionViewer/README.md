# MotionViewer

モーションキャプチャデータ(.rd / .trc / .c3d / .sd)を 3D 可視化・解析する軽量ビューワ。Three.js ベース。

## 主な機能

### 可視化

- **3D骨格アニメーション**: マーカー点 + セグメント結線
- **重心(Center of Mass)表示**: 身体重心およびセグメント別重心
- **軌跡描画**: 任意マーカーの時系列軌跡
- **カメラビュー**: 正面/側面/上面/自由視点
- **グリッド・軸**: ワールド座標系の可視化

### 解析

- **関節角度計算**: 任意の3点から角度時系列を算出
- **逆動力学(Inverse Dynamics)**: 関節モーメント・力の推定
- **バイオメカニクスモデル**:
  - 阿江モデル(14セグメント男女別質量慣性係数)
  - 和田モデル
  - De Leva 慣性係数
- **フィルタ**: バタワースローパスフィルタ

### エクスポート

- **動画エクスポート**: アニメーションを動画ファイルに変換(ffmpeg)
- **シーケンス画像**: 各フレームの画像 + ストロボ合成

## 対応データ形式

### 入力
| 拡張子 | 仕様 |
|---|---|
| `.rd` / `.sd` | 独自モーションデータ(CSV ベース) |
| `.2d` / `.3d` | 旧SuperBall Motion 形式 |
| `.trc` | OpenSim TRC(タブ区切り) |
| `.c3d` | Vicon/Qualisys/OptiTrack 標準([C3D.org 仕様](https://www.c3d.org)) |

### 独自形式 (.rd / .sd) 構造

```
フレーム数,ポイント数,フレーム間隔(秒)
x1,y1,z1,x2,y2,z2,...,xN,yN,zN   ← 1フレーム目
x1,y1,z1,x2,y2,z2,...,xN,yN,zN   ← 2フレーム目
...
```

**例**:
```
250,29,0.004000
3.806947,1.367895,0.996992,3.698909,1.370197,1.051615,...
```

- 座標系: 右手座標系
- 単位: メートル
- フレーム間隔: 秒(浮動小数点)
- 座標値: 6桁精度の浮動小数点
- 典型規模: 15〜30ポイント × 100〜1000フレーム

付属 `.set` ファイルでポイント名/色/接続を定義。

## ディレクトリ構成

```
MotionViewer/
├── package.json
├── src/
│   ├── main/
│   │   ├── main.js              # Electron メインプロセス(C3D/TRC 読み込み含む)
│   │   └── preload.js
│   └── renderer/
│       ├── index.html
│       ├── app.js               # メインレンダラ
│       ├── filter.js            # バタワースフィルタ
│       ├── body-com.js          # 身体重心計算(簡易版)
│       ├── body-com-full.js     # 身体重心計算(完全版・阿江/和田/De Leva)
│       ├── inverse-dynamics.js  # 逆動力学
│       ├── sequence-draw-window.html / .js  # シーケンス画像ウィンドウ
│       └── lib/                 # three.js 等のベンダーファイル
├── build/                       # electron-builder リソース
├── shared/                      # ビルド時に /shared からコピー(.gitignore)
└── README.md
```

## 開発・ビルド

```bash
npm install
npm start            # 通常起動
npm run dev          # DevTools 自動起動
```

**macOS ビルド:**
```bash
npm run build:mac
# → MotionViewer/dist/MotionViewer-1.1.0-arm64.dmg
```

**Windows ビルド:**
```powershell
npm run build          # NSIS インストーラ(.exe)
npm run build:portable # ポータブル(.exe)
# → MotionViewer\dist\MotionViewer-Setup-1.1.0.exe
```

Windows は Node.js 20+ のみで依存関係がシンプルなので、macOS からのクロスビルドも可能です。

## サードパーティライセンス表記

### FFmpeg (LGPL v2.1+)

動画エクスポート用に **ffmpeg-static** 経由で FFmpeg バイナリを同梱しています。

> This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the [LGPLv2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) and its source can be downloaded [here](https://ffmpeg.org/download.html).

配布時は FFmpeg のライセンス文書(LGPLv2.1)とソース入手先の明記が必要です。

### その他

- **Three.js** (MIT) — 3D レンダリング
- **ffmpeg-static** (MIT) — FFmpeg バイナリ配布ラッパー

本アプリ本体: MIT License
