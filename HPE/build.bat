@echo off
chcp 65001 >nul
REM HPE Windows ビルドスクリプト
REM
REM デフォルト動作: GPU 版と CPU 版を順番にビルドして 2 つのインストーラを出力
REM   - dist\HPE-GPU-Setup-<version>.exe
REM   - dist\HPE-CPU-Setup-<version>.exe
REM
REM どちらか片方だけ欲しい場合:
REM   build_gpu.bat    ...  GPU 版のみ
REM   build_cpu.bat    ...  CPU 版のみ

setlocal enabledelayedexpansion

cd /d "%~dp0"

echo === HPE Windows Build (GPU + CPU) ===
echo.

REM 子バッチに「親から呼ばれた」ことを通知(子側の pause を抑制)
set "HPE_CALLED_FROM_PARENT=1"

REM ── GPU 版 ──
call "%~dp0build_gpu.bat"
if !errorlevel! neq 0 (
    echo.
    echo [ERROR] HPE-GPU ビルド失敗
    echo.
    pause
    exit /b 1
)

echo.
echo --- CPU 版に進みます ---
echo.

REM ── CPU 版 ──
call "%~dp0build_cpu.bat"
if !errorlevel! neq 0 (
    echo.
    echo [ERROR] HPE-CPU ビルド失敗
    echo.
    pause
    exit /b 1
)

echo.
echo === 全ビルド完了 ===
dir /b dist\HPE-GPU-*.exe 2>nul
dir /b dist\HPE-CPU-*.exe 2>nul

echo.
echo Enterキーで終了します
pause >nul

endlocal
