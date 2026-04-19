#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RTMPose Estimator
RTMPose-X (HALPE 26点) + オプション:
  - rtmpose-m_hand : 手先 (middle MCP) 推定

出力 keypoints インデックス:
  0-25 : HALPE 26点
  26   : right_hand_tip (hand モデルあれば middle MCP、なければ前腕延長)
  27   : left_hand_tip  (同上)
  28   : sternum        (両肩の中点)
"""

import sys
import numpy as np
import cv2
from typing import Dict, List, Optional, Any, Tuple
from pathlib import Path


# ===================================
# rtmlib をプロジェクトルートから読む
# ===================================
_THIS_DIR = Path(__file__).parent
_ROOT     = _THIS_DIR.parent
_RTMLIB   = _ROOT / "rtmlib"
if str(_RTMLIB) not in sys.path:
    sys.path.insert(0, str(_RTMLIB))


# ===================================
# モデル入力サイズ（実測値）
# ===================================
# body モデル: ファイル名末尾の文字でサイズを決定
BODY_INPUT_SIZES = {
    'x': (288, 384),   # rtmpose-x
    'l': (256, 320),   # rtmpose-l
    'm': (192, 256),   # rtmpose-m
    's': (192, 256),   # rtmpose-s
    't': (192, 256),   # rtmpose-t
}
BODY_INPUT_SIZE_DEFAULT = (288, 384)
HAND_INPUT_SIZE = (192, 256)   # rtmpose-m_hand: (w, h)

# RTMPose hand 21点出力における middle MCP インデックス
HAND_MIDDLE_MCP  = 9
# 前腕長に対する手先 bbox の半辺スケール
HAND_BBOX_SCALE  = 0.7


# ===================================
# ONNXモデル入力サイズ検出
# ===================================
def _detect_input_size(onnx_path: str) -> Tuple[int, int]:
    """ONNXモデルの入力形状から (width, height) を取得。失敗時はファイル名から推測。"""
    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
        shape = sess.get_inputs()[0].shape  # [batch, channels, height, width]
        if len(shape) >= 4 and isinstance(shape[2], int) and isinstance(shape[3], int):
            return (shape[3], shape[2])  # (width, height)
    except Exception:
        pass
    # フォールバック: ファイル名末尾の文字からサイズを決定
    _stem = Path(str(onnx_path)).stem.lower()
    _size_key = _stem[-1] if _stem else 'x'
    return BODY_INPUT_SIZES.get(_size_key, BODY_INPUT_SIZE_DEFAULT)


# ===================================
# YOLOX 検出器ラッパー
# ===================================
class _YOLOXDetectorWrapper:
    """rtmlib の YOLOX クラスを RTMPoseEstimator の detector インターフェースに合わせるラッパー。

    MPS (Apple Silicon) デバイスでの優先順位:
    1. rtmlib humanart YOLOX (NMS なし → CoreML 対応) を自動ダウンロードして使用
    2. ローカル YOLOX (NMS あり) で CoreML を試みる
    3. MPS (Metal GPU) を試みる
    4. CPU にフォールバック

    detect() の戻り値は ONNXYoloDetector と同じ (N, 5) [x1,y1,x2,y2,conf] 形式に統一。
    """

    # rtmlib humanart YOLOX モデル (NMS なし → CoreML 対応)
    # mmpose 公式モデルハブからダウンロード (~/.cache/rtmlib/ にキャッシュ)
    _RTMLIB_HUMANART_URL = (
        'https://download.openmmlab.com/mmpose/v1/projects/'
        'rtmposev1/onnx_sdk/yolox_x_8xb8-300e_humanart-a39d44ed.zip'
    )

    def __init__(self,
                 onnx_path: str,
                 device: str = 'cpu',
                 conf_threshold: float = 0.3,
                 iou_threshold: float = 0.45,
                 input_size: int = 640,
                 log_func=None):
        self._log = log_func or (lambda msg: None)

        from rtmlib.tools.object_detection.yolox import YOLOX

        # ONNXモデルの実際の入力サイズを検出（config.yolo_sizeがモデルと不一致の場合に対応）
        actual_size = self._detect_model_input_size(onnx_path, input_size)
        if actual_size != input_size:
            self._log(f'[YOLOX] config yolo_size={input_size} だがモデル入力は {actual_size}x{actual_size} → モデルに合わせる')
        input_size = actual_size

        if device == 'mps':
            # MPS デバイスでは CoreML 対応の rtmlib humanart モデルを優先
            # ローカルモデル (NMS 内蔵) は CoreML 非対応のため後回し
            self._model = self._load_mps_preferred(
                YOLOX, onnx_path, device, conf_threshold, iou_threshold, input_size
            )
        else:
            self._model = YOLOX(
                onnx_model=onnx_path,
                model_input_size=(input_size, input_size),
                mode='human',
                score_thr=conf_threshold,
                nms_thr=iou_threshold,
                backend='onnxruntime',
                device=device,
            )

        self.device = self._model.device

    @staticmethod
    def _detect_model_input_size(onnx_path: str, fallback: int = 640) -> int:
        """ONNXモデルの実際の入力サイズを検出する。固定サイズでない場合は fallback を返す。"""
        try:
            import onnxruntime as ort
            sess = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
            shape = sess.get_inputs()[0].shape  # [batch, channels, height, width]
            if len(shape) >= 4 and isinstance(shape[2], int) and shape[2] > 0:
                return shape[2]  # height (正方形前提)
        except Exception:
            pass
        return fallback

    def _load_mps_preferred(self, YOLOX, onnx_path, device, conf_threshold, iou_threshold, input_size):
        """MPS デバイス向けロード戦略。CoreML 対応モデルを優先的に試みる。"""

        # ---- Step 1: rtmlib humanart YOLOX (NMS なし → CoreML 対応) ----
        # キャッシュ済みか、ダウンロード可能であれば使用
        try:
            from rtmlib.tools.file import download_checkpoint as _rtmlib_dl
            self._log('[YOLOX] rtmlib humanart YOLOX (CoreML対応) を確認中...')
            _humanart_path = _rtmlib_dl(self._RTMLIB_HUMANART_URL)
            self._log(f'[YOLOX] humanart モデル: {_humanart_path}')
            _humanart_size = self._detect_model_input_size(_humanart_path, input_size)
            _model = YOLOX(
                onnx_model=_humanart_path,
                model_input_size=(_humanart_size, _humanart_size),
                mode='human',
                score_thr=conf_threshold,
                nms_thr=iou_threshold,
                backend='onnxruntime',
                device=device,   # 'mps' → base.py が CoreML を試みる
            )
            if _model.device != 'cpu':
                self._log(f'[YOLOX] humanart YOLOX: CoreML で動作 (providers={_model.session.get_providers()})')
                return _model
            else:
                self._log('[YOLOX] humanart YOLOX: CoreML 失敗、ローカルモデルを試みる...')
        except Exception as _e:
            self._log(f'[YOLOX] humanart YOLOX ダウンロード/ロード失敗 ({_e})')

        # ---- Step 2: ローカルモデル (NMS あり) で CoreML を試みる ----
        try:
            _model = YOLOX(
                onnx_model=onnx_path,
                model_input_size=(input_size, input_size),
                mode='human',
                score_thr=conf_threshold,
                nms_thr=iou_threshold,
                backend='onnxruntime',
                device=device,
            )
            if _model.device != 'cpu':
                self._log(f'[YOLOX] ローカル YOLOX: CoreML で動作')
                return _model
            self._log('[YOLOX] ローカル YOLOX: CoreML 失敗 (NMS 内蔵モデルは CoreML 非対応)')
        except Exception as _e:
            self._log(f'[YOLOX] ローカルモデルロード失敗 ({_e})')
            # ローカルモデルを CPU で作成 (フォールバック用)
            _model = YOLOX(
                onnx_model=onnx_path,
                model_input_size=(input_size, input_size),
                mode='human',
                score_thr=conf_threshold,
                nms_thr=iou_threshold,
                backend='onnxruntime',
                device='cpu',
            )

        # ---- Step 3: MPS (Metal GPU) を試みる ----
        import onnxruntime as ort
        _avail = ort.get_available_providers()
        self._log(f'[YOLOX] 利用可能なプロバイダー: {_avail}')
        if 'MPSExecutionProvider' in _avail:
            try:
                self._log('[YOLOX] MPSExecutionProvider を試みる...')
                _sess = ort.InferenceSession(
                    onnx_path,
                    providers=['MPSExecutionProvider', 'CPUExecutionProvider'],
                )
                _inp = _sess.get_inputs()[0]
                _shape = [d if (isinstance(d, int) and d > 0) else 1 for d in _inp.shape]
                _sess.run(None, {_inp.name: np.zeros(_shape, dtype=np.float32)})
                _model.session = _sess
                _model.device  = 'mps'
                self._log('[YOLOX] MPSExecutionProvider OK')
                return _model
            except Exception as _e:
                self._log(f'[YOLOX] MPS も失敗 ({_e}), CPU で動作')
        else:
            self._log('[YOLOX] MPSExecutionProvider 未サポート, CPU で動作')

        # ---- Step 4: CPU (最終フォールバック) ----
        self._log('[YOLOX] CPU で動作 (M5 でも十分高速です)')
        return _model

    def detect(self, image: np.ndarray) -> np.ndarray:
        """人物検出を実行。

        Returns:
            boxes: (N, 5) [x1, y1, x2, y2, conf]
            ※ rtmlib YOLOX は conf を返さないため 1.0 で埋める。
        """
        boxes = self._model(image)  # (N, 4) or empty
        if boxes is None or len(boxes) == 0:
            return np.zeros((0, 5), dtype=np.float32)
        conf_col = np.ones((len(boxes), 1), dtype=np.float32)
        return np.hstack([boxes.astype(np.float32), conf_col])

    def get_providers(self) -> list:
        """現在有効な ONNX Runtime プロバイダーを返す。"""
        return self._model.session.get_providers()


# ===================================
# RTMPose Estimator クラス
# ===================================
class RTMPoseEstimator:
    """
    RTMPose-X (HALPE 26点) 推定器。
    rtmpose-m_hand.onnx が Models/ に存在すれば手先推定も行う。

    inference() 戻り値: {i: {'keypoints': np.ndarray(29,3), 'bbox': bbox}}

    keypoints インデックス:
      0-25 : HALPE 26点
      26   : right_hand_tip
      27   : left_hand_tip
      28   : sternum (両肩の中点)
    """

    def __init__(self,
                 body_onnx_path: str,
                 device: str = 'cpu',
                 yolo_onnx_path: str = '',
                 yolo_size: int = 640,
                 conf_threshold: float = 0.3,
                 iou_threshold: float = 0.45,
                 log_func=None):

        self._log = log_func or print
        self.device = device

        from rtmlib.tools.pose_estimation.rtmpose import RTMPose
        from onnx_vitpose_integration import ONNXYoloDetector

        # CoreML非対応モデルへのフォールバック用ヘルパー
        def _load_with_fallback(loader_fn, label: str, target_device: str = None):
            """loader_fn() を試し、失敗したら CPU で再試行"""
            _dev = target_device or device
            try:
                return loader_fn(_dev), _dev
            except Exception as e:
                if _dev != 'cpu':
                    self._log(f"[RTMPose] {label} load error on {_dev}: {e}")
                    self._log(f"[RTMPose] {label} falling back to CPU")
                    try:
                        return loader_fn('cpu'), 'cpu'
                    except Exception as e2:
                        raise RuntimeError(f"{label} loading failed: {e2}") from e2
                raise RuntimeError(f"{label} loading failed: {e}") from e

        # ----- YOLO 検出器 -----
        # M5 ベンチマーク: YOLOはCoreMLよりCPUの方が速い（パーティション分割コスト）
        # mps デバイスでも YOLO は CPU 実行が最適
        yolo_device_override = 'cpu' if device == 'mps' else device
        self._log(f"[RTMPose] Loading YOLO: {yolo_onnx_path} (device={yolo_device_override})")
        is_yolox = 'yolox' in Path(yolo_onnx_path).name.lower()
        if is_yolox:
            # rtmlib 純正 YOLOX クラスを使用
            self.detector, yolo_device = _load_with_fallback(
                lambda d: _YOLOXDetectorWrapper(
                    onnx_path=yolo_onnx_path,
                    device=d,
                    conf_threshold=conf_threshold,
                    iou_threshold=iou_threshold,
                    input_size=yolo_size,
                    log_func=self._log,
                ),
                "YOLOX",
                target_device=yolo_device_override,
            )
        else:
            self.detector, yolo_device = _load_with_fallback(
                lambda d: ONNXYoloDetector(
                    onnx_path=yolo_onnx_path,
                    device=d,
                    conf_threshold=conf_threshold,
                    iou_threshold=iou_threshold,
                    input_size=yolo_size,
                ),
                "YOLO",
                target_device=yolo_device_override,
            )

        # ----- rtmlib RTMPose (体幹) -----
        self._log(f"[RTMPose] Loading body: {body_onnx_path}")
        body_input_size = _detect_input_size(body_onnx_path)
        self._log(f"[RTMPose] Body input size: {body_input_size}")
        self._body_model, body_device = _load_with_fallback(
            lambda d: RTMPose(
                onnx_model=body_onnx_path,
                model_input_size=body_input_size,
                backend='onnxruntime',
                device=d,
            ),
            "RTMPose body"
        )

        # base.py が CoreML フォールバック時に self.device を 'cpu' に更新するため
        # _load_with_fallback の戻り値 body_device ではなく
        # モデルが実際に使ったデバイスを参照する
        self.device = self._body_model.device
        if self.device != device:
            import sys as _sys_rtm
            if _sys_rtm.platform == 'darwin':
                _reason = "CoreML unsupported for this model"
            elif _sys_rtm.platform == 'win32':
                _reason = "GPU EP load failed (CUDA/cuDNN 未検出 or バージョン不整合)"
            else:
                _reason = "GPU EP unavailable, fell back to CPU"
            self._log(f"[RTMPose] body: requested={device}, actual={self.device} ({_reason})")

        # ----- rtmlib RTMPose (手先) — オプション -----
        hand_path = Path(body_onnx_path).parent / "rtmpose-m_hand.onnx"
        if hand_path.exists():
            self._log(f"[RTMPose] Loading hand: {hand_path}")
            try:
                # body モデルと同様に ONNX モデルから入力サイズを自動検出する。
                # HAND_INPUT_SIZE ハードコード値 (192, 256) はモデルによって異なるため
                # _detect_input_size() で実際の形状を読み取る。
                hand_input_size = _detect_input_size(str(hand_path))
                self._log(f"[RTMPose] Hand input size (auto-detected): {hand_input_size}")
                self._hand_model, _ = _load_with_fallback(
                    lambda d: RTMPose(
                        onnx_model=str(hand_path),
                        model_input_size=hand_input_size,
                        backend='onnxruntime',
                        device=d,
                    ),
                    "RTMPose hand"
                )
                self._with_hand = True
            except Exception as e:
                self._log(f"[RTMPose] Hand model load failed: {e}, skipping")
                self._hand_model = None
                self._with_hand = False
        else:
            self._hand_model = None
            self._with_hand = False
            self._log("[RTMPose] Hand model not found, using forearm extension fallback")

        self._log(f"[RTMPose] Ready (device={self.device})")
        # 実際に使用されているプロバイダーをログ出力（CoreML/CPU フォールバック確認用）
        try:
            active = self.get_active_providers()
            for model_name, providers in active.items():
                self._log(f"[RTMPose] Active providers [{model_name}]: {providers}")
        except Exception as e:
            self._log(f"[RTMPose] Could not retrieve active providers: {e}")

        # ウォームアップ: GPU/CPU の JIT コンパイルとメモリアリーナを事前初期化して
        # 最初の実フレームでの遅延スパイクを防ぐ
        self._warmup()

    # ------------------------------------------------------------------
    def reset(self):
        pass

    # ------------------------------------------------------------------
    def _warmup(self) -> None:
        """GPU/CPU の初回推論オーバーヘッド（CUDA JIT・メモリアリーナ初期化）を事前に消化する。
        モデルロード直後に一度だけ呼び出す。失敗しても致命的エラーにはしない。"""
        try:
            self._log("[RTMPose] Warming up models...")

            # ── YOLO ──────────────────────────────────────────────────────────
            # detector の入力サイズに合わせたダミー画像を作成することで
            # 内部リサイズ処理をスキップし、前処理コストをほぼゼロにする。
            _yw = getattr(self.detector, 'input_width',  640)
            _yh = getattr(self.detector, 'input_height', 640)
            _ = self.detector.detect(np.full((_yh, _yw, 3), 128, dtype=np.uint8))

            # ── RTMPose body / hand ───────────────────────────────────────────
            # model_input_size (w, h) に合わせた最小ダミー画像を用意し、
            # 画像全体を bbox として渡す → クロップ後のリサイズが恒等変換になり前処理コスト最小。
            for _model in filter(None, [self._body_model,
                                        self._hand_model if self._with_hand else None]):
                _mw, _mh = _model.model_input_size   # (width, height) as stored by rtmlib
                _img = np.full((_mh, _mw, 3), 128, dtype=np.uint8)
                _ = _model(_img, bboxes=[[0, 0, _mw, _mh]])

            self._log("[RTMPose] Warmup complete")
        except Exception as _e:
            self._log(f"[RTMPose] Warmup warning (non-critical): {_e}")

    # ------------------------------------------------------------------
    def _wrist_bbox(self, kpts: np.ndarray, side: str) -> Optional[List[float]]:
        """手首周辺の bbox を返す。信頼度が低い場合は None。"""
        if side == 'right':
            wrist, elbow = kpts[10], kpts[8]
        else:
            wrist, elbow = kpts[9], kpts[7]

        if wrist[2] < 0.3:
            return None

        if elbow[2] > 0.3:
            arm_len = float(np.linalg.norm(wrist[:2] - elbow[:2]))
        else:
            arm_len = 60.0

        half = max(arm_len * HAND_BBOX_SCALE, 30.0)
        return [wrist[0] - half, wrist[1] - half, wrist[0] + half, wrist[1] + half]

    # ------------------------------------------------------------------
    def _fill_hand_tips(self, kpts: np.ndarray, image: np.ndarray) -> None:
        """kpts[26]/[27] に手先 (middle MCP) を書き込む。"""
        for side, tip_idx in [('right', 26), ('left', 27)]:
            bbox = self._wrist_bbox(kpts, side)
            if bbox is None:
                continue
            try:
                hand_kpts, hand_scores = self._hand_model(image, bboxes=[bbox])
                if len(hand_kpts) > 0 and len(hand_kpts[0]) > HAND_MIDDLE_MCP:
                    kpts[tip_idx, :2] = hand_kpts[0][HAND_MIDDLE_MCP]
                    kpts[tip_idx, 2]  = hand_scores[0][HAND_MIDDLE_MCP]
            except Exception:
                pass

    # ------------------------------------------------------------------
    def inference(self, image: np.ndarray) -> Dict[int, Any]:
        """
        BGR 画像を受け取り、拡張キーポイントを返す。
        Returns: {person_id: {'keypoints': np.ndarray(29,3), 'bbox': bbox}}

        Args:
            image: BGR 画像 (H, W, 3)。OpenCV の cap.read() 出力をそのまま渡せる。
                   呼び出し元で BGR→RGB 変換不要。
        """
        # YOLO: BGR 入力を期待（内部で BGR→RGB 変換） — 変換コストなし
        boxes = self.detector.detect(image)
        if len(boxes) == 0:
            return {}

        # RTMPose (body/hand): RGB 入力を期待 → ここで 1 回だけ変換
        # 旧実装: ipc_handler で BGR→RGB、ここで RGB→BGR、YOLO後に改めてRGBを使用
        #   = 2 回の cvtColor。新実装では 1 回に削減。
        img_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        # ---- 体幹推定 (全人物一括) ----
        bboxes_list = [b[:4].tolist() for b in boxes]
        body_kpts_all, body_scores_all = self._body_model(img_rgb, bboxes=bboxes_list)

        results: Dict[int, Any] = {}
        # 手先推定用: 全人物の手 bbox を一括収集
        hand_requests = []  # [(person_idx, tip_idx, bbox), ...]

        for i, bbox in enumerate(boxes):
            kpts_xy = body_kpts_all[i]   # (26, 2)
            scores  = body_scores_all[i]  # (26,)

            # (29, 3) バッファ: 0-25=HALPE, 26-27=hand_tip, 28=sternum
            kpts = np.zeros((29, 3), dtype=np.float32)
            kpts[:26, :2] = kpts_xy
            kpts[:26, 2]  = scores

            # kpts[28]: 胸骨上縁 = 両肩の中点 (HALPE 5=LShoulder, 6=RShoulder)
            l_sh, r_sh = kpts[5], kpts[6]
            if l_sh[2] > 0.1 and r_sh[2] > 0.1:
                kpts[28, :2] = (l_sh[:2] + r_sh[:2]) / 2
                kpts[28, 2]  = min(l_sh[2], r_sh[2])
            else:
                kpts[28] = kpts[18]  # fallback: HALPE neck

            # 手先 bbox を収集（後でバッチ推定）
            if self._with_hand:
                for side, tip_idx in [('right', 26), ('left', 27)]:
                    hbox = self._wrist_bbox(kpts, side)
                    if hbox is not None:
                        hand_requests.append((i, tip_idx, hbox))

            results[i] = {'keypoints': kpts, 'bbox': bbox}

        # ---- 手先推定 (全人物・両手を一括バッチ) ----
        if self._with_hand and hand_requests:
            all_hand_bboxes = [req[2] for req in hand_requests]
            try:
                hand_kpts_all, hand_scores_all = self._hand_model(img_rgb, bboxes=all_hand_bboxes)
                for idx, (person_i, tip_idx, _) in enumerate(hand_requests):
                    if idx < len(hand_kpts_all) and len(hand_kpts_all[idx]) > HAND_MIDDLE_MCP:
                        kpts = results[person_i]['keypoints']
                        kpts[tip_idx, :2] = hand_kpts_all[idx][HAND_MIDDLE_MCP]
                        kpts[tip_idx, 2]  = hand_scores_all[idx][HAND_MIDDLE_MCP]
            except Exception:
                pass

        return results

    # ------------------------------------------------------------------
    def get_active_providers(self) -> Dict[str, List[str]]:
        yolo_providers = self.detector.get_providers()
        try:
            body_providers = self._body_model.session.get_providers()
        except Exception:
            body_providers = ['unknown']
        return {
            'yolo':    yolo_providers,
            'vitpose': body_providers,
        }


# ===================================
# ロードヘルパー (ipc_handler.py から呼び出す)
# ===================================
def load_rtmpose_estimator(models_dir: Path,
                           yolo_type: Optional[str],
                           device: str,
                           body_model: str = 'rtmpose-x.onnx',
                           yolo_size: int = 640,
                           conf_threshold: float = 0.3,
                           log_func=None) -> Tuple['RTMPoseEstimator', str, str]:
    _log = log_func or print

    # YOLO パス
    if yolo_type:
        yolo_path = str(models_dir / yolo_type)
    else:
        yolo_files = sorted(models_dir.glob("yolo*.onnx"))
        if not yolo_files:
            raise FileNotFoundError("YOLO ONNX model not found in Models/")
        yolo_path = str(yolo_files[0])

    # 体幹モデル
    body_path = models_dir / body_model
    if not body_path.exists():
        raise FileNotFoundError(f"RTMPose body model not found: {body_path}")

    estimator = RTMPoseEstimator(
        body_onnx_path=str(body_path),
        device=device,
        yolo_onnx_path=yolo_path,
        yolo_size=yolo_size,
        conf_threshold=conf_threshold,
        log_func=_log,
    )

    model_tag = body_path.stem.upper().replace('RTMPOSE-', 'RTMPose-')
    hand_note = " + Hand" if estimator._with_hand else ""
    vitpose_name = f"{model_tag}{hand_note} (HALPE 26pt)"

    # フォールバック後の実デバイスを使用
    actual_device = estimator.device

    return estimator, vitpose_name, actual_device
