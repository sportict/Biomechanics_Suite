# ============================================================================
# fetch-hpe-models.ps1
#
# HPE/Models/ に必要な ONNX モデルをダウンロードする
#
# 優先順位:
#   1. GitHub Releases の添付アセット(環境変数 MODEL_RELEASE_URL が設定されている場合)
#   2. HuggingFace から SynthPose のみ自動変換(他モデルはスキップ警告)
#
# 使い方: `.\scripts\fetch-hpe-models.ps1`
# ============================================================================

$ErrorActionPreference = "Stop"
$REPO_ROOT = Split-Path -Parent $PSScriptRoot
$MODELS_DIR = Join-Path $REPO_ROOT "HPE\Models"

New-Item -ItemType Directory -Force -Path $MODELS_DIR | Out-Null

# 必須モデル一覧(ファイル名 -> 概算サイズ[MB])
$REQUIRED_MODELS = @{
    "yolo26m.onnx"                       = 78
    "rtmpose-m.onnx"                     = 53
    "rtmpose-m_hand.onnx"                = 53
    "rtmpose-x.onnx"                     = 191
    "synthpose-vitpose-huge-hf.onnx"     = 1228
}

# GitHub Releases のベースURL(未設定時は $null のまま)
# 例: "https://github.com/sportict/Biomechanics_Suite/releases/download/models-v1"
$RELEASE_BASE = $env:MODEL_RELEASE_URL
if (-not $RELEASE_BASE) {
    $RELEASE_BASE = "https://github.com/sportict/Biomechanics_Suite/releases/download/models-v1"
}

function Test-ModelPresent {
    param($Name, $ExpectedMB)
    $path = Join-Path $MODELS_DIR $Name
    if (-not (Test-Path $path)) { return $false }
    $sizeMB = [math]::Round((Get-Item $path).Length / 1MB, 0)
    # 期待サイズの 90% 以上なら OK とみなす(完全一致でなくても良い)
    return ($sizeMB -ge [math]::Floor($ExpectedMB * 0.9))
}

function Download-Model {
    param($Name)
    $url = "$RELEASE_BASE/$Name"
    $dest = Join-Path $MODELS_DIR $Name
    Write-Host "  [DL] $Name ..." -NoNewline
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
        Write-Host " done" -ForegroundColor Green
        return $true
    } catch {
        Write-Host " FAILED ($_)" -ForegroundColor Red
        Remove-Item $dest -ErrorAction SilentlyContinue
        return $false
    }
}

Write-Host "=== HPE Models Fetch ===" -ForegroundColor Cyan
Write-Host "Destination: $MODELS_DIR"
Write-Host "Release base: $RELEASE_BASE"
Write-Host ""

$missing = @()
$failed = @()

foreach ($model in $REQUIRED_MODELS.GetEnumerator() | Sort-Object Name) {
    $name = $model.Key
    $expected = $model.Value

    if (Test-ModelPresent -Name $name -ExpectedMB $expected) {
        Write-Host "  [SKIP] $name (already present)" -ForegroundColor Gray
        continue
    }

    $ok = Download-Model -Name $name
    if (-not $ok) {
        $missing += $name
        $failed += $name
    }
}

Write-Host ""
if ($failed.Count -eq 0) {
    Write-Host "[OK] 全モデル取得完了" -ForegroundColor Green
    Get-ChildItem "$MODELS_DIR\*.onnx" | ForEach-Object {
        $sz = [math]::Round($_.Length / 1MB, 0)
        Write-Host ("  {0,-40} {1}MB" -f $_.Name, $sz)
    }
    exit 0
}

Write-Host "[WARN] 以下のモデルが取得できませんでした:" -ForegroundColor Yellow
foreach ($m in $failed) { Write-Host "  - $m" }
Write-Host ""
Write-Host "フォールバック手順:" -ForegroundColor Yellow
Write-Host "  1. macOS マシンから HPE\Models\ を USB 等でコピー(WINDOWS_HANDOFF.md 3-A)"
Write-Host "  2. SynthPose のみ生成する場合: "
Write-Host "       cd HPE && python server\convert_synthpose_to_onnx.py --size huge"
Write-Host "  3. GitHub Releases に手動アップロード後、環境変数で再試行:"
Write-Host "       `$env:MODEL_RELEASE_URL = 'https://.../download/models-v1'"
Write-Host "       .\scripts\fetch-hpe-models.ps1"

exit 1
