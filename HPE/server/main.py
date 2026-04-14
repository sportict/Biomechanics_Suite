#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HPE API Server - FastAPI backend for pose estimation
GPU/CPU両対応
"""

import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional, List, Dict, Any

import numpy as np
import cv2
from fastapi import FastAPI, File, UploadFile, HTTPException, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
import json
import shutil

# FFmpeg
try:
    import ffmpeg
    FFMPEG_AVAILABLE = True
except ImportError:
    FFMPEG_AVAILABLE = False
    print("[Warning] ffmpeg-python がインストールされていません。pip install ffmpeg-python でインストールしてください。")

# プロジェクトルートをパスに追加
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
# serverディレクトリもパスに追加（filtering.pyをインポートするため）
SERVER_DIR = Path(__file__).parent
sys.path.insert(0, str(SERVER_DIR))

# 共通モジュールからインポート
from utils import (
    KEYPOINT_NAMES_23,
    NorfairPersonTracker,
    convert_to_23_keypoints,
    detect_device as utils_detect_device,
    get_device_info as utils_get_device_info
)

# ===================================
# 設定
# ===================================
class AppConfig:
    def __init__(self):
        self.device = "auto"  # "auto", "cuda", "cpu"
        self.yolo_size = 320
        self.confidence_threshold = 0.3
        self.model_loaded = False
        
config = AppConfig()

# ===================================
# GPU/CPU検出（utils.pyを使用）
# ===================================
def detect_device() -> str:
    """利用可能なデバイスを検出"""
    return utils_detect_device(config.device)

def get_device_info() -> Dict[str, Any]:
    """デバイス情報を取得"""
    return utils_get_device_info()

# ===================================
# モデル管理（ONNX ViTPose）
# ===================================
from onnx_vitpose_integration import ONNXPoseEstimator

model_instance = None

def get_model():
    """モデルインスタンスを取得（遅延ロード）"""
    global model_instance

    if model_instance is None:
        load_model()

    return model_instance

def load_model():
    """ONNX ViTPoseモデルをロード"""
    global model_instance

    models_dir = PROJECT_ROOT / "Models"

    # ONNX モデルパス
    vitpose_path = models_dir / "vitpose-b-wholebody.onnx"
    yolo_path = models_dir / "yolo11x.onnx"

    # 代替モデルを探す
    if not vitpose_path.exists():
        candidates = list(models_dir.glob("**/vitpose*.onnx"))
        if candidates:
            vitpose_path = candidates[0]
            print(f"[Info] Found ViTPose: {vitpose_path}")

    if not yolo_path.exists():
        candidates = list(models_dir.glob("**/yolo*.onnx"))
        if candidates:
            yolo_path = candidates[0]
            print(f"[Info] Found YOLO: {yolo_path}")

    if not vitpose_path.exists():
        raise FileNotFoundError(f"ViTPose ONNX model not found at {vitpose_path}")

    if not yolo_path.exists():
        raise FileNotFoundError(f"YOLO ONNX model not found at {yolo_path}")

    current_device = detect_device()
    print(f"[Info] Loading ONNXPoseEstimator with device: {current_device}")

    model_instance = ONNXPoseEstimator(
        yolo_path=str(yolo_path),
        pose_path=str(vitpose_path),
        device=current_device
    )

    config.model_loaded = True
    return model_instance


# ===================================
# 人物追跡（utils.pyから使用）
# ===================================
# グローバルトラッカーインスタンス
norfair_tracker = NorfairPersonTracker(
    distance_threshold=0.4,
    hit_counter_max=30,
    initialization_delay=1
)


# ===================================
# FastAPI アプリケーション
# ===================================
app = FastAPI(
    title="HPE API Server",
    description="Human Pose Estimation API using easy-ViTPose",
    version="1.0.0"
)

# CORS設定（Electronからのアクセス許可）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ===================================
# Pydantic モデル
# ===================================
class ConfigRequest(BaseModel):
    device: Optional[str] = None
    yolo_size: Optional[int] = None
    confidence_threshold: Optional[float] = None

class FilterRequest(BaseModel):
    frames: List[Dict[str, Any]]
    fps: float = 30.0
    confidence_threshold: float = 0.3
    enable_id_swap_fix: bool = True
    id_swap_threshold: float = 100.0
    enable_outlier_removal: bool = True
    enable_interpolation: bool = True
    enable_butterworth: bool = True
    enable_kalman: bool = False
    enable_limb_swap_fix: bool = True
    interpolation_method: str = 'pchip'
    butterworth_cutoff: float = 6.0
    butterworth_order: int = 4
    max_gap: int = 50
    edge_padding: int = 20  # 両端パディング（フィルタ前に追加、後に削除）

class ManualEditRequest(BaseModel):
    frames: List[Dict[str, Any]]
    edits: List[Dict[str, Any]]  # [{frame: int, keypoint_idx: int, person_id: str, x: float, y: float}, ...]

# ===================================
# エンドポイント
# ===================================
@app.get("/api/health")
async def health_check():
    """ヘルスチェック"""
    return {"status": "ok", "timestamp": time.time()}

@app.get("/api/status")
async def get_status():
    """モデル状態とデバイス情報"""
    device_info = get_device_info()
    return {
        "model_loaded": config.model_loaded,
        "device_info": device_info,
        "config": {
            "device": config.device,
            "yolo_size": config.yolo_size,
            "confidence_threshold": config.confidence_threshold
        }
    }

@app.get("/api/config")
async def get_config():
    """現在の設定を取得"""
    return {
        "device": config.device,
        "yolo_size": config.yolo_size,
        "confidence_threshold": config.confidence_threshold
    }

@app.post("/api/config")
async def update_config(req: ConfigRequest):
    """設定を更新"""
    global model_instance
    
    if req.device is not None:
        if req.device not in ["auto", "cuda", "cpu"]:
            raise HTTPException(status_code=400, detail="Invalid device")
        config.device = req.device
        model_instance = None  # モデル再ロードが必要
        config.model_loaded = False
    
    if req.yolo_size is not None:
        config.yolo_size = req.yolo_size
        model_instance = None
        config.model_loaded = False
    
    if req.confidence_threshold is not None:
        config.confidence_threshold = req.confidence_threshold
    
    return {"status": "ok", "config": {
        "device": config.device,
        "yolo_size": config.yolo_size,
        "confidence_threshold": config.confidence_threshold
    }}

@app.post("/api/detect/image")
async def detect_image(file: UploadFile = File(...)):
    """画像からポーズ推定"""
    start_time = time.time()
    
    try:
        # 画像読み込み
        contents = await file.read()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        if img is None:
            raise HTTPException(status_code=400, detail="Invalid image")
        
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        
        # モデル取得・推論
        model = get_model()
        frame_keypoints = model.inference(img_rgb)
        
        # 結果を23点形式に変換
        # frame_keypoints は dict: {person_id: keypoints}
        results = {}
        for person_id, kpts in frame_keypoints.items():
            kpts_23 = convert_to_23_keypoints(kpts)
            results[str(person_id)] = kpts_23.tolist()
        
        processing_time = (time.time() - start_time) * 1000
        
        return {
            "success": True,
            "num_persons": len(results),
            "keypoints": results,
            "keypoint_names": KEYPOINT_NAMES_23,
            "processing_time_ms": processing_time
        }
        
    except Exception as e:
        import traceback
        traceback.print_exc()  # エラー詳細をターミナルに表示
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/detect/video")
async def detect_video(file: UploadFile = File(...)):
    """動画からポーズ推定（全フレーム処理）- 従来API"""
    start_time = time.time()
    tmp_path = None
    
    try:
        # 一時ファイルに保存
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmp:
            contents = await file.read()
            tmp.write(contents)
            tmp_path = tmp.name
        
        # 動画読み込み
        cap = cv2.VideoCapture(tmp_path)
        if not cap.isOpened():
            raise HTTPException(status_code=400, detail="Invalid video")
        
        fps = int(cap.get(cv2.CAP_PROP_FPS))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        model = get_model()
        model.reset()  # モデルトラッカーをリセット
        norfair_tracker.reset()  # 人物追跡トラッカーをリセット
        all_results = []
        
        frame_idx = 0
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            
            img_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            frame_keypoints = model.inference(img_rgb)
            
            # まず23点形式に変換
            converted_keypoints = {}
            for person_id, kpts in frame_keypoints.items():
                kpts_23 = convert_to_23_keypoints(kpts)
                converted_keypoints[str(person_id)] = kpts_23
            
            # PersonTrackerで安定したIDを割り当て
            stable_keypoints = norfair_tracker.track(converted_keypoints)
            
            frame_result = {
                "frame": frame_idx + 1,
                "keypoints": {pid: kpts.tolist() for pid, kpts in stable_keypoints.items()}
            }
            
            all_results.append(frame_result)
            frame_idx += 1
        
        cap.release()
        
        processing_time = (time.time() - start_time) * 1000
        
        return {
            "success": True,
            "fps": fps,
            "total_frames": total_frames,
            "processed_frames": len(all_results),
            "keypoint_names": KEYPOINT_NAMES_23,
            "frames": all_results,
            "processing_time_ms": processing_time
        }
        
    except Exception as e:
        import traceback
        traceback.print_exc()  # エラー詳細をターミナルに表示
        raise HTTPException(status_code=500, detail=str(e))
    
    finally:
        # 一時ファイルを削除
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

@app.post("/api/detect/video/stream")
async def detect_video_stream(file: UploadFile = File(...), frame_skip: int = Form(default=1)):
    """動画からポーズ推定（SSEでリアルタイム進捗送信）
    
    Args:
        file: 動画ファイル
        frame_skip: 処理するフレーム間隔（1=全フレーム, 4=4フレームごと）
    """
    
    # 一時ファイルに保存
    tmp_path = None
    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmp:
        contents = await file.read()
        tmp.write(contents)
        tmp_path = tmp.name
    
    def generate_sync():
        """同期ジェネレーター（バッファリング回避）"""
        start_time = time.time()
        
        try:
            # 動画読み込み
            cap = cv2.VideoCapture(tmp_path)
            if not cap.isOpened():
                yield f"data: {json.dumps({'type': 'error', 'error': 'Invalid video'})}\n\n"
                return
            
            fps = int(cap.get(cv2.CAP_PROP_FPS))
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            
            # 初期情報を送信（frame_skipを含む）
            init_data = {'type': 'init', 'fps': fps, 'total_frames': total_frames, 'frame_skip': frame_skip}
            yield f"data: {json.dumps(init_data)}\n\n"
            
            model = get_model()
            model.reset()  # モデルトラッカーをリセット
            norfair_tracker.reset()  # 人物追跡トラッカーをリセット
            all_results = []
            last_keypoints = {}  # 最後に検出したキーポイント（スキップ時に使用）
            
            frame_idx = 0
            while cap.isOpened():
                ret, frame = cap.read()
                if not ret:
                    break
                
                # frame_skipに基づいてフレームを処理またはスキップ
                if frame_skip <= 1 or frame_idx % frame_skip == 0:
                    # 推定を実行
                    img_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    frame_keypoints = model.inference(img_rgb)
                    
                    # まず23点形式に変換
                    converted_keypoints = {}
                    for person_id, kpts in frame_keypoints.items():
                        if kpts.shape[0] == 26:
                            kpts_23 = convert_halpe_to_23(kpts)
                        else:
                            kpts_23 = convert_to_23_keypoints(kpts)
                        converted_keypoints[str(person_id)] = kpts_23
                    
                    # PersonTrackerで安定したIDを割り当て
                    stable_keypoints = norfair_tracker.track(converted_keypoints)
                    last_keypoints = stable_keypoints  # 最後のキーポイントを保存
                    
                    frame_result = {
                        "frame": frame_idx + 1,
                        "keypoints": {pid: kpts.tolist() for pid, kpts in stable_keypoints.items()}
                    }
                else:
                    # スキップされたフレーム：NaNで埋める（後で補間）
                    frame_result = {
                        "frame": frame_idx + 1,
                        "keypoints": {pid: [[0.0, 0.0, 0.0] for _ in range(23)] for pid in last_keypoints.keys()}
                    }
                
                all_results.append(frame_result)
                frame_idx += 1
                
                # 進捗を送信
                progress = int((frame_idx / total_frames) * 100) if total_frames > 0 else 0
                progress_data = {'type': 'progress', 'frame': frame_idx, 'total': total_frames, 'progress': progress}
                yield f"data: {json.dumps(progress_data)}\n\n"
            
            cap.release()
            
            processing_time = (time.time() - start_time) * 1000
            
            # 完了データを送信
            result = {
                "type": "complete",
                "success": True,
                "fps": fps,
                "total_frames": total_frames,
                "processed_frames": len(all_results),
                "keypoint_names": KEYPOINT_NAMES_23,
                "frames": all_results,
                "processing_time_ms": processing_time
            }
            yield f"data: {json.dumps(result)}\n\n"
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
        
        finally:
            # 一時ファイルを削除
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except:
                    pass
    
    return StreamingResponse(
        generate_sync(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Content-Type": "text/event-stream"
        }
    )

# ===================================
# 骨格描画用定数
# ===================================
SKELETON_CONNECTIONS = [
    # 右腕
    (0, 1), (1, 2), (2, 3),
    # 左腕
    (4, 5), (5, 6), (6, 7),
    # 右脚
    (8, 11), (9, 11), (10, 11), (11, 12), (12, 13),
    # 左脚
    (14, 17), (15, 17), (16, 17), (17, 18), (18, 19),
    # 体幹
    (3, 7), (13, 19), (3, 13), (7, 19), (3, 22), (7, 22),
    # 頭部
    (20, 21), (21, 22)
]

COLORS_BGR = {
    'right': (68, 68, 239),   # 赤
    'left': (246, 130, 59),   # 青
    'center': (129, 185, 16)  # 緑
}

def get_keypoint_color(idx):
    """キーポイントインデックスから色を取得"""
    if idx < 4 or (8 <= idx <= 13):  # 右側
        return COLORS_BGR['right']
    elif idx < 8 or (14 <= idx <= 19):  # 左側
        return COLORS_BGR['left']
    return COLORS_BGR['center']

def get_line_color(idx1, idx2):
    """接続線の色を取得"""
    if (idx1 < 4 and idx2 < 4) or (8 <= idx1 <= 13 and 8 <= idx2 <= 13):
        return COLORS_BGR['right']
    elif (4 <= idx1 < 8 and 4 <= idx2 < 8) or (14 <= idx1 <= 19 and 14 <= idx2 <= 19):
        return COLORS_BGR['left']
    return COLORS_BGR['center']

def draw_skeleton_on_frame(frame, keypoints_dict, confidence_threshold=0.3):
    """フレームに骨格を描画"""
    for person_id, kpts in keypoints_dict.items():
        # 骨格線を描画
        for idx1, idx2 in SKELETON_CONNECTIONS:
            if idx1 < len(kpts) and idx2 < len(kpts):
                p1, p2 = kpts[idx1], kpts[idx2]
                if p1[2] > confidence_threshold and p2[2] > confidence_threshold:
                    color = get_line_color(idx1, idx2)
                    cv2.line(frame, (int(p1[0]), int(p1[1])), (int(p2[0]), int(p2[1])), color, 3)
        
        # キーポイントを描画
        for idx, kp in enumerate(kpts):
            if kp[2] > confidence_threshold:
                color = get_keypoint_color(idx)
                cv2.circle(frame, (int(kp[0]), int(kp[1])), 5, color, -1)
                cv2.circle(frame, (int(kp[0]), int(kp[1])), 5, (255, 255, 255), 1)
    
    return frame

@app.post("/api/export/video")
async def export_video_with_skeleton(
    file: UploadFile = File(...),
    keypoints_file: UploadFile = File(...)
):
    """骨格付き動画をエクスポート"""
    tmp_input_path = None
    tmp_output_path = None
    
    try:
        # キーポイントデータをパース
        content = await keypoints_file.read()
        keypoints_data = json.loads(content)
        frames_data = keypoints_data.get('frames', [])
        fps = keypoints_data.get('fps', 30)
        
        # 入力動画を一時ファイルに保存
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmp:
            contents = await file.read()
            tmp.write(contents)
            tmp_input_path = tmp.name
        
        # 出力動画の一時ファイル
        tmp_output_path = tempfile.mktemp(suffix="_skeleton.mp4")
        
        # 動画読み込み
        cap = cv2.VideoCapture(tmp_input_path)
        if not cap.isOpened():
            raise HTTPException(status_code=400, detail="Invalid video")
        
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        video_fps = int(cap.get(cv2.CAP_PROP_FPS)) or fps
        
        # 出力動画設定
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(tmp_output_path, fourcc, video_fps, (width, height))
        
        frame_idx = 0
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            
            # 対応するキーポイントデータを探す
            frame_kpts = None
            for fd in frames_data:
                if fd.get('frame') == frame_idx + 1:
                    frame_kpts = fd.get('keypoints', {})
                    break
            
            # 骨格を描画
            if frame_kpts:
                frame = draw_skeleton_on_frame(frame, frame_kpts)
            
            out.write(frame)
            frame_idx += 1
        
        cap.release()
        out.release()
        
        # ファイルを返す
        return FileResponse(
            tmp_output_path,
            media_type='video/mp4',
            filename='skeleton_video.mp4',
            background=None
        )
        
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON format")
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    
    finally:
        # 入力一時ファイルを削除
        if tmp_input_path and os.path.exists(tmp_input_path):
            os.unlink(tmp_input_path)
        # 出力ファイルは FileResponse が処理後に削除するか、
        # クライアントがダウンロード後に手動で削除が必要

# ===================================
# フィルタリング API
# ===================================
@app.post("/api/filter")
async def filter_keypoints(req: FilterRequest):
    """キーポイントデータにフィルタリングを適用"""
    try:
        print(f"[Filter API] Received request with {len(req.frames)} frames")
        print(f"[Filter API] FPS: {req.fps}, Enable outlier: {req.enable_outlier_removal}")
        print(f"[Filter API] Enable interpolation: {req.enable_interpolation}, Method: {req.interpolation_method}")
        print(f"[Filter API] Enable butterworth: {req.enable_butterworth}, Cutoff: {req.butterworth_cutoff}")
        print(f"[Filter API] Enable kalman: {req.enable_kalman}")
        
        # データの検証
        if not req.frames or len(req.frames) == 0:
            raise HTTPException(status_code=400, detail="No frames data provided")
        
        # 最初のフレームの構造を確認
        if 'frame' not in req.frames[0] or 'keypoints' not in req.frames[0]:
            print(f"[Filter API] Invalid frame structure: {req.frames[0].keys() if req.frames else 'empty'}")
            raise HTTPException(status_code=400, detail=f"Invalid frame structure. Expected 'frame' and 'keypoints' keys")
        
        from filtering import process_video_keypoints
        
        print(f"[Filter API] Enable ID swap fix: {req.enable_id_swap_fix}")
        print(f"[Filter API] Enable limb swap fix: {req.enable_limb_swap_fix}")
        
        filtered_frames = process_video_keypoints(
            req.frames,
            fps=req.fps,
            confidence_threshold=req.confidence_threshold,
            enable_id_swap_fix=req.enable_id_swap_fix,
            id_swap_threshold=req.id_swap_threshold,
            enable_outlier_removal=req.enable_outlier_removal,
            enable_interpolation=req.enable_interpolation,
            enable_butterworth=req.enable_butterworth,
            enable_kalman=req.enable_kalman,
            enable_limb_swap_fix=req.enable_limb_swap_fix,
            interpolation_method=req.interpolation_method,
            butterworth_cutoff=req.butterworth_cutoff,
            butterworth_order=req.butterworth_order,
            max_gap=req.max_gap,
            edge_padding=req.edge_padding
        )
        
        print(f"[Filter API] Filtering complete, returning {len(filtered_frames)} frames")
        
        return {
            "success": True,
            "frames": filtered_frames,
            "filter_settings": {
                "fps": req.fps,
                "confidence_threshold": req.confidence_threshold,
                "enable_id_swap_fix": req.enable_id_swap_fix,
                "enable_outlier_removal": req.enable_outlier_removal,
                "enable_interpolation": req.enable_interpolation,
                "enable_butterworth": req.enable_butterworth,
                "enable_kalman": req.enable_kalman,
                "enable_limb_swap_fix": req.enable_limb_swap_fix,
                "interpolation_method": req.interpolation_method,
                "butterworth_cutoff": req.butterworth_cutoff,
                "butterworth_order": req.butterworth_order
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"[Filter API] Error: {str(e)}")
        print(f"[Filter API] Traceback:\n{error_trace}")
        raise HTTPException(status_code=500, detail=f"Filtering error: {str(e)}\n{error_trace}")

@app.post("/api/manual-edit")
async def apply_manual_edits(req: ManualEditRequest):
    """手動編集を適用"""
    try:
        frames = req.frames.copy()
        
        for edit in req.edits:
            frame_num = edit.get('frame')
            kpt_idx = edit.get('keypoint_idx')
            person_id = edit.get('person_id')
            new_x = edit.get('x')
            new_y = edit.get('y')
            
            # 該当フレームを探して更新
            for frame_data in frames:
                if frame_data['frame'] == frame_num:
                    if person_id in frame_data['keypoints']:
                        kpts = frame_data['keypoints'][person_id]
                        if kpt_idx < len(kpts):
                            kpts[kpt_idx][0] = new_x
                            kpts[kpt_idx][1] = new_y
                            kpts[kpt_idx][2] = 1.0  # 手動編集は信頼度最大
                    break
        
        return {
            "success": True,
            "frames": frames
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

# ===================================
# FFmpeg ユーティリティ
# ===================================
# ブラウザでネイティブ再生可能なコーデック
BROWSER_COMPATIBLE_CODECS = ['h264', 'vp8', 'vp9', 'av1']
BROWSER_COMPATIBLE_CONTAINERS = ['.mp4', '.webm', '.ogg']

def check_ffmpeg_installed() -> bool:
    """FFmpegがインストールされているか確認"""
    return shutil.which('ffmpeg') is not None

def get_video_info(file_path: str) -> Dict[str, Any]:
    """動画ファイルの情報を取得（FFprobeを使用）"""
    if not FFMPEG_AVAILABLE:
        raise Exception("ffmpeg-python がインストールされていません")
    
    try:
        probe = ffmpeg.probe(file_path)
        video_streams = [s for s in probe['streams'] if s['codec_type'] == 'video']
        
        if not video_streams:
            return {"error": "動画ストリームが見つかりません"}
        
        video_stream = video_streams[0]
        
        # フレームレート解析
        fps_str = video_stream.get('r_frame_rate', '30/1')
        if '/' in fps_str:
            num, den = map(int, fps_str.split('/'))
            fps = num / den if den != 0 else 30.0
        else:
            fps = float(fps_str)
        
        return {
            "codec": video_stream.get('codec_name', 'unknown'),
            "width": video_stream.get('width', 0),
            "height": video_stream.get('height', 0),
            "fps": fps,
            "duration": float(probe['format'].get('duration', 0)),
            "bit_rate": int(probe['format'].get('bit_rate', 0)),
            "format": probe['format'].get('format_name', 'unknown'),
            "container": Path(file_path).suffix.lower()
        }
    except ffmpeg.Error as e:
        return {"error": f"FFprobe エラー: {e.stderr.decode() if e.stderr else str(e)}"}
    except Exception as e:
        return {"error": str(e)}

def needs_conversion(video_info: Dict[str, Any]) -> bool:
    """動画が変換を必要とするか判定"""
    if "error" in video_info:
        return True
    
    codec = video_info.get('codec', '').lower()
    container = video_info.get('container', '').lower()
    
    # コーデックとコンテナの両方がブラウザ互換かチェック
    codec_ok = codec in BROWSER_COMPATIBLE_CODECS
    container_ok = container in BROWSER_COMPATIBLE_CONTAINERS
    
    return not (codec_ok and container_ok)

def convert_video_to_mp4(input_path: str, output_path: str, 
                         progress_callback=None) -> Dict[str, Any]:
    """動画をH.264/MP4に変換"""
    if not FFMPEG_AVAILABLE:
        raise Exception("ffmpeg-python がインストールされていません")
    
    if not check_ffmpeg_installed():
        raise Exception("FFmpegがインストールされていません。FFmpegをインストールしてください。")
    
    try:
        # 入力ファイルの情報を取得
        probe = ffmpeg.probe(input_path)
        duration = float(probe['format'].get('duration', 0))
        
        # 変換コマンドを構築
        stream = ffmpeg.input(input_path)
        stream = ffmpeg.output(
            stream,
            output_path,
            vcodec='libx264',
            acodec='aac',
            preset='fast',
            crf=23,  # 品質（18-28、低いほど高品質）
            movflags='faststart',  # Web再生最適化
            pix_fmt='yuv420p',  # ブラウザ互換ピクセルフォーマット
            **{'vsync': 'cfr'}  # 固定フレームレート
        )
        
        # 上書き許可
        stream = ffmpeg.overwrite_output(stream)
        
        # 実行
        ffmpeg.run(stream, capture_stderr=True)
        
        # 変換後の情報を取得
        output_info = get_video_info(output_path)
        
        return {
            "success": True,
            "output_path": output_path,
            "duration": duration,
            "output_info": output_info
        }
        
    except ffmpeg.Error as e:
        error_msg = e.stderr.decode() if e.stderr else str(e)
        return {"success": False, "error": f"変換エラー: {error_msg}"}
    except Exception as e:
        return {"success": False, "error": str(e)}

# 変換済みファイルのキャッシュ（元ファイルパス -> 変換後ファイルパス）
converted_video_cache: Dict[str, str] = {}

@app.get("/api/ffmpeg/status")
async def get_ffmpeg_status():
    """FFmpegの状態を確認"""
    return {
        "ffmpeg_python_available": FFMPEG_AVAILABLE,
        "ffmpeg_installed": check_ffmpeg_installed(),
        "compatible_codecs": BROWSER_COMPATIBLE_CODECS,
        "compatible_containers": BROWSER_COMPATIBLE_CONTAINERS
    }

class VideoCheckRequest(BaseModel):
    file_path: str

@app.post("/api/video/check")
async def check_video(request: VideoCheckRequest):
    """動画ファイルのフォーマットを確認し、変換が必要か判定"""
    file_path = request.file_path
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")
    
    # キャッシュ確認
    if file_path in converted_video_cache:
        cached_path = converted_video_cache[file_path]
        if os.path.exists(cached_path):
            return {
                "needs_conversion": False,
                "already_converted": True,
                "converted_path": cached_path,
                "video_info": get_video_info(cached_path)
            }
    
    video_info = get_video_info(file_path)
    needs_conv = needs_conversion(video_info)
    
    return {
        "needs_conversion": needs_conv,
        "already_converted": False,
        "video_info": video_info,
        "reason": "コーデックまたはコンテナがブラウザ非対応" if needs_conv else None
    }

class VideoConvertRequest(BaseModel):
    file_path: str
    output_dir: Optional[str] = None

@app.post("/api/video/convert")
async def convert_video(request: VideoConvertRequest):
    """動画をブラウザ互換のH.264/MP4に変換"""
    file_path = request.file_path
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")
    
    # キャッシュ確認
    if file_path in converted_video_cache:
        cached_path = converted_video_cache[file_path]
        if os.path.exists(cached_path):
            return {
                "success": True,
                "output_path": cached_path,
                "cached": True,
                "video_info": get_video_info(cached_path)
            }
    
    # 出力パスを決定
    input_path = Path(file_path)
    if request.output_dir:
        output_dir = Path(request.output_dir)
    else:
        output_dir = input_path.parent
    
    output_path = output_dir / f"{input_path.stem}_converted.mp4"
    
    # 変換実行
    result = convert_video_to_mp4(file_path, str(output_path))
    
    if result.get("success"):
        # キャッシュに追加
        converted_video_cache[file_path] = str(output_path)
        return {
            "success": True,
            "output_path": str(output_path),
            "cached": False,
            "video_info": result.get("output_info")
        }
    else:
        raise HTTPException(status_code=500, detail=result.get("error", "変換に失敗しました"))

@app.post("/api/video/convert/stream")
async def convert_video_stream(file: UploadFile = File(...)):
    """アップロードされた動画をブラウザ互換のH.264/MP4に変換（SSEで進捗送信）"""
    
    # 一時ファイルに保存
    tmp_input = None
    tmp_output = None
    
    with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename).suffix) as tmp:
        contents = await file.read()
        tmp.write(contents)
        tmp_input = tmp.name
    
    def generate():
        nonlocal tmp_output
        try:
            yield f"data: {json.dumps({'type': 'start', 'message': '変換を開始しています...'})}\n\n"
            
            # 動画情報を取得
            video_info = get_video_info(tmp_input)
            yield f"data: {json.dumps({'type': 'info', 'video_info': video_info})}\n\n"
            
            # 変換が必要か確認
            if not needs_conversion(video_info):
                yield f"data: {json.dumps({'type': 'complete', 'message': '変換不要', 'output_path': tmp_input, 'needs_conversion': False})}\n\n"
                return
            
            # 一時出力ファイル
            with tempfile.NamedTemporaryFile(delete=False, suffix='.mp4') as tmp:
                tmp_output = tmp.name
            
            yield f"data: {json.dumps({'type': 'progress', 'progress': 10, 'message': '変換中...'})}\n\n"
            
            # 変換実行
            result = convert_video_to_mp4(tmp_input, tmp_output)
            
            if result.get("success"):
                yield f"data: {json.dumps({'type': 'complete', 'success': True, 'output_path': tmp_output, 'video_info': result.get('output_info')})}\n\n"
            else:
                yield f"data: {json.dumps({'type': 'error', 'error': result.get('error')})}\n\n"
                
        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
        finally:
            # 入力一時ファイルを削除（出力は保持）
            if tmp_input and os.path.exists(tmp_input):
                try:
                    os.unlink(tmp_input)
                except:
                    pass
    
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        }
    )

# ===================================
# 起動
# ===================================
if __name__ == "__main__":
    import uvicorn
    print("=" * 50)
    print("HPE API Server starting...")
    print(f"Device: {detect_device()}")
    print(f"FFmpeg available: {FFMPEG_AVAILABLE and check_ffmpeg_installed()}")
    print(f"Project root: {PROJECT_ROOT}")
    print("=" * 50)
    uvicorn.run(app, host="127.0.0.1", port=8000)
