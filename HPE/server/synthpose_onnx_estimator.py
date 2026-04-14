#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SynthPose ONNX Estimator
PyTorchを使用せずONNX Runtimeで骨格推定を行う

変換元: synthpose-vitpose-{base|huge}-hf.safetensors
変換先: synthpose-vitpose-{base|huge}-hf.onnx
"""

import numpy as np
import cv2
from typing import Dict, List, Tuple, Optional, Any
from pathlib import Path


# ===================================
# 定数 (synthpose_torch_estimatorと共通)
# ===================================
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD  = np.array([0.229, 0.224, 0.225], dtype=np.float32)

INPUT_WIDTH  = 192
INPUT_HEIGHT = 256
NUM_KEYPOINTS = 52


# ===================================
# 前処理・後処理 (torch版と同一ロジック)
# ===================================
def _preprocess_crop(image_bgr: np.ndarray,
                     bbox: np.ndarray,
                     expand_ratio: float = 1.25) -> Tuple[np.ndarray, dict]:
    img_h, img_w = image_bgr.shape[:2]
    x1, y1, x2, y2 = bbox[:4]

    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    w  = (x2 - x1) * expand_ratio
    h  = (y2 - y1) * expand_ratio

    target_ratio = INPUT_WIDTH / INPUT_HEIGHT  # 0.75
    curr_ratio   = w / h if h > 0 else target_ratio

    if curr_ratio > target_ratio:
        h = w / target_ratio
    else:
        w = h * target_ratio

    x1_new = cx - w / 2.0
    y1_new = cy - h / 2.0
    x2_new = cx + w / 2.0
    y2_new = cy + h / 2.0

    src_pts = np.array([[x1_new, y1_new], [x2_new, y1_new], [x1_new, y2_new]], dtype=np.float32)
    dst_pts = np.array([[0, 0], [INPUT_WIDTH, 0], [0, INPUT_HEIGHT]], dtype=np.float32)

    M   = cv2.getAffineTransform(src_pts, dst_pts)
    inv = cv2.invertAffineTransform(M)

    warped = cv2.warpAffine(image_bgr, M, (INPUT_WIDTH, INPUT_HEIGHT),
                            flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0))

    rgb    = warped[:, :, ::-1].astype(np.float32) / 255.0
    norm   = (rgb - IMAGENET_MEAN) / IMAGENET_STD
    tensor = norm.transpose(2, 0, 1)[np.newaxis].astype(np.float32)  # (1,3,256,192)

    return tensor, {'inv_matrix': inv, 'valid': True}


def _decode_heatmaps(heatmaps: np.ndarray, transform_info: dict) -> np.ndarray:
    hm = heatmaps[0]        # (K, hm_H, hm_W)
    K, hm_h, hm_w = hm.shape
    keypoints = np.zeros((K, 3), dtype=np.float32)

    for i in range(K):
        hm_i    = hm[i]
        max_idx = int(np.argmax(hm_i))
        y_idx, x_idx = divmod(max_idx, hm_w)
        conf = float(hm_i[y_idx, x_idx])

        x_f = float(x_idx)
        y_f = float(y_idx)
        if 0 < x_idx < hm_w - 1 and 0 < y_idx < hm_h - 1 and conf > 0.01:
            dx = 0.5 * (float(hm_i[y_idx, x_idx + 1]) - float(hm_i[y_idx, x_idx - 1]))
            dy = 0.5 * (float(hm_i[y_idx + 1, x_idx]) - float(hm_i[y_idx - 1, x_idx]))
            x_f += np.sign(dx) * 0.25
            y_f += np.sign(dy) * 0.25

        x = (x_f + 0.5) / hm_w * INPUT_WIDTH
        y = (y_f + 0.5) / hm_h * INPUT_HEIGHT
        keypoints[i] = [x, y, conf]

    inv_M = transform_info['inv_matrix']
    pts   = keypoints[:, :2].reshape(-1, 1, 2)
    keypoints[:, :2] = cv2.transform(pts, inv_M).reshape(-1, 2)

    return keypoints


# ===================================
# ONNX SynthPose 推定クラス
# ===================================
class SynthPoseONNXEstimator:
    """
    ONNX Runtime ベースの SynthPose 推定器
    PyTorch 不要・SynthPoseTorchEstimator と互換インターフェース
    """

    def __init__(self,
                 yolo_onnx_path: str,
                 synthpose_onnx_path: str,
                 device: str = 'cuda',
                 yolo_size: int = 640,
                 conf_threshold: float = 0.5,
                 iou_threshold: float = 0.45,
                 log_func=None):
        self._log   = log_func or print
        self.device = device

        # setup_onnx_session は cuda/mps(CoreML)/cpu のフォールバックを内包
        from onnx_vitpose_integration import ONNXYoloDetector, setup_onnx_session

        # ----- YOLO 検出器 -----
        self._log(f"[SynthPoseONNX] Loading YOLO: {yolo_onnx_path}")
        self.detector = ONNXYoloDetector(
            onnx_path=yolo_onnx_path,
            device=device,
            conf_threshold=conf_threshold,
            iou_threshold=iou_threshold,
            input_size=yolo_size,
        )

        # ----- SynthPose ONNX セッション（CoreMLフォールバック付き）-----
        self._log(f"[SynthPoseONNX] Loading SynthPose ONNX: {synthpose_onnx_path}")
        self._session = setup_onnx_session(synthpose_onnx_path, device)

        self._input_name  = self._session.get_inputs()[0].name
        self._output_name = self._session.get_outputs()[0].name

        # 実際に使用されているプロバイダーを取得
        self._active_provider = self._session.get_providers()[0]
        self._log(f"[SynthPoseONNX] Provider: {self._active_provider}")
        self._log(f"[SynthPoseONNX] Estimator ready")

    # ------------------------------------------------------------------
    @property
    def num_keypoints(self) -> int:
        return NUM_KEYPOINTS

    def reset(self):
        pass

    # ------------------------------------------------------------------
    def _run_pose(self, image_bgr: np.ndarray, bbox: np.ndarray) -> np.ndarray:
        input_np, transform_info = _preprocess_crop(image_bgr, bbox)

        heatmaps_np = self._session.run(
            [self._output_name],
            {self._input_name: input_np}
        )[0]  # (1, 52, 64, 48)

        return _decode_heatmaps(heatmaps_np, transform_info)

    # ------------------------------------------------------------------
    def inference(self, image: np.ndarray) -> Dict[int, Any]:
        bgr   = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        boxes = self.detector.detect(bgr)
        if len(boxes) == 0:
            return {}

        results = {}
        for i, bbox in enumerate(boxes):
            kpts = self._run_pose(bgr, bbox)
            results[i] = {'keypoints': kpts, 'bbox': bbox}

        return results

    # ------------------------------------------------------------------
    def get_active_providers(self) -> Dict[str, List[str]]:
        yolo_providers = self.detector.get_providers()
        return {
            'yolo':    yolo_providers,
            'vitpose': [self._active_provider],
        }


# ===================================
# ロードヘルパー (ipc_handler.py から呼び出す)
# ===================================
def load_synthpose_onnx_estimator(models_dir: Path,
                                  model_size: str,
                                  yolo_type: Optional[str],
                                  device: str,
                                  yolo_size: int = 640,
                                  conf_threshold: float = 0.5,
                                  log_func=None) -> Tuple['SynthPoseONNXEstimator', str, str]:
    _log = log_func or print

    # YOLO パス
    if yolo_type:
        yolo_path = str(models_dir / yolo_type)
    else:
        yolo_files = sorted(models_dir.glob("yolo*.onnx"))
        if not yolo_files:
            raise FileNotFoundError("YOLO ONNX model not found in Models/")
        yolo_path = str(yolo_files[0])

    # SynthPose ONNX パス
    onnx_filename = f'synthpose-vitpose-{model_size}-hf.onnx'
    onnx_path = models_dir / onnx_filename
    if not onnx_path.exists():
        raise FileNotFoundError(
            f"SynthPose ONNX not found: {onnx_path}\n"
            f"先に convert_synthpose_to_onnx.py --size {model_size} を実行してください。"
        )

    estimator = SynthPoseONNXEstimator(
        yolo_onnx_path=yolo_path,
        synthpose_onnx_path=str(onnx_path),
        device=device,
        yolo_size=yolo_size,
        conf_threshold=conf_threshold,
        log_func=_log,
    )

    vitpose_name  = f"SynthPose-{model_size.capitalize()} (ONNX)"
    prov = estimator._active_provider
    if 'CUDA' in prov:
        actual_device = 'cuda'
    elif 'CoreML' in prov or 'MPS' in prov:
        actual_device = 'mps'
    else:
        actual_device = 'cpu'
        if device == 'mps':
            _log("[SynthPoseONNX] CoreML is not available for this model (ViTPose transformer ops unsupported). Running on CPU.")

    return estimator, vitpose_name, actual_device
