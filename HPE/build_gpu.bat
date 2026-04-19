@echo off
chcp 65001 >nul
REM HPE-GPU Windows ビルドスクリプト
REM
REM 出力: dist\HPE-GPU-Setup-<version>.exe
REM
REM フロー:
REM   1. python_embed_gpu/ を GPU モード (onnxruntime-gpu + CUDA/cuDNN 同梱) で構築
REM   2. npm install
REM   3. ジャンクション python_embed -> python_embed_gpu を一時的に張る
REM   4. electron-builder で HPE-GPU-Setup-*.exe を作成
REM   5. ジャンクションを削除
REM
REM 環境変数:
REM   HPE_SKIP_EMBED_REBUILD=1  既存 python_embed_gpu を再利用 (開発時の高速ビルド)
REM   HPE_USE_STANDARD_NSIS=1   customNsisBinary を無効化 (切り分け用)

setlocal enabledelayedexpansion

cd /d "%~dp0"

echo === HPE-GPU Windows Build ===
echo.

REM ── [1/5] ビルドホストの Python 確認 ──
where python >nul 2>&1
if !errorlevel! neq 0 (
    where python3 >nul 2>&1
    if !errorlevel! neq 0 (
        echo [ERROR] ビルドホストに Python が見つかりません。
        echo         python_embed_gpu の構築には Python 3.11+ が必要です。
        echo         ^(配布先には Python 不要^)
        if not "%HPE_CALLED_FROM_PARENT%"=="1" pause
        exit /b 1
    )
)

REM ── [2/5] python_embed_gpu (GPU モード) ──
set "EMBED_DIR=%~dp0python_embed_gpu"
set "EMBED_PY=%EMBED_DIR%\python.exe"
set "EMBED_MARKER=%EMBED_DIR%\_HPE_BUILD_MODE"

set "DO_REBUILD=1"
if "%HPE_SKIP_EMBED_REBUILD%"=="1" (
    if exist "%EMBED_PY%" (
        if exist "%EMBED_MARKER%" (
            REM マーカーが "Gpu" であることを確認
            set /p EMBED_MODE=<"%EMBED_MARKER%"
            if /i "!EMBED_MODE!"=="Gpu" (
                set "DO_REBUILD=0"
            ) else (
                echo [Info] 既存 python_embed_gpu のビルドモード ^(!EMBED_MODE!^) が不一致のため再ビルドします
            )
        )
    )
)

if "%DO_REBUILD%"=="1" (
    echo [2/5] python_embed_gpu を GPU モードで構築中... ^(初回 5-10 分^)
    powershell -ExecutionPolicy Bypass -File "%~dp0build_python_embed.ps1" -Mode Gpu
    if !errorlevel! neq 0 (
        echo [ERROR] python_embed_gpu の GPU ビルドに失敗しました
        if not "%HPE_CALLED_FROM_PARENT%"=="1" pause
        exit /b 1
    )
) else (
    echo [2/5] python_embed_gpu: 既存の GPU ビルドを再利用
)

REM ── [3/5] npm ──
echo [3/5] npm install ...
REM --silent を外してエラー詳細を表示する
call npm install
if !errorlevel! neq 0 (
    echo.
    echo [ERROR] npm install 失敗 ^(errorlevel=!errorlevel!^)
    echo        詳細は上の npm のエラー出力を参照
    if not "%HPE_CALLED_FROM_PARENT%"=="1" pause
    exit /b 1
)

REM ── [4/5] ジャンクション python_embed -> python_embed_gpu ──
REM electron-builder の extraResources.from は "python_embed" 固定なので、
REM ビルド直前にジャンクション (/J = ディレクトリジャンクション。管理者権限不要) を張る。
set "EMBED_LINK=%~dp0python_embed"
echo [4/5] ジャンクション python_embed -^> python_embed_gpu を作成中...
if exist "%EMBED_LINK%" (
    REM 既存の python_embed があれば削除。
    REM ジャンクションかどうかを判定: fsutil reparsepoint query が成功すればジャンクション。
    fsutil reparsepoint query "%EMBED_LINK%" >nul 2>&1
    if !errorlevel! equ 0 (
        REM ジャンクション -> rmdir で安全に削除できる (中身は消えない)
        rmdir "%EMBED_LINK%"
    ) else (
        echo [WARN] 既存の python_embed が実体ディレクトリです。削除せずに中断します。
        echo        手動で確認してください: %EMBED_LINK%
        if not "%HPE_CALLED_FROM_PARENT%"=="1" pause
        exit /b 1
    )
)
mklink /J "%EMBED_LINK%" "%EMBED_DIR%" >nul
if !errorlevel! neq 0 (
    echo [ERROR] ジャンクション作成に失敗しました
    if not "%HPE_CALLED_FROM_PARENT%"=="1" pause
    exit /b 1
)

REM ── [5/5] electron-builder ──
echo [5/5] HPE-GPU-Setup-*.exe を作成中...
REM
REM 切り分け: HPE_USE_STANDARD_NSIS=1 で customNsisBinary を無効化して標準 NSIS で試す。
REM ただし GPU 版は python_embed ~4GB のため標準 NSIS の 4GB 制限で失敗する可能性あり。
if "%HPE_USE_STANDARD_NSIS%"=="1" (
    echo   [info] HPE_USE_STANDARD_NSIS=1 → customNsisBinary を無効化
    call npm run build:gpu -- --config.nsis.customNsisBinary=null
) else (
    call npm run build:gpu
)
set "BUILD_EXITCODE=!errorlevel!"

REM ── ジャンクション後片付け ──
REM ビルド成否に関わらずジャンクションは削除する (次回ビルドモード切替の衛生上)
if exist "%EMBED_LINK%" (
    fsutil reparsepoint query "%EMBED_LINK%" >nul 2>&1
    if !errorlevel! equ 0 (
        rmdir "%EMBED_LINK%"
        echo ジャンクション python_embed を削除しました
    )
)

if !BUILD_EXITCODE! neq 0 (
    echo [ERROR] electron-builder 失敗
    if not "%HPE_CALLED_FROM_PARENT%"=="1" pause
    exit /b 1
)

echo.
echo === HPE-GPU ビルド完了 ===
dir /b dist\HPE-GPU-*.exe 2>nul

if not "%HPE_CALLED_FROM_PARENT%"=="1" (
    echo.
    echo Enterキーで終了します
    pause >nul
)

endlocal
