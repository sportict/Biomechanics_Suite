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
        def _load_with_fallback(loader_fn, label: str):
            """loader_fn() を試し、失敗したら CPU で再試行"""
            try:
                return loader_fn(device), device
            except Exception as e:
                if device != 'cpu':
                    self._log(f"[RTMPose] {label} load error on {device}: {e}")
                    self._log(f"[RTMPose] {label} falling back to CPU")
                    try:
                        return loader_fn('cpu'), 'cpu'
                    except Exception as e2:
                        raise RuntimeError(f"{label} loading failed: {e2}") from e2
                raise RuntimeError(f"{label} loading failed: {e}") from e

        # ----- YOLO 検出器 -----
        self._log(f"[RTMPose] Loading YOLO: {yolo_onnx_path}")
        self.detector, yolo_device = _load_with_fallback(
            lambda d: ONNXYoloDetector(
                onnx_path=yolo_onnx_path,
                device=d,
                conf_threshold=conf_threshold,
                iou_threshold=iou_threshold,
                input_size=yolo_size,
            ),
            "YOLO"
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
            self._log(f"[RTMPose] body: requested={device}, actual={self.device} (CoreML unsupported for this model)")

        # ----- rtmlib RTMPose (手先) — オプション -----
        hand_path = Path(body_onnx_path).parent / "rtmpose-m_hand.onnx"
        if hand_path.exists():
            self._log(f"[RTMPose] Loading hand: {hand_path}")
            try:
                self._hand_model, _ = _load_with_fallback(
                    lambda d: RTMPose(
                        onnx_model=str(hand_path),
                        model_input_size=HAND_INPUT_SIZE,
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

    # ------------------------------------------------------------------
    def reset(self):
        pass

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
        RGB 画像を受け取り、拡張キーポイントを返す。
        Returns: {person_id: {'keypoints': np.ndarray(29,3), 'bbox': bbox}}
        """
        bgr   = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        boxes = self.detector.detect(bgr)
        if len(boxes) == 0:
            return {}

        # ---- 体幹推定 (全人物一括) ----
        bboxes_list = [b[:4].tolist() for b in boxes]
        body_kpts_all, body_scores_all = self._body_model(image, bboxes=bboxes_list)

        results: Dict[int, Any] = {}

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

            # kpts[26-27]: 手先 (hand モデルがあれば middle MCP)
            if self._with_hand:
                self._fill_hand_tips(kpts, image)

            results[i] = {'keypoints': kpts, 'bbox': bbox}

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
