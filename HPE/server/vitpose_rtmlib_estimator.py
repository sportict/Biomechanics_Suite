#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ViTPose-H Wholebody Estimator (via rtmlib)
YOLO検出 + rtmlib ViTPose (COCO Wholebody 133点)

出力 keypoints インデックス:
  0-16  : COCO 17点 (body)
  17-22 : 足 (6点)
  23-90 : 顔 (68点)
  91-111: 左手 (21点)
  112-132: 右手 (21点)
"""

import sys
import numpy as np
import cv2
from typing import Dict, List, Optional, Any, Tuple
from pathlib import Path


# ===================================
# モデル入力サイズ
# ===================================
VIT_INPUT_SIZE = (192, 256)  # ViTPose wholebody: (w, h)


# ===================================
# ViTPose Estimator クラス
# ===================================
class ViTPoseEstimator:
    """
    ViTPose-H Wholebody 推定器。
    inference() 戻り値: {i: {'keypoints': np.ndarray(133, 3), 'bbox': bbox}}
    """

    def __init__(self,
                 vitpose_onnx_path: str,
                 device: str = 'cpu',
                 yolo_onnx_path: str = '',
                 yolo_size: int = 640,
                 conf_threshold: float = 0.3,
                 iou_threshold: float = 0.45,
                 log_func=None):

        self._log = log_func or print
        self.device = device

        # ----- YOLO 検出器 -----
        self._log(f"[ViTPose] Loading YOLO: {yolo_onnx_path}")
        from onnx_vitpose_integration import ONNXYoloDetector
        self.detector = ONNXYoloDetector(
            onnx_path=yolo_onnx_path,
            device=device,
            conf_threshold=conf_threshold,
            iou_threshold=iou_threshold,
            input_size=yolo_size,
        )

        # ----- rtmlib ViTPose -----
        self._log(f"[ViTPose] Loading ViTPose: {vitpose_onnx_path}")
        from rtmlib.tools.pose_estimation.vitpose import ViTPose
        self._body_model = ViTPose(
            onnx_model=vitpose_onnx_path,
            model_input_size=VIT_INPUT_SIZE,
            backend='onnxruntime',
            device=device,
        )

        self._log("[ViTPose] Ready")

    # ------------------------------------------------------------------
    def reset(self):
        pass

    # ------------------------------------------------------------------
    def inference(self, image: np.ndarray) -> Dict[int, Any]:
        """
        RGB 画像を受け取り、133点キーポイントを返す。
        Returns: {person_id: {'keypoints': np.ndarray(133, 3), 'bbox': bbox}}
        """
        bgr   = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        boxes = self.detector.detect(bgr)
        if len(boxes) == 0:
            return {}

        bboxes_list = [b[:4].tolist() for b in boxes]
        kpts_all, scores_all = self._body_model(image, bboxes=bboxes_list)

        results: Dict[int, Any] = {}

        for i, bbox in enumerate(boxes):
            kpts_xy = kpts_all[i]    # (133, 2)
            scores  = scores_all[i]  # (133,)

            kpts = np.zeros((133, 3), dtype=np.float32)
            kpts[:, :2] = kpts_xy
            kpts[:, 2]  = scores

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
def load_vitpose_estimator(models_dir: Path,
                           yolo_type: Optional[str],
                           device: str,
                           yolo_size: int = 640,
                           conf_threshold: float = 0.3,
                           log_func=None) -> Tuple['ViTPoseEstimator', str, str]:
    _log = log_func or print

    # YOLO パス
    if yolo_type:
        yolo_path = str(models_dir / yolo_type)
    else:
        yolo_files = sorted(models_dir.glob("yolo*.onnx"))
        if not yolo_files:
            raise FileNotFoundError("YOLO ONNX model not found in Models/")
        yolo_path = str(yolo_files[0])

    # ViTPose-H wholebody モデル
    vit_path = models_dir / "vitpose-h-wholebody" / "vitpose-h-wholebody.onnx"
    if not vit_path.exists():
        raise FileNotFoundError(f"ViTPose-H wholebody not found: {vit_path}")

    estimator = ViTPoseEstimator(
        vitpose_onnx_path=str(vit_path),
        device=device,
        yolo_onnx_path=yolo_path,
        yolo_size=yolo_size,
        conf_threshold=conf_threshold,
        log_func=_log,
    )

    vitpose_name = "ViTPose-H Wholebody (rtmlib)"

    try:
        prov = estimator.get_active_providers().get('vitpose', ['CPUExecutionProvider'])[0]
        actual_device = 'cuda' if 'CUDA' in prov else 'cpu'
    except Exception:
        actual_device = device

    return estimator, vitpose_name, actual_device
