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

        import glob as _glob

        found_paths = []

        def _add(p):
            p = str(p)
            if p not in found_paths and os.path.isdir(p):
                try:
                    os.add_dll_directory(p)
                except Exception:
                    pass
                found_paths.append(p)

        # 1) pip install nvidia-cudnn-cu12 等でインストールされた DLL パス
        #    .venv/Lib/site-packages/nvidia/*/bin/
        try:
            import site
            for sp in site.getsitepackages():
                nvidia_root = Path(sp) / 'nvidia'
                if nvidia_root.is_dir():
                    for bin_dir in nvidia_root.glob('*/bin'):
                        _add(bin_dir)
        except Exception as _e:
            print(f"[CUDNN] pip nvidia path search failed: {_e}", file=sys.stderr)

        # 2) システム CUDNN インストール (cuDNN 9.x は bin\<cuda_ver>\ サブディレクトリ)
        system_cudnn_root = r"C:\Program Files\NVIDIA\CUDNN"
        if os.path.isdir(system_cudnn_root):
            # v*\bin\** 以下の cudnn64_*.dll が存在するディレクトリを再帰検索
            for dll in _glob.glob(os.path.join(system_cudnn_root, 'v*', 'bin', '**', 'cudnn64_*.dll'), recursive=True):
                _add(Path(dll).parent)
            # v*\bin\ 直下も念のため追加 (cuDNN 8.x 形式)
            for bin_dir in _glob.glob(os.path.join(system_cudnn_root, 'v*', 'bin')):
                _add(bin_dir)

        # PATH環境変数にも追加
        if found_paths:
            os.environ['PATH'] = os.pathsep.join(found_paths) + os.pathsep + os.environ['PATH']
            print(f"[CUDNN] Added DLL paths: {found_paths}", file=sys.stderr)
        else:
            print("[CUDNN] No cuDNN DLL paths found", file=sys.stderr)

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

def _get_available_models_list(models_dir: Path) -> list:
    """Models/ に存在する rtmpose モデルのリストを返す"""
    result = []
    for name in ('rtmpose-x', 'rtmpose-m'):
        if (models_dir / f"{name}.onnx").exists():
            result.append(name)
    return result


def _load_model_internal(progress_callback=None, model_type=None, yolo_type=None, progress=0, message=None):
    """モデルをロード (ONNX / SynthPose PyTorch) - Internal Implementation"""
    global model_instance

    def report(p, msg):
        if progress_callback:
            progress_callback(p, msg)
        else:
            report_progress(p, msg)

    report(progress, message or "初期化中...")

    # 遅延ロードとCUDNNパス設定
    ensure_cudnn_paths()

    # model_type 未指定時: デバイスに応じてデフォルトプリセットを自動選択
    #
    # M5 ベンチマーク結果 (2026-04):
    #   YOLO: CoreMLはCPUより遅い (パーティション分割+転送コスト) → 全デバイスでCPU実行
    #     yolo11s CPU: 42ms,  yolox_x CPU: 271ms  → yolo11s が最速
    #   RTMPose: CoreMLで5倍高速 → mps時はCoreML
    #     rtmpose-x CoreML: 10ms vs CPU: 52ms
    #
    # mps  → rtmpose-x(CoreML) + yolo11s(CPU最速)
    # cuda → rtmpose-x(CUDA)   + yolo11x(CUDA)
    # cpu  → rtmpose-m(CPU)    + yolo11s(CPU)
    if model_type is None:
        _auto_device = detect_device()
        _models_dir = PROJECT_ROOT / "Models"

        def _pick_yolo(*names):
            """存在するファイルを先頭から優先して返す。どれもなければ先頭名を返す。"""
            for n in names:
                if (_models_dir / n).exists():
                    return n
            return names[0]

        if _auto_device in ('cuda', 'directml', 'dml', 'mps') and (_models_dir / 'rtmpose-x.onnx').exists():
            model_type = 'rtmpose-x'
            if yolo_type is None:
                # YOLO26m を全デバイスで統一（mAP=53.4, M5 CPU 97ms）
                yolo_type = _pick_yolo('yolo26m.onnx', 'yolo26x.onnx', 'yolo11x.onnx', 'yolo11s.onnx')
        else:
            model_type = 'rtmpose-m'
            if yolo_type is None:
                yolo_type = _pick_yolo('yolo26m.onnx', 'yolo26s.onnx', 'yolo11s.onnx')
        print(json.dumps({"type": "log", "data": f"[AutoPreset] device={_auto_device} → model={model_type}, yolo={yolo_type}"}), flush=True)

    # mps デバイスで旧来の大型YOLOが明示指定された場合、yolo26m に自動切替
    # ベンチマーク (M5 CPU): yolox_x 271ms, yolo11x 232ms, yolo26m 97ms
    _MPS_SLOW_YOLO = {'yolo11x.onnx', 'yolo11l.onnx', 'yolo11m.onnx',
                      'yolo26x.onnx', 'yolo26l.onnx',
                      'yolox_x.onnx', 'yolox_m.onnx'}
    if (yolo_type is not None
            and Path(yolo_type).name in _MPS_SLOW_YOLO
            and detect_device() == 'mps'):
        _models_dir = PROJECT_ROOT / "Models"
        _better = _pick_yolo('yolo26m.onnx', 'yolo11s.onnx')
        if (_models_dir / _better).exists() and _better != Path(yolo_type).name:
            print(json.dumps({"type": "log", "data":
                f"[AutoSwitch] {Path(yolo_type).name} → {_better} に自動切替"}), flush=True)
            yolo_type = _better

    # ========== RTMPose Branch ==========
    if model_type in ('rtmpose-x', 'rtmpose-m'):
        models_dir = PROJECT_ROOT / "Models"
        current_device = detect_device()
        body_model_file = f"{model_type}.onnx"

        report(progress + 10, f"{model_type.upper()} モデルを確認中...")
        from rtmpose_estimator import load_rtmpose_estimator

        # GPU→CPU フォールバック: 指定デバイスで失敗したら CPU で再試行する。
        # これにより Windows で CUDA ランタイムが不完全な環境でも
        # 「推定できない」状態にならず CPU モードで続行できる。
        def _try_load(_device):
            report(progress + 20, f"{model_type.upper()} モデルをロード中... ({_device})")
            return load_rtmpose_estimator(
                models_dir=models_dir,
                yolo_type=yolo_type,
                device=_device,
                body_model=body_model_file,
                yolo_size=config.yolo_size,
                conf_threshold=config.confidence_threshold,
                log_func=log_debug,
                progress_callback=report,
            )

        try:
            model_instance, vitpose_name, actual_device = _try_load(current_device)
            current_device = actual_device
        except Exception as e:
            error_msg = str(e)
            log_debug(f"RTMPose load error on {current_device}: {error_msg}")
            if current_device != 'cpu':
                log_debug(f"RTMPose: {current_device} でのロード失敗 → CPU にフォールバックして再試行")
                try:
                    model_instance, vitpose_name, actual_device = _try_load('cpu')
                    current_device = actual_device
                except Exception as e2:
                    log_debug(f"RTMPose CPU fallback also failed: {e2}")
                    raise RuntimeError(f"RTMPose loading failed (both {current_device} and CPU): {e2}")
            else:
                raise RuntimeError(f"RTMPose loading failed: {error_msg}")

        available_yolo = []
        try:
            yolo_files = list((PROJECT_ROOT / "Models").glob("yolo*.onnx"))
            available_yolo = [f.name for f in yolo_files]
            available_yolo.sort()
        except Exception as e:
            log_debug(f"Failed to list YOLO models: {e}")

        report(90, "モデル初期化完了...")

        # プロバイダー情報をログ出力（YOLO は意図的に CPU 実行）
        load_warnings = []
        try:
            active_providers = model_instance.get_active_providers()
            yolo_providers = active_providers.get('yolo', [])
            body_providers = active_providers.get('vitpose', [])
            log_debug(f"[Info] YOLO providers: {yolo_providers}")
            log_debug(f"[Info] RTMPose providers: {body_providers}")
            # M5 ベンチマーク結果: YOLO は CoreML より CPU の方が速い（パーティション分割コスト）
            # そのため mps 時の YOLO CPU 実行は意図的な最適化であり、警告は不要
            if current_device in ('cuda', 'directml', 'dml') and yolo_providers == ['CPUExecutionProvider']:
                yolo_model_name = Path(yolo_type).name if yolo_type else "YOLO"
                warn_msg = f"YOLO 検出器が CPU で動作しています（{yolo_model_name} の CUDA ロードに失敗）。"
                load_warnings.append(warn_msg)
                log_debug(f"[Warning] {warn_msg}")
        except Exception as e:
            log_debug(f"[Warning] provider check failed: {e}")

        config.model_loaded = True
        config.loaded_models = {
            "vitpose":          vitpose_name,
            "vitpose_type":     model_type,
            "available_models": _get_available_models_list(models_dir),
            "yolo":             Path(yolo_type).name if yolo_type else "auto",
            "yolo_model":       Path(yolo_type).name if yolo_type else "auto",
            "available_yolo":   available_yolo,
            "device":           current_device,
            "warnings":         load_warnings,
        }

        report(100, "完了")
        model_loading_complete.set()
        return model_instance
    # ========== End RTMPose Branch ==========

    # ========== SynthPose ONNX Branch ==========
    # 対応モデル例: 'synthpose-huge-onnx', 'synthpose-base-onnx'
    #   → Models/synthpose-vitpose-{size}-hf.onnx をロード
    if isinstance(model_type, str) and model_type.startswith('synthpose-') and model_type.endswith('-onnx'):
        models_dir = PROJECT_ROOT / "Models"
        current_device = detect_device()

        # 'synthpose-huge-onnx' → size='huge'
        model_size = model_type[len('synthpose-'):-len('-onnx')]
        if not model_size:
            raise ValueError(f"Invalid synthpose model_type: {model_type}")

        report(progress + 10, f"SynthPose-{model_size} モデルを確認中...")
        from synthpose_onnx_estimator import load_synthpose_onnx_estimator

        # GPU→CPU フォールバック
        def _try_load_sp(_device):
            report(progress + 20, f"SynthPose-{model_size} モデルをロード中... ({_device})")
            return load_synthpose_onnx_estimator(
                models_dir=models_dir,
                model_size=model_size,
                yolo_type=yolo_type,
                device=_device,
                yolo_size=config.yolo_size,
                conf_threshold=config.confidence_threshold,
                log_func=log_debug,
            )

        try:
            model_instance, vitpose_name, actual_device = _try_load_sp(current_device)
            current_device = actual_device
        except Exception as e:
            error_msg = str(e)
            log_debug(f"SynthPose load error on {current_device}: {error_msg}")
            if current_device != 'cpu':
                log_debug(f"SynthPose: {current_device} でのロード失敗 → CPU にフォールバックして再試行")
                try:
                    model_instance, vitpose_name, actual_device = _try_load_sp('cpu')
                    current_device = actual_device
                except Exception as e2:
                    log_debug(f"SynthPose CPU fallback also failed: {e2}")
                    raise RuntimeError(f"SynthPose loading failed (both {current_device} and CPU): {e2}")
            else:
                raise RuntimeError(f"SynthPose loading failed: {error_msg}")

        available_yolo = []
        try:
            yolo_files = list((PROJECT_ROOT / "Models").glob("yolo*.onnx"))
            available_yolo = [f.name for f in yolo_files]
            available_yolo.sort()
        except Exception as e:
            log_debug(f"Failed to list YOLO models: {e}")

        report(90, "モデル初期化完了...")

        # プロバイダー情報をログ出力（CoreML使用可否の確認用）
        load_warnings = []
        try:
            active_providers = model_instance.get_active_providers()
            yolo_providers = active_providers.get('yolo', [])
            vit_providers  = active_providers.get('vitpose', [])
            log_debug(f"[Info] YOLO providers: {yolo_providers}")
            log_debug(f"[Info] SynthPose providers: {vit_providers}")
            if current_device == 'mps' and vit_providers and 'CoreMLExecutionProvider' not in vit_providers[0]:
                # ViTPose の transformer op は CoreML が対応しきれずCPUフォールバックする既知の挙動
                warn_msg = "SynthPose は CoreML ではなく CPU で動作しています（ViTPose op が一部非対応）。"
                load_warnings.append(warn_msg)
                log_debug(f"[Warning] {warn_msg}")
        except Exception as e:
            log_debug(f"[Warning] provider check failed: {e}")

        config.model_loaded = True
        config.loaded_models = {
            "vitpose":          vitpose_name,
            "vitpose_type":     model_type,
            "available_models": _get_available_models_list(models_dir),
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

    raise ValueError(f"Unsupported model_type: {model_type}")



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

        # 信頼度閾値の一時変更（フレーム再推定で使用）
        confidence_threshold = data.get("confidence_threshold")
        original_threshold = None
        if confidence_threshold is not None:
            original_threshold = model.detector.conf_threshold
            model.detector.conf_threshold = float(confidence_threshold)

        try:
            frame_keypoints = model.inference(img_rgb)
        finally:
            if original_threshold is not None:
                model.detector.conf_threshold = original_threshold
        
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

        # Google Drive / 日本語パス対応: 一時パスにコピー
        _actual_path = file_path
        _temp_copy = None
        try:
            _has_non_ascii = any(ord(c) > 127 for c in file_path)
            _is_network = any(seg in file_path for seg in ['CloudStorage', 'GoogleDrive', 'OneDrive', 'Dropbox'])
            if _has_non_ascii or _is_network:
                _suffix = os.path.splitext(file_path)[1]
                _fd, _temp_copy = tempfile.mkstemp(prefix="hpe_redet_", suffix=_suffix)
                os.close(_fd)
                import shutil
                shutil.copy2(file_path, _temp_copy)
                _actual_path = _temp_copy
        except Exception:
            _actual_path = file_path
            _temp_copy = None

        # 動画を開いてフレームを取得
        cap = cv2.VideoCapture(_actual_path)
        if not cap.isOpened():
            if _temp_copy and os.path.exists(_temp_copy):
                os.remove(_temp_copy)
            send_response(request_id, "error", {"error": "動画を開けませんでした"})
            return

        # フレーム番号に移動（0-indexed）
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_number - 1)
        ret, frame = cap.read()
        cap.release()

        # 一時ファイルを削除
        if _temp_copy and os.path.exists(_temp_copy):
            try:
                os.remove(_temp_copy)
            except Exception:
                pass

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

    # 受信ログ（フロントエンドのDevToolsコンソールに表示される）
    log_debug(f"[detect_video] 開始 request_id={request_id[:8]}... file={data.get('file_path','?')}")

    # 既に別のリクエストが実行中の場合はキャンセルして待機
    if current_detection_request_id is not None and current_detection_request_id != request_id:
        log_debug(f"[detect_video] 別リクエスト実行中 ({current_detection_request_id[:8]}...) → キャンセル後に続行")
        cancel_detection_flag.set()
        import time as _time_mod
        _wait = 0
        while current_detection_request_id is not None and _wait < 30:
            _time_mod.sleep(0.1)
            _wait += 1
        log_debug(f"[detect_video] 前リクエスト終了確認 ({_wait * 100}ms待機)")

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

        # Google Drive / 日本語パス対応: まず一時パスにコピーしてから開く
        _actual_path = file_path
        _temp_copy_path = None
        try:
            import unicodedata
            _has_non_ascii = any(ord(c) > 127 for c in file_path)
            _is_network_mount = any(seg in file_path for seg in ['CloudStorage', 'GoogleDrive', 'OneDrive', 'Dropbox'])
            if _has_non_ascii or _is_network_mount:
                import shutil
                _suffix = os.path.splitext(file_path)[1]
                _tmp_fd, _temp_copy_path = tempfile.mkstemp(prefix="hpe_video_", suffix=_suffix)
                os.close(_tmp_fd)
                log_debug(f"[detect_video] 日本語/ネットワークパス検出 → 一時ファイルにコピー中...")
                shutil.copy2(file_path, _temp_copy_path)
                _actual_path = _temp_copy_path
                log_debug(f"[detect_video] コピー完了: {_temp_copy_path}")
        except Exception as _copy_err:
            log_debug(f"[detect_video] 一時コピー失敗 ({_copy_err})、元パスで続行")
            _actual_path = file_path
            _temp_copy_path = None

        cap = cv2.VideoCapture(_actual_path)
        if not cap.isOpened():
            if _temp_copy_path and os.path.exists(_temp_copy_path):
                os.remove(_temp_copy_path)
            send_response(request_id, "error", {"error": "動画の読み込みに失敗しました"})
            return

        fps = int(cap.get(cv2.CAP_PROP_FPS))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        log_debug(f"[detect_video] VideoCapture OK: fps={fps}, total_frames={total_frames}, size={width}x{height}")

        frame_output_dir = None
        if extract_frames:
            frame_output_dir = tempfile.mkdtemp(prefix="hpe_frames_")

        send_response(request_id, "init", {
            "fps": fps,
            "total_frames": total_frames,
            "frame_skip": frame_skip
        })

        model = get_model()
        if model is None:
            log_debug("[detect_video] モデルのロードに失敗しました。再試行してください。")
            send_response(request_id, "error", {"error": "モデルが未ロードです。アプリを再起動してください。"})
            return
        log_debug(f"[detect_video] モデル取得OK: {type(model).__name__}")
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

        # FPS適応型距離閾値（正規化値）
        # 人間の最大移動速度を 3000px/秒 と仮定し、1フレームの最大許容移動量を算出。
        # Norfair は max(height, width) で正規化するため同じ値で除算する。
        #   例: 60fps  → 3000/60  = 50px/frame → 50/1920 ≈ 0.026
        #       240fps → 3000/240 = 12.5px/frame → 12.5/1920 ≈ 0.0065
        _max_dim = max(width, height)
        _max_px_per_frame = 3000.0 / fps
        dist_thresh = float(np.clip(_max_px_per_frame / _max_dim, 0.005, 0.4))

        log_debug(f"Tracker Init: Resolution={width}x{height}, FPS={fps:.1f}, "
                  f"HitMax={hit_max}, DistThresh={dist_thresh:.4f} ({_max_px_per_frame:.1f}px/frame)")

        # initialization_delay=0 にして、即座に安定IDを割り当てる（Raw IDとの入れ替わり防止）
        norfair_tracker.reset(
            height=height,
            width=width,
            initialization_delay=0,
            hit_counter_max=hit_max,
            distance_threshold=dist_thresh,
        )
        all_results = []
        last_keypoints = {}

        # JPEG書き出し用スレッドプール（メインスレッドをブロックしない）
        from concurrent.futures import ThreadPoolExecutor
        _jpeg_pool = ThreadPoolExecutor(max_workers=2) if (extract_frames and frame_output_dir) else None
        _jpeg_futures = []
        _jpeg_params = [cv2.IMWRITE_JPEG_QUALITY, frame_quality]

        frame_idx = 0
        _first_read_logged = False
        while cap.isOpened():
            # キャンセルチェック
            if cancel_detection_flag.is_set():
                log_debug(f"Detection cancelled at frame {frame_idx}")
                was_cancelled = True
                break

            ret, frame = cap.read()
            if not _first_read_logged:
                _first_read_logged = True
                log_debug(f"[detect_video] 第1フレーム読み取り: ret={ret}, frame={'OK' if frame is not None else 'None'}")
            if not ret:
                log_debug(f"[detect_video] cap.read() failed at frame_idx={frame_idx} (total={total_frames})")
                break

            # JPEG書き出し: バックグラウンドスレッドで非同期実行
            if _jpeg_pool is not None:
                _fn = os.path.join(frame_output_dir, f"frame_{frame_idx + 1:05d}.jpg")
                # frame をコピーしてスレッドに渡す（cap.read() が上書きする可能性）
                _jpeg_futures.append(_jpeg_pool.submit(cv2.imwrite, _fn, frame.copy(), _jpeg_params))

            if frame_skip <= 1 or frame_idx % frame_skip == 0:
                # BGR を直接渡す（rtmpose_estimator 内で YOLO用はそのまま使用し、
                # RTMPose 用のみ BGR→RGB に 1 回変換する）
                frame_results = model.inference(frame)

                # YOLO bbox をキーとして渡す → NorfairがYOLO bbox中心でトラッキング
                tracking_data = {}
                for person_id, pdata in frame_results.items():
                    if isinstance(pdata, dict):
                        tracking_data[str(person_id)] = {
                            'keypoints': pdata['keypoints'],
                            'bbox': pdata.get('bbox')
                        }
                    else:
                        tracking_data[str(person_id)] = pdata

                # stable_id → raw HALPE keypoints
                stable_raw = norfair_tracker.track(tracking_data)

                # 安定IDが確定した後に出力フォーマットへ変換
                stable_keypoints = {pid: convert_kpts(kpts) for pid, kpts in stable_raw.items()}
                last_keypoints = stable_keypoints

                frame_result = {
                    "frame": frame_idx + 1,
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

        # JPEG書き出し完了を待機
        if _jpeg_pool is not None:
            _jpeg_pool.shutdown(wait=True)

        # 一時コピーファイルを削除
        if _temp_copy_path and os.path.exists(_temp_copy_path):
            try:
                os.remove(_temp_copy_path)
            except Exception:
                pass

        log_debug(f"[detect_video] フレームループ完了: frame_idx={frame_idx}, all_results={len(all_results)}, cancelled={was_cancelled}")

        # 推定直後にID統合を実行（断片化したIDを統合）
        id_mapping = {}
        if len(all_results) > 0 and not was_cancelled:
            try:
                from filtering import consolidate_person_ids
                max_gap_frames = int(fps * 2.0)  # 2秒分のギャップまで統合
                # 解像度に応じた距離閾値（画像対角線の15%）
                _diag = (width**2 + height**2) ** 0.5
                distance_threshold = _diag * 0.15
                all_results, id_mapping = consolidate_person_ids(
                    all_results,
                    max_gap_frames=max_gap_frames,
                    distance_threshold=distance_threshold,
                )
                if id_mapping:
                    log_debug(f"[Detect] ID consolidation: merged {len(id_mapping)} IDs")
            except Exception as e:
                log_debug(f"[Detect] ID consolidation failed: {e}")

        # 検出ギャップ補間: YOLO が失敗したフレームを前後から線形補間
        if len(all_results) > 0 and not was_cancelled:
            try:
                from filtering import fill_detection_gaps
                max_gap = int(fps * 0.5)  # 0.5秒以内のギャップを補間
                all_results = fill_detection_gaps(all_results, max_gap_frames=max_gap)
            except Exception as e:
                log_debug(f"[Detect] Gap fill failed: {e}")

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
        
        if device and device not in ['auto', 'cuda', 'directml', 'dml', 'mps', 'cpu']:
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

        # RTMPose モデルのみを検出
        available = []
        rtmpose_models = [
            ('rtmpose-x', 'RTMPose-X (高精度)', 'rtmpose-x.onnx'),
            ('rtmpose-m', 'RTMPose-M (高速)', 'rtmpose-m.onnx'),
        ]
        for model_type, model_name, filename in rtmpose_models:
            if (models_dir / filename).exists():
                available.append({'type': model_type, 'name': model_name, 'path': filename})

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
        "data": {"device": detected_device, "model_loading": True}
    }, ensure_ascii=True), flush=True)

    # ready 送信後にバックグラウンドでモデルをプリロード開始
    # → ユーザーが操作する前にロードが完了しやすくなる
    threading.Thread(target=load_model, daemon=True).start()

    
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
