#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ONNX-Only ViTPose Integration for ipc_handler.py
PyTorch完全不要 - ONNXRuntime のみで動作

使用方法:
1. このファイルを server/ ディレクトリに配置
2. ipc_handler.py の先頭付近に以下を追加:
   from onnx_vitpose_integration import ONNXPoseEstimator, check_onnx_models_available
3. load_model() 関数内で ONNXPoseEstimator を使用するように変更

必要なファイル:
- Models/yolo11x.onnx (または他のYOLO ONNXモデル)
- Models/vitpose-b-wholebody.onnx (133点 Wholebody モデル)
"""

import numpy as np
import cv2
from typing import Dict, List, Tuple, Any
from pathlib import Path
import sys


# ===================================
# ONNX Runtime セットアップ
# ===================================
def _validate_session(sess: 'ort.InferenceSession') -> None:
    """セッションのダミー推論を実行して実行時エラーを事前に検出する。
    CoreML は InferenceSession 作成時には成功しても session.run() で
    "Error in building plan" などのエラーが発生することがあるため、
    セッション返却前にここで検証する。

    注意: np.zeros だと検出系モデル (YOLOX等) で動的シェイプが 0 要素に解決され
    CoreML EP がエラーを出す。画像らしい値 (0.5) を使用する。
    「動的シェイプが 0 要素」エラーは検出結果が空のときだけ発生し、
    実映像では問題にならないため許容する。"""
    import numpy as np
    inp = sess.get_inputs()[0]
    # 動的次元 (None / str) は 1 に置き換える
    shape = [d if (isinstance(d, int) and d > 0) else 1 for d in inp.shape]
    dummy = np.full(shape, 0.5, dtype=np.float32)
    try:
        sess.run(None, {inp.name: dummy})
    except Exception as e:
        msg = str(e)
        if 'zero elements' in msg or 'dynamic shape' in msg:
            import sys
            print(f'[ONNX] CoreML validation warning (ignored): {msg}', file=sys.stderr)
        else:
            raise


def setup_onnx_session(onnx_path: str, device: str = 'cuda') -> 'ort.InferenceSession':
    """ONNXセッションを作成。CoreML/CUDA失敗時はCPUへフォールバック。

    CoreML は InferenceSession 作成時には例外が出なくても、
    実際に session.run() を呼んで初めて "Error in building plan" などの
    エラーが発生することがある。そのため各候補を作成後に _validate_session()
    でダミー推論まで実行し、成功したセッションのみを返す。
    """
    import onnxruntime as ort
    import sys as _sys

    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess_options.intra_op_num_threads = 4
    sess_options.inter_op_num_threads = 2

    available = ort.get_available_providers()

    if device == 'cuda' and 'CUDAExecutionProvider' in available:
        providers = [
            ('CUDAExecutionProvider', {
                'device_id': 0,
                'arena_extend_strategy': 'kNextPowerOfTwo',
                'gpu_mem_limit': 4 * 1024 * 1024 * 1024,
                'cudnn_conv_algo_search': 'DEFAULT',
            }),
            'CPUExecutionProvider'
        ]
        try:
            return ort.InferenceSession(onnx_path, sess_options=sess_options, providers=providers)
        except Exception as e:
            print(f"[ONNX] CUDA session failed ({e}), falling back to CPU", file=_sys.stderr)

    elif device == 'mps':
        # CoreML → MPS の順に試みる。
        # 各候補はセッション作成だけでなくダミー推論まで実行して検証する。
        if 'CoreMLExecutionProvider' in available:
            for coreml_opts in (
                {'ModelFormat': 'MLProgram'},        # 新形式: より多くのopをサポート
                {'ModelFormat': 'NeuralNetwork'},    # 旧形式: 互換性重視
                {},                                  # デフォルト (ランタイムに委ねる)
            ):
                try:
                    sess = ort.InferenceSession(
                        onnx_path, sess_options=sess_options,
                        providers=[('CoreMLExecutionProvider', coreml_opts), 'CPUExecutionProvider']
                    )
                    _validate_session(sess)   # ← 実行時エラーをここで検出
                    print(f"[ONNX] Using CoreMLExecutionProvider {coreml_opts}", file=_sys.stderr)
                    return sess
                except Exception as e:
                    print(f"[ONNX] CoreML {coreml_opts} failed ({e}), trying next...", file=_sys.stderr)

        if 'MPSExecutionProvider' in available:
            try:
                sess = ort.InferenceSession(
                    onnx_path, sess_options=sess_options,
                    providers=['MPSExecutionProvider', 'CPUExecutionProvider']
                )
                _validate_session(sess)
                print("[ONNX] Using MPSExecutionProvider", file=_sys.stderr)
                return sess
            except Exception as e:
                print(f"[ONNX] MPS failed ({e}), falling back to CPU", file=_sys.stderr)

        print("[ONNX] CoreML/MPS unavailable, falling back to CPU", file=_sys.stderr)

    # CPU フォールバック
    return ort.InferenceSession(onnx_path, sess_options=sess_options,
                                providers=['CPUExecutionProvider'])


# ===================================
# YOLO ONNX 検出器
# ===================================
class ONNXYoloDetector:
    """
    YOLO ONNX専用人物検出器
    ultralytics不要 - ONNXRuntimeで直接推論
    """
    
    def get_providers(self) -> List[str]:
        """現在有効なプロバイダーリストを取得"""
        return self.session.get_providers()
    
    def __init__(self, onnx_path: str, device: str = 'cuda', 
                 conf_threshold: float = 0.5, iou_threshold: float = 0.45,
                 input_size: int = 640):
        """
        Args:
            onnx_path: YOLO ONNXファイルパス
            device: 'cuda' or 'cpu'
            conf_threshold: 信頼度閾値
            iou_threshold: NMS IoU閾値
            input_size: 入力画像サイズ（正方形）
        """
        self.session = setup_onnx_session(onnx_path, device)
        self.device = device
        self._onnx_path = onnx_path

        # 入力情報取得
        self.input_name = self.session.get_inputs()[0].name
        input_shape = self.session.get_inputs()[0].shape

        # 入力サイズ決定
        if isinstance(input_shape[2], int) and input_shape[2] > 0:
            self.input_height = input_shape[2]
            self.input_width = input_shape[3]
        else:
            self.input_height = input_size
            self.input_width = input_size

        self.conf_threshold = conf_threshold
        self.iou_threshold = iou_threshold

        # 出力形式を検出
        # setup_onnx_session 内で _validate_session() による検証済みのため、
        # ここでは CoreML 起因の実行時エラーは発生しない想定。
        # ただし万が一の保険として CPU 再構築フォールバックは残す。
        try:
            self._detect_output_format()
        except Exception as e:
            if self.device != 'cpu':
                import sys
                print(f"[ONNX] YOLO run failed on {self.device} ({e}), rebuilding with CPU",
                      file=sys.stderr)
                self.session = setup_onnx_session(onnx_path, 'cpu')
                self.device = 'cpu'
                self._detect_output_format()
            else:
                raise
        
    def _detect_output_format(self):
        """モデルの出力形式を検出（YOLO v5/v8/v11/v26 対応）"""
        dummy = np.zeros((1, 3, self.input_height, self.input_width), dtype=np.float32)
        outputs = self.session.run(None, {self.input_name: dummy})

        output_shape = outputs[0].shape

        # YOLO26 End-to-End: (1, 300, 6) = [x1, y1, x2, y2, score, class_id]
        # YOLO v8/v11: (1, 84, 8400) - 転置が必要
        # YOLO v5: (1, 25200, 85) - そのまま
        if len(output_shape) == 3:
            if output_shape[2] == 6:
                self.output_format = 'e2e'  # End-to-End NMS (YOLO26等)
            elif output_shape[1] < output_shape[2]:
                self.output_format = 'v8'  # (1, 84, N) -> transpose needed
            else:
                self.output_format = 'v5'  # (1, N, 85)
        else:
            self.output_format = 'v8'
            
    def preprocess(self, image: np.ndarray) -> Tuple[np.ndarray, float, Tuple[int, int]]:
        """
        画像をYOLO形式に前処理
        
        Returns:
            input_tensor: (1, 3, H, W) float32
            scale: リサイズ倍率
            pad: (pad_w, pad_h) パディング量
        """
        h, w = image.shape[:2]
        
        # アスペクト比を維持してリサイズ
        scale = min(self.input_width / w, self.input_height / h)
        new_w = int(w * scale)
        new_h = int(h * scale)
        
        resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        
        # パディング（中央配置）- 浮動小数点で計算して精度を保持
        pad_w = (self.input_width - new_w) / 2.0
        pad_h = (self.input_height - new_h) / 2.0
        
        padded = np.full((self.input_height, self.input_width, 3), 114, dtype=np.uint8)
        # インデックスは整数にキャスト（pad_w, pad_hは逆計算用に浮動小数点で保持）
        pad_h_int = int(pad_h)
        pad_w_int = int(pad_w)
        padded[pad_h_int:pad_h_int + new_h, pad_w_int:pad_w_int + new_w] = resized
        
        # BGR -> RGB, HWC -> CHW, normalize (1回の変換で完了)
        input_tensor = padded[:, :, ::-1].transpose(2, 0, 1).astype(np.float32, copy=False)
        input_tensor *= (1.0 / 255.0)
        input_tensor = input_tensor[np.newaxis]  # (1, 3, H, W)

        return input_tensor, scale, (pad_w, pad_h)
    
    def postprocess(self, outputs: np.ndarray, scale: float, pad: Tuple[int, int],
                    orig_shape: Tuple[int, int]) -> np.ndarray:
        """
        YOLO出力を後処理してバウンディングボックスを取得
        """
        output = outputs[0]
        orig_h, orig_w = orig_shape
        pad_w, pad_h = pad

        # ---- End-to-End NMS 形式 (YOLO26等): (1, 300, 6) = [x1,y1,x2,y2,score,class_id] ----
        if self.output_format == 'e2e':
            dets = output[0]  # (300, 6)
            # person (class 0) かつ信頼度フィルタ
            mask = (dets[:, 5].astype(int) == 0) & (dets[:, 4] > self.conf_threshold)
            dets = dets[mask]
            if len(dets) == 0:
                return np.array([]).reshape(0, 5)
            boxes_xyxy = dets[:, :4].copy()
            scores = dets[:, 4]
            # パディングとスケールを元に戻す
            boxes_xyxy[:, [0, 2]] = (boxes_xyxy[:, [0, 2]] - pad_w) / scale
            boxes_xyxy[:, [1, 3]] = (boxes_xyxy[:, [1, 3]] - pad_h) / scale
            boxes_xyxy[:, [0, 2]] = np.clip(boxes_xyxy[:, [0, 2]], 0, orig_w)
            boxes_xyxy[:, [1, 3]] = np.clip(boxes_xyxy[:, [1, 3]], 0, orig_h)
            result = np.zeros((len(scores), 5), dtype=np.float32)
            result[:, :4] = boxes_xyxy
            result[:, 4] = scores
            return result

        # ---- v8/v11 形式 or v5 形式 ----
        if self.output_format == 'v8':
            # YOLO v8/v11: (1, 84, N) -> (N, 84)
            predictions = output[0].T if output.shape[0] == 1 else output.T
        else:
            # YOLO v5: (1, N, 85) -> (N, 85)
            predictions = output[0] if output.shape[0] == 1 else output

        # バウンディングボックス (cx, cy, w, h) と クラス確率
        boxes_xywh = predictions[:, :4]

        if self.output_format == 'v8':
            # v8: 4列目以降がクラススコア
            class_scores = predictions[:, 4:]
            person_scores = class_scores[:, 0]  # class 0 = person
        else:
            # v5: 4列目がobjectness, 5列目以降がクラススコア
            objectness = predictions[:, 4]
            class_scores = predictions[:, 5:]
            person_scores = objectness * class_scores[:, 0]

        # 信頼度でフィルタ
        mask = person_scores > self.conf_threshold
        boxes_xywh = boxes_xywh[mask]
        scores = person_scores[mask]

        if len(boxes_xywh) == 0:
            return np.array([]).reshape(0, 5)

        # xywh -> xyxy
        boxes_xyxy = np.zeros_like(boxes_xywh)
        boxes_xyxy[:, 0] = boxes_xywh[:, 0] - boxes_xywh[:, 2] / 2
        boxes_xyxy[:, 1] = boxes_xywh[:, 1] - boxes_xywh[:, 3] / 2
        boxes_xyxy[:, 2] = boxes_xywh[:, 0] + boxes_xywh[:, 2] / 2
        boxes_xyxy[:, 3] = boxes_xywh[:, 1] + boxes_xywh[:, 3] / 2

        # パディングとスケールを元に戻す
        boxes_xyxy[:, [0, 2]] = (boxes_xyxy[:, [0, 2]] - pad_w) / scale
        boxes_xyxy[:, [1, 3]] = (boxes_xyxy[:, [1, 3]] - pad_h) / scale

        # 画像境界でクリップ
        boxes_xyxy[:, [0, 2]] = np.clip(boxes_xyxy[:, [0, 2]], 0, orig_w)
        boxes_xyxy[:, [1, 3]] = np.clip(boxes_xyxy[:, [1, 3]], 0, orig_h)

        # NMS適用
        indices = self._nms(boxes_xyxy, scores)

        result = np.zeros((len(indices), 5), dtype=np.float32)
        result[:, :4] = boxes_xyxy[indices]
        result[:, 4] = scores[indices]

        return result
    
    def _nms(self, boxes: np.ndarray, scores: np.ndarray) -> List[int]:
        """Non-Maximum Suppression"""
        if len(boxes) == 0:
            return []
            
        x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
        areas = (x2 - x1) * (y2 - y1)
        order = scores.argsort()[::-1]
        
        keep = []
        while order.size > 0:
            i = order[0]
            keep.append(i)
            
            if order.size == 1:
                break
                
            xx1 = np.maximum(x1[i], x1[order[1:]])
            yy1 = np.maximum(y1[i], y1[order[1:]])
            xx2 = np.minimum(x2[i], x2[order[1:]])
            yy2 = np.minimum(y2[i], y2[order[1:]])
            
            w = np.maximum(0.0, xx2 - xx1)
            h = np.maximum(0.0, yy2 - yy1)
            inter = w * h
            
            iou = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
            inds = np.where(iou <= self.iou_threshold)[0]
            order = order[inds + 1]
            
        return keep
    
    def detect(self, image: np.ndarray) -> np.ndarray:
        """
        人物検出を実行
        
        Args:
            image: BGR画像 (H, W, 3)
            
        Returns:
            boxes: (N, 5) [x1, y1, x2, y2, conf]
        """
        orig_shape = image.shape[:2]
        input_tensor, scale, pad = self.preprocess(image)
        outputs = self.session.run(None, {self.input_name: input_tensor})
        return self.postprocess(outputs, scale, pad, orig_shape)


# ===================================
# ViTPose ONNX 姿勢推定器
# ===================================
class ONNXViTPoseEstimator:
    """
    ViTPose ONNX専用姿勢推定器
    133-point Wholebody対応
    """
    
    def get_providers(self) -> List[str]:
        """現在有効なプロバイダーリストを取得"""
        return self.session.get_providers()
    
    # ImageNet正規化パラメータ
    MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    
    def __init__(self, onnx_path: str, device: str = 'cuda'):
        """
        Args:
            onnx_path: ViTPose Wholebody ONNXファイルパス
            device: 'cuda' or 'cpu'
        """
        self.session = setup_onnx_session(onnx_path, device)
        self.device = device
        
        # 入力情報
        self.input_name = self.session.get_inputs()[0].name
        input_shape = self.session.get_inputs()[0].shape
        
        # 入力サイズ (W, H) - ViTPoseは通常 (192, 256)
        if isinstance(input_shape[2], int) and input_shape[2] > 0:
            self.input_size = (input_shape[3], input_shape[2])
        else:
            self.input_size = (192, 256)
            
        # 出力キーポイント数を検出
        self.num_keypoints = self._detect_keypoints()
        
    def _detect_keypoints(self) -> int:
        """モデルのキーポイント数を検出"""
        w, h = self.input_size
        dummy = np.zeros((1, 3, h, w), dtype=np.float32)
        
        try:
            outputs = self.session.run(None, {self.input_name: dummy})
            
            # ヒートマップ出力: (1, K, H, W)
            if len(outputs[0].shape) == 4:
                return outputs[0].shape[1]
            # SimCC出力: (1, K, SimCC_dim)
            elif len(outputs[0].shape) == 3:
                return outputs[0].shape[1]
        except Exception:
            pass
        
        return 133  # Wholebodyデフォルト
    
    def preprocess(self, image: np.ndarray, bbox: np.ndarray, 
                   expand_ratio: float = 1.25) -> Tuple[np.ndarray, dict]:
        """
        検出領域を切り出してViTPose入力に変換
        
        Args:
            image: BGR画像
            bbox: [x1, y1, x2, y2, conf]
            expand_ratio: バウンディングボックス拡張率
            
        Returns:
            input_tensor: (1, 3, H, W)
            transform_info: 逆変換用情報
        """
        img_h, img_w = image.shape[:2]
        x1, y1, x2, y2 = bbox[:4]
        
        # バウンディングボックス中心と大きさ
        cx = (x1 + x2) / 2
        cy = (y1 + y2) / 2
        w = x2 - x1
        h = y2 - y1
        
        # 拡張
        w *= expand_ratio
        h *= expand_ratio
        
        # アスペクト比を入力サイズに合わせる
        target_w, target_h = self.input_size
        target_ratio = target_w / target_h
        current_ratio = w / h if h > 0 else target_ratio
        
        if current_ratio > target_ratio:
            h = w / target_ratio
        else:
            w = h * target_ratio
        
        # 新しいバウンディングボックス
        x1_new = cx - w / 2
        y1_new = cy - h / 2
        x2_new = cx + w / 2
        y2_new = cy + h / 2
        
        # アフィン変換行列を計算
        src_pts = np.array([
            [x1_new, y1_new],
            [x2_new, y1_new],
            [x1_new, y2_new]
        ], dtype=np.float32)
        
        dst_pts = np.array([
            [0, 0],
            [target_w, 0],
            [0, target_h]
        ], dtype=np.float32)
        
        transform_matrix = cv2.getAffineTransform(src_pts, dst_pts)
        
        # 変換実行
        warped = cv2.warpAffine(
            image, transform_matrix, 
            (target_w, target_h),
            flags=cv2.INTER_LINEAR,
            borderValue=(0, 0, 0)
        )
        
        # BGR -> RGB, 正規化
        rgb = warped[:, :, ::-1].astype(np.float32) / 255.0
        normalized = (rgb - self.MEAN) / self.STD
        
        # HWC -> CHW
        input_tensor = normalized.transpose(2, 0, 1)[np.newaxis, ...].astype(np.float32)
        
        # 逆変換用情報
        inv_matrix = cv2.invertAffineTransform(transform_matrix)
        transform_info = {
            'inv_matrix': inv_matrix,
            'bbox': bbox,
            'valid': True
        }
        
        return input_tensor, transform_info
    
    def postprocess_heatmap(self, heatmaps: np.ndarray, 
                            transform_info: dict) -> np.ndarray:
        """
        ヒートマップ出力を元画像座標系のキーポイントに変換
        
        Args:
            heatmaps: (1, K, hm_H, hm_W)
            transform_info: 変換情報
            
        Returns:
            keypoints: (K, 3) [x, y, confidence]
        """
        hm = heatmaps[0]  # (K, H, W)
        k, hm_h, hm_w = hm.shape
        
        keypoints = np.zeros((k, 3), dtype=np.float32)
        target_w, target_h = self.input_size
        
        for i in range(k):
            hm_single = hm[i]
            
            # 最大値位置を検出
            max_idx = np.argmax(hm_single)
            y_idx, x_idx = np.unravel_index(max_idx, hm_single.shape)
            conf = float(hm_single[y_idx, x_idx])
            
            # サブピクセル精度で位置を調整（Taylor expansion）
            if 0 < x_idx < hm_w - 1 and 0 < y_idx < hm_h - 1 and conf > 0.01:
                dx = 0.5 * (hm_single[y_idx, x_idx + 1] - hm_single[y_idx, x_idx - 1])
                dy = 0.5 * (hm_single[y_idx + 1, x_idx] - hm_single[y_idx - 1, x_idx])
                x_idx = x_idx + np.sign(dx) * 0.25
                y_idx = y_idx + np.sign(dy) * 0.25
            
            # ヒートマップ座標を入力画像座標に変換
            # ヒートマップの各セルは領域の中心を表すため、+0.5のオフセットが必要
            x = ((x_idx + 0.5) / hm_w) * target_w
            y = ((y_idx + 0.5) / hm_h) * target_h
            
            keypoints[i] = [x, y, conf]
        
        # 元画像座標に変換
        inv_matrix = transform_info['inv_matrix']
        pts = keypoints[:, :2].reshape(-1, 1, 2)
        transformed = cv2.transform(pts, inv_matrix).reshape(-1, 2)
        
        keypoints[:, :2] = transformed
        
        return keypoints
    
    def postprocess_simcc(self, simcc_x: np.ndarray, simcc_y: np.ndarray,
                          transform_info: dict) -> np.ndarray:
        """
        SimCC出力を元画像座標系のキーポイントに変換
        
        Args:
            simcc_x: (1, K, W*ratio)
            simcc_y: (1, K, H*ratio)
            
        Returns:
            keypoints: (K, 3)
        """
        target_w, target_h = self.input_size
        
        x_locs = simcc_x[0]  # (K, W*ratio)
        y_locs = simcc_y[0]  # (K, H*ratio)
        
        k = x_locs.shape[0]
        keypoints = np.zeros((k, 3), dtype=np.float32)
        
        # SimCC ratio を推測
        simcc_w = x_locs.shape[1]
        simcc_h = y_locs.shape[1]
        ratio_w = simcc_w / target_w
        ratio_h = simcc_h / target_h
        
        for i in range(k):
            x_idx = np.argmax(x_locs[i])
            y_idx = np.argmax(y_locs[i])

            conf = (x_locs[i, x_idx] + y_locs[i, y_idx]) / 2

            # SimCCのインデックスもビン中心を表すため+0.5のオフセットが必要
            x = (x_idx + 0.5) / ratio_w
            y = (y_idx + 0.5) / ratio_h

            keypoints[i] = [x, y, conf]
        
        # 元画像座標に変換
        inv_matrix = transform_info['inv_matrix']
        pts = keypoints[:, :2].reshape(-1, 1, 2)
        transformed = cv2.transform(pts, inv_matrix).reshape(-1, 2)
        keypoints[:, :2] = transformed
        
        return keypoints
    
    def estimate(self, image: np.ndarray, bbox: np.ndarray) -> np.ndarray:
        """
        単一人物の姿勢推定
        
        Args:
            image: BGR画像
            bbox: [x1, y1, x2, y2, conf]
            
        Returns:
            keypoints: (K, 3) [x, y, confidence]
        """
        input_tensor, transform_info = self.preprocess(image, bbox)
        outputs = self.session.run(None, {self.input_name: input_tensor})
        
        # 出力形式に応じて後処理
        if len(outputs) >= 2 and len(outputs[0].shape) == 3:
            # SimCC形式: 2つの出力
            return self.postprocess_simcc(outputs[0], outputs[1], transform_info)
        else:
            # ヒートマップ形式
            return self.postprocess_heatmap(outputs[0], transform_info)


# ===================================
# 統合 Pose Estimator
# ===================================
class ONNXPoseEstimator:
    """
    ONNX専用のEnd-to-End姿勢推定
    ipc_handler.py の VitInference / RtmLibEstimator と互換性のあるインターフェース
    
    使用方法:
        estimator = ONNXPoseEstimator(
            yolo_onnx_path="Models/yolo11x.onnx",
            vitpose_onnx_path="Models/vitpose-b-wholebody.onnx",
            device='cuda'
        )
        
        # inference() は {person_id: keypoints} を返す
        results = estimator.inference(image_rgb)
    """
    
    def __init__(self, 
                 yolo_onnx_path: str,
                 vitpose_onnx_path: str,
                 device: str = 'cuda',
                 yolo_size: int = 640,
                 conf_threshold: float = 0.5,
                 iou_threshold: float = 0.45,
                 log_func=None):
        """
        Args:
            yolo_onnx_path: YOLO ONNX モデルパス
            vitpose_onnx_path: ViTPose ONNX モデルパス
            device: 'cuda' or 'cpu'
            yolo_size: YOLO入力サイズ
            conf_threshold: 検出信頼度閾値
            iou_threshold: NMS IoU閾値
            log_func: ログ出力関数 (log_debug等)
        """
        self.device = device
        self._log = log_func or print
        
        self._log(f"[ONNX] Loading YOLO: {yolo_onnx_path}")
        self.detector = ONNXYoloDetector(
            yolo_onnx_path, 
            device=device,
            conf_threshold=conf_threshold,
            iou_threshold=iou_threshold,
            input_size=yolo_size
        )
        
        self._log(f"[ONNX] Loading ViTPose: {vitpose_onnx_path}")
        self.pose_estimator = ONNXViTPoseEstimator(vitpose_onnx_path, device=device)
        
        self._log(f"[ONNX] Initialized: {self.pose_estimator.num_keypoints} keypoints, device={device}")
        
        # トラッキング用の内部ID
        self._next_id = 0
        
    @property
    def num_keypoints(self) -> int:
        return self.pose_estimator.num_keypoints
        
    def reset(self):
        """トラッカーリセット（互換性のため）"""
        self._next_id = 0
    
    def inference(self, image: np.ndarray) -> Dict[int, np.ndarray]:
        """
        画像から全人物の姿勢を推定
        VitInference / RtmLibEstimator と互換のインターフェース
        
        Args:
            image: RGB画像 (H, W, 3) - 既存コードとの互換性のため
            
        Returns:
            {track_id: keypoints (K, 3)} 形式の辞書
        """
        # RGB -> BGR (ONNX RuntimeモデルはBGR入力を期待)
        # 既存IPCハンドラはRGBを渡してくるため変換が必要
        bgr_image = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        
        # 1. 人物検出
        boxes = self.detector.detect(bgr_image)
        
        if len(boxes) == 0:
            return {}
        
        # 2. 各人物の姿勢推定
        results = {}
        for i, bbox in enumerate(boxes):
            keypoints = self.pose_estimator.estimate(bgr_image, bbox)
            
            # 簡易的なID割り当て（実運用ではnorfairトラッカーを使用）
            track_id = i
            # バウンディングボックス情報も含めて返す（トラッキングの安定化のため）
            results[track_id] = {
                'keypoints': keypoints,
                'bbox': bbox  # [x1, y1, x2, y2, conf]
            }
            
        return results

    def get_active_providers(self) -> Dict[str, List[str]]:
        """各モデルで実際に有効なプロバイダーを取得"""
        return {
            'yolo': self.detector.get_providers(),
            'vitpose': self.pose_estimator.get_providers()
        }


# ===================================
# ユーティリティ関数
# ===================================
def check_onnx_models_available(models_dir: Path, device: str = 'cuda') -> Dict[str, Any]:
    """
    利用可能なONNXモデルをチェック

    Args:
        models_dir: Modelsディレクトリパス
        device: 'cuda' or 'cpu' - デバイスに応じて推奨モデルを変更
                GPU使用可能時: ViTPose-H（高精度）をデフォルト
                GPU使用不可時: ViTPose-B（軽量）をデフォルト

    Returns:
        {
            'yolo': [利用可能なYOLOモデルリスト],
            'vitpose': [利用可能なViTPoseモデルリスト],
            'recommended': {'yolo': 推奨モデル, 'vitpose': 推奨モデル}
        }
    """
    result = {
        'yolo': [],
        'vitpose': [],
        'recommended': {'yolo': None, 'vitpose': None}
    }

    # YOLOモデル検索
    yolo_patterns = ['yolo*.onnx', 'YOLO*.onnx']
    for pattern in yolo_patterns:
        for path in models_dir.glob(pattern):
            result['yolo'].append(str(path))

    # 推奨YOLOモデル（優先順）
    yolo_priority = ['yolo11x.onnx', 'yolo26x.onnx', 'yolov8x.onnx', 'yolo11m.onnx']
    for model in yolo_priority:
        model_path = models_dir / model
        if model_path.exists():
            result['recommended']['yolo'] = str(model_path)
            break

    # ViTPoseモデル検索
    vitpose_patterns = ['vitpose*.onnx', 'ViTPose*.onnx']
    for pattern in vitpose_patterns:
        for path in models_dir.glob(pattern):
            result['vitpose'].append(str(path))

    # サブディレクトリも検索
    for subdir in models_dir.iterdir():
        if subdir.is_dir():
            for pattern in vitpose_patterns:
                for path in subdir.glob(pattern):
                    result['vitpose'].append(str(path))

    # 推奨ViTPoseモデル（デバイスに応じて優先順を変更）
    if device == 'cuda':
        # GPU使用可能時: 高精度モデル優先 (H > B)
        vitpose_priority = [
            'vitpose-h-wholebody.onnx',
            'vitpose-h-wholebody/vitpose-h-wholebody.onnx',
            'vitpose-b-wholebody.onnx',
        ]
    else:
        # CPU使用時: 軽量モデル優先 (B > H)
        vitpose_priority = [
            'vitpose-b-wholebody.onnx',
            'vitpose-h-wholebody.onnx',
            'vitpose-h-wholebody/vitpose-h-wholebody.onnx',
        ]

    for model in vitpose_priority:
        model_path = models_dir / model
        if model_path.exists():
            result['recommended']['vitpose'] = str(model_path)
            break

    return result


def load_onnx_pose_estimator(models_dir: Path,
                             device: str = 'cuda',
                             yolo_model: str = None,
                             vitpose_model: str = None,
                             log_func=None) -> ONNXPoseEstimator:
    """
    ONNXPoseEstimatorを簡単にロードするヘルパー関数

    Args:
        models_dir: Modelsディレクトリパス
        device: 'cuda' or 'cpu' - デバイスに応じて推奨モデルを変更
        yolo_model: 特定のYOLOモデル名（省略時は自動選択）
        vitpose_model: 特定のViTPoseモデル名（省略時は自動選択）
        log_func: ログ関数

    Returns:
        ONNXPoseEstimator インスタンス
    """
    log = log_func or print

    # デバイスに応じて推奨モデルを選択（GPU: ViTPose-H、CPU: ViTPose-B）
    available = check_onnx_models_available(models_dir, device=device)
    
    # YOLOモデル選択
    if yolo_model:
        yolo_path = str(models_dir / yolo_model)
    else:
        yolo_path = available['recommended']['yolo']
        
    if not yolo_path or not Path(yolo_path).exists():
        raise FileNotFoundError(f"YOLO ONNX model not found. Available: {available['yolo']}")
    
    # ViTPoseモデル選択
    if vitpose_model:
        vitpose_path = str(models_dir / vitpose_model)
    else:
        vitpose_path = available['recommended']['vitpose']
        
    if not vitpose_path or not Path(vitpose_path).exists():
        raise FileNotFoundError(f"ViTPose ONNX model not found. Available: {available['vitpose']}")
    
    log(f"[ONNX] Selected YOLO: {yolo_path}")
    log(f"[ONNX] Selected ViTPose: {vitpose_path}")
    
    return ONNXPoseEstimator(
        yolo_onnx_path=yolo_path,
        vitpose_onnx_path=vitpose_path,
        device=device,
        log_func=log
    )


# ===================================
# テスト用
# ===================================
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', type=str, required=True, help='Test image path')
    parser.add_argument('--models', type=str, default='Models', help='Models directory')
    parser.add_argument('--device', type=str, default='cuda', choices=['cuda', 'cpu'])
    args = parser.parse_args()
    
    models_dir = Path(args.models)
    
    # モデルチェック（デバイスに応じた推奨モデルを表示）
    available = check_onnx_models_available(models_dir, device=args.device)
    print(f"Available YOLO: {available['yolo']}")
    print(f"Available ViTPose: {available['vitpose']}")
    print(f"Recommended (device={args.device}): {available['recommended']}")
    
    if not available['recommended']['yolo'] or not available['recommended']['vitpose']:
        print("ERROR: Required ONNX models not found!")
        sys.exit(1)
    
    # エスティメーター作成
    estimator = load_onnx_pose_estimator(models_dir, device=args.device)
    
    # テスト推論
    image = cv2.imread(args.image)
    if image is None:
        print(f"ERROR: Cannot read image: {args.image}")
        sys.exit(1)
    
    rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    results = estimator.inference(rgb_image)
    
    print(f"\nDetected {len(results)} person(s)")
    for pid, kpts in results.items():
        print(f"  Person {pid}: {kpts.shape[0]} keypoints")
        
    # 可視化
    for pid, kpts in results.items():
        for i, (x, y, conf) in enumerate(kpts):
            if conf > 0.3:
                cv2.circle(image, (int(x), int(y)), 3, (0, 255, 0), -1)
    
    output_path = 'onnx_test_output.jpg'
    cv2.imwrite(output_path, image)
    print(f"\nOutput saved: {output_path}")
