#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SynthPose safetensors → ONNX 変換スクリプト

使用方法:
    python convert_synthpose_to_onnx.py --size base
    python convert_synthpose_to_onnx.py --size huge
    python convert_synthpose_to_onnx.py --size base --simplify   # onnxsim使用
"""

import argparse
import sys
from pathlib import Path

# プロジェクトルートをパスに追加
ROOT = Path(__file__).parent.parent
MODELS_DIR = ROOT / 'Models'


def convert(model_size: str, simplify: bool = False):
    import torch
    # synthpose_torch_estimatorをインポートするためサーバーディレクトリをパスに追加
    sys.path.insert(0, str(Path(__file__).parent))
    from synthpose_torch_estimator import _build_synthpose_model, load_synthpose_model

    safetensors_map = {
        'base': 'synthpose-vitpose-base-hf.safetensors',
        'huge': 'synthpose-vitpose-huge-hf.safetensors',
    }
    st_path = MODELS_DIR / safetensors_map[model_size]
    onnx_path = MODELS_DIR / f'synthpose-vitpose-{model_size}-hf.onnx'

    if not st_path.exists():
        print(f'[ERROR] Not found: {st_path}')
        sys.exit(1)

    print(f'[Convert] Loading PyTorch model ({model_size})...')
    model, device = load_synthpose_model(
        path=str(st_path),
        model_size=model_size,
        device='cpu',   # ONNX変換はCPUで実施
    )
    model.eval()

    # cls_token を必ずゼロ初期化した nn.Parameter に置き換える
    # safetensors に含まれていない場合、TorchScript exporter が外部ファイルを探してエラーになるため
    try:
        emb = model.backbone.embeddings
        hidden = model.backbone.config.hidden_size
        emb.cls_token = torch.nn.Parameter(torch.zeros(1, 1, hidden))
        print(f'[Convert] cls_token re-initialized as zeros (hidden_size={hidden})')
    except AttributeError as e:
        print(f'[Convert] cls_token init skipped: {e}')

    # ダミー入力 (batch=1, RGB, H=256, W=192)
    dummy = torch.zeros(1, 3, 256, 192, dtype=torch.float32)

    print(f'[Convert] Exporting to ONNX: {onnx_path}')
    torch.onnx.export(
        model,
        dummy,
        str(onnx_path),
        opset_version=17,
        input_names=['input'],
        output_names=['heatmaps'],
        dynamic_axes={
            'input':    {0: 'batch'},
            'heatmaps': {0: 'batch'},
        },
        do_constant_folding=True,
        dynamo=False,   # 旧APIで重みをファイル内に埋め込む
    )
    print(f'[Convert] Saved: {onnx_path}  ({onnx_path.stat().st_size / 1024**2:.1f} MB)')

    # onnxsim による最適化（オプション）
    if simplify:
        try:
            import onnxsim
            import onnx
            print('[Convert] Simplifying with onnxsim...')
            model_onnx = onnx.load(str(onnx_path))
            model_simplified, ok = onnxsim.simplify(model_onnx)
            if ok:
                onnx.save(model_simplified, str(onnx_path))
                print(f'[Convert] Simplified: {onnx_path.stat().st_size / 1024**2:.1f} MB')
            else:
                print('[Convert] onnxsim failed, keeping original.')
        except ImportError:
            print('[Convert] onnxsim not installed. Skipping simplification.')

    # 動作確認
    print('[Convert] Verifying ONNX output...')
    import onnxruntime as ort
    import numpy as np
    sess = ort.InferenceSession(str(onnx_path), providers=['CPUExecutionProvider'])
    dummy_np = np.zeros((1, 3, 256, 192), dtype=np.float32)
    out = sess.run(['heatmaps'], {'input': dummy_np})[0]
    print(f'[Convert] Output shape: {out.shape}  (expected: (1, 52, 64, 48))')
    print('[Convert] Done!')
    return onnx_path


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--size', choices=['base', 'huge'], default='base')
    parser.add_argument('--simplify', action='store_true', help='Run onnxsim after export')
    args = parser.parse_args()
    convert(args.size, args.simplify)
