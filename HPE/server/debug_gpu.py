import sys
print(f"Python: {sys.executable}")

try:
    import torch
    print(f"Torch: {torch.__version__}")
    print(f"Torch CUDA Available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"Torch CUDA Device: {torch.cuda.get_device_name(0)}")
except ImportError:
    print("Torch not installed")

try:
    import onnxruntime as ort
    print(f"ONNX Runtime: {ort.__version__}")
    print(f"ONNX Providers: {ort.get_available_providers()}")
except ImportError:
    print("ONNX Runtime not installed")
