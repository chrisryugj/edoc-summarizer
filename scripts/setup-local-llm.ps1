# 전자문서 AI 요약 — 로컬 LLM(Ollama) 자동 설정 스크립트
#
# 하는 일:
#   1. Ollama 설치 확인 (없으면 winget으로 설치)
#   2. 브라우저 확장이 접근할 수 있도록 OLLAMA_ORIGINS 환경변수 설정
#   3. Ollama 서버 기동 및 모델 다운로드
#   4. API 동작 검증
#
# 사용법 (PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-local-llm.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup-local-llm.ps1 -Model gemma4:e2b
param(
    [string]$Model = "qwen3.5:9b"
)

$ErrorActionPreference = "Stop"
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# 1. Ollama 설치 확인
Step "Ollama 설치 확인"
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
    $exe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
    if (Test-Path $exe) { $ollama = @{ Source = $exe } }
}
if (-not $ollama) {
    Write-Host "Ollama가 없습니다. winget으로 설치합니다..." -ForegroundColor Yellow
    winget install --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
    $ollama = @{ Source = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" }
    if (-not (Test-Path $ollama.Source)) { throw "설치 실패 — https://ollama.com/download 에서 수동 설치 후 재실행하세요." }
}
$exe = $ollama.Source
Write-Host "OK: $exe"

# 2. 확장 접근 허용 (chrome-extension:// 오리진)
Step "OLLAMA_ORIGINS 설정 (브라우저 확장 접근 허용)"
$cur = [Environment]::GetEnvironmentVariable("OLLAMA_ORIGINS", "User")
if ($cur -notlike "*chrome-extension://*") {
    $val = if ($cur) { "$cur,chrome-extension://*" } else { "chrome-extension://*" }
    [Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", $val, "User")
    Write-Host "설정됨: $val (Ollama 재시작 후 적용)"
    # 재시작하여 즉시 적용
    Get-Process | Where-Object { $_.Name -match "ollama" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
} else {
    Write-Host "이미 설정되어 있음: $cur"
}

# 3. 서버 기동 확인 (앱이 안 떠 있으면 실행)
Step "Ollama 서버 확인"
$up = $false
try { Invoke-RestMethod http://localhost:11434/api/tags -TimeoutSec 3 | Out-Null; $up = $true } catch {}
if (-not $up) {
    $app = "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
    if (Test-Path $app) { Start-Process $app } else { Start-Process $exe -ArgumentList "serve" -WindowStyle Hidden }
    foreach ($i in 1..20) {
        Start-Sleep -Seconds 3
        try { Invoke-RestMethod http://localhost:11434/api/tags -TimeoutSec 3 | Out-Null; $up = $true; break } catch {}
    }
}
if (-not $up) { throw "서버가 응답하지 않습니다. Ollama 앱을 직접 실행한 뒤 재실행하세요." }
Write-Host "OK: http://localhost:11434"

# 4. 모델 다운로드
Step "모델 다운로드: $Model (수 GB — 시간이 걸립니다)"
& $exe pull $Model
if ($LASTEXITCODE -ne 0) { throw "모델 다운로드 실패" }

# 5. 검증
Step "검증"
$models = (Invoke-RestMethod http://localhost:11434/v1/models).data | ForEach-Object { $_.id }
Write-Host "설치된 모델: $($models -join ', ')"
if ($models -notcontains $Model) { throw "모델이 목록에 없습니다." }

Write-Host @"

✅ 완료! 이제 확장 옵션에서:
   1. LLM 프로바이더 → '내부 LLM (OpenAI 호환)' 선택
   2. 모델 드롭다운에서 '$Model' 선택 (Base URL은 비워두면 됨)
   3. 저장 후 전자문서 화면에서 ✨ 버튼 클릭
"@ -ForegroundColor Green
