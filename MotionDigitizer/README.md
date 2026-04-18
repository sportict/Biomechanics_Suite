# MotionDigitizer

手動デジタイズと多手法キャリブレーションを統合した動作解析アプリ。OpenCV(C++ ネイティブモジュール) + Electron。

## 主な機能

### キャリブレーション手法(7種類)

| 手法 | カメラ数 | 用途 |
|---|---|---|
| **ChArUcoボード法(シングル)** | 1 | ChArUco ボード配置で内部パラメータ + 2D実長換算 |
| **ChArUcoボード法(ステレオ)** | 2 | 内部・外部パラメータ同時推定、3D復元 |
| **2次元DLT法(シングル)** | 1 | 平面計測向けの古典的手法 |
| **2次元DLT法(ステレオ)** | 2 | ステレオDLT |
| **3次元DLT法** | 2 | 既知キャリブレーションポイントからの3D復元 |
| **3次元CC法(競技場特徴点)** | 2 | コート線等の特徴点ベース自己校正 |
| **4点実長換算** | 1 | 4点の実座標のみで簡易スケーリング |

### デジタイズ・解析

- **マニュアルデジタイズ**: 動画を逐次表示しながら各フレームでポイント配置
- **リバースデジタイズ**: 終端→先頭方向の作業モード
- **軌跡表示**: 時系列ポイントの軌跡を動画上に重畳
- **フレーム制御**: スライダー / 矢印キー / 再生ボタン、ハイスピードカメラ対応(FPS 任意設定)
- **ChArUco 自動検出**: CLAHE前処理 + サブピクセル精緻化(CoreML/OpenCL 未使用の純CV)
  - 高速パス: Canvas の生ピクセル(RGBA)を IPC で直接C++へ渡して JPEG エンコード/デコード往復を廃止

### 解析結果

- **2D実長換算**: 画像座標→実空間座標(Z=0平面)
- **3D再構成**: ステレオキャリブレーション + 三角測量
- **再投影誤差**: Rodrigues 変換ベースの pinhole 投影で px 単位誤差を算出
- **外れ値除外**: 各サンプル(view)の RMS グラフから個別に除外 → 再計算を繰り返し可能

### エクスポート

- **.rd / .set** (独自モーションデータ形式)
- **TRC** (OpenSim 互換)
- **C3D** (Vicon 標準)
- **Excel (.xlsx)** (`xlsx` ライブラリ)
- **JSON** (プロジェクトファイル .mdp)

## ディレクトリ構成

```
MotionDigitizer/
├── electron-main.js                  # Electron メインプロセス + IPC + ファイルI/O
├── preload.js
├── index.html                        # メイン UI
├── calibration-3d-view.html          # 3D可視化用別ウィンドウ
├── package.json
├── src/
│   ├── renderer.js                   # メインレンダラ(5000+行)
│   ├── ui-components.js              # UI部品 + 実長換算ロジック
│   ├── file-handler.js               # .mdp / .rd / .trc / .c3d 入出力
│   ├── trc-handler.js                # TRC フォーマット詳細
│   ├── c3d-handler.js                # C3D フォーマット詳細
│   ├── data-manager.js               # プロジェクトデータ管理
│   ├── analysis-engine.js            # 解析計算(DLT, CC法等)
│   ├── camera-model-projection.js    # カメラモデル投影関数
│   ├── table-operations.js           # 表編集
│   └── style.css
├── native/                           # C++ ネイティブモジュール
│   ├── opencv_module.cpp             # OpenCV + ArUco ラッパー
│   ├── binding.gyp                   # node-gyp ビルド設定
│   └── build.bat                     # Windows個別ビルド(MSVC)
├── shared/                           # ビルド時に /shared からコピー
│   └── electron-utils.js
├── vendor/opencv/                    # Windows用 OpenCV DLL(同梱、.gitignore)
├── assets/                           # アイコン等
├── mdp/                              # サンプルプロジェクトファイル
└── README.md
```

## 開発環境での起動

### 前提

- Node.js 20+
- **Windows**: Visual Studio Build Tools 2022 + [vcpkg](https://github.com/microsoft/vcpkg) で OpenCV(`vcpkg install opencv:x64-windows`)
- **macOS**: Xcode Command Line Tools + Homebrew OpenCV(`brew install opencv`)

### セットアップ

```bash
cd MotionDigitizer
npm install
npm run rebuild:native   # C++ ネイティブモジュール(opencv_module)をビルド
npm start
```

開発時のホットリロードは `npm run dev` 相当が無いため、コード変更後は `Cmd/Ctrl+R` で再読み込み。

## ビルド

**macOS:**
```bash
npm run build:mac
# → MotionDigitizer/dist/MotionDigitizer-1.1.0-arm64.dmg
```

**Windows:**
```powershell
npm install
npm run rebuild:native
npm run build
# → MotionDigitizer\dist\MotionDigitizer-Setup-1.1.0.exe
```

ビルド前に自動的に `npm run copy-shared` がリポジトリ直下の `/shared/` を `MotionDigitizer/shared/` にコピーします。

## プロジェクトファイル(.mdp)

MotionDigitizer のすべての状態(動画パス・ポイント定義・デジタイズデータ・キャリブレーション結果)は単一の `.mdp`(JSON形式)に保存されます。サンプルは [`mdp/`](./mdp/) を参照。

## サードパーティライセンス表記

本アプリは以下のライブラリを利用しています。配布時はライセンス表記を同梱する必要があります。

### FFmpeg (LGPL v2.1+)

動画フレーム抽出・変換に **ffmpeg-static** / **ffprobe-static** 経由で FFmpeg バイナリを同梱しています。

> This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the [LGPLv2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html) and its source can be downloaded [here](https://ffmpeg.org/download.html).

- ffmpeg-static (MIT) → 内部で FFmpeg LGPL ビルドを配布
- ffprobe-static (MIT) → 同上
- fluent-ffmpeg (MIT)

**重要**: 再配布する場合、FFmpeg バイナリと同じディレクトリに **LICENSE / COPYING.LGPLv2.1** を含め、ソース入手先を明記してください。

### OpenCV (Apache License 2.0)

`native/opencv_module.cpp` で OpenCV(含む ArUco contribモジュール) をリンク。Windows は vcpkg 配布、macOS は Homebrew 配布を利用。

### その他

- **Three.js** (MIT) — 3D可視化
- **Plotly.js** (MIT) — グラフ
- **mathjs** (Apache License 2.0) — 行列計算
- **xlsx (SheetJS)** (Apache License 2.0) — Excelエクスポート
- **dat.GUI** (Apache License 2.0)
- **iconv-lite** (MIT)
- **electron-store** (MIT)

本アプリ本体: MIT License
