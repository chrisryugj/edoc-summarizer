# 전자문서 AI 요약 — kordoc 헬퍼 자동 설정 스크립트
#
# 하는 일:
#   1. Node.js / kordoc CLI 설치 확인 (kordoc 없으면 npm i -g kordoc)
#   2. 로그인 시 자동 시작 등록 (시작프로그램에 숨김 실행 바로가기)
#   3. 헬퍼 기동 및 /health 검증
#
# 사용법:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-kordoc-helper.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup-kordoc-helper.ps1 -NoAutoStart   # 등록 없이 지금만 실행
param(
    [int]$Port = 8531,
    [switch]$NoAutoStart
)
$ErrorActionPreference = "Stop"
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

$helper = Join-Path $PSScriptRoot "kordoc-helper.mjs"
if (-not (Test-Path $helper)) { throw "kordoc-helper.mjs가 없습니다: $helper" }

# 1. Node / kordoc 확인
Step "Node.js / kordoc 확인"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js가 필요합니다 — https://nodejs.org 에서 LTS 설치 후 재실행하세요." }
Write-Host "OK: node $(& node --version)"
$kordoc = Get-Command kordoc -ErrorAction SilentlyContinue
if (-not $kordoc) {
    Write-Host "kordoc이 없습니다. npm으로 설치합니다..." -ForegroundColor Yellow
    npm install -g kordoc
    if ($LASTEXITCODE -ne 0) { throw "kordoc 설치 실패 — 수동으로 'npm i -g kordoc' 실행 후 재시도하세요." }
}
Write-Host "OK: kordoc $(& kordoc -V)"

# 2. 자동 시작 등록 — 시작프로그램에 VBS(숨김 창) 바로가기
if (-not $NoAutoStart) {
    Step "자동 시작 등록"
    $vbs = Join-Path $PSScriptRoot "kordoc-helper.vbs"
    # WScript로 창 없이 실행 (0 = 숨김)
    Set-Content -Path $vbs -Encoding Unicode -Value @"
CreateObject("WScript.Shell").Run """$((Get-Command node).Source)"" ""$helper""", 0, False
"@
    $lnk = Join-Path ([Environment]::GetFolderPath("Startup")) "kordoc-helper.lnk"
    $sh = New-Object -ComObject WScript.Shell
    $sc = $sh.CreateShortcut($lnk)
    $sc.TargetPath = "wscript.exe"
    $sc.Arguments = "`"$vbs`""
    $sc.Description = "전자문서 AI 요약 — kordoc 첨부 변환 헬퍼"
    $sc.Save()
    Write-Host "등록됨: $lnk"
}

# 3. 지금 기동 + 검증
Step "헬퍼 기동"
$up = $false
try { Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null; $up = $true } catch {}
if (-not $up) {
    $vbsPath = Join-Path $PSScriptRoot 'kordoc-helper.vbs'
    if (Test-Path $vbsPath) { Start-Process wscript.exe -ArgumentList "`"$vbsPath`"" }
    else { Start-Process node -ArgumentList "`"$helper`"" -WindowStyle Hidden }
    foreach ($i in 1..10) {
        Start-Sleep -Seconds 1
        try { Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null; $up = $true; break } catch {}
    }
}
if (-not $up) { throw "헬퍼가 응답하지 않습니다 — 'node $helper' 를 직접 실행해 오류를 확인하세요." }
$h = Invoke-RestMethod "http://127.0.0.1:$Port/health"
Write-Host @"

✅ 완료! kordoc 헬퍼 동작 중 — http://127.0.0.1:$Port (kordoc $($h.kordoc))
   확장이 자동으로 감지해 첨부 변환·표기법 검수에 사용합니다. 별도 설정 불요.
"@ -ForegroundColor Green
