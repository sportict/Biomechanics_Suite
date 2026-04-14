#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SynthPose PyTorch Estimator for HPE
safetensors形式のSynthPoseモデルを使用した姿勢推定

モデルアーキテクチャ:
  - バックボーン: ViT-Base (768次元, 12層) または ViT-Huge (1280次元, 32層)
  - ヘッド: 転置畳み込み×2 → BatchNorm → ReLU → 1×1 Conv → 52点ヒートマップ
  - 入力: 256×192 (RGB, ImageNet正規化)
  - 出力: 64×48 ヒートマップ × 52チャンネル

参照: https://github.com/StanfordMIMI/OpenCapBench
"""

import numpy as np
import cv2
from typing import Dict, List, Tuple, Optional, Any
from pathlib import Path


# ===================================
# ImageNet 正規化パラメータ
# ===================================
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD  = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# SynthPose 入力サイズ
INPUT_WIDTH  = 192
INPUT_HEIGHT = 256

# SynthPose キーポイント数 (native model output)
NUM_KEYPOINTS = 52


# ===================================
# SynthPose ヘッドアーキテクチャ
# ===================================
class SynthPoseHead:
    """
    ViTPose スタイルのヒートマップ出力ヘッド
    (実装は SynthPoseModel 内の nn.Module として定義)
    """
    pass  # 下の SynthPoseModule を参照


def _build_synthpose_model(model_size: str, num_keypoints: int = NUM_KEYPOINTS):
    """
    SynthPose モデルを構築 (nn.Module)

    Args:
        model_size: 'base' (ViT-Base) または 'huge' (ViT-Huge)
        num_keypoints: 出力キーポイント数 (デフォルト52)

    Returns:
        torch.nn.Module
    """
    import torch
    import torch.nn as nn
    from transformers import ViTConfig, ViTModel

    # ViT設定
    if model_size == 'base':
        hidden_dim   = 768
        num_layers   = 12
        num_heads    = 12
        mlp_ratio    = 4
    elif model_size == 'huge':
        hidden_dim   = 1280
        num_layers   = 32
        num_heads    = 16
        mlp_ratio    = 4
    else:
        raise ValueError(f"Unknown model_size: {model_size}. Use 'base' or 'huge'.")

    config = ViTConfig(
        image_size=[INPUT_HEIGHT, INPUT_WIDTH],   # [256, 192]
        patch_size=16,
        hidden_size=hidden_dim,
        num_hidden_layers=num_layers,
        num_attention_heads=num_heads,
        intermediate_size=hidden_dim * mlp_ratio,
        add_pooling_layer=False,
    )

    grid_h = INPUT_HEIGHT // 16  # 16
    grid_w = INPUT_WIDTH  // 16  # 12

    class _Head(nn.Module):
        def __init__(self, in_ch: int, n_kpts: int):
            super().__init__()
            self.deconv1    = nn.ConvTranspose2d(in_ch, 256, kernel_size=4, stride=2, padding=1, bias=False)
            self.batchnorm1 = nn.BatchNorm2d(256)
            self.deconv2    = nn.ConvTranspose2d(256,   256, kernel_size=4, stride=2, padding=1, bias=False)
            self.batchnorm2 = nn.BatchNorm2d(256)
            self.relu       = nn.ReLU(inplace=True)
            self.conv       = nn.Conv2d(256, n_kpts, kernel_size=1)

        def forward(self, x):
            x = self.relu(self.batchnorm1(self.deconv1(x)))
            x = self.relu(self.batchnorm2(self.deconv2(x)))
            return self.conv(x)

    class _SynthPoseModel(nn.Module):
        def __init__(self):
            super().__init__()
            self.backbone   = ViTModel(config, add_pooling_layer=False)
            self.head       = _Head(hidden_dim, num_keypoints)
            self._grid_h    = grid_h
            self._grid_w    = grid_w
            self._hidden    = hidden_dim

        def forward(self, x):
            # x: (B, 3, 256, 192)
            out     = self.backbone(pixel_values=x)
            hidden  = out.last_hidden_state          # (B, 193, hidden_dim)
            patches = hidden[:, 1:, :]               # (B, 192, hidden_dim)  CLSを除外
            B       = patches.shape[0]
            # (B, 192, D) → (B, D, 16, 12)
            feat    = patches.permute(0, 2, 1).contiguous().view(B, self._hidden, self._grid_h, self._grid_w)
            return self.head(feat)                   # (B, 52, 64, 48)

    return _SynthPoseModel()


def load_synthpose_model(path: str,
                         model_size: str = 'base',
                         device: str = 'cuda',
                         num_keypoints: int = NUM_KEYPOINTS,
                         log_func=None) -> Any:
    """
    safetensors ファイルから SynthPose モデルをロード

    Args:
        path:          .safetensors ファイルパス
        model_size:    'base' または 'huge'
        device:        'cuda' または 'cpu'
        num_keypoints: 出力キーポイント数
        log_func:      ログ出力関数

    Returns:
        評価モードの SynthPoseModel (torch.nn.Module)
    """
    import torch
    from safetensors import safe_open

    _log = log_func or print

    _log(f"[SynthPose] Building {model_size} model ({num_keypoints} keypoints)...")
    model = _build_synthpose_model(model_size, num_keypoints)

    _log(f"[SynthPose] Loading weights from: {path}")
    state_dict = {}
    with safe_open(path, framework="pt", device="cpu") as f:
        for key in f.keys():
            # mlp.fc1/fc2 → HuggingFace ViTModel の intermediate.dense/output.dense にリマップ
            new_key = key.replace('.mlp.fc1.', '.intermediate.dense.') \
                         .replace('.mlp.fc2.', '.output.dense.')
            state_dict[new_key] = f.get_tensor(key)

    missing, unexpected = model.load_state_dict(state_dict, strict=False)

    if missing:
        _log(f"[SynthPose] Missing keys ({len(missing)}): {missing[:3]}{'...' if len(missing) > 3 else ''}")
    if unexpected:
        _log(f"[SynthPose] Unexpected keys ({len(unexpected)}): {unexpected[:3]}{'...' if len(unexpected) > 3 else ''}")

    _log(f"[SynthPose] State dict loaded successfully.")

    model.eval()

    torch_device = torch.device('cuda' if device == 'cuda' and torch.cuda.is_available() else 'cpu')
    model = model.to(torch_device)

    _log(f"[SynthPose] Model ready on device: {torch_device}")
    return model, str(torch_device)


# ===================================
# 前処理・後処理ユーティリティ
# ===================================
def _preprocess_crop(image_bgr: np.ndarray,
                     bbox: np.ndarray,
                     expand_ratio: float = 1.25) -> Tuple[np.ndarray, dict]:
    """
    バウンディングボックス領域をクロップして SynthPose 入力テンソルに変換

    Args:
        image_bgr:    BGR画像 (H, W, 3)
        bbox:         [x1, y1, x2, y2, conf]
        expand_ratio: バウンディングボックス拡張率

    Returns:
        input_tensor:   (1, 3, 256, 192) float32 numpy配列
        transform_info: 逆変換用情報 {'inv_matrix': ..., 'valid': True}
    """
    img_h, img_w = image_bgr.shape[:2]
    x1, y1, x2, y2 = bbox[:4]

    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    w  = (x2 - x1) * expand_ratio
    h  = (y2 - y1) * expand_ratio

    # アスペクト比を 192:256 = 3:4 に合わせる
    target_ratio = INPUT_WIDTH / INPUT_HEIGHT  # 192/256 = 0.75
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

    # BGR→RGB, 正規化, HWC→CHW
    rgb  = warped[:, :, ::-1].astype(np.float32) / 255.0
    norm = (rgb - IMAGENET_MEAN) / IMAGENET_STD
    tensor = norm.transpose(2, 0, 1)[np.newaxis].astype(np.float32)  # (1, 3, 256, 192)

    transform_info = {'inv_matrix': inv, 'valid': True}
    return tensor, transform_info


def _decode_heatmaps(heatmaps: np.ndarray, transform_info: dict) -> np.ndarray:
    """
    ヒートマップ (1, K, 64, 48) → 元画像座標キーポイント (K, 3)

    Args:
        heatmaps:       (1, K, hm_H, hm_W) numpy配列
        transform_info: _preprocess_crop が返した変換情報

    Returns:
        keypoints: (K, 3) [x, y, confidence]
    """
    hm = heatmaps[0]        # (K, hm_H, hm_W)
    K, hm_h, hm_w = hm.shape

    keypoints = np.zeros((K, 3), dtype=np.float32)

    for i in range(K):
        hm_i    = hm[i]
        max_idx = int(np.argmax(hm_i))
        y_idx, x_idx = divmod(max_idx, hm_w)
        conf = float(hm_i[y_idx, x_idx])

        # サブピクセル精度 (Taylor expansion)
        x_f = float(x_idx)
        y_f = float(y_idx)
        if 0 < x_idx < hm_w - 1 and 0 < y_idx < hm_h - 1 and conf > 0.01:
            dx = 0.5 * (float(hm_i[y_idx, x_idx + 1]) - float(hm_i[y_idx, x_idx - 1]))
            dy = 0.5 * (float(hm_i[y_idx + 1, x_idx]) - float(hm_i[y_idx - 1, x_idx]))
            x_f += np.sign(dx) * 0.25
            y_f += np.sign(dy) * 0.25

        # ヒートマップ座標 → 入力画像座標
        x = (x_f + 0.5) / hm_w * INPUT_WIDTH
        y = (y_f + 0.5) / hm_h * INPUT_HEIGHT

        keypoints[i] = [x, y, conf]

    # アフィン逆変換 → 元画像座標
    inv_M = transform_info['inv_matrix']
    pts   = keypoints[:, :2].reshape(-1, 1, 2)
    keypoints[:, :2] = cv2.transform(pts, inv_M).reshape(-1, 2)

    return keypoints


# ===================================
# SynthPose Torch Estimator (メインクラス)
# ===================================
class SynthPoseTorchEstimator:
    """
    PyTorch ベースの SynthPose 姿勢推定器
    ONNXPoseEstimator と互換性のあるインターフェース

    検出: ONNXYoloDetector (YOLO ONNX)
    推定: SynthPoseModel  (safetensors + PyTorch)

    使用例:
        estimator = SynthPoseTorchEstimator(
            yolo_onnx_path="Models/yolo11x.onnx",
            safetensors_path="Models/synthpose-vitpose-base-hf.safetensors",
            model_size='base',
            device='cuda'
        )
        results = estimator.inference(image_rgb)
        # → {track_id: {'keypoints': np.ndarray(52, 3), 'bbox': [x1,y1,x2,y2,conf]}}
    """

    def __init__(self,
                 yolo_onnx_path: str,
                 safetensors_path: str,
                 model_size: str = 'base',
                 device: str = 'cuda',
                 yolo_size: int = 640,
                 conf_threshold: float = 0.5,
                 iou_threshold: float = 0.45,
                 log_func=None):
        """
        Args:
            yolo_onnx_path:    YOLO ONNX モデルファイルパス
            safetensors_path:  SynthPose .safetensors ファイルパス
            model_size:        'base' または 'huge'
            device:            'cuda' または 'cpu'
            yolo_size:         YOLO 入力サイズ (通常 640)
            conf_threshold:    人物検出信頼度閾値
            iou_threshold:     NMS IoU 閾値
            log_func:          ログ出力関数
        """
        self._log   = log_func or print
        self.device = device

        # ----- 重要な修正 -----
        # ONNXRuntimeより先にPyTorchをインポートすることで、
        # Windows上の cuDNN/cuBLAS 等のDLL競合 (WinError 127) を防ぎます
        self._log(f"[SynthPose] Pre-loading torch to avoid DLL conflicts...")
        import torch
        self._torch  = torch

        # ----- YOLO 検出器 (ONNX) -----
        self._log(f"[SynthPose] Loading YOLO detector: {yolo_onnx_path}")
        from onnx_vitpose_integration import ONNXYoloDetector
        self.detector = ONNXYoloDetector(
            onnx_path=yolo_onnx_path,
            device=device,
            conf_threshold=conf_threshold,
            iou_threshold=iou_threshold,
            input_size=yolo_size,
        )

        # ----- SynthPose ポーズ推定モデル (PyTorch) -----
        self._log(f"[SynthPose] Loading SynthPose-{model_size}: {safetensors_path}")
        self.model, actual_device = load_synthpose_model(
            path=safetensors_path,
            model_size=model_size,
            device=device,
            num_keypoints=NUM_KEYPOINTS,
            log_func=self._log,
        )
        self.actual_device = actual_device  # 'cuda:0' または 'cpu'
        self._torch_device = torch.device(actual_device)

        self._model_size = model_size
        self._log(f"[SynthPose] Estimator ready (device={actual_device})")

    # ------------------------------------------------------------------
    @property
    def num_keypoints(self) -> int:
        return NUM_KEYPOINTS

    def reset(self):
        """互換性のため (トラッカーリセット)"""
        pass

    # ------------------------------------------------------------------
    def _run_pose(self, image_bgr: np.ndarray, bbox: np.ndarray) -> np.ndarray:
        """
        単一人物の姿勢推定

        Returns:
            keypoints: (52, 3) [x, y, confidence]
        """
        import torch

        input_np, transform_info = _preprocess_crop(image_bgr, bbox)

        # numpy → torch tensor
        tensor = torch.from_numpy(input_np).to(self._torch_device)

        with torch.no_grad():
            heatmaps_t = self.model(tensor)   # (1, 52, 64, 48)

        # torch → numpy
        heatmaps_np = heatmaps_t.cpu().numpy()

        return _decode_heatmaps(heatmaps_np, transform_info)

    # ------------------------------------------------------------------
    def inference(self, image: np.ndarray) -> Dict[int, Any]:
        """
        画像から全人物の姿勢を推定 (ONNXPoseEstimator 互換インターフェース)

        Args:
            image: RGB 画像 (H, W, 3)

        Returns:
            {track_id: {'keypoints': np.ndarray(52, 3), 'bbox': [x1,y1,x2,y2,conf]}}
        """
        # RGB → BGR (YOLO/OpenCV は BGR)
        bgr = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)

        # 1. 人物検出
        boxes = self.detector.detect(bgr)
        if len(boxes) == 0:
            return {}

        # 2. 各人物の姿勢推定
        results = {}
        for i, bbox in enumerate(boxes):
            kpts = self._run_pose(bgr, bbox)
            results[i] = {
                'keypoints': kpts,
                'bbox':      bbox,
            }

        return results

    # ------------------------------------------------------------------
    def get_active_providers(self) -> Dict[str, List[str]]:
        """各モデルで実際に有効なプロバイダーを取得 (ONNXPoseEstimator 互換)"""
        yolo_providers = self.detector.get_providers()
        # PyTorch デバイス表示
        if 'cuda' in self.actual_device:
            vitpose_providers = [f'CUDA ({self.actual_device})']
        else:
            vitpose_providers = ['CPU (PyTorch)']
        return {
            'yolo':    yolo_providers,
            'vitpose': vitpose_providers,
        }


# ===================================
# モデルロードヘルパー (ipc_handler.py から呼び出す)
# ===================================
def load_synthpose_estimator(models_dir: Path,
                             model_size: str,
                             yolo_type: Optional[str],
                             device: str,
                             yolo_size: int = 640,
                             conf_threshold: float = 0.5,
                             log_func=None) -> Tuple['SynthPoseTorchEstimator', str, str]:
    """
    SynthPoseTorchEstimator を構築して返す

    Args:
        models_dir:       Models/ ディレクトリ Path
        model_size:       'base' または 'huge'
        yolo_type:        YOLO ファイル名 (None の場合は自動検索)
        device:           'cuda' または 'cpu'
        yolo_size:        YOLO 入力サイズ
        conf_threshold:   検出信頼度閾値
        log_func:         ログ関数

    Returns:
        (estimator, vitpose_name, actual_device)
    """
    _log = log_func or print

    # --- YOLO パス決定 ---
    if yolo_type:
        yolo_path = str(models_dir / yolo_type)
    else:
        yolo_files = sorted(models_dir.glob("yolo*.onnx"))
        if not yolo_files:
            raise FileNotFoundError("YOLO ONNX model (yolo*.onnx) not found in Models/ directory.")
        yolo_path = str(yolo_files[0])

    # --- SynthPose safetensors パス決定 ---
    safetensors_map = {
        'base': 'synthpose-vitpose-base-hf.safetensors',
        'huge': 'synthpose-vitpose-huge-hf.safetensors',
    }
    st_filename = safetensors_map.get(model_size)
    if not st_filename:
        raise ValueError(f"Unknown SynthPose model_size: {model_size}")

    st_path = models_dir / st_filename
    if not st_path.exists():
        raise FileNotFoundError(
            f"SynthPose safetensors not found: {st_path}\n"
            f"Place '{st_filename}' in the Models/ directory."
        )

    # --- Estimator 構築 ---
    estimator = SynthPoseTorchEstimator(
        yolo_onnx_path=yolo_path,
        safetensors_path=str(st_path),
        model_size=model_size,
        device=device,
        yolo_size=yolo_size,
        conf_threshold=conf_threshold,
        log_func=log_func,
    )

    vitpose_name = f"SynthPose-{model_size.capitalize()} (PyTorch)"
    actual_device = estimator.actual_device.replace('cuda:0', 'cuda').replace('cuda:1', 'cuda')

    return estimator, vitpose_name, actual_device
