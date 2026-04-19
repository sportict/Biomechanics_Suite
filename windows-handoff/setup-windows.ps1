# ============================================================================
# setup-windows.ps1
#
# 1コマンドで clone + モデル取得 + 全ビルド まで完結させる総合セットアップ
# Claude Desktop に windows-handoff/README.md を読ませた際、
# 最初にこのスクリプトを呼べば良い想定。
#
# 使い方:
#   # 1. 空のフォルダで PowerShell を開いて以下を実行
#   iwr -useb https://raw.githubusercontent.com/sportict/Biomechanics_Suite/main/windows-handoff/setup-windows.ps1 | iex
#
#   # または既にclone済みなら
#   .\windows-handoff\setup-windows.ps1
# ============================================================================

$ErrorActionPreference = "Stop"

function Write-Phase { param($msg) Write-Host "`n==== $msg ====" -ForegroundColor Cyan }
function Write-Warn  { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Die { param($msg) Write-Host "[FATAL] $msg" -ForegroundColor Red; exit 1 }

Write-Phase "Biomechanics Suite Windows セットアップ"

# --- 1. 前提ツール確認 ---
Write-Phase "1. 前提ツール確認"
$tools = @{
    "node"   = "Node.js 20+ (https://nodejs.org/)"
    "npm"    = "Node.js LTS に同梱"
    "git"    = "Git for Windows (https://git-scm.com/)"
    "python" = "Python 3.11 (https://www.python.org/)"
}
$missing = @()
foreach ($t in $tools.GetEnumerator()) {
    if (Get-Command $t.Key -ErrorAction SilentlyContinue) {
        $ver = & $t.Key --version 2>&1 | Select-Object -First 1
        Write-Host "  [OK]   $($t.Key): $ver"
    } else {
        Write-Host "  [MISS] $($t.Key) — $($t.Value)" -ForegroundColor Red
        $missing += $t.Key
    }
}
if ($missing.Count -gt 0) {
    Die "前提ツールが不足しています。windows-handoff/README.md 1章を参照してインストール後に再実行してください。"
}

# vcpkg は MotionDigitizer ビルド時にのみ必要。存在チェックだけ実施。
if (-not (Test-Path "C:\vcpkg\vcpkg.exe")) {
    Write-Warn "C:\vcpkg が見つかりません。MotionDigitizer のビルドは失敗します。"
    Write-Warn "windows-handoff/README.md 1-D を参照して vcpkg + opencv:x64-windows を準備してください。"
    Write-Warn "MotionDigitizer 以外の3アプリは続行します。"
}

# --- 2. リポジトリ取得 ---
Write-Phase "2. リポジトリ取得"
if (Test-Path ".\Biomechanics_Suite") {
    Write-Host "  既存の Biomechanics_Suite フォルダを更新します..."
    Set-Location ".\Biomechanics_Suite"
    git pull origin main
} elseif (Test-Path ".\package.json") {
    Write-Host "  既にリポジトリ内で実行されているようです。pull のみ実行します。"
    git pull origin main
} else {
    Write-Host "  git clone 実行..."
    git clone https://github.com/sportict/Biomechanics_Suite.git
    Set-Location ".\Biomechanics_Suite"
}

$REPO_ROOT = (Get-Location).Path

# --- 3. モデル取得 ---
Write-Phase "3. HPE モデル取得"
$modelsNeeded = @(
    "yolo26m.onnx",
    "rtmpose-m.onnx",
    "rtmpose-m_hand.onnx",
    "rtmpose-x.onnx",
    "synthpose-vitpose-huge-hf.onnx"
)
$allModelsPresent = $true
foreach ($m in $modelsNeeded) {
    if (-not (Test-Path "HPE\Models\$m")) {
        $allModelsPresent = $false
        break
    }
}
if ($allModelsPresent) {
    Write-Host "  全モデルが HPE\Models\ に存在します。スキップ。"
} else {
    Write-Host "  fetch-hpe-models.ps1 を実行してモデルを取得します..."
    & "$REPO_ROOT\windows-handoff\fetch-hpe-models.ps1"
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "モデル取得に失敗しました。HPE のビルドはスキップされます。"
        Write-Warn "他の3アプリは続行します。"
    }
}

# --- 4. 全アプリビルド ---
Write-Phase "4. 全アプリビルド"
& "$REPO_ROOT\windows-handoff\build-all-windows.ps1"

Write-Phase "セットアップ完了"
Write-Host "成果物:"
Get-ChildItem "$REPO_ROOT\*\dist\*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
    $sz = [math]::Round