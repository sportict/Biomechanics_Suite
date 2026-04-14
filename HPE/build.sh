#!/bin/bash
# HPE macOS ビルドスクリプト
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== HPE macOS Build ==="
echo ""

# Python バージョン確認
PYTHON=$(command -v python3.11 || command -v python3 || echo "")
if [ -z "$PYTHON" ]; then
  echo "[ERROR] Python3 が見つかりません"
  exit 1
fi
echo "[1/4] Python: $($PYTHON --version)"

# 仮想環境のセットアップ
VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "[2/4] 仮想環境を作成中..."
  $PYTHON -m venv "$VENV_DIR"
else
  echo "[2/4] 仮想環境: $VENV_DIR (既存)"
fi

VENV_PYTHON="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"

# Apple Silicon かどうかを確認
ARCH=$(uname -m)
echo "       アーキテクチャ: $ARCH"

# 依存パッケージのインストール
echo "[3/4] Python依存パッケージをインストール中..."
$VENV_PIP install --upgrade pip --quiet

# rtmlib をローカルからインストール
if [ -d "$SCRIPT_DIR/rtmlib" ]; then
  $VENV_PIP install "$SCRIPT_DIR/rtmlib" --no-deps --quiet
fi

# requirements.txt からインストール（torch は任意）
$VENV_PIP install \
  fastapi uvicorn python-multipart \
  "numpy>=1.24.0,<2.0.0" \
  "opencv-python>=4.8.0" \
  "Pillow>=10.0.0" \
  "tqdm>=4.66.0" \
  "scipy>=1.11.0" \
  "filterpy>=1.4.0" \
  "ffmpeg-python>=0.2.0" \
  "norfair>=2.2.0" \
  --quiet

# Apple Silicon では onnxruntime-silicon を優先
if [ "$ARCH" = "arm64" ]; then
  echo "       Apple Silicon: onnxruntime-silicon をインストール中..."
  $VENV_PIP install onnxruntime-silicon --quiet 2>/dev/null || \
    $VENV_PIP install onnxruntime --quiet
else
  $VENV_PIP install onnxruntime --quiet
fi

echo ""

# Electron アプリのビルド
echo "[4/4] Electron アプリをビルド中..."
npm install --silent
npm run build:mac

echo ""
echo "=== ビルド完了 ==="
echo "出力先: $SCRIPT_DIR/dist/"
ls "$SCRIPT_DIR/dist/"
