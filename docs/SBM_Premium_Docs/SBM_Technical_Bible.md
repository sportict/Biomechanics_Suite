  SBM Technical Bible | アルゴリズム詳細仕様書    .toc { background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; padding: 2rem; margin: 2rem 0; } .toc h3 { margin-top: 0; color: var(--accent-cyan); } .toc ol { margin: 0; padding-left: 1.5rem; } .toc li { margin: 0.4rem 0; } .toc a { color: var(--text-secondary); text-decoration: none; transition: color 0.2s; } .toc a:hover { color: var(--accent-cyan); } .toc ol ol { margin-top: 0.3rem; } .toc ol ol li { font-size: 0.92em; margin: 0.2rem 0; } .algo-pipeline { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin: 1.5rem 0; } .algo-stage { background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 8px; padding: 0.8rem 1.2rem; text-align: center; flex: 1; min-width: 120px; } .algo-stage .stage-name { font-weight: 700; color: var(--accent-cyan); font-size: 0.95rem; } .algo-stage .stage-detail { font-size: 0.82rem; color: var(--text-secondary); margin-top: 0.3rem; } .algo-arrow { color: var(--accent-blue); font-size: 1.5rem; flex-shrink: 0; } .param-table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; font-size: 0.9rem; } .param-table th { background: rgba(139, 92, 246, 0.12); color: var(--accent-purple); padding: 0.7rem 0.8rem; text-align: left; border-bottom: 2px solid rgba(139, 92, 246, 0.3); font-weight: 600; } .param-table td { padding: 0.6rem 0.8rem; border-bottom: 1px solid rgba(255, 255, 255, 0.06); vertical-align: top; } .param-table tr:hover td { background: rgba(255, 255, 255, 0.02); } .param-table code { background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 3px; font-size: 0.88em; color: #93c5fd; } .bsp-table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; font-size: 0.82rem; } .bsp-table th { background: rgba(6, 182, 212, 0.12); color: var(--accent-cyan); padding: 0.5rem; text-align: center; border-bottom: 2px solid rgba(6, 182, 212, 0.3); font-weight: 600; } .bsp-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.06); text-align: center; } .bsp-table tr:hover td { background: rgba(255,255,255,0.02); } pre { background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 1.2rem; overflow-x: auto; font-family: 'Fira Code', 'Consolas', monospace; font-size: 0.85rem; line-height: 1.6; color: #e2e8f0; } pre .comment { color: #6b7280; } pre .keyword { color: #c084fc; } pre .string { color: #34d399; } pre .number { color: #fbbf24; } pre .func { color: #60a5fa; } .file-ref { display: inline-block; font-size: 0.82rem; color: var(--text-secondary); background: rgba(0, 0, 0, 0.2); padding: 2px 10px; border-radius: 20px; margin-bottom: 0.5rem; } .file-ref i { margin-right: 4px; } .math-block { background: rgba(0, 0, 0, 0.25); border-left: 3px solid var(--accent-purple); padding: 1.2rem 1.5rem; margin: 1.5rem 0; border-radius: 0 8px 8px 0; overflow-x: auto; } .sub-section { margin-top: 2.5rem; } .sub-section:first-of-type { margin-top: 1.5rem; } .note-box { background: rgba(251, 191, 36, 0.08); border-left: 3px solid #fbbf24; padding: 1rem 1.2rem; border-radius: 0 8px 8px 0; margin: 1rem 0; font-size: 0.92rem; } .note-box strong { color: #fbbf24; } .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1rem 0; } @media (max-width: 768px) { .two-col { grid-template-columns: 1fr; } }

SBM System Technical Bible

[User Manual](SBM_User_Manual.html) [Integration Map](SBM_Integration_Map.html) [Technical Bible](SBM_Technical_Bible.html)

Algorithm Deep Dive Mathematical Proof Source Code Reference

# Algorithm &  
Mathematics

コードの深層にある数理モデルとアルゴリズムの正体。  
ブラックボックスを排除し、信頼できる科学的根拠（エビデンス）をここに提示する。

### Table of Contents

1.  [設計思想 & Tech Stack Comparison](#philosophy)
2.  [VideoSyncLab — 映像処理アルゴリズム](#vsl)
    1.  [FFmpeg Smart Cut（3セグメントハイブリッド）](#vsl-smartcut)
    2.  [フレーム同期アルゴリズム](#vsl-sync)
    3.  [ストロボモーション合成](#vsl-strobe)
    4.  [ONNX人物セグメンテーション](#vsl-onnx)
3.  [HPE — AI姿勢推定パイプライン](#hpe)
    1.  [サーバーアーキテクチャ](#hpe-arch)
    2.  [YOLO人物検出](#hpe-yolo)
    3.  [rtmlib統合骨格推定（RTMPose / SynthPose）](#hpe-vitpose)
    4.  [Norfairマルチ人物追跡](#hpe-norfair)
    5.  [検出ギャップ補間](#hpe-gapfill)
    6.  [5段階フィルタリングパイプライン](#hpe-filter)
4.  [MotionDigitizer — 空間座標変換](#md)
    1.  [2D-DLT法](#md-dlt2d)
    2.  [3D-DLT法](#md-dlt3d)
    3.  [CC法（Control Coordinates Method）](#md-cc)
    4.  [カメラモデル & レンズ歪み補正](#md-camera)
    5.  [ChArUco自動キャリブレーション](#md-charuco)
    6.  [実長換算](#md-reallength)
    7.  [C3Dフォーマット](#md-c3d)
    8.  [TRCフォーマット（OpenSim連携）](#md-trc)
    9.  [Windows 配布ビルド（OpenCV DLL 同梱 + delay-load hook）](#md-winbuild)
5.  [MotionViewer — 運動学解析エンジン](#mv)
    1.  [Butterworthフィルタ](#mv-butter)
    2.  [Wells & Winter自動カットオフ決定](#mv-cutoff)
    3.  [身体部分慣性係数（BSP）](#mv-bsp)
    4.  [身体重心（COM）算出](#mv-com)
    5.  [速度・加速度の数値微分](#mv-vel)
    6.  [関節角度の算出](#mv-joint)
    7.  [セグメント角度](#mv-segment)
    8.  [Three.js 3Dレンダリング](#mv-3d)
6.  [ファイルフォーマット仕様](#formats)
7.  [参考文献](#refs)
8.  [開発者・連絡先](#author)

## 1\. 設計思想 & Tech Stack Comparison

**SBM System** (Sports BioMechanics System) は、従来の高価な光学式モーションキャプチャ（VICON、Qualisys等）が独占していた「定量的3D動作分析」を、 汎用カメラと最先端AIと堅牢な幾何学アルゴリズムの融合によって民主化するために設計された。

**Core Philosophy:** 「AIによる省力化」と「古典的幾何学による精度保証」のハイブリッド。 AIが大量フレームの骨格推定を自動処理し、人間はAIが苦手なオクルージョン区間のみを修正する。 最終的な座標変換はDLT/CC法という確立された数理モデルが担保する。

特徴

SBM System (Hybrid)

光学式MoCap (Vicon等)

簡易スマホアプリ

**マーカー**

不要（Markerless）

必須（反射マーカー）

不要

**環境制約**

低（屋外・試合中OK）

高（専用スタジオ必須）

低

**3D精度**

高（DLT/CC補正）

極高（sub-mm）

低（2Dのみが多い）

**コスト**

低（汎用PC+カメラ）

極高（数千万円〜）

無料〜安価

**解析ロジック**

**Hybrid（AI + Human-in-the-Loop）**

幾何計算のみ

AIブラックボックス

**マルチカメラ3D**

2〜N台（DLT法）

8〜20台以上

非対応が多い

**出力形式**

CSV / C3D / 独自形式

C3D / TSV

CSV / JSON

## 2\. VideoSyncLab — 映像処理アルゴリズム

映像の品質が分析の品質を決定する。VideoSyncLabは FFmpeg を核とした高精度映像処理エンジンである。

### 2.1 FFmpeg Smart Cut（3セグメントハイブリッド）

VideoSyncLab/renderer.js — performSmartCut()

通常のストリームコピー（`-c copy`）はキーフレーム境界でしかカットできず、 開始点がGOPの途中にある場合は映像が乱れる。Smart Cutはこの問題を**3セグメント合成**で解決する。

Segment A

IN点〜次のキーフレーム  
再エンコード（H.264）

→

Segment B

キーフレーム〜最終キーフレーム  
ストリームコピー（高速）

→

Segment C

最終キーフレーム〜OUT点  
再エンコード（H.264）

→

Concat

FFmpeg concat demuxer  
で3セグメントを結合

**Note:** 再エンコードは先頭と末尾の数フレームのみに限定されるため、 全フレーム再エンコードに比べ処理時間は大幅に短縮され、画質劣化も最小限に抑えられる。

エンコードパラメータ:

// Smart Cut エンコード設定
const encodeArgs = \[
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '18',          // 高品質（視覚的にほぼロスレス）
  '-pix\_fmt', 'yuv420p',
  '-c:a', 'aac',
  '-b:a', '192k'
\];

### 2.2 フレーム同期アルゴリズム

VideoSyncLab/renderer.js — syncToParent()

マルチカメラ同期は**Parent-Child**モデルで実装されている。 左プレーヤーが親（タイムライン基準）、右プレーヤーが子となり、 ユーザーが設定した同期ポイントからオフセットを自動計算する。

\\\[ \\Delta t = \\frac{F\_{sync}^{parent} - F\_{sync}^{child}}{fps} \\\] \\\[ t\_{child} = t\_{parent} - \\Delta t \\\]

ここで \\( F\_{sync} \\) は各プレーヤーの同期ポイントフレーム番号、\\( fps \\) はフレームレートである。 同期再生中は `requestAnimationFrame` ループ内で毎フレーム子動画の `currentTime` を補正する。

### 2.3 ストロボモーション合成

VideoSyncLab/strobe-motion.js

複数フレームの人物像を1枚の静止画に重ね合わせ、動作の軌跡を視覚化する。 ONNX Runtime で YOLO11m-seg モデルを実行し、人物のセグメンテーションマスクを取得する。

Frame取得

指定間隔でフレーム  
をCanvasに描画

→

YOLO11m-seg

ONNXセグメンテーション  
人物マスク生成

→

マスク適用

ImageDataのピクセル  
単位でアルファ合成

→

合成出力

背景+全フレーム  
の人物像を重畳

#### セグメンテーション処理

YOLO11m-seg の出力テンソルからセグメンテーションマスクを復元する処理:

// 1. 検出結果 (8400 candidates) から信頼度閾値でフィルタ
// 2. 各検出のproto係数(32次元)とprotoマスク(160x160x32)の内積
// 3. シグモイド関数でマスク確率に変換
for (let i = 0; i < maskH \* maskW; i++) {
    let val = 0;
    for (let k = 0; k < 32; k++) {
        val += maskCoeffs\[k\] \* protoData\[k \* maskH \* maskW + i\];
    }
    mask\[i\] = 1.0 / (1.0 + Math.exp(-val));  // sigmoid
}
// 4. bbox領域でクリップ → 元画像サイズにリサイズ

#### 合成モード

モード

アルゴリズム

用途

**通常合成**

透明度付きオーバーレイ（後のフレームが前面）

標準的な動作軌跡の可視化

**背景差分**

先頭フレームとの差分でマスク生成

セグメンテーションなしの高速処理

**グラデーション**

時間軸に沿って色相を変化（HSL回転）

時間経過の視覚的表現

### 2.4 ONNX人物セグメンテーション

VideoSyncLab/strobe-motion.js — OnnxSegmenter

`onnxruntime-web` (WebAssembly backend) により、ブラウザプロセス内でYOLO11m-segを推論する。 モデルは `.onnx` 形式で配布され、GPUを必要としない。

パラメータ

値

説明

入力テンソル

`[1, 3, 640, 640]`

NCHW形式、RGB正規化 (0-1)

検出出力

`[1, 116, 8400]`

bbox(4) + conf(1) + classes(80) + mask\_coeffs(32) × 8400候補

マスク出力

`[1, 32, 160, 160]`

プロトタイプマスク（32チャンネル）

NMS閾値

`0.45`

IoUによる重複除去

信頼度閾値

`0.5`

検出スコアの下限

## 3\. HPE — AI姿勢推定パイプライン

HPEは**Electron（フロントエンド）+ Python IPC（バックエンド）**の二層構成で動作する。GPU/CPUの重い推論処理をPythonプロセスに委譲し、UIの応答性を維持する。

**対応プラットフォーム**: Windows (CUDA GPU) / macOS (CoreML/Apple Silicon) / CPU フォールバック

**Python環境**: Windows = `python_embed_gpu/` または `python_embed_cpu/`（組み込み配布用）/ macOS = `.venv` 仮想環境

### 3.1 サーバーアーキテクチャ

```
Electron (main.js)
  UI / ファイル管理
  app.whenReady() → startPythonProcess()
      ⇄ spawn + stdin/stdout
  Python (ipc_handler.py)
  JSON-line プロトコル
      →
  YOLO + RTMPose / SynthPose
  ONNX Runtime (CUDA 11 / CoreML / CPU)
      →
  Norfair Tracking (YOLO bbox中心)
  FPS適応型 ID永続化
      →
  fill_detection_gaps()
  検出ギャップ線形補間
```

起動シーケンス（v1.1以降）:

```
# Electron main.js から起動 (Windows: GPU優先 → CPU フォールバック)
python_embed_gpu/python.exe -u server/ipc_handler.py
python_embed_cpu/python.exe -u server/ipc_handler.py  # GPU不在時

# JSON-line プロトコル (stdin/stdout)
← {"type": "ready", "data": {"device": "cuda", "model_loading": true}}
  # ↑ ready 送信直後にバックグラウンドスレッドでモデルをプリロード開始
← {"type": "model_loading_progress", "data": {"progress": 25, "message": "YOLO検出器をロード中..."}}
← {"type": "model_loaded", "data": {"success": true, "device": "cuda"}}
→ {"type": "detect_video", "data": {"file_path": "...", ...}}
← {"type": "progress", "data": {"percent": 50}}
← {"type": "result", "data": {...}}
```

モデルプリロード（v1.1新機能）:
- `ready` 送信直後にバックグラウンドスレッドでデフォルトモデルをロード開始
- ユーザーがUIを操作する間（通常5〜30秒）に完了するため、検出ボタン押下時の待機を排除

GPU自動検出:
- **Windows**: `nvcuda.dll` の存在を高速チェック → `CUDAExecutionProvider` 確認
- **macOS**: `CoreMLExecutionProvider` / `MPSExecutionProvider` 確認
- **フォールバック**: CPUExecutionProvider

Windows CUDA環境（ORT 1.18.0固定):
- ONNX Runtime 1.18.0 は **CUDA 11 ビルド**（`cudart64_110.dll`, `cudnn64_8.dll` 等）
- ORT 1.19.0以降は cuDNN Frontend API（sm_70+ 専用）を使用するため Pascal GPU (GTX 1070 Ti / sm_61) で動作不可
- `nvidia-cudnn-cu11==8.9.5.29` の `win_amd64` wheel で `cudnn64_8.dll` を供給

### 3.2 YOLO人物検出

YOLO（You Only Look Once）は1パスでバウンディングボックスとクラスを同時予測するリアルタイム物体検出モデルである。 本システムでは **YOLO26M**（精度・速度のバランス最優）をONNX形式で利用する。

設定

値

備考

モデル

`yolo26m.onnx`（推奨）

mAP=53.4, CPU 97ms。`yolo11s.onnx` 等にも対応

入力解像度

`640 × 640`

letterbox padding で縦横比保持

対象クラス

`person (id=0)`

COCO 80クラスからpersonのみフィルタ

信頼度閾値

`0.25`（デフォルト）

UI設定で変更可能

NMS IoU

`0.45`

重複ボックス除去

推論バックエンド

`CUDA / CPU`（自動判定）

mps時はYOLOをCPUで実行（CoreMLよりCPUが高速）

**重要**: YOLOはフレーム間のID一貫性を持たない。`inference()` の戻り値は当該フレーム内の連番インデックス（0, 1, 2...）であり、次フレームでリセットされる。フレーム間のID追跡は次段のNorfairトラッカーのみが担う。

検出結果は各人物の bounding box `[x1, y1, x2, y2, confidence]` として骨格推定モデルとNorfairトラッカーに渡される。

### 3.3 rtmlib統合骨格推定（RTMPose / SynthPose）

v1.1.0 から **rtmlib** に一本化された。rtmlib は MMDeploy を使わず ONNX Runtime で直接推論する軽量ラッパーであり、RTMPose・ViTPose・SynthPose を統一インターフェースで扱える。PyTorch は不要で、ONNX ファイルのみで動作する。

#### 計測プリセットとモデル対応

プリセット | ポーズモデル | 検出モデル | 出力キーポイント | 主な用途
---|---|---|---|---
**23点（RTMPose-M・高速）** | `RTMPose-M` (HALPE 26pt ONNX) | `yolo11s.onnx` | 26pt → **23pt**変換 | 高速プレビュー・大量バッチ
**23点（RTMPose-X・高精度）** | `RTMPose-X` (HALPE 26pt ONNX) | `yolo11x.onnx` | 26pt → **23pt**変換 | 標準分析（推奨）
**52点（SynthPose-Huge）** | `SynthPose-Huge` (ViT-Huge ONNX) | `yolo11x.onnx` | **52pt** (OpenCapBench) | バイオメカニクス精密解析・OpenSim連携

#### RTMPose（23点モード）

**RTMPose**（Real-Time Multi-Person Pose Estimation）は、RTMDet をバックボーンとした高速・高精度 CNN 姿勢推定モデルである。

項目 | RTMPose-M | RTMPose-X
---|---|---
バックボーン | CSPNeXt-M | CSPNeXt-XL
入力解像度 | `256 × 192` | `256 × 192`
出力キーポイント | **26点** (HALPE) | **26点** (HALPE)
変換後 | **23点**（バイオメカニクス標準） | **23点**（バイオメカニクス標準）
速度 | 高速 | 標準
推論形式 | ONNX Runtime (CUDA/CPU) | ONNX Runtime (CUDA/CPU)

#### SynthPose（52点モード）

**SynthPose** は OpenCap / OpenCapBench の合成データで学習した ViT-Huge ベースのモデルで、OpenSim 互換の **52点** バイオメカニクスマーカーを直接出力する。

項目 | 詳細
---|---
モデル | `synthpose-vitpose-huge-hf.onnx` (ViT-Huge backbone)
入力解像度 | `256 × 192`
出力 | **52点** ヒートマップ `[batch, 52, 64, 48]`
フォーマット | OpenCapBench（OpenSim マーカー互換）
推論形式 | ONNX Runtime (CUDA/CPU)

#### HALPE 26点 → 23点マッピング（RTMPoseモード）

RTMPose の HALPE 26点出力から、バイオメカニクス分析に必要な 23 関節を選択・統合する:

#

関節名

HALPE元ID

備考

0

鼻 (Nose)

0

頭部基準

1-2

左右目

1, 2

頭部方向の推定

3-4

左右耳

3, 4

頭部幅の推定

5-6

左右肩

5, 6

上肢の起点

7-8

左右肘

7, 8

—

9-10

左右手首

9, 10

—

11-12

左右股関節

11, 12

下肢の起点

13-14

左右膝

13, 14

—

15-16

左右足首

15, 16

—

17-18

左右つま先

17, 20 (foot)

大指先端

19-20

左右かかと

19, 22 (foot)

踵骨後端

21-22

左右手指先

mid-finger tip

中指先端

### 3.4 Norfairマルチ人物追跡

HPE/server/utils.py — NorfairPersonTracker

複数人物が交差する場面でのID入れ替わりを防止するため、 **Norfair**ライブラリのカルマンフィルタ + ハンガリアンアルゴリズムによる追跡を実装。

#### v1.1の重要設計変更

**トラッキング入力: キーポイント → YOLO bbox 中心点**

旧実装ではRTMPoseの肩・腰キーポイント（HALPE 26pt インデックス 5,6,11,12）をアンカーとしていた。しかし出力フォーマット（23pt等）変換後はインデックスが別の関節（手首・肘・足首・膝）を指し、姿勢変化でマッチングが外れてID断片化が発生していた。v1.1では **YOLO bbox 中心点 `(cx, cy)`** をトラッキング入力とし、RTMPoseの推定精度に依存しない安定したID追跡を実現している。

```python
# Detection作成（1点 = bbox中心）
cx = (bbox[0] + bbox[2]) / 2
cy = (bbox[1] + bbox[3]) / 2
points = np.array([[cx, cy]])
scores = np.array([bbox[4]])  # YOLO confidence
```

#### カルマンフィルタ

各追跡対象の状態ベクトルは位置と速度で構成される:

\\\[ \\mathbf{x}\_k = \\begin{bmatrix} x \\\\ y \\\\ \\dot{x} \\\\ \\dot{y} \\end{bmatrix}, \\quad \\mathbf{x}\_{k|k-1} = \\mathbf{F} \\mathbf{x}\_{k-1} + \\mathbf{w}\_k \\\]

予測ステップで次フレームの位置を推定し、観測ステップで実際の検出結果と照合する。

#### FPS適応型距離閾値

1フレームあたりの最大許容移動量をFPSから動的に算出する。人間の最大移動速度を **3000 px/秒**（走行時の四肢末端を想定）として正規化:

\\\[ d\_{threshold} = \\text{clip}\\left(\\frac{3000 \\; \\text{[px/s]}}{fps \\times \\max(width, height)},\\; 0.005,\\; 0.4\\right) \\\]

| FPS | 最大許容移動量 | 正規化閾値（1920px幅） |
|---|---|---|
| 30fps | 100 px/frame | 0.052 |
| 60fps | 50 px/frame | 0.026 |
| 120fps | 25 px/frame | 0.013 |
| 240fps | 12.5 px/frame | 0.0065 |

この閾値を超えたbbox移動は同一人物として認識せず、新規IDを発行する。通常カメラ・ハイスピードカメラを自動的に区別できる。

#### パラメータ（動画検出時に自動設定）

パラメータ

値

役割

`distance_function`

Normalized Euclidean (bbox center)

bbox中心間の正規化ユークリッド距離

`distance_threshold`

FPS適応型（上表参照）

これを超えると別人物と判定

`hit_counter_max`

`max(60, fps × 2)` フレーム

検出消失後もこのフレーム数IDを保持

`initialization_delay`

`0`

即座にIDを確定（Raw IDとの入れ替わり防止）

`pointwise_hit_counter_max`

`1`

1点トラッキングに最適化

### 3.5 検出ギャップ補間

HPE/server/filtering.py — fill_detection_gaps()

YOLO検出が失敗したフレーム（オクルージョン、急激な動き、照明変化等）では `frame_data["keypoints"]` にその人物のエントリが存在しない。`fill_detection_gaps()` は動画全フレーム検出完了後のポストプロセスとして、人物ごとに不在フレームを前後から**線形補間**で埋める。

```
Frame N-2: Person 1 detected  → kpts_a (confidence: 0.85)
Frame N-1: 未検出              → 線形補間: t=0.5, conf=0.34  ← 自動補完
Frame N:   Person 1 detected  → kpts_b (confidence: 0.82)
```

\\\[ \\mathbf{k}(t) = \\mathbf{k}\_a \\cdot (1 - t) + \\mathbf{k}\_b \\cdot t, \\quad t = \\frac{f - f\_a}{f\_b - f\_a} \\\]

補間フレームの信頼度は端点の低い方 × `interp_confidence`（デフォルト 0.4）を付与し、元データより弱い値としてマークする。これにより後段のフィルタリング（外れ値除去・Butterworth等）で「補間由来データ」として適切に扱われる。

パラメータ

値

説明

`max_gap_frames`

`int(fps × 0.5)`

補間対象の最大ギャップ（0.5秒超は補間しない）

`interp_confidence`

`0.4`

補間フレームに付与する信頼度係数

適用順序（detect_video ポストプロセス）:
1. `consolidate_person_ids()` — ID統合（断片化ID同士のマージ）
2. `fill_detection_gaps()` ← ここで補間（統合後のIDに対して適用）

### 3.6 5段階フィルタリングパイプライン

HPE/renderer/app.js — filterPipeline()

AI推定の生データにはスパイクノイズ、左右入替、欠損が含まれる。 以下の5段階フィルタで段階的にデータ品質を改善する。

① 外れ値除去

速度ベース  
閾値判定

→

② 左右入替補正

交差距離  
チェック

→

③ 補間

PCHIP / Cubic  
Akima / Linear

→

④ Butterworth

ローパス  
フィルタ

→

⑤ Kalman

前後双方向  
スムーザ

#### ① 外れ値除去（Velocity-based Outlier Rejection）

隣接フレーム間の移動速度が閾値を超えた場合、そのフレームのキーポイントを欠損（NaN）とマークする。

\\\[ v\_i = \\sqrt{(x\_i - x\_{i-1})^2 + (y\_i - y\_{i-1})^2} \\\] \\\[ \\text{if} \\quad v\_i > \\mu + k \\sigma \\quad \\Rightarrow \\quad (x\_i, y\_i) = \\text{NaN} \\\]

#### ② 左右入替補正（Limb Swap Correction）

AIが左右のキーポイントを誤って入れ替えるケースを検出・修正する。 対称関節ペア（左肩-右肩等）の交差距離をフレーム間で追跡し、急激な入替を検出する。

#### ③ 補間（Interpolation）

欠損区間を以下のアルゴリズムで補間する（ユーザー選択可能）:

手法

特徴

推奨場面

**PCHIP**

区分的3次エルミート。オーバーシュートなし

一般的な動作（推奨）

**Cubic Spline**

滑らかだがオーバーシュートの可能性あり

滑らかな動作

**Akima**

局所的フィット。急激な変化に強い

爆発的動作

**Linear**

直線補間。最もシンプル

短い欠損区間

#### ④ Butterworthローパスフィルタ

高周波ノイズを除去する2次Butterworthフィルタ。カットオフ周波数はユーザー設定（デフォルト: 6Hz）。

#### ⑤ Kalmanスムーザ

前方パス（フィルタ）と後方パス（スムーザ）を組み合わせた **RTS（Rauch-Tung-Striebel）スムーザ**。 時系列全体の情報を使って最適な状態推定を行う。

### 3.6 ONNX Runtime Optimization & Acceleration

本システムでは、PyTorchなどの学習フレームワークをそのまま推論に使用せず、 **ONNX (Open Neural Network Exchange) Runtime** を採用することで、 商用レベルの推論速度と効率性を実現している。

#### なぜ PyTorch 生モデルではなく ONNX なのか？

学習（Training）と推論（Inference）は要求されるリソース特性が全く異なる。 ONNX Runtimeへの移行により、以下の数理的・工学的最適化が適用される。

最適化技術

詳細

効果

**Graph Optimization**

計算グラフの静的解析による不要ノード削除、定数畳み込み（Constant Folding）、 演算融合（Operator Fusion: Conv+BatchNorm+Relu → Single Kernel）。

メモリアクセス回数の削減、レイテンシ低下

**Execution Providers**

ハードウェアごとのバックエンド（CUDA, TensorRT, CPU, DirectML）を 抽象化レイヤーで切り替え、各デバイスに特化したカーネルを実行。

ハードウェア性能の最大化

**Quantization (量子化)**

FP32（32bit浮動小数点）から FP16 / INT8 への精度・型変換。 ダイナミックレンジの縮小による計算コスト削減。

モデルサイズ 1/2〜1/4、推論速度 2〜4倍

**Memory Optimization**

メモリ割り当ての計画化（Static Memory Planning）により、 動的なメモリ確保・解放のオーバーヘッドを排除。

ピークメモリ使用量の削減

**Deployment Benefit:** PyTorchの巨大な依存関係（数GB）を排除し、軽量なONNX Runtimeライブラリのみで動作するため、 配布パッケージサイズを劇的に削減でき、Python環境のバージョン依存問題（Dependency Hell）も回避できる。

## 4\. MotionDigitizer — 空間座標変換

MotionDigitizerの中核は「ピクセル座標（画像平面）を実世界座標（メートル空間）に変換する」ことである。 この変換を支える数理的基盤を詳述する。

### 4.1 2D-DLT法（Direct Linear Transformation）

MotionDigitizer/src/analysis-engine.js — solveDLT2D()

単一カメラで撮影した2D平面上の運動を実長換算する手法。 **8個のカメラ定数** \\( L\_1 \\dots L\_8 \\) を用いて射影変換を定義する。

\\\[ u = \\frac{L\_1 X + L\_2 Y + L\_3}{L\_7 X + L\_8 Y + 1} \\\] \\\[ v = \\frac{L\_4 X + L\_5 Y + L\_6}{L\_7 X + L\_8 Y + 1} \\\]

ここで \\( (u, v) \\) は画像座標（ピクセル）、\\( (X, Y) \\) は実空間座標（メートル等）。 分母を払って線形化すると:

\\\[ \\begin{bmatrix} X\_1 & Y\_1 & 1 & 0 & 0 & 0 & -u\_1 X\_1 & -u\_1 Y\_1 \\\\ 0 & 0 & 0 & X\_1 & Y\_1 & 1 & -v\_1 X\_1 & -v\_1 Y\_1 \\\\ \\vdots & & & & & & & \\vdots \\end{bmatrix} \\begin{bmatrix} L\_1 \\\\ L\_2 \\\\ \\vdots \\\\ L\_8 \\end{bmatrix} = \\begin{bmatrix} u\_1 \\\\ v\_1 \\\\ \\vdots \\end{bmatrix} \\\]

**必要条件:** 最低4個の制御点（8個の方程式で8個の未知数を解く）。冗長性のため6点以上を推奨。

**逆変換:** 既知の \\( L\_1 \\dots L\_8 \\) を用いて、任意の画像座標 \\( (u, v) \\) から実空間座標 \\( (X, Y) \\) を逆算可能。 これにより、デジタイズした全キーポイントを実長に換算する。

### 4.2 3D-DLT法

MotionDigitizer/src/analysis-engine.js — solveDLT3D()

2台以上のカメラ映像から3次元座標を復元する。各カメラに**11個の定数** \\( L\_1 \\dots L\_{11} \\) を定義する。

\\\[ u = \\frac{L\_1 X + L\_2 Y + L\_3 Z + L\_4}{L\_9 X + L\_{10} Y + L\_{11} Z + 1} \\\] \\\[ v = \\frac{L\_5 X + L\_6 Y + L\_7 Z + L\_8}{L\_9 X + L\_{10} Y + L\_{11} Z + 1} \\\]

**キャリブレーション:** 6個以上の既知3D制御点から、各カメラの11定数を最小二乗法で算出。

**3D復元:** 2台のカメラで同一点をデジタイズすると、4本の方程式（各カメラ2本）で3つの未知数 \\( (X, Y, Z) \\) を解く過決定系となる。

// 3D-DLT 座標復元（2カメラの場合）
// 行列 A (4×3) と ベクトル b (4×1) を構築
A = \[
  \[L11 - L91·u1,  L21 - L101·u1,  L31 - L111·u1\],
  \[L51 - L91·v1,  L61 - L101·v1,  L71 - L111·v1\],
  \[L12 - L92·u2,  L22 - L102·u2,  L32 - L112·u2\],
  \[L52 - L92·v2,  L62 - L102·v2,  L72 - L112·v2\]
\];
// 最小二乗法: X = (AᵀA)⁻¹ Aᵀb
const result = math.lusolve(AtA, Atb);

### 4.3 3次元CC法（競技場特徴点利用）

MotionDigitizer/src/cc-method-implementation.js

**鈴木ら (2016)** によって提案された「競技場の特徴点を利用したカメラパラメータ算出法」。 DLT法が少なくとも6点の3次元的（Z軸方向に広がりのある）な制御点を必要とするのに対し、 CC法は**平面上（Z=0）の最低3点**の制御点のみでキャリブレーションが可能である。

#### 透視投影モデル（共線性条件式）

\\\[ u = u\_0 - f\_u \\frac{r\_{11}(X - X\_0) + r\_{12}(Y - Y\_0) + r\_{13}(Z - Z\_0)}{r\_{31}(X - X\_0) + r\_{32}(Y - Y\_0) + r\_{33}(Z - Z\_0)} \\\] \\\[ v = v\_0 - f\_v \\frac{r\_{21}(X - X\_0) + r\_{22}(Y - Y\_0) + r\_{23}(Z - Z\_0)}{r\_{31}(X - X\_0) + r\_{32}(Y - Y\_0) + r\_{33}(Z - Z\_0)} \\\]

ここで \\((X\_0, Y\_0, Z\_0)\\) はカメラ位置、\\((u\_0, v\_0)\\) は光学中心、 \\((f\_u, f\_v)\\) は焦点距離、\\(r\_{ij}\\) は回転行列要素（オイラー角 \\(\\phi, \\theta, \\psi\\) より算出）である。

#### 最適化の2段階戦略

#### Stage 1: 大域的探索 (GA)

**遺伝的アルゴリズム（Genetic Algorithm）**を用いて、多峰性を持つ探索空間から大域的最適解の候補を探索する。 これにより、初期値依存性を低減し、局所解へのトラップを回避する（鈴木らの手法の核）。

#### Stage 2: 局所的収束

**Nelder-Mead法**（シンプレックス法）または準ニュートン法で、GAの解を初期値として高精度に収束させる。 再投影誤差を最小化するパラメータを確定する。

#### 目的関数（再投影誤差）

\\\[ E = \\sum\_{i=1}^{N} \\sqrt{(u\_i - \\hat{u}\_i(\\mathbf{p}))^2 + (v\_i - \\hat{v}\_i(\\mathbf{p}))^2} \\\]

**Accuracy Improvement:** 本システムでは、**Charucoボード**で事前に取得した高精度な内部パラメータ（焦点距離、歪み係数）を固定値として利用することで、 最適化計算の自由度を下げ、外部パラメータ（カメラ位置・姿勢）の推定精度を飛躍的に向上させている。

### 4.4 カメラモデル & レンズ歪み補正

CC法の内部で使用されるピンホールカメラモデルとレンズ歪みモデルを示す。

#### ピンホールカメラ投影

\\\[ \\begin{bmatrix} x' \\\\ y' \\\\ z' \\end{bmatrix} = \\mathbf{R} \\begin{bmatrix} X - T\_x \\\\ Y - T\_y \\\\ Z - T\_z \\end{bmatrix} \\\] \\\[ u\_0 = f \\cdot \\frac{x'}{z'}, \\quad v\_0 = f \\cdot \\frac{y'}{z'} \\\]

ここで \\( \\mathbf{R} \\) は回転行列（3つの回転角 ω, φ, κ から構成）、\\( (T\_x, T\_y, T\_z) \\) はカメラ位置、\\( f \\) は焦点距離。

#### レンズ歪み補正

放射歪みと接線歪みの両方を補正する:

\\\[ r^2 = u\_0^2 + v\_0^2 \\\] \\\[ \\Delta\_r = k\_1 r^2 + k\_2 r^4 + k\_3 r^6 \\quad \\text{(放射歪み)} \\\] \\\[ \\Delta u\_t = 2 p\_1 u\_0 v\_0 + p\_2 (r^2 + 2 u\_0^2) \\quad \\text{(接線歪み)} \\\] \\\[ \\Delta v\_t = p\_1 (r^2 + 2 v\_0^2) + 2 p\_2 u\_0 v\_0 \\\] \\\[ u = u\_0 (1 + \\Delta\_r) + \\Delta u\_t + c\_x \\\] \\\[ v = v\_0 (1 + \\Delta\_r) + \\Delta v\_t + c\_y \\\]

歪み係数

種別

効果

\\( k\_1, k\_2, k\_3 \\)

放射歪み

樽型 / 糸巻き型歪みの補正

\\( p\_1, p\_2 \\)

接線歪み

レンズ軸のズレによる歪みの補正

\\( c\_x, c\_y \\)

主点

光学中心のオフセット

### 4.5 ChArUco自動キャリブレーション

MotionDigitizer/src/charuco-calibration.js

ChArUcoボード（チェスボード + ArUcoマーカーの融合）を撮影した複数枚の画像から、 カメラの内部パラメータと歪み係数を自動推定する。OpenCV nativeモジュールを使用。

処理ステップ

内容

1\. ArUco検出

各画像からArUcoマーカーのIDと角点を検出

2\. ChArUco補間

ArUcoの位置からチェスボード角点のサブピクセル位置を補間

3\. キャリブレーション

`cv.calibrateCamera()` で内部パラメータと歪み係数を推定

4\. 再投影誤差

平均再投影誤差（RMS）を表示。0.5px以下が良好

### 4.6 実長換算（4点法）

MotionDigitizer/src/renderer.js — calculateRealLength()

DLT/CC法が使えない簡易的な場面では、映像内の既知距離（身長、器具の長さ等）を 基準として画素→実長のスケールファクターを算出する。

\\\[ \\text{scale} = \\frac{D\_{real}}{D\_{pixel}} = \\frac{D\_{real}}{\\sqrt{(x\_2 - x\_1)^2 + (y\_2 - y\_1)^2}} \\\]

4点法では2組の基準距離（例: 水平方向と垂直方向）を指定し、直交2方向のスケールを独立に設定できる。

### 4.7 C3Dフォーマット

MotionDigitizer/src/c3d-exporter.js

**C3D**（Coordinate 3D）はバイオメカニクス分野の標準バイナリ交換フォーマットである。 Visual3D、MATLAB等の外部ソフトウェアとのデータ互換を確保する。

セクション

内容

ヘッダー

マーカー数、フレーム数、サンプリングレート等（512バイトブロック）

パラメータ

グループ/パラメータ階層構造（POINT:LABELS, POINT:RATE等）

3Dデータ

各フレーム × 各マーカーの (X, Y, Z, residual) を float32 で格納

**エンディアン:** C3Dはリトルエンディアン（Intel形式）とビッグエンディアン（SGI形式）の両方をサポート。 本システムはリトルエンディアンで出力する。

### 4.8 TRCフォーマット（OpenSim連携）

MotionDigitizer/src/trc-handler.js

**TRC**（Track Row Column）は OpenSim が採用するマーカー軌跡の標準テキストフォーマットである。DLT法または実長換算で得た 3D 座標を、Inverse Kinematics / Scale Tool の入力として使用する。

ファイル構造（タブ区切り）は以下のとおり:

- Line 1: `PathFileType  4  (X/Y/Z)  motion.trc`
- Line 2: パラメータ列名（`DataRate  CameraRate  NumFrames  NumMarkers  Units ...`）
- Line 3: パラメータ値（例 `30.00  30.00  300  23  m ...`）
- Line 4: マーカー名ヘッダー（`Frame#  Time  R.Ankle      L.Ankle ...`）
- Line 5: サブ列ラベル（`X1  Y1  Z1  X2  Y2  Z2 ...`）
- Line 6: **必須空行**（OpenSim 仕様）
- Line 7+: データ行

**重要:** Line 6 の空行は OpenSim 公式仕様で必須。この行がないと一部の OpenSim バージョンでデータが正しく読み込まれない。

**座標系変換:** カメラ座標系（Z-up）から OpenSim 座標系（Y-up）への変換を実装する。`X_new = Y_cam`（奥行き→前後）、`Y_new = Z_cam`（高さ→上下）、`Z_new = X_cam`（横→左右）。

```js
/**
 * カメラ座標系 → OpenSim 座標系への変換
 * カメラ: X=左右, Y=奥行, Z=高さ
 * OpenSim: X=前後, Y=上下, Z=左右
 */
function toOpenSimAxes(x, y, z) {
    return { x: y, y: z, z: x };
}
```

**マーカー名:** ポイント名は CSV/プロジェクトの名前がそのまま TRC に出力される。OpenSim モデル側のマーカー名と一致させる必要があるため、OpenSim モデルのマーカー名にプロジェクトのポイント名を合わせるか、OpenSim 側の Setup XML でマーカーをマッピングすること。

### 4.9 Windows 配布ビルド — OpenCV DLL 同梱と delay-load hook

MotionDigitizer v1.1.0 以降、Windows インストーラは **自己完結型 (self-contained)** とし、OpenCV / FFmpeg / VC++ Redist の全依存 DLL を `resources/opencv/` に同梱する。ユーザ側の `vcpkg` 環境や `%PATH%` 設定に依存せず、クリーン環境でも起動できることを要件とする。

#### アーキテクチャ

ネイティブアドオン `opencv_module.node` は node-addon-api ベースで、OpenCV 4.x を静的にリンクせず **動的 DLL 参照** としている（ビルド時間短縮と再配布ライセンス対応のため）。実行時は以下の経路で解決される:

1. Electron プロセス起動時に `electron-main.js` が `process.env.PATH` の先頭に `<resourcesPath>/opencv` を挿入する。
2. `require('opencv_module')` 実行時、Windows ローダが `opencv_core4.dll`、`opencv_imgproc4.dll` 等を `PATH` から解決する。
3. 同フォルダに同梱した `avformat-61.dll`、`avcodec-61.dll` 等の FFmpeg ランタイム、`MSVCP140.dll`、`VCRUNTIME140.dll`、`VCRUNTIME140_1.dll` も同様に解決される。

#### delay-load hook（Electron v32+ 対応）

Electron v32 以降、Node.js API は `electron.exe` に内部統合されており、配布物には `libnode.dll` / `node.exe` / `iojs.exe` のいずれも存在しない。node-addon-api を使ったネイティブアドオンは既定でこれらをインポートテーブルに含むため、ロード時に `ERR_DLOPEN_FAILED: libnode.dll could not be found` が発生する。

本プロジェクトではカスタム delay-load hook `native/win_delay_load_hook_electron.cc` を用意し、上記 3 DLL のシンボルを `GetModuleHandle(NULL)` 経由で **ホストプロセス (electron.exe)** にリダイレクトする。`binding.gyp` で以下を指定することで、node-gyp のデフォルトフックを無効化してカスタムフックを優先させる:

```python
"win_delay_load_hook": "false",
"conditions": [["OS=='win'", {
  "sources": [ "win_delay_load_hook_electron.cc" ],
  "msvs_settings": {
    "VCLinkerTool": {
      "DelayLoadDLLs": [ "libnode.dll", "node.exe", "iojs.exe" ],
      "AdditionalOptions": [ "/ignore:4199" ]
    }
  }
}]]
```

ビルド後は `dumpbin /imports opencv_module.node` で **"Section contains the following delay load imports: node.exe"** と表示されることを確認する。これら 3 DLL が `static imports` 側に残っている場合、配布環境で起動失敗する。

#### 同梱 DLL レイアウト（resources/opencv/）

| カテゴリ | DLL 例 | 由来 |
| --- | --- | --- |
| OpenCV 4.x core | `opencv_core4.dll`, `opencv_imgproc4.dll`, `opencv_videoio4.dll`, `opencv_calib3d4.dll`, `opencv_aruco4.dll` 等 9 個 | vcpkg x64-windows |
| FFmpeg | `avformat-61.dll`, `avcodec-61.dll`, `avutil-59.dll`, `swscale-8.dll` ほか | vcpkg x64-windows |
| 画像コーデック | `libpng16.dll`, `libjpeg*.dll`, `libwebp*.dll`, `tiff.dll`, `openjp2.dll` 等 | vcpkg x64-windows（OpenCV 間接依存） |
| VC++ Redistributable | `MSVCP140.dll`, `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` | Microsoft VC++ Runtime（再配布ライセンス対応） |

DLL 総数は約 75 個、サイズは約 120 MB。`REBUILD_OPENCV_WINDOWS.ps1` が `vcpkg` インストールディレクトリから必要 DLL を再帰的に抽出して配置する。

#### electron-builder 設定のポイント

- `package.json` の `build.extraResources` に `{"from": "vendor/opencv/bin", "to": "opencv"}` を指定し、`resources/opencv/` 配下に展開する。
- `asarUnpack` に `"**/*.node"`, `"**/ffmpeg*"`, `"**/ffprobe*"` を含め、ASAR 外に展開して動的ロード可能にする。
- `nsis.oneClick: false`、`nsis.allowElevation: true` でユーザ選択インストーラに切り替え、インストール先を `C:\Program Files\MotionDigitizer` 既定とする。

#### 起動時診断ログ

`electron-main.js` の `writeOpenCVDiagLog()` が起動時に `%APPDATA%\MotionDigitizer\opencv-diag.log` へ以下を書き出し、配布環境でのロード失敗を事後診断できるようにしている:

- `app.getAppPath()` / `process.resourcesPath` の実パス
- `resources/opencv/` の全エントリ列挙（ファイル名・サイズ）
- 17 個の必須 DLL（OpenCV 9 + FFmpeg 4 + 画像コーデック 1 + VC++ Redist 3）の個別存在チェック結果
- `process.env.PATH` のスナップショット（挿入後）

ユーザがトラブルシュートで該当ログを添付すれば、DLL 欠落なのかローダパスの問題なのかを即座に判別できる。

## 5\. MotionViewer — 運動学解析エンジン

3D座標データから運動学的パラメータ（速度、角度、重心等）を算出し、 3D可視化と時系列グラフで表示するエンジン。

### 5.1 Butterworthフィルタ

MotionViewer/src/renderer/butterworth-filter.js

座標データの高周波ノイズを除去するため、**4次Butterworthローパスフィルタ**を実装。 カスケード接続された2つの2次セクション（biquad）で構成される。

#### 伝達関数（アナログ）

\\\[ |H(j\\omega)|^2 = \\frac{1}{1 + \\left(\\frac{\\omega}{\\omega\_c}\\right)^{2n}} \\\]

ここで \\( n = 4 \\)（4次）、\\( \\omega\_c \\) はカットオフ角周波数。

#### カスケードBiquad実装

4次フィルタは2つの2次セクションに分解される。各セクションのQ値:

セクション

Q値

極角度

Biquad 1

\\( Q\_1 = 0.5411961 \\)

\\( \\pi \\cdot 5/8 \\)

Biquad 2

\\( Q\_2 = 1.3065630 \\)

\\( \\pi \\cdot 7/8 \\)

双線形変換（Bilinear Transform）でデジタルフィルタ係数に変換:

\\\[ \\omega\_a = \\tan\\left(\\frac{\\pi f\_c}{f\_s}\\right) \\quad \\text{(周波数プリワーピング)} \\\] \\\[ a\_0 = 1 + \\frac{\\omega\_a}{Q} + \\omega\_a^2, \\quad b\_0 = \\frac{\\omega\_a^2}{a\_0}, \\quad b\_1 = \\frac{2\\omega\_a^2}{a\_0}, \\quad b\_2 = b\_0 \\\]

#### ゼロ位相フィルタ（filtfilt）

位相遅れを完全に除去するため、**前方パス + 時系列反転 + 後方パス**の構成を採用。 実効的なフィルタ次数は 4×2 = **8次** 相当となる。

function filtfilt(b, a, data) {
    const forward = applyFilter(b, a, data);         // 前方パス
    const reversed = forward.slice().reverse();     // 時系列反転
    const backward = applyFilter(b, a, reversed);    // 後方パス
    return backward.slice().reverse();              // 再反転で出力
}

### 5.2 Wells & Winter 自動カットオフ決定

MotionViewer/src/renderer/butterworth-filter.js — autoDetectCutoff()

**Wells & Winter (1980)** の残差分析法により、最適なカットオフ周波数を自動決定する。 各候補周波数でフィルタリングを行い、残差の二乗和（SSE）を評価する。

\\\[ SSE(f\_c) = \\sum\_{i=1}^{N} \\left( x\_i - \\hat{x}\_i(f\_c) \\right)^2 \\\]

SSE曲線を高周波側（ノイズ成分のみが残る領域）で線形回帰し、 その外挿直線からSSE曲線が乖離し始める点を最適カットオフとする。

// 候補周波数 1Hz〜Nyquist/2 を走査
for (let fc = 1; fc <= nyquist / 2; fc += 0.5) {
    const filtered = butterworthFilter(data, fc, fs);
    const sse = data.reduce((sum, x, i) =>
        sum + (x - filtered\[i\]) \*\* 2, 0);
    residuals.push({ fc, sse });
}
// SSE曲線の変曲点を検出 → 最適カットオフ

### 5.3 身体部分慣性係数（BSP）

MotionViewer/src/renderer/body-com.js

各身体セグメントの**質量比**（体重に対する割合）と**重心比**（近位端からの距離比）を 文献データベースとして保持している。

#### Ae et al. (2014/2015) — 日本人成人モデル

セグメント

質量比 (男性)

重心比 (男性)

質量比 (女性)

重心比 (女性)

頭部

0.0694

0.4860

0.0669

0.4860

体幹

0.4270

0.4510

0.4260

0.4510

上腕

0.0280

0.5290

0.0255

0.5290

前腕

0.0168

0.4150

0.0138

0.4150

手

0.0061

0.8910

0.0056

0.8910

大腿

0.1100

0.4330

0.1180

0.4330

下腿

0.0500

0.4340

0.0480

0.4340

足

0.0124

0.4400

0.0107

0.4400

#### 対応BSPモデル一覧

モデル名

対象

特徴

文献

**Ae 2014**

日本人成人

15セグメント、23点モデル対応

阿江ほか (2014)

**Ae 2015**

日本人成人

15セグメント、25点モデル対応

阿江ほか (2015)

**Yokoi**

日本人小児 (3-15歳)

年齢別パラメータ（発育補正）

横井ほか

**Okada**

日本人高齢者

サルコペニア・脂肪分布を考慮

岡田ほか

### 5.4 身体重心（COM）算出

各セグメントの重心位置 \\( \\mathbf{g}\_i \\) をBSPの重心比から算出し、 質量加重平均で全身重心を求める。

#### セグメント重心の算出

\\\[ \\mathbf{g}\_i = \\mathbf{p}\_{proximal} + r\_i \\cdot (\\mathbf{p}\_{distal} - \\mathbf{p}\_{proximal}) \\\]

ここで \\( r\_i \\) はBSPテーブルの重心比、\\( \\mathbf{p}\_{proximal} \\) は近位端、\\( \\mathbf{p}\_{distal} \\) は遠位端の座標。

#### 全身重心

\\\[ \\mathbf{G}\_{body} = \\frac{\\sum\_{i=1}^{n} m\_i \\cdot \\mathbf{g}\_i}{\\sum\_{i=1}^{n} m\_i} = \\sum\_{i=1}^{n} w\_i \\cdot \\mathbf{g}\_i \\\]

ここで \\( w\_i = m\_i / M \\) は各セグメントの質量比（BSPテーブルの値そのもの）。

### 5.5 速度・加速度の数値微分（FDF法）

MotionViewer/src/renderer/filter.js — calculateVelocitySeries() MotionViewer/src/renderer/app.js — calculateAndCacheVelocity()

速度の算出には、微分によるノイズ増幅を抑制するため、**FDF法（Filtering-Differentiation-Filtering）**を採用している。 位置データの平滑化だけでなく、微分後の速度データに対しても再度ローパスフィルタを適用する。

位置データ

Raw Coordinate

→

Filter 1

Butterworth 4次  
(位置用Cutoff)

→

微分

3点中央差分  
Central Diff

→

Filter 2

Butterworth 4次  
(速度用Cutoff)

→

速度

Smooth Velocity

#### 1\. 中央差分法（Central Difference）

2次精度の3点中央差分により、フレーム \\( i \\) における仮速度を算出する:

\\\[ v\_x(t) = \\frac{x(t + \\Delta t) - x(t - \\Delta t)}{2 \\Delta t} \\\]

#### 2\. 第2段階フィルタリング（Velocity Filtering）

数値微分プロセスは高周波ノイズを直線的に増幅させる特性がある（\\( \\frac{d}{dt} e^{i\\omega t} = i\\omega e^{i\\omega t} \\)）。 そのため、第1段階（位置）のフィルタだけでは不十分であり、微分後に第2段階のフィルタリングを行うことがバイオメカニクス分析のベストプラクティスとされる。

速度データの最適カットオフ周波数は **Wells & Winter法** (\`calculateVelocityCutoff\`) により、位置データとは独立して推定される。通常、位置データよりも低い周波数が選択される傾向にある。

**Performance Note:** このFDF処理は計算コストが高いため、\`app.js\` 内で **事前計算キャッシュ (Velocity Cache)** される。 グラフ描画時にはキャッシュされたデータが高速に参照され、フィルタ設定変更時のみ再計算が行われる。

### 5.6 関節角度の算出

MotionViewer/src/renderer/app.js — calculateJoi