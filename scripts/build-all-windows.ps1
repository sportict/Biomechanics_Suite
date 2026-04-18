# ============================================================================
# build-all-windows.ps1
#
# Windows環境で 4 アプリを一括ビルドするスクリプト
# 前提: Node.js 20+, Python 3.11, VS Build Tools 2022, vcpkg+OpenCV
#       詳細は WINDOWS_HANDOFF.md 1章を参照
# 使い方: リポジトリ直下で `.\scripts\build-all-windows.ps1`
# ============================================================================

$ErrorActionPreference = "Stop"
$REPO_ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $REPO_ROOT

function Write-Step { param($msg) Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Fail { param($msg) Write-Host "[FAIL] $msg" -ForegroundColor Red }

$results = @{}

function Build-App {
    param(
        [string]$Name,
        [string]$Dir,
        [scriptblock]$BuildCmd,
        [string]$ExpectedArtifact
    )
    Write-Step "$Name をビルド中..."
    Push-Location (Join-Path $REPO_ROOT $Dir)
    try {
        & $BuildCmd
        $artifactPath = Join-Path (Join-Path $REPO_ROOT $Dir) "dist\$ExpectedArtifact"
        if (Test-Path $artifactPath) {
            $size = [math]::Round((Get-Item $artifactPath).Length / 1MB, 0)
            Write-Success "$Name : $ExpectedArtifact (${size}MB)"
            $results[$Name] = "OK (${size}MB)"
        } else {
            Write-Fail "$Name : 成果物が見つかりません ($artifactPath)"
            $results[$Name] = "FAILED (no artifact)"
        }
    } catch {
        Write-Fail "$Name : $_"
        $results[$Name] = "FAILED: $_"
    } finally {
        Pop-Location
    }
}

Write-Step "Biomechanics Suite 一括ビルド開始"
Write-Host "作業ディレクトリ: $REPO_ROOT"

# --- 1. MotionViewer(最軽量・純Electron) ---
Build-App -Name "MotionViewer" -Dir "MotionViewer" -ExpectedArtifact "MotionViewer-Setup-1.1.0.exe" -BuildCmd {
    npm install
    npm run build
}

# --- 2. VideoSyncLab(中サイズ・ネイティブ依存あり) ---
Build-App -Name "VideoSyncLab" -Dir "VideoSyncLab" -ExpectedArtifact "VideoSyncLab-Setup-1.0.0.exe" -BuildCmd {
    npm install
    npm run build
}

# --- 3. MotionDigitizer(C++ネイティブ+vcpkg OpenCV) ---
Build-App -Name "MotionDigitizer" -Dir "MotionDigitizer" -ExpectedArtifact "MotionDigitizer-Setup-1.1.0.exe" -BuildCmd {
    npm install
    # C++ネイティブモジュールを先にビルド(binding.gyp経由)
    npm run rebuild:native
    npm run build
}

# --- 4. HPE(Python venv + ONNX モデル同梱) ---
Write-Step "HPE をビルド中(build.bat経由)..."
Push-Location (Join-Path $REPO_ROOT "HPE")
try {
    # Models フォルダ存在確認
    if (-not (Test-Path "Models\yolo26m.onnx") -or -not (Test-Path "Models\rtmpose-x.onnx")) {
        Write-Fail "HPE\Models\ にモデルファイルがありません。WINDOWS_HANDOFF.md 3章を参照して配置してください。"
        $results["HPE"] = "SKIPPED (missing models)"
    } else {
        cmd.exe /c build.bat
        $artifact = Get-ChildItem "dist\*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($artifact) {
            $size = [math]::Round($artifact.Length / 1MB, 0)
            Write-Success "HPE : $($artifact.Name) (${size}MB)"
            $results["HPE"] = "OK (${size}MB)"
        } else {
            Write-Fail "HPE : 成果物が見つかりません"
            $results["HPE"] = "FAILED (no artifact)"
        }
    }
} catch {
    Write-Fail "HPE : $_"
    $results["HPE"] = "FAILED: $_"
} finally {
    Pop-Location
}

# --- サマリ ---
Write-Step "ビルド結果サマリ"
$results.GetEnumerator() | Sort-Object Name | ForEach-Object {
    $icon = if ($_.Value -like "OK*") { "[OK]  " } else { "[!]   " }
    $color = if ($_.Value -like "OK*") { "Green" } else { "Yellow" }
    Write-Host "$icon $($_.Name) : $($_.Value)" -ForegroundColor $color
}

Write-Host "`n成果物は各アプリの dist\ フォルダにあります。"
Write-Host "詳細: Get-ChildItem .\*\dist\*.exe"
