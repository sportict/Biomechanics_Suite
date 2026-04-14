#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HPE IPC Handler - stdin/stdout based communication for Electron
JSON-line protocol: one JSON object per line

REWRITTEN: ONNX-GPU Only version (No PyTorch)
"""

import os
import sys
import json
import time
import traceback
import tempfile
import shutil
import threading
from pathlib import Path
from typing import Optional, Dict, Any, List

# Windows環境でのstdin/stdout/stderrエンコーディングをUTF-8に設定
if sys.platform == 'win32':
    os.environ['PYTHONIOENCODING'] = 'utf-8'
    import io
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8', errors='replace')
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace', newline='\n')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace', newline='\n')

    # プロジェクトルート設定
    if getattr(sys, 'frozen', False):
        PROJECT_ROOT = Path(sys.executable).parent
    else:
        PROJECT_ROOT = Path(__file__).parent.parent

    # [Auto-Fix] Add Python executable directory to DLL search path
    # .venv/Scripts/ 内のDLLを検索できるように明示的に追加
    try:
        if sys.platform == 'win32':
            exe_dir = os.path.dirname(sys.executable)
            os.add_dll_directory(exe_dir)
            os.environ['PATH'] = exe_dir + os.pathsep + os.environ['PATH']
            print(f"[Init] Added DLL directory: {exe_dir}", file=sys.stderr)
    except Exception as e:
        print(f"[Init] Failed to add DLL directory: {e}", file=sys.stderr)

    # CUDNNパス検索は遅延実行 (ensure_cudnn_paths) に移動しました
    pass

# プロジェクトルートをパスに追加
# If not on Windows, or if the above block didn't run, define PROJECT_ROOT here.
# Otherwise, it's already defined.
if 'PROJECT_ROOT' not in locals():
    PROJECT_ROOT = Path(__file__).parent.parent

sys.path.insert(0, str(PROJECT_ROOT))
# serverディレクトリもパスに追加
SERVER_DIR = Path(__file__).parent
sys.path.insert(0, str(SERVER_DIR))

# 共通モジュールからインポート
from utils import (
    KEYPOINT_NAMES_23,
    KEYPOINT_NAMES_SYNTHPOSE,
    KEYPOINT_NAMES_HALPE,
    NorfairPersonTracker,
    convert_to_23_keypoints,
    convert_to_synthpose_keypoints,
    convert_synthpose_to_23_keypoints,
    convert_halpe_to_23_keypoints,
    detect_device as utils_detect_device,
    get_device_info as utils_get_device_info
)

# ONNX Integration (Deferred)
ONNXPoseEstimator = None
check_onnx_models_available = None
load_onnx_pose_estimator = None
ONNX_INTEGRATION_AVAILABLE = False # Will be checked in load_model

class LazyLoader:
    def __init__(self, lib_name):
        self.lib_name = lib_name
        self._mod = None
    
    def __getattr__(self, name):
        if self._mod is None:
            import importlib
            self._mod = importlib.import_module(self.lib_name)
        return getattr(self._mod, name)

# Lazy load heavy dependencies
np = LazyLoader("numpy")
cv2 = LazyLoader("cv2")

# FFmpeg
try:
    import ffmpeg
    FFMPEG_AVAILABLE = True
except ImportError:
    FFMPEG_AVAILABLE = False

# ===================================
# Helper Functions
# ===================================
def send_message(type: str, data: Any = None):
    """メインプロセスへメッセージ送信"""
    msg = {"type": type}
    if data is not None:
        msg["data"] = data
    sys.stdout.write(json.dumps(msg) + '\n')
    sys.stdout.flush()

def send_response(request_id: str, type: str, data: Any = None):
    """リクエストへのレスポンス送信"""
    msg = {"id": request_id, "type": type}
    if data is not None:
        msg["data"] = data
    sys.stdout.write(json.dumps(msg) + '\n')
    sys.stdout.flush()

def report_progress(progress, message, request_id=None):
    """進捗を報告"""
    data = {"progress": progress, "message": message}
    if request_id:
        send_response(request_id, "progress", data)
    else:
        send_message("model_loading_progress", data)

def log_debug(message):
    """デバッグログをフロントエンドに送信"""
    print(f"[DEBUG] {message}", file=sys.stderr)
    send_message("log", str(message))

def send_progress(request_id: str, progress: int, frame: int = 0, total: int = 0, message: str = None):
    """リクエスト処理の進捗を送信"""
    data = {
        "progress": progress,
        "frame": frame,
        "total": total
    }
    if message:
        data["message"] = message
    send_response(request_id, "progress", data)

# ===================================
# Config & Device Detection
# ===================================
# ===================================
# Config & Device Detection
# ===================================
CONFIG_FILE = PROJECT_ROOT / "config.json"

class AppConfig:
    def __init__(self):
        self.device = "auto"
        self.yolo_size = 640 # default (推奨・高精度)
        self.confidence_threshold = 0.3 # default
        self.nms_threshold = 0.45 # default
        self.model_loaded = False
        self.loaded_models = {}
        self.load()

    def load(self):
        """設定ファイルからロード"""
        if CONFIG_FILE.exists():
            try:
                with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    self.yolo_size = int(data.get('yolo_size', 320))
                    self.confidence_threshold = float(data.get('confidence_threshold', 0.3))
                    self.nms_threshold = float(data.get('nms_threshold', 0.45))
                    # deviceは保存しない（毎回検出またはauto）
            except Exception as e:
                print(f"[Config] Failed to load config: {e}", file=sys.stderr)

    def save(self):
        """設定ファイルに保存"""
        data = {
            'yolo_size': self.yolo_size,
            'confidence_threshold': self.confidence_threshold,
            'nms_threshold': self.nms_threshold
        }
        try:
            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            print(f"[Config] Failed to save config: {e}", file=sys.stderr)

config = AppConfig()

def detect_device() -> str:
    """利用可能なデバイスを検出（utils.pyを使用）"""
    return utils_detect_device(config.device)

def get_device_info() -> Dict[str, Any]:
    """デバイス情報を取得（utils.pyを使用）"""
    return utils_get_device_info()

def handle_set_config(request_id: str, data: Dict):
    """設定を更新"""
    try:
        # 新しい設定値を取得
        new_yolo_size = data.get('yolo_size')
        new_conf = data.get('confidence_threshold')
        new_nms = data.get('nms_threshold')

        need_reload = False
        
        # 値の検証と更新
        if new_yolo_size is not None:
            new_yolo_size = int(new_yolo_size)
            if config.yolo_size != new_yolo_size:
                config.yolo_size = new_yolo_size
                need_reload = True
        
        if new_conf is not None:
            config.confidence_threshold = float(new_conf)
            # 閾値変更だけならリロード不要だが、ONNXPoseEstimatorのインスタンス変数を更新する必要がある
            # 現在の実装ではコンストラクタで渡しているので、リロードする方が安全で確実
            # もし軽量化したければインスタンスのプロパティを更新するメソッドを作るべきだが
            # ここではシンプルにリロードとする（YOLOモデル再構築はそれなりに速い）
            need_reload = True
            
        if new_nms is not None:
            config.nms_threshold = float(new_nms)
            need_reload = True
            
        # 設定を保存
        config.save()
        
        # 必要ならモデル再ロード
        if need_reload and config.model_loaded:
            # グローバル状態をリセット
            config.model_loaded = False
            global model_instance
            model_instance = None
            model_loading_complete.clear()
            
            # 再ロード実行（非同期）
            threading.Thread(target=load_model, kwargs={
                'message': "設定変更によりモデルを再読み込み中..."
            }).start()
            
        send_response(request_id, "result", {"success": True, "need_reload": need_reload})
        
    except Exception as e:
        send_response(request_id, "error", {"error": str(e)})

# ===================================
# Model Management
# ===================================
model_instance = None
model_loading_lock = threading.Lock()
model_loading_complete = threading.Event()

# キャンセル機能用のグローバル変数
cancel_detection_flag = threading.Event()  # キャンセルリクエストフラグ
current_detection_request_id = None  # 現在処理中のリクエストID

def get_model():
    """モデルインスタンスを取得"""
    global model_instance
    if not config.model_loaded and model_instance is None:
        # Not loaded or failed, try sync load as fallback
        try:
            load_model()
        except Exception as e:
            log_debug(f"Auto-load failed: {e}")
            return None
    return model_instance


def ensure_cudnn_paths():
    """
    Windows環境でCUDNNのパスを環境変数に追加する
    起動時ではなく、モデルロード直前に実行する
    """
    if sys.platform == 'win32':
        # 既に設定済みならスキップ
        if getattr(ensure_cudnn_paths, '_done', False):
            return
            
        # CUDNN/TensorRTパスの追加（環境に合わせて調整）
        possible_cudnn_paths = [
            r"C:\Program Files\NVIDIA\CUDNN\v9.12\bin",
            r"C:\Program Files\NVIDIA\CUDNN\v9.11\bin",
            r"C:\Program Files\NVIDIA\CUDNN\v9.10\bin",
            r"C:\Program Files\NVIDIA\CUDNN\v9.9\bin",
            r"C:\Program Files\NVIDIA\CUDNN\v9.8\bin",
            r"C:\Program Files\NVIDIA\CUDNN\v9.7\bin",
            r"C:\Program Files\NVIDIA\CUDNN\v8.9\bin",
            r"C:\Program Files\NVIDIA\CUDNN\v8.8\bin",
            r"C:\Program Files\NVIDIA\CUDNN\v8.x\bin",
        ]
        
        found_paths = []
        for p in possible_cudnn_paths:
            if os.path.exists(p):
                try:
                    os.add_dll_directory(p)
                except:
                   pass
                found_paths.append(p)
        
        # PATH環境変数にも追加
        if found_paths:
            os.environ['PATH'] = os.pathsep.join(found_paths) + os.pathsep + os.environ['PATH']
            
        ensure_cudnn_paths._done = True

# Lock for load_model to prevent concurrent/duplicate execution
_load_lock = threading.Lock()

def load_model(progress_callback=None, model_type=None, yolo_type=None, progress=0, message=None):
    """モデルをロード (ONNX only) - Thread-safe Wrapper"""
    global model_instance
    with _load_lock:
        # If simple reload is requested (no specific model change) and already loaded, skip
        if model_type is None and yolo_type is None and config.model_loaded and model_instance is not None:
            log_debug("Model already loaded. Skipping duplicate load_model call.")
            return model_instance
        
        instance = _load_model_internal(progress_callback, model_type, yolo_type, progress, message)
        
        # Notify completion
        if config.model_loaded and config.loaded_models:
             print(json.dumps({
                "type": "model_loaded",
                "data": {
                    "success": True,
                    "device": config.loaded_models.get('device', 'cpu'),
                    "models": config.loaded_models
                }
            }), flush=True)
            
        return instance

def _get_available_models_list(models_dir: Path, base_list: list) -> list:
    """base_list に存在するファイルに基づいて rtmpose/vitpose モデルを追加した完全なリストを返す"""
    result = list(base_list)
    for name in ('rtmpose-x', 'rtmpose-m'):
        if (models_dir / f"{name}.onnx").exists() and name not in result:
            result.append(name)
    if (models_dir / "vitpose-h-wholebody" / "vitpose-h-wholebody.onnx").exists():
        if 'vitpose-h-wholebody' not in result:
            result.append('vitpose-h-wholebody')
    return result


def _load_model_internal(progress_callback=None, model_type=None, yolo_type=None, progress=0, message=None):
    """モデルをロード (ONNX / SynthPose PyTorch) - Internal Implementation"""
    global model_instance

    def report(p, msg):
        if progress_callback:
            progress_callback(p, msg)
        else:
            report_progress(p, msg)

    global ONNX_INTEGRATION_AVAILABLE, ONNXPoseEstimator, check_onnx_models_available, load_onnx_pose_estimator

    report(progress, message or "初期化中...")

    # 遅延ロードとCUDNNパス設定
    ensure_cudnn_paths()

    # model_type 未指定時: デバイスに応じてデフォルトプリセットを自動選択
    # GPU → 高精度 (rtmpose-x + yolo11x), CPU → 高速 (rtmpose-m + yolo11s)
    if model_type is None:
        _auto_device = detect_device()
        _models_dir = PROJECT_ROOT / "Models"
        if _auto_device == 'cuda' and (_models_dir / 'rtmpose-x.onnx').exists():
            model_type = 'rtmpose-x'
            if yolo_type is None:
                _yolo_x = _models_dir / 'yolo11x.onnx'
                yolo_type = 'yolo11x.onnx' if _yolo_x.exists() else 'yolo11s.onnx'
        else:
            model_type = 'rtmpose-m'
            if yolo_type is None:
                yolo_type = 'yolo11s.onnx'
        print(json.dumps({"type": "log", "data": f"[AutoPreset] device={_auto_device} → model={model_type}, yolo={yolo_type}"}), flush=True)

    # ========== RTMPose Branch ==========
    if model_type in ('rtmpose-x', 'rtmpose-m'):
        models_dir = PROJECT_ROOT / "Models"
        current_device = detect_device()
        body_model_file = f"{model_type}.onnx"

        report(progress + 10, f"{model_type.upper()} モデルを確認中...")
        try:
            from rtmpose_estimator import load_rtmpose_estimator

            report(progress + 20, f"{model_type.upper()} モデルをロード中... ({current_device})")
            model_instance, vitpose_name, actual_device = load_rtmpose_estimator(
                models_dir=models_dir,
                yolo_type=yolo_type,
                device=current_device,
                body_model=body_model_file,
                yolo_size=config.yolo_size,
                conf_threshold=config.confidence_threshold,
                log_func=log_debug,
            )
            current_device = actual_device
        except Exception as e:
            error_msg = str(e)
            log_debug(f"RTMPose load error: {error_msg}")
            raise RuntimeError(f"RTMPose loading failed: {error_msg}")

        available_yolo = []
        try:
            yolo_files = list((PROJECT_ROOT / "Models").glob("yolo*.onnx"))
            available_yolo = [f.name for f in yolo_files]
            available_yolo.sort()
        except Exception as e:
            log_debug(f"Failed to list YOLO models: {e}")

        report(90, "モデル初期化完了...")

        config.model_loaded = True
        config.loaded_models = {
            "vitpose":          vitpose_name,
            "vitpose_type":     model_type,
            "available_models": _get_available_models_list(models_dir, ['h', 'b', 'synthpose-base', 'synthpose-huge', 'synthpose-base-onnx', 'synthpose-huge-onnx']),
            "yolo":             Path(yolo_type).name if yolo_type else "auto",
            "yolo_model":       Path(yolo_type).name if yolo_type else "auto",
            "available_yolo":   available_yolo,
            "device":           current_device,
            "warnings":         [],
        }

        report(100, "完了")
        model_loading_complete.set()
        return model_instance
    # ========== End RTMPose Branch ==========

    # ========== ViTPose-H Wholebody (rtmlib) Branch ==========
    if model_type == 'vitpose-h-wholebody':
        models_dir = PROJECT_ROOT / "Models"
        current_device = detect_device()

        report(progress + 10, "ViTPose-H モデルを確認中...")
        try:
            from vitpose_rtmlib_estimator import load_vitpose_estimator

            report(progress + 20, f"ViTPose-H モデルをロード中... ({current_device})")
            model_instance, vitpose_name, actual_device = load_vitpose_estimator(
                models_dir=models_dir,
                yolo_type=yolo_type,
                device=current_device,
                yolo_size=config.yolo_size,
                conf_threshold=config.confidence_threshold,
                log_func=log_debug,
            )
            current_device = actual_device
        except Exception as e:
            error_msg = str(e)
            log_debug(f"ViTPose-H load error: {error_msg}")
            raise RuntimeError(f"ViTPose-H loading failed: {error_msg}")

        available_yolo = []
        try:
            yolo_files = list((PROJECT_ROOT / "Models").glob("yolo*.onnx"))
            available_yolo = [f.name for f in yolo_files]
            available_yolo.sort()
        except Exception as e:
            log_debug(f"Failed to list YOLO models: {e}")

        report(90, "モデル初期化完了...")

        config.model_loaded = True
        config.loaded_models = {
            "vitpose":          vitpose_name,
            "vitpose_type":     model_type,
            "available_models": _get_available_models_list(models_dir, ['h', 'b', 'synthpose-base', 'synthpose-huge', 'synthpose-base-onnx', 'synthpose-huge-onnx']),
            "yolo":             Path(yolo_type).name if yolo_type else "auto",
            "yolo_model":       Path(yolo_type).name if yolo_type else "auto",
            "available_yolo":   available_yolo,
            "device":           current_device,
            "warnings":         [],
        }

        report(100, "完了")
        model_loading_complete.set()
        return model_instance
    # ========== End ViTPose-H Wholebody Branch ==========

    # ========== SynthPose ONNX Branch ==========
    synthpose_onnx_size = None
    if model_type == 'synthpose-base-onnx':
        synthpose_onnx_size = 'base'
    elif model_type == 'synthpose-huge-onnx':
        synthpose_onnx_size = 'huge'

    if synthpose_onnx_size is not None:
        models_dir = PROJECT_ROOT / "Models"
        current_device = detect_device()
        load_warnings = []

        report(progress + 10, f"SynthPose-{synthpose_onnx_size.capitalize()} ONNX モデルを確認中...")
        try:
            from synthpose_onnx_estimator import load_synthpose_onnx_estimator

            report(progress + 20, f"ONNX モデルをロード中... ({current_device})")
            model_instance, vitpose_name, actual_device = load_synthpose_onnx_estimator(
                models_dir=models_dir,
                model_size=synthpose_onnx_size,
                yolo_type=yolo_type,
                device=current_device,
                yolo_size=config.yolo_size,
                conf_threshold=config.confidence_threshold,
                log_func=log_debug,
            )
            current_device = actual_device
        except Exception as e:
            error_msg = str(e)
            log_debug(f"SynthPose ONNX load error: {error_msg}")
            raise RuntimeError(f"SynthPose ONNX loading failed: {error_msg}")

        available_yolo = []
        try:
            yolo_files = list((PROJECT_ROOT / "Models").glob("yolo*.onnx"))
            available_yolo = [f.name for f in yolo_files]
            available_yolo.sort()
        except Exception as e:
            log_debug(f"Failed to list YOLO models: {e}")

        report(90, "モデル初期化完了...")

        config.model_loaded = True
        config.loaded_models = {
            "vitpose":          vitpose_name,
            "vitpose_type":     model_type,   # 'synthpose-base-onnx' or 'synthpose-huge-onnx'
            "available_models": _get_available_models_list(models_dir, ['h', 'b', 'synthpose-base', 'synthpose-huge', 'synthpose-base-onnx', 'synthpose-huge-onnx']),
            "yolo":             Path(yolo_type).name if yolo_type else "auto",
            "yolo_model":       Path(yolo_type).name if yolo_type else "auto",
            "available_yolo":   available_yolo,
            "device":           current_device,
            "warnings":         load_warnings,
        }

        report(100, "完了")
        model_loading_complete.set()
        return model_instance
    # ========== End SynthPose ONNX Branch ==========

    # ========== SynthPose PyTorch Branch ==========
    synthpose_size = None
    if model_type == 'synthpose-base':
        synthpose_size = 'base'
    elif model_type == 'synthpose-huge':
        synthpose_size = 'huge'

    if synthpose_size is not None:
        models_dir = PROJECT_ROOT / "Models"
        current_device = detect_device()
        load_warnings = []

        report(progress + 10, f"SynthPose-{synthpose_size.capitalize()} モデルを確認中...")
        try:
            from synthpose_torch_estimator import load_synthpose_estimator

            report(progress + 20, f"PyTorch モデルをロード中... ({current_device})")
            model_instance, vitpose_name, actual_device = load_synthpose_estimator(
                models_dir=models_dir,
                model_size=synthpose_size,
                yolo_type=yolo_type,
                device=current_device,
                yolo_size=config.yolo_size,
                conf_threshold=config.confidence_threshold,
                log_func=log_debug,
            )
            current_device = actual_device
        except Exception as e:
            error_msg = str(e)
            log_debug(f"SynthPose load error: {error_msg}")
            raise RuntimeError(f"SynthPose loading failed: {error_msg}")

        # YOLOモデルリスト (UI用)
        available_yolo = []
        try:
            yolo_files = list((PROJECT_ROOT / "Models").glob("yolo*.onnx"))
            available_yolo = [f.name for f in yolo_files]
            available_yolo.sort()
        except Exception as e:
            log_debug(f"Failed to list YOLO models: {e}")

        report(90, "モデル初期化完了...")

        config.model_loaded = True
        config.loaded_models = {
            "vitpose":           vitpose_name,
            "vitpose_type":      model_type,   # 'synthpose-base' or 'synthpose-huge'
            "available_models":  _get_available_models_list(models_dir, ['h', 'b', 'synthpose-base', 'synthpose-huge', 'synthpose-base-onnx', 'synthpose-huge-onnx']),
            "yolo":              Path(yolo_type).name if yolo_type else "auto",
            "yolo_model":        Path(yolo_type).name if yolo_type else "auto",
            "available_yolo":    available_yolo,
            "device":            current_device,
            "warnings":          load_warnings,
        }

        report(100, "完了")
        model_loading_complete.set()
        return model_instance
    # ========== End SynthPose Branch ==========

    if not ONNX_INTEGRATION_AVAILABLE:
        try:
            from onnx_vitpose_integration import (
                ONNXPoseEstimator as _ONNXPoseEstimator,
                check_onnx_models_available as _check_onnx_models_available,
                load_onnx_pose_estimator as _load_onnx_pose_estimator
            )
            ONNXPoseEstimator = _ONNXPoseEstimator
            check_onnx_models_available = _check_onnx_models_available
            load_onnx_pose_estimator = _load_onnx_pose_estimator
            ONNX_INTEGRATION_AVAILABLE = True
        except ImportError as e:
            raise ImportError(f"onnx_vitpose_integration module missing or failed to import: {e}")


    models_dir = PROJECT_ROOT / "Models"
    current_device = detect_device()
    load_warnings = []
    
    report(progress + 10, "ONNXモデルを確認中...")
    # デバイスに応じて推奨モデルを選択（GPU: ViTPose-H、CPU: ViTPose-B）
    onnx_available = check_onnx_models_available(models_dir, device=current_device)
    
    has_yolo = onnx_available['recommended']['yolo'] is not None
    has_vitpose = onnx_available['recommended']['vitpose'] is not None
    
    if not has_yolo:
        # Try to find any yolo*.onnx
        if not onnx_available['yolo']:
             raise FileNotFoundError("YOLO ONNX model (yolo*.onnx) not found in Models/ directory.")
    if not has_vitpose:
        if not onnx_available['vitpose']:
             raise FileNotFoundError("ViTPose ONNX model (vitpose*.onnx) not found in Models/ directory.")
        
    report(progress + 20, f"ONNXモデルをロード中... ({current_device})")
    
    yolo_path = (str(models_dir / yolo_type) if yolo_type else onnx_available['recommended']['yolo'])
    if not yolo_path: # Fallback
         yolo_path = onnx_available['yolo'][0]

    vitpose_path = onnx_available['recommended']['vitpose']
    if not vitpose_path: # Fallback
         vitpose_path = onnx_available['vitpose'][0]

    log_debug(f"ONNX YOLO: {yolo_path}")
    log_debug(f"ONNX ViTPose: {vitpose_path}")

    yolo_name = Path(yolo_path).name

    # モデルタイプを先に検出（表示名用）
    vitpose_type_label = 'B'  # default
    vp_str = vitpose_path.lower()
    if 'vitpose-h' in vp_str: vitpose_type_label = 'H'
    elif 'vitpose-l' in vp_str: vitpose_type_label = 'L'
    elif 'vitpose-s' in vp_str: vitpose_type_label = 'S'
    elif 'vitpose-g' in vp_str: vitpose_type_label = 'G'

    vitpose_name = "ViTPose (Loading...)"

    try:
        import time
        t0 = time.time()
        model_instance = ONNXPoseEstimator(
            yolo_onnx_path=yolo_path,
            vitpose_onnx_path=vitpose_path,
            device=current_device,
            yolo_size=config.yolo_size,
            conf_threshold=config.confidence_threshold,
            log_func=log_debug
        )
        t1 = time.time()
        log_debug(f"[Profiling] ONNXPoseEstimator initialization took: {t1 - t0:.4f} sec")

        vitpose_name = f"ViTPose-{vitpose_type_label} ONNX"
        
        # [Validation] 実際にCUDAが使われているか確認 (ONNX Runtime silent fallback対策)
        try:
            active = model_instance.get_active_providers()
            yolo_prov = active.get('yolo', [])
            vitpose_prov = active.get('vitpose', [])
            
            log_debug(f"Active providers: YOLO={yolo_prov}, ViTPose={vitpose_prov}")
            
            if current_device == 'cuda':
                # CUDAが有効ならリストの先頭にあるはず
                yolo_cuda_ok = len(yolo_prov) > 0 and 'CUDAExecutionProvider' in yolo_prov[0]
                vitpose_cuda_ok = len(vitpose_prov) > 0 and 'CUDAExecutionProvider' in vitpose_prov[0]
                
                if not yolo_cuda_ok or not vitpose_cuda_ok:
                    warn_msg = "GPU Requested but running on CPU. Missing correct cuDNN/CUDA DLLs?"
                    log_debug(f"[WARN] {warn_msg}")
                    load_warnings.append(warn_msg)
                    if not yolo_cuda_ok: load_warnings.append(f"YOLO fell back to: {yolo_prov[0]}")
                    if not vitpose_cuda_ok: load_warnings.append(f"ViTPose fell back to: {vitpose_prov[0]}")
                    
                    # UI表示をCPUに強制変更
                    current_device = 'cpu'
                    vitpose_name = f"ViTPose-{vitpose_type_label} ONNX (CPU Fallback)"
        except Exception as check_e:
            log_debug(f"Provider check failed: {check_e}")

    except Exception as e:
        error_msg = str(e)
        log_debug(f"ONNX load error ({current_device}): {error_msg}")
        load_warnings.append(f"ONNX ({current_device}): {error_msg}")
        
        # Fallback to CPU if CUDA failed
        if current_device == 'cuda':
            report(progress + 40, "GPUロード失敗、CPUで再試行中...")
            try:
                model_instance = ONNXPoseEstimator(
                    yolo_onnx_path=yolo_path,
                    vitpose_onnx_path=vitpose_path,
                    device='cpu',
                    yolo_size=config.yolo_size,
                    conf_threshold=config.confidence_threshold,
                    log_func=log_debug
                )
                vitpose_name = f"ViTPose-{vitpose_type_label} ONNX (CPU)"
                current_device = 'cpu'
                load_warnings.append("Switched to CPU due to GPU error")
            except Exception as e2:
                raise RuntimeError(f"ONNX loading failed (CPU fallback also failed): {e2}")
        else:
            raise RuntimeError(f"ONNX loading failed: {e}")

    # モデルタイプをファイル名から推定 (UI互換性のため)
    v_type = 'b' # default fallback
    p_str = vitpose_path.lower()
    if 'vitpose-h' in p_str: v_type = 'h'
    elif 'vitpose-l' in p_str: v_type = 'l'
    elif 'vitpose-s' in p_str: v_type = 's'
    elif 'vitpose-g' in p_str: v_type = 'g'

    # 利用可能なViTPoseモデルタイプを検出
    available_vitpose_types = []
    vitpose_check = [
        ('h', ['vitpose-h-wholebody.onnx', 'vitpose-h-wholebody/vitpose-h-wholebody.onnx']),
        ('b', ['vitpose-b-wholebody.onnx']),
    ]
    for model_type, paths in vitpose_check:
        for path in paths:
            if (models_dir / path).exists():
                available_vitpose_types.append(model_type)
                break

    # デバイスに応じてソート（GPU: H優先、CPU: B優先）
    if current_device == 'cuda':
        type_order = {'h': 0, 'b': 1}
    else:
        type_order = {'b': 0, 'h': 1}
    available_vitpose_types.sort(key=lambda x: type_order.get(x, 99))

    report(90, "モデル初期化完了...")

    # YOLOモデルリストの取得 (UI用)
    available_yolo = []
    try:
        yolo_files = list(models_dir.glob("yolo*.onnx"))
        available_yolo = [f.name for f in yolo_files]
        available_yolo.sort()
    except Exception as e:
        log_debug(f"Failed to list YOLO models: {e}")

    config.model_loaded = True
    config.loaded_models = {
        "vitpose": vitpose_name,
        "vitpose_type": v_type,
        "available_models": _get_available_models_list(models_dir, available_vitpose_types),
        "yolo": yolo_name,
        "yolo_model": yolo_name,
        "available_yolo": available_yolo,
        "device": current_device,
        "warnings": load_warnings
    }
    
    report(100, "完了")
    model_loading_complete.set()
    return model_instance



# ===================================
# 人物追跡（utils.pyから使用）
# ===================================
norfair_tracker = NorfairPersonTracker(
    distance_threshold=0.6,  # 0.4→0.6: 座っている人など姿勢変化に対応
    hit_counter_max=60,      # 30→60: 検出漏れに対する耐性向上
    initialization_delay=1
)

# ===================================
# 骨格描画
# ===================================
SKELETON_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3),
    (4, 5), (5, 6), (6, 7),
    (8, 11), (9, 11), (10, 11), (11, 12), (12, 13),
    (14, 17), (15, 17), (16, 17), (17, 18), (18, 19),
    (3, 7), (13, 19), (3, 13), (7, 19), (3, 22), (7, 22),
    (20, 21), (21, 22)
]

COLORS_BGR = {
    'right': (68, 68, 239),
    'left': (246, 130, 59),
    'center': (129, 185, 16)
}

def get_keypoint_color(idx):
    if idx < 4 or (8 <= idx <= 13):
        return COLORS_BGR['right']
    elif idx < 8 or (14 <= idx <= 19):
        return COLORS_BGR['left']
    return COLORS_BGR['center']

def get_line_color(idx1, idx2):
    if (idx1 < 4 and idx2 < 4) or (8 <= idx1 <= 13 and 8 <= idx2 <= 13):
        return COLORS_BGR['right']
    elif (4 <= idx1 < 8 and 4 <= idx2 < 8) or (14 <= idx1 <= 19 and 14 <= idx2 <= 19):
        return COLORS_BGR['left']
    return COLORS_BGR['center']

def draw_skeleton_on_frame(frame, keypoints_dict, confidence_threshold=0.3):
    for person_id, kpts in keypoints_dict.items():
        if isinstance(kpts, list):
            kpts = np.array(kpts)
            
        # 有効なキーポイントを収集してバウンディングボックスを計算
        valid_points = []
        for kp in kpts:
            if kp[2] > confidence_threshold:
                valid_points.append((int(kp[0]), int(kp[1])))
        
        # バウンディングボックスと人物IDを描画
        if len(valid_points) >= 2:
            xs = [p[0] for p in valid_points]
            ys = [p[1] for p in valid_points]
            x_min, x_max = min(xs), max(xs)
            y_min, y_max = min(ys), max(ys)
            
            # パディングを追加
            padding = 20
            x_min = max(0, x_min - padding)
            y_min = max(0, y_min - padding)
            x_max = min(frame.shape[1], x_max + padding)
            y_max = min(frame.shape[0], y_max + padding)
            
            # バウンディングボックスを描画（赤色）
            bbox_color = (59, 59, 238)  # BGR: 赤系
            cv2.rectangle(frame, (x_min, y_min), (x_max, y_max), bbox_color, 2)
            
            # 人物IDラベルの背景
            label = f"Person {person_id}"
            font = cv2.FONT_HERSHEY_SIMPLEX
            font_scale = 0.6
            thickness = 2
            (label_w, label_h), baseline = cv2.getTextSize(label, font, font_scale, thickness)
            
            # ラベル背景ボックス
            label_y = max(y_min - 5, label_h + 5)
            cv2.rectangle(frame, (x_min, label_y - label_h - 5), (x_min + label_w + 10, label_y + 5), bbox_color, -1)
            
            # ラベルテキスト（白色）
            cv2.putText(frame, label, (x_min + 5, label_y), font, font_scale, (255, 255, 255), thickness)
        
        # スケルトン線を描画
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

# ===================================
# FFmpeg ユーティリティ
# ===================================
BROWSER_COMPATIBLE_CODECS = ['h264', 'vp8', 'vp9', 'av1']
BROWSER_COMPATIBLE_CONTAINERS = ['.mp4', '.webm', '.ogg']

def check_ffmpeg_installed() -> bool:
    if not FFMPEG_AVAILABLE: return False
    return shutil.which('ffmpeg') is not None

def get_video_info(file_path: str) -> Dict[str, Any]:
    if not FFMPEG_AVAILABLE:
        raise Exception("ffmpeg-python がインストールされていません")
    
    try:
        probe = ffmpeg.probe(file_path)
        video_streams = [s for s in probe['streams'] if s['codec_type'] == 'video']
        
        if not video_streams:
            return {"error": "動画ストリームが見つかりません"}
        
        video_stream = video_streams[0]
        
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
    except Exception as e:
        return {"error": str(e)}

def needs_conversion(video_info: Dict[str, Any]) -> bool:
    if "error" in video_info:
        return True
    
    codec = video_info.get('codec', '').lower()
    container = video_info.get('container', '').lower()
    
    return not (codec in BROWSER_COMPATIBLE_CODECS and container in BROWSER_COMPATIBLE_CONTAINERS)

def convert_video_to_mp4(input_path: str, output_path: str) -> Dict[str, Any]:
    if not FFMPEG_AVAILABLE:
        raise Exception("ffmpeg-python がインストールされていません")
    
    if not check_ffmpeg_installed():
        raise Exception("FFmpegがインストールされていません")
    
    try:
        probe = ffmpeg.probe(input_path)
        duration = float(probe['format'].get('duration', 0))
        
        stream = ffmpeg.input(input_path)
        stream = ffmpeg.output(
            stream,
            output_path,
            vcodec='libx264',
            acodec='aac',
            preset='fast',
            crf=23,
            movflags='faststart',
            pix_fmt='yuv420p',
            **{'vsync': 'cfr'}
        )
        stream = ffmpeg.overwrite_output(stream)
        ffmpeg.run(stream, capture_stderr=True)
        
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

converted_video_cache: Dict[str, str] = {}
created_temp_dirs = []

# ===================================
# IPC メッセージハンドラ
# ===================================

def handle_status(request_id: str, data: Dict):
    """ステータス取得"""
    device_info = get_device_info()
    send_response(request_id, "result", {
        "model_loaded": config.model_loaded,
        "device_info": device_info,
        "config": {
            "device": config.device,
            "yolo_size": config.yolo_size,
            "confidence_threshold": config.confidence_threshold,
            "nms_threshold": config.nms_threshold
        }
    })

def handle_detect_image(request_id: str, data: Dict):
    """画像からポーズ推定"""
    
    start_time = time.time()
    
    try:
        file_path = data.get("file_path")
        if not file_path or not os.path.exists(file_path):
            send_response(request_id, "error", {"error": "ファイルが見つかりません"})
            return
        
        # 日本語パスに対応するため、np.fromfileとcv2.imdecodeを使用
        img = cv2.imdecode(np.fromfile(file_path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            send_response(request_id, "error", {"error": "画像の読み込みに失敗しました"})
            return
        
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        
        model = get_model()
        frame_keypoints = model.inference(img_rgb)
        
        output_format = data.get("output_format", "23pts")
        _vtype = config.loaded_models.get('vitpose_type', '') if config.loaded_models else ''
        _is_native_sp      = _vtype.startswith('synthpose')
        _is_rtmpose        = _vtype.startswith('rtmpose')
        if output_format == "synthpose":
            if _is_native_sp:
                def img_convert_kpts(x): return x
                img_kpt_names = KEYPOINT_NAMES_SYNTHPOSE
            elif _is_rtmpose:
                def img_convert_kpts(x): return x
                img_kpt_names = KEYPOINT_NAMES_HALPE
            else:
                img_convert_kpts = convert_to_synthpose_keypoints
                img_kpt_names = KEYPOINT_NAMES_SYNTHPOSE
        else:  # 23pts
            if _is_native_sp:
                img_convert_kpts = convert_synthpose_to_23_keypoints
            elif _is_rtmpose:
                img_convert_kpts = convert_halpe_to_23_keypoints
            else:
                img_convert_kpts = convert_to_23_keypoints
            img_kpt_names = KEYPOINT_NAMES_23

        results = {}
        for person_id, person_data in frame_keypoints.items():
            kpts = person_data['keypoints'] if isinstance(person_data, dict) else person_data
            kpts_out = img_convert_kpts(kpts)
            results[str(person_id)] = kpts_out.tolist()

        processing_time = (time.time() - start_time) * 1000

        height, width = img.shape[:2]

        send_response(request_id, "result", {
            "success": True,
            "num_persons": len(results),
            "keypoints": results,
            "keypoint_names": img_kpt_names,
            "output_format": output_format,
            "processing_time_ms": processing_time,
            "width": width,
            "height": height
        })
    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})

def handle_detect_frame(request_id: str, data: Dict):
    """動画の特定フレームからポーズ推定（フレーム再推定用）"""
    start_time = time.time()

    try:
        file_path = data.get("file_path")
        frame_number = data.get("frame_number", 1)
        confidence_threshold = data.get("confidence_threshold", config.confidence_threshold)

        if not file_path or not os.path.exists(file_path):
            send_response(request_id, "error", {"error": "ファイルが見つかりません"})
            return

        # 動画を開いてフレームを取得
        cap = cv2.VideoCapture(file_path)
        if not cap.isOpened():
            send_response(request_id, "error", {"error": "動画を開けませんでした"})
            return

        # フレーム番号に移動（0-indexed）
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number - 1)
        ret, frame = cap.read()
        cap.release()

        if not ret or frame is None:
            send_response(request_id, "error", {"error": f"フレーム {frame_number} の読み込みに失敗しました"})
            return

        img_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        # モデルを取得
        model = get_model()

        # 一時的に信頼度閾値を変更（detectorに直接設定）
        original_threshold = model.detector.conf_threshold
        model.detector.conf_threshold = confidence_threshold

        try:
            frame_keypoints = model.inference(img_rgb)
        finally:
            # 元の閾値に戻す
            model.detector.conf_threshold = original_threshold

        fr_output_format = data.get("output_format", "23pts")
        _fr_vtype = config.loaded_models.get('vitpose_type', '') if config.loaded_models else ''
        _is_native_sp     = _fr_vtype.startswith('synthpose')
        _is_rtmpose       = _fr_vtype.startswith('rtmpose')
        if fr_output_format == "synthpose":
            if _is_native_sp:
                def fr_convert_kpts(x): return x
                fr_kpt_names = KEYPOINT_NAMES_SYNTHPOSE
            elif _is_rtmpose:
                def fr_convert_kpts(x): return x
                fr_kpt_names = KEYPOINT_NAMES_HALPE
            else:
                fr_convert_kpts = convert_to_synthpose_keypoints
                fr_kpt_names = KEYPOINT_NAMES_SYNTHPOSE
        else:  # 23pts
            if _is_native_sp:
                fr_convert_kpts = convert_synthpose_to_23_keypoints
            elif _is_rtmpose:
                fr_convert_kpts = convert_halpe_to_23_keypoints
            else:
                fr_convert_kpts = convert_to_23_keypoints
            fr_kpt_names = KEYPOINT_NAMES_23

        results = {}
        for person_id, person_data in frame_keypoints.items():
            # inference()は {'keypoints': ..., 'bbox': ...} 形式の辞書を返す
            keypoints = person_data['keypoints'] if isinstance(person_data, dict) else person_data
            kpts_out = fr_convert_kpts(keypoints)
            results[str(person_id)] = kpts_out.tolist()

        processing_time = (time.time() - start_time) * 1000
        height, width = frame.shape[:2]

        send_response(request_id, "result", {
            "success": True,
            "frame_number": frame_number,
            "num_persons": len(results),
            "keypoints": results,
            "keypoint_names": fr_kpt_names,
            "output_format": fr_output_format,
            "processing_time_ms": processing_time,
            "width": width,
            "height": height,
            "confidence_threshold_used": confidence_threshold,
            "yolo_size_used": config.yolo_size
        })
    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})

def handle_detect_video(request_id: str, data: Dict):
    """動画からポーズ推定（進捗付き、キャンセル対応）"""
    global current_detection_request_id

    # キャンセルフラグをリセットし、現在のリクエストIDを記録
    cancel_detection_flag.clear()
    current_detection_request_id = request_id

    start_time = time.time()
    was_cancelled = False

    try:
        file_path = data.get("file_path")
        frame_skip = data.get("frame_skip", 1)
        extract_frames = data.get("extract_frames", True)
        frame_quality = data.get("frame_quality", 85)
        output_format = data.get("output_format", "23pts")  # "23pts" or "synthpose"

        # 出力形式に応じたキーポイント数・名前・変換関数を決定
        _vid_vtype = config.loaded_models.get('vitpose_type', '') if config.loaded_models else ''
        _is_native_synthpose = _vid_vtype.startswith('synthpose')
        _is_rtmpose          = _vid_vtype.startswith('rtmpose')
        if output_format == "synthpose":
            if _is_native_synthpose:
                kpt_count = 52
                active_kpt_names = KEYPOINT_NAMES_SYNTHPOSE
                def convert_kpts(x): return x
            elif _is_rtmpose:
                kpt_count = 26
                active_kpt_names = KEYPOINT_NAMES_HALPE
                def convert_kpts(x): return x
            else:
                kpt_count = 52
                active_kpt_names = KEYPOINT_NAMES_SYNTHPOSE
                convert_kpts = convert_to_synthpose_keypoints
        else:  # 23pts
            kpt_count = 23
            active_kpt_names = KEYPOINT_NAMES_23
            if _is_native_synthpose:
                convert_kpts = convert_synthpose_to_23_keypoints
            elif _is_rtmpose:
                convert_kpts = convert_halpe_to_23_keypoints
            else:
                convert_kpts = convert_to_23_keypoints

        if not file_path or not os.path.exists(file_path):
            send_response(request_id, "error", {"error": "ファイルが見つかりません"})
            return

        cap = cv2.VideoCapture(file_path)
        if not cap.isOpened():
            send_response(request_id, "error", {"error": "動画の読み込みに失敗しました"})
            return

        fps = int(cap.get(cv2.CAP_PROP_FPS))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        frame_output_dir = None
        if extract_frames:
            frame_output_dir = tempfile.mkdtemp(prefix="hpe_frames_")

        send_response(request_id, "init", {
            "fps": fps,
            "total_frames": total_frames,
            "frame_skip": frame_skip
        })

        model = get_model()
        model.reset()

        # モデルロード後に vitpose_type を再判定（モデル未ロード状態で detect_video が呼ばれた場合の修正）
        _vid_vtype = config.loaded_models.get('vitpose_type', '') if config.loaded_models else ''
        _is_native_synthpose = _vid_vtype.startswith('synthpose')
        _is_rtmpose          = _vid_vtype.startswith('rtmpose')
        if output_format == "synthpose":
            if _is_native_synthpose:
                kpt_count = 52
                active_kpt_names = KEYPOINT_NAMES_SYNTHPOSE
                def convert_kpts(x): return x
            elif _is_rtmpose:
                kpt_count = 26
                active_kpt_names = KEYPOINT_NAMES_HALPE
                def convert_kpts(x): return x
            else:
                kpt_count = 52
                active_kpt_names = KEYPOINT_NAMES_SYNTHPOSE
                convert_kpts = convert_to_synthpose_keypoints
        else:  # 23pts
            kpt_count = 23
            active_kpt_names = KEYPOINT_NAMES_23
            if _is_native_synthpose:
                convert_kpts = convert_synthpose_to_23_keypoints
            elif _is_rtmpose:
                convert_kpts = convert_halpe_to_23_keypoints
            else:
                convert_kpts = convert_to_23_keypoints

        # FPSに応じて追跡維持パラメータを調整 (2秒分保持 - 長めに設定してID断片化を防ぐ)
        hit_max = max(60, int(fps * 2.0))

        log_debug(f"Tracker Init: Enabled={norfair_tracker.tracker is not None}, Resolution={width}x{height}, HitMax={hit_max}, Delay=0")

        # initialization_delay=0 にして、即座に安定IDを割り当てる（Raw IDとの入れ替わり防止）
        norfair_tracker.reset(
            height=height,
            width=width,
            initialization_delay=0,
            hit_counter_max=hit_max
        )
        all_results = []
        last_keypoints = {}

        frame_idx = 0
        while cap.isOpened():
            # キャンセルチェック
            if cancel_detection_flag.is_set():
                log_debug(f"Detection cancelled at frame {frame_idx}")
                was_cancelled = True
                break

            ret, frame = cap.read()
            if not ret:
                break

            if extract_frames and frame_output_dir:
                frame_filename = os.path.join(frame_output_dir, f"frame_{frame_idx + 1:05d}.jpg")
                cv2.imwrite(frame_filename, frame, [cv2.IMWRITE_JPEG_QUALITY, frame_quality])

            if frame_skip <= 1 or frame_idx % frame_skip == 0:
                img_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                frame_results = model.inference(img_rgb)

                converted_data = {}
                for person_id, pdata in frame_results.items():
                    # 新しい形式: {'keypoints': kpts, 'bbox': bbox}
                    if isinstance(pdata, dict) and 'keypoints' in pdata:
                        kpts = pdata['keypoints']
                        bbox = pdata.get('bbox')
                        kpts_out = convert_kpts(kpts)
                        converted_data[str(person_id)] = {
                            'keypoints': kpts_out,
                            'bbox': bbox
                        }
                    # 古い形式互換 (numpy arrayのみ)
                    else:
                        kpts = pdata
                        kpts_out = convert_kpts(kpts)
                        converted_data[str(person_id)] = kpts_out

                stable_keypoints = norfair_tracker.track(converted_data)
                last_keypoints = stable_keypoints

                frame_result = {
                    "frame": frame_idx + 1,
                    # stable_keypointsは常に {id: kpts_array} 形式で返される
                    "keypoints": {pid: kpts.tolist() for pid, kpts in stable_keypoints.items()}
                }
            else:
                frame_result = {
                    "frame": frame_idx + 1,
                    "keypoints": {pid: [[0.0, 0.0, 0.0] for _ in range(kpt_count)] for pid in last_keypoints.keys()}
                }

            all_results.append(frame_result)
            frame_idx += 1

            progress = int((frame_idx / total_frames) * 100) if total_frames > 0 else 0
            send_progress(request_id, progress, frame_idx, total_frames)

        cap.release()

        # 推定直後にID統合を実行（断片化したIDを統合）
        id_mapping = {}
        if len(all_results) > 0 and not was_cancelled:
            try:
                from filtering import consolidate_person_ids
                max_gap_frames = int(fps * 2.0)  # 2秒分のギャップまで統合
                distance_threshold = 150.0  # 150px以内なら同一人物
                all_results, id_mapping = consolidate_person_ids(
                    all_results,
                    max_gap_frames=max_gap_frames,
                    distance_threshold=distance_threshold
                )
                if id_mapping:
                    log_debug(f"[Detect] ID consolidation: merged {len(id_mapping)} IDs")
            except Exception as e:
                log_debug(f"[Detect] ID consolidation failed: {e}")

        processing_time = (time.time() - start_time) * 1000

        # 結果を返す（キャンセルされた場合も部分的な結果を返す）
        result_data = {
            "success": True,
            "fps": fps,
            "total_frames": total_frames,
            "processed_frames": len(all_results),
            "keypoint_names": active_kpt_names,
            "output_format": output_format,
            "frames": all_results,
            "processing_time_ms": processing_time,
            "cancelled": was_cancelled,  # キャンセルされたかどうかのフラグ
            "id_mapping": id_mapping  # 統合されたIDのマッピング
        }

        if frame_output_dir:
            result_data["extracted_frames_dir"] = frame_output_dir

        send_response(request_id, "result", result_data)

    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})
    finally:
        # リクエストIDをクリア
        current_detection_request_id = None


def handle_cancel_detection(request_id: str, data: Dict):
    """ポーズ推定をキャンセル"""
    global current_detection_request_id

    if current_detection_request_id is not None:
        log_debug(f"Cancelling detection request: {current_detection_request_id}")
        cancel_detection_flag.set()
        send_response(request_id, "result", {"success": True, "message": "キャンセルリクエストを送信しました"})
    else:
        send_response(request_id, "result", {"success": False, "message": "キャンセルする処理がありません"})

def handle_filter(request_id: str, data: Dict):
    """キーポイントデータにフィルタリングを適用"""
    try:
        from filtering import process_video_keypoints

        frames = data.get("frames", [])
        fps = data.get("fps", 30.0)

        # ID統合は推定完了時に実行済み（handle_detect_video）

        filtered_frames = process_video_keypoints(
            frames,
            fps=fps,
            confidence_threshold=data.get("confidence_threshold", 0.3),
            enable_id_swap_fix=data.get("enable_id_swap_fix", True),
            id_swap_threshold=data.get("id_swap_threshold", 100.0),
            enable_outlier_removal=data.get("enable_outlier_removal", True),
            enable_interpolation=data.get("enable_interpolation", True),
            enable_butterworth=data.get("enable_butterworth", True),
            enable_kalman=data.get("enable_kalman", False),
            enable_limb_swap_fix=data.get("enable_limb_swap_fix", True),
            interpolation_method=data.get("interpolation_method", 'pchip'),
            butterworth_cutoff=data.get("butterworth_cutoff", 6.0),
            butterworth_order=data.get("butterworth_order", 4),
            max_gap=data.get("max_gap", 50),
            edge_padding=data.get("edge_padding", 20),
            # 外れ値除去の厳格化パラメータ
            zscore_threshold=data.get("zscore_threshold", 3.5),
            max_velocity=data.get("max_velocity", 3000.0),
            enable_acceleration_check=data.get("enable_acceleration_check", False),
            max_acceleration=data.get("max_acceleration", 50000.0),
            # 左右脚スワップ検出の改善パラメータ
            base_swap_velocity=data.get("base_swap_velocity", 1500.0),
            swap_window_size=data.get("swap_window_size", 5),
            swap_min_consecutive=data.get("swap_min_consecutive", 3),
            enable_crossing_detection=data.get("enable_crossing_detection", True),
            crossing_suppression_threshold=data.get("crossing_suppression_threshold", 0.6),
            # スワップ検出アルゴリズム選択
            swap_detection_method=data.get("swap_detection_method", "global_optimization")
        )

        send_response(request_id, "result", {
            "success": True,
            "frames": filtered_frames
        })
    except ImportError as ie:
        log_debug(f"Import error in handle_filter: {ie}")
        send_response(request_id, "error", {"error": f"Import error: {str(ie)}", "traceback": traceback.format_exc()})
    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})

def handle_consolidate_ids(request_id: str, data: Dict):
    """断片化したIDを統合する（単独実行用）"""
    try:
        from filtering import consolidate_person_ids

        frames = data.get("frames", [])
        fps = data.get("fps", 30.0)

        # パラメータ
        max_gap_seconds = data.get("max_gap_seconds", 2.0)
        max_gap_frames = int(fps * max_gap_seconds)
        distance_threshold = data.get("distance_threshold", 150.0)

        log_debug(f"[ID Consolidation] Starting: gap={max_gap_frames} frames, distance={distance_threshold}px")

        consolidated_frames, id_mapping = consolidate_person_ids(
            frames,
            max_gap_frames=max_gap_frames,
            distance_threshold=distance_threshold
        )

        send_response(request_id, "result", {
            "success": True,
            "frames": consolidated_frames,
            "id_mapping": id_mapping,
            "merged_count": len(id_mapping)
        })
    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})

def handle_video_check(request_id: str, data: Dict):
    """動画ファイルのフォーマットを確認"""
    try:
        file_path = data.get("file_path")
        
        if not file_path or not os.path.exists(file_path):
            send_response(request_id, "error", {"error": "ファイルが見つかりません"})
            return
        
        if file_path in converted_video_cache:
            cached_path = converted_video_cache[file_path]
            if os.path.exists(cached_path):
                send_response(request_id, "result", {
                    "needs_conversion": False,
                    "already_converted": True,
                    "converted_path": cached_path,
                    "video_info": get_video_info(cached_path)
                })
                return
        
        video_info = get_video_info(file_path)
        needs_conv = needs_conversion(video_info)
        
        send_response(request_id, "result", {
            "needs_conversion": needs_conv,
            "already_converted": False,
            "video_info": video_info
        })
    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})

def handle_video_convert(request_id: str, data: Dict):
    """動画を変換"""
    try:
        file_path = data.get("file_path")
        
        if not file_path or not os.path.exists(file_path):
            send_response(request_id, "error", {"error": "ファイルが見つかりません"})
            return
        
        if file_path in converted_video_cache:
            cached_path = converted_video_cache[file_path]
            if os.path.exists(cached_path):
                send_response(request_id, "result", {
                    "success": True,
                    "output_path": cached_path,
                    "cached": True,
                    "video_info": get_video_info(cached_path)
                })
                return
        
        input_path = Path(file_path)
        output_path = input_path.parent / f"{input_path.stem}_converted.mp4"
        
        result = convert_video_to_mp4(file_path, str(output_path))
        
        if result.get("success"):
            converted_video_cache[file_path] = str(output_path)
            send_response(request_id, "result", {
                "success": True,
                "output_path": str(output_path),
                "cached": False,
                "video_info": result.get("output_info")
            })
        else:
            send_response(request_id, "error", {"error": result.get("error", "変換に失敗しました")})
    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})

def handle_export_video(request_id: str, data: Dict):
    """骨格付き動画をエクスポート"""
    try:
        video_path = data.get("video_path")
        keypoints_data = data.get("keypoints_data")
        output_path = data.get("output_path")
        
        if not video_path or not os.path.exists(video_path):
            send_response(request_id, "error", {"error": "動画ファイルが見つかりません"})
            return
        
        frames_data = keypoints_data.get('frames', [])
        
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            send_response(request_id, "error", {"error": "動画の読み込みに失敗しました"})
            return
        
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = int(cap.get(cv2.CAP_PROP_FPS)) or keypoints_data.get('fps', 30)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))
        
        frame_idx = 0
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            
            frame_kpts = None
            for fd in frames_data:
                if fd.get('frame') == frame_idx + 1:
                    frame_kpts = fd.get('keypoints', {})
                    break
            
            if frame_kpts:
                frame = draw_skeleton_on_frame(frame, frame_kpts)
            
            out.write(frame)
            frame_idx += 1
            
            progress = int((frame_idx / total_frames) * 100) if total_frames > 0 else 0
            send_progress(request_id, progress, frame_idx, total_frames)
        
        cap.release()
        out.release()
        
        send_response(request_id, "result", {
            "success": True,
            "output_path": output_path
        })
    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})

def handle_switch_model(request_id: str, data: Dict):
    """モデルとデバイスを切り替え"""
    global model_instance
    try:
        model_type = data.get("model_type", "").lower() or None
        yolo_model = data.get("yolo_model", "") or None
        device = data.get("device", "").lower() or None
        
        if device and device not in ['auto', 'cuda', 'mps', 'cpu']:
            send_response(request_id, "error", {"error": "Invalid device"})
            return
        
        if device:
            config.device = device
            
        def send_loading_progress(progress, message):
            send_response(request_id, "progress", {"progress": progress, "message": message})
        
        model_instance = None
        config.model_loaded = False
        model_loading_complete.clear()
        
        # Load directly
        load_model(progress_callback=send_loading_progress, model_type=model_type, yolo_type=yolo_model)
        
        send_response(request_id, "result", {
            "success": True,
            "models": config.loaded_models,
            "device": config.loaded_models.get('device', detect_device())
        })
    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})

def handle_get_model_info(request_id: str, data: Dict):
    """現在のモデル情報を取得"""
    try:
        models_dir = PROJECT_ROOT / "Models"
        current_device = config.loaded_models.get('device', detect_device()) if config.model_loaded else detect_device()

        # check_onnx_models_available が使えるようにインポート
        if check_onnx_models_available is None:
            try:
                from onnx_vitpose_integration import check_onnx_models_available as _check
                # グローバルには代入しない（他で整合性が崩れるのを防ぐため、ここだけのローカル使用にするか、
                # あるいは ensure_cudnn_paths などを呼ばないとDLLエラーになる可能性もあるが、
                # check_onnx_models_available 自体は glob するだけなので軽量なはず）
                # ただし onnx_vitpose_integration 自体が numpy/cv2 をトップレベルでインポートしているため
                # ここでインポートすると少し時間がかかる。
                # ensure_cudnn_paths は不要（実行しないので）。
                pass
            except ImportError:
                 _check = None
        else:
             _check = check_onnx_models_available

        # 利用可能なViTPoseモデルを検索
        # _check があるならそれを使う（推奨モデル判定ロジックを活用）
        if _check:
             onnx_available = _check(models_dir, device=current_device)
             # _checkの結果から構築
             available = []
             # vitpose
             # ... (logic to convert onnx_available to list) ...
             # しかし既存コードは glob を自前でやっている部分もある?
             # いえ、既存コードは自前でリストを作っている (lines 1125-1128)
             
             # ここでは既存ロジックを生かしつつ、推奨モデル情報を付加するのが筋だが
             # _check を使うと推奨モデルがわかる。
             pass

        # 既存ロジック
        available = []

        # ViTPose ONNX モデル
        vitpose_models = [
            ('h', 'ViTPose-H (ONNX)', ['vitpose-h-wholebody.onnx', 'vitpose-h-wholebody/vitpose-h-wholebody.onnx']),
            ('b', 'ViTPose-B (ONNX)', ['vitpose-b-wholebody.onnx']),
        ]
        for vit_type, model_name, paths in vitpose_models:
            for path in paths:
                if (models_dir / path).exists():
                    available.append({'type': vit_type, 'name': model_name, 'path': path})
                    break

        # SynthPose ONNX モデル（PyTorch不要）
        synthpose_onnx_models = [
            ('synthpose-base-onnx', 'SynthPose-Base (ONNX)', 'synthpose-vitpose-base-hf.onnx'),
            ('synthpose-huge-onnx', 'SynthPose-Huge (ONNX)', 'synthpose-vitpose-huge-hf.onnx'),
        ]
        for sp_type, model_name, filename in synthpose_onnx_models:
            if (models_dir / filename).exists():
                available.append({'type': sp_type, 'name': model_name, 'path': filename})

        # SynthPose PyTorch モデル
        synthpose_models = [
            ('synthpose-base', 'SynthPose-Base (PyTorch)', 'synthpose-vitpose-base-hf.safetensors'),
            ('synthpose-huge', 'SynthPose-Huge (PyTorch)', 'synthpose-vitpose-huge-hf.safetensors'),
        ]
        for sp_type, model_name, filename in synthpose_models:
            if (models_dir / filename).exists():
                available.append({'type': sp_type, 'name': model_name, 'path': filename})

        # デバイスに応じてソート（GPU: H優先、CPU: B優先、SynthPose ONNX → PyTorch の順）
        if current_device == 'cuda':
            type_order = {'h': 0, 'b': 1,
                          'synthpose-base-onnx': 2, 'synthpose-huge-onnx': 3,
                          'synthpose-base': 4, 'synthpose-huge': 5}
        else:
            type_order = {'b': 0, 'h': 1,
                          'synthpose-base-onnx': 2, 'synthpose-huge-onnx': 3,
                          'synthpose-base': 4, 'synthpose-huge': 5}
        available.sort(key=lambda x: type_order.get(x['type'], 99))

        available_yolo = []
        try:
            yolo_files = list(models_dir.glob("yolo*.onnx"))
            available_yolo = [f.name for f in yolo_files]
            available_yolo.sort()
        except:
            pass

        send_response(request_id, "result", {
            "current": config.loaded_models if config.model_loaded else None,
            "current_type": config.loaded_models.get('vitpose_type') if config.model_loaded else None,
            "available": available,
            "available_yolo": available_yolo,
            "device": current_device
        })
    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})

import hashlib

def get_video_hash(video_path: str) -> str:
    hasher = hashlib.md5()
    hasher.update(video_path.encode('utf-8'))
    return hasher.hexdigest()

def handle_extract_frames(request_id: str, data: Dict):
    """動画から全フレームを抽出"""
    global created_temp_dirs
    try:
        video_path = data.get("video_path")
        output_dir = data.get("output_dir")
        quality = data.get("quality", 85)
        
        if not video_path or not os.path.exists(video_path):
            send_response(request_id, "error", {"error": "ファイルが見つかりません"})
            return
        
        if output_dir:
            output_path = Path(output_dir)
        else:
            video_hash = get_video_hash(video_path)
            temp_root = Path(tempfile.gettempdir()) / "hpe_cache"
            output_path = temp_root / video_hash
            output_dir = str(output_path)
            
        output_path.mkdir(parents=True, exist_ok=True)
        
        if output_dir not in created_temp_dirs:
            created_temp_dirs.append(output_dir)
            
        marker_path = output_path / ".complete"
        if marker_path.exists():
            frames = list(output_path.glob("frame_*.jpg"))
            if len(frames) > 0:
                send_response(request_id, "result", {
                    "success": True,
                    "output_dir": output_dir,
                    "total_frames": len(frames)
                })
                return

        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            send_response(request_id, "error", {"error": "動画の読み込みに失敗しました"})
            return
        
        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        
        send_response(request_id, "init", {
            "fps": fps,
            "total_frames": total_frames,
            "width": width,
            "height": height,
            "output_dir": str(output_path)
        })
        
        frame_idx = 0
        extracted_count = 0
        
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            
            frame_file = output_path / f"frame_{frame_idx + 1:05d}.jpg"
            cv2.imwrite(str(frame_file), frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
            
            frame_idx += 1
            extracted_count += 1
            
            if frame_idx % 10 == 0 or frame_idx == total_frames:
                progress = int((frame_idx / total_frames) * 100) if total_frames > 0 else 0
                send_progress(request_id, progress, frame_idx, total_frames)
        
        cap.release()
        (output_path / ".complete").touch()
        
        send_response(request_id, "result", {
            "success": True,
            "output_dir": str(output_path),
            "total_frames": extracted_count,
            "fps": fps,
            "width": width,
            "height": height
        })
    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})

def handle_cleanup(request_id: str, data: Dict):
    """作成した一時ディレクトリを削除"""
    global created_temp_dirs
    deleted_count = 0
    errors = []
    
    for temp_dir in created_temp_dirs[:]:
        try:
            if os.path.exists(temp_dir):
                shutil.rmtree(temp_dir)
                deleted_count += 1
            created_temp_dirs.remove(temp_dir)
        except Exception as e:
            errors.append(f"{temp_dir}: {str(e)}")
            
    send_response(request_id, "result", {
        "success": True,
        "deleted": deleted_count,
        "errors": errors
    })

def handle_export_dataset(request_id: str, data: Dict):
    """学習用データセットをエクスポート"""
    try:
        from server.dataset_exporter import YoloDatasetExporter
        
        video_path = data.get("video_path")
        keypoints_data = data.get("keypoints_data")
        dataset_name = data.get("dataset_name")
        train_ratio = data.get("train_ratio", 0.8)
        output_root_str = data.get("output_root")
        
        if not video_path or not os.path.exists(video_path):
            send_response(request_id, "error", {"error": "動画ファイルが見つかりません"})
            return
            
        if output_root_str:
            output_root = Path(output_root_str)
        else:
            output_root = Path.home() / "Documents" / "HPE_Training_Datasets"
            
        frames_list = keypoints_data.get("frames", [])
        if not frames_list and isinstance(keypoints_data, list):
             frames_list = keypoints_data
             
        export_data = {}
        for f in frames_list:
            f_num = f.get('frame')
            if f_num is not None:
                idx = int(f_num) - 1
                export_data[idx] = f.get('keypoints')
            
        exporter = YoloDatasetExporter(output_root=output_root)
        output_dir, count = exporter.export(
            video_path, 
            export_data, 
            dataset_name=dataset_name, 
            train_ratio=train_ratio
        )
        
        send_response(request_id, "result", {
            "success": True,
            "output_dir": output_dir,
            "frames_count": count
        })
        
    except Exception as e:
        send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})

def handle_get_temp_dir(request_id: str, data: Dict):
    temp_root = Path(tempfile.gettempdir()) / "hpe_cache"
    send_response(request_id, "result", {
        "temp_dir": str(temp_root)
    })

def handle_get_files_info(request_id: str, data: Dict):
    """複数ファイルの情報（フレーム数）を取得"""
    file_paths = data.get("file_paths", [])

    VIDEO_EXTENSIONS = {'.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.3gp', '.asf', '.mpeg', '.mpg'}
    IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'}

    results = []
    total_frames = 0

    for file_path in file_paths:
        path = Path(file_path)
        ext = path.suffix.lower()

        file_info = {
            "path": file_path,
            "name": path.name,
            "frames": 0,
            "type": "unknown"
        }

        try:
            if ext in VIDEO_EXTENSIONS:
                file_info["type"] = "video"
                if FFMPEG_AVAILABLE:
                    video_info = get_video_info(file_path)
                    if "error" not in video_info:
                        duration = video_info.get("duration", 0)
                        fps = video_info.get("fps", 30)
                        frames = int(duration * fps)
                        file_info["frames"] = frames
                        file_info["fps"] = fps
                        file_info["duration"] = duration
            elif ext in IMAGE_EXTENSIONS:
                file_info["type"] = "image"
                file_info["frames"] = 1

            total_frames += file_info["frames"]
        except Exception as e:
            file_info["error"] = str(e)

        results.append(file_info)

    send_response(request_id, "result", {
        "files": results,
        "total_frames": total_frames
    })

ACTION_HANDLERS = {
    "status": handle_status,
    "set_config": handle_set_config,
    "detect_image": handle_detect_image,
    "detect_frame": handle_detect_frame,
    "detect_video": handle_detect_video,
    "cancel_detection": handle_cancel_detection,
    "filter": handle_filter,
    "consolidate_ids": handle_consolidate_ids,
    "video_check": handle_video_check,
    "video_convert": handle_video_convert,
    "export_video": handle_export_video,
    "export_dataset": handle_export_dataset,
    "switch_model": handle_switch_model,
    "get_model_info": handle_get_model_info,
    "extract_frames": handle_extract_frames,
    "cleanup": handle_cleanup,
    "get_temp_dir": handle_get_temp_dir,
    "get_files_info": handle_get_files_info,
}

# 重い処理はワーカースレッドで実行（メインスレッドはstdin読取を継続）
HEAVY_ACTIONS = {"detect_video", "detect_image", "detect_frame", "export_video", "filter", "extract_frames", "export_dataset"}

def process_message(message: Dict):
    request_id = message.get("id", "unknown")
    action = message.get("action")
    data = message.get("data", {})
    
    handler = ACTION_HANDLERS.get(action)
    if handler:
        try:
            handler(request_id, data)
        except Exception as e:
            send_response(request_id, "error", {"error": str(e), "traceback": traceback.format_exc()})
    else:
        # Fallback for lagacy "type" if "action" missing? 
        pass

def main():
    detected_device = detect_device()
    # 検出結果を即座に設定に反映（ロード時の再検出/迷いを防止）
    config.device = detected_device
    
    print(json.dumps({
        "type": "ready",
        "data": {"device": detected_device, "model_loading": False}
    }, ensure_ascii=True), flush=True)
    
    # 自動ロードスレッドは廃止
    # ユーザーが「ポーズ検出」ボタンを押した時に初めてロードする
    config.model_loaded = False

    
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        
        try:
            message = json.loads(line)
            action = message.get("action", "")

            # 重い処理はワーカースレッドで実行（メインスレッドは常にstdin読取を継続）
            if action in HEAVY_ACTIONS:
                threading.Thread(
                    target=process_message,
                    args=(message,),
                    daemon=True
                ).start()
            else:
                # 軽い処理（cancel_detection等）はメインスレッドで即座に実行
                process_message(message)
        except json.JSONDecodeError:
            pass
        except Exception as e:
            log_debug(f"Main loop error: {e}")

if __name__ == "__main__":
    main()
