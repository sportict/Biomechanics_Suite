@echo off
REM HPE Windows ビルドスクリプト (.venv 統一版)
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo === HPE Windows Build ===
echo.

REM Python 確認
set PYTHON=
where python >nul 2>&1
if !errorlevel! equ 0 (
    set "PYTHON=python"
) else (
    where python3 >nul 2>&1
    if !errorlevel! equ 0 (
        set "PYTHON=python3"
    ) else (
        echo [ERROR] Python が見つかりません。Python 3.11+ をインストールしてください。
        exit /b 1
    )
)

for /f "tokens=*" %%i in ('%PYTHON% --version 2^>^&1') do echo [1/4] %%i

REM 仮想環境のセットアップ
if not exist ".venv\Scripts\python.exe" (
    echo [2/4] 仮想環境を作成中...
    %PYTHON% -m venv .venv
) else (
    echo [2/4] 仮想環境: .venv (既存^)
)

set "VENV_PYTHON=.venv\Scripts\python.exe"
set "VENV_PIP=.venv\Scripts\pip.exe"

REM 依存パッケージのインストール
echo [3/4] Python依存パッケージをインストール中...
%VENV_PIP% install --upgrade pip --quiet

REM rtmlib をローカルからインストール
if exist "rtmlib" (
    %VENV_PIP% install "./rtmlib" --no-deps --quiet 2>nul
)

%VENV_PIP% install ^
    fastapi uvicorn python-multipart ^
    "numpy>=1.24.0,<2.0.0" ^
    "opencv-python>=4.8.0" ^
    "onnxruntime-gpu>=1.18.0" ^
    "Pillow>=10.0.0" ^
    "tqdm>=4.66.0" ^
    "scipy>=1.11.0" ^
    "filterpy>=1.4.0" ^
    "ffmpeg-python>=0.2.0" ^
    "norfair>=2.2.0" ^
    --quiet

echo.

REM npm 依存パッケージ + ビルド
echo [4/4] Electron アプリをビルド中...
call npm install --silent
call npm run build

echo.
echo === ビルド完了 ===
echo 出力先: %~dp0dist\
dir /b dist\*.exe 2>nul

endlocal
