# 전자문서 AI 요약 — 로컬 LLM(Ollama) 자동 설정 스크립트
#
# 하는 일:
#   1. Ollama 설치 확인 (없으면 winget으로 설치)
#   2. 브라우저 확장이 접근할 수 있도록 OLLAMA_ORIGINS 환경변수 설정
#   3. Ollama 서버 기동 및 모델 다운로드
#   4. API 동작 검증
#
# 사용법 (PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\setup-local-llm.ps1 -ExtensionId <확장ID>
#   powershell -ExecutionPolicy Bypass -File scripts\setup-local-llm.ps1 -ExtensionId <확장ID> -Model gemma4:e2b
#
# 확장 ID는 edge://extensions (또는 chrome://extensions)에서 이 확장의 "ID" 값을 복사한다.
# ID를 주지 않으면 chrome-extension://* 와일드카드로 열리는데, 이는 설치된 **모든** 확장에
# 인증 없는 로컬 LLM을 개방하는 설정이라 권장하지 않는다 (Ollama는 오리진 허용목록이 유일한 접근통제).
param(
    [string]$Model = "qwen3.5:9b",
    [string]$ExtensionId = "",
    [switch]$AllowAnyExtension
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
# Ollama에는 인증이 없다 — OLLAMA_ORIGINS 허용목록이 유일한 접근 통제이므로 이 확장 ID로만 연다.
Step "OLLAMA_ORIGINS 설정 (브라우저 확장 접근 허용)"
if (-not $ExtensionId -and -not $AllowAnyExtension) {
    throw @"
-ExtensionId 가 필요합니다.
  1) edge://extensions 또는 chrome://extensions 를 연다
  2) 개발자 모드를 켜고 '전자문서 AI 요약'의 ID(32자 영문)를 복사한다
  3) 다시 실행: powershell -ExecutionPolicy Bypass -File scripts\setup-local-llm.ps1 -ExtensionId <복사한ID>

모든 확장에 로컬 LLM을 개방해도 괜찮다면 -AllowAnyExtension 을 붙이세요 (권장하지 않음).
"@
}
if ($ExtensionId -and $ExtensionId -notmatch '^[a-p]{32}$') {
    throw "확장 ID 형식이 올바르지 않습니다: $ExtensionId (a~p 32자여야 합니다)"
}
$origin = if ($ExtensionId) { "chrome-extension://$ExtensionId" } else { "chrome-extension://*" }
$cur = [Environment]::GetEnvironmentVariable("OLLAMA_ORIGINS", "User")
if ($cur -split ',' -notcontains $origin) {
    $val = if ($cur) { "$cur,$origin" } else { $origin }
    [Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", $val, "User")
    # 이 스크립트가 아래 3단계에서 Ollama를 다시 띄운다. Start-Process는 사용자 환경변수가 아니라
    # **부모(이 프로세스)의 환경 블록**을 물려주므로, 현재 세션 값도 같이 갱신하지 않으면
    # 새로 뜬 서버가 옛 환경(=허용목록 없음) 그대로 돌아 확장 요청을 403으로 끊는다.
    $env:OLLAMA_ORIGINS = $val
    Write-Host "설정됨: $val"
    # 재시작하여 즉시 적용 — 이름이 정확히 일치하는 프로세스만 (부분 일치는 무관한 프로세스를 죽인다)
    Get-Process -Name "ollama", "ollama app" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
} else {
    # 이 창이 환경변수 설정 이전에 열렸을 수 있다 — 여기서도 세션 값을 맞춰야 재기동한 서버가 물려받는다
    $env:OLLAMA_ORIGINS = $cur
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

# 확장이 실제로 쓰는 경로로 확인한다 — Origin 헤더 없이 부르면 CORS 거부가 안 잡혀
# "설치 성공"이라고 찍고도 확장에서는 403이 난다.
$probe = if ($ExtensionId) { "chrome-extension://$ExtensionId" } else { "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
try {
    Invoke-WebRequest "http://localhost:11434/v1/models" -Headers @{ Origin = $probe } -UseBasicParsing -TimeoutSec 5 | Out-Null
    Write-Host "OK: 확장 오리진 허용 확인 ($probe)"
} catch {
    throw @"
Ollama가 확장 오리진($probe) 요청을 거부했습니다 — 지금 도는 서버에 OLLAMA_ORIGINS가 반영되지 않았습니다.
  1) 작업표시줄 트레이의 Ollama 아이콘 → Quit (창만 닫으면 서버는 계속 돕니다)
  2) 이 스크립트를 다시 실행
"@
}

Write-Host @"

✅ 완료! 이제 확장 옵션에서:
   1. LLM 프로바이더 → '내부 LLM (OpenAI 호환)' 선택
   2. 모델 드롭다운에서 '$Model' 선택 (Base URL은 비워두면 됨)
   3. 저장 후 전자문서 화면에서 ✨ 버튼 클릭
"@ -ForegroundColor Green
