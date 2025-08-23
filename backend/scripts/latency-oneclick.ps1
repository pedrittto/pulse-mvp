#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..\..')
$art = Join-Path $root 'artifacts/latency_oneclick'
New-Item -ItemType Directory -Force -Path $art | Out-Null

function Write-Info($m){ Write-Host "[oneclick] $m" }
function Save-Json($obj,$path){ $obj | ConvertTo-Json -Depth 20 | Out-File -Encoding UTF8 $path }

# ---- ENV (scoped to spawned processes) ----
$token = 'pR2025xA1'
$envMap = @{
  PORT='4000';
  FASTLANE_ENABLED='1';
  WARMUP_TIER1='1';
  SSE_ENABLED='1';
  BULKWRITER_ENABLED='0';           # immediate writes, no buffering
  TRADING_ONLY_FILTER='0';          # do not drop stubs
  FASTLANE_DRY_RUN='0';
  DISABLE_INGEST='0';
  SCHEDULER_LEADER_LOCK='0';
  ALLOW_PUBLISH_AT_FALLBACK='1';
  INGEST_STATUS_WRITER='1';
  PUBLISH_AT_SHIM='1';
  DRIFT_CORRECT_METRICS='1';
  ADMIN_API_ENABLED='1';
  ADMIN_TOKEN=$token;
  ADMIN_API_TOKEN=$token;
  SOAK_INTERVAL_SEC='60';
  SOAK_DURATION_MIN='20';
}

# helper: set env in current process (children inherit)
$envMap.GetEnumerator() | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Key,$_.Value,'Process') }

# ---- kill anything on :4000 ----
try {
  netstat -ano | Select-String ':4000' | ForEach-Object {
    $pid = ($_.ToString() -split '\s+')[-1]
    if ($pid -match '^\d+$') { taskkill /PID $pid /F *>$null }
  }
} catch {}

# ---- build (backend only) ----
Write-Info "Building backend…"
$buildOut = & cmd /c "npm --prefix `"$root\backend`" run build"
if ($LASTEXITCODE -ne 0) {
  $fail = Join-Path $art 'FAIL.txt'
  Set-Content -Path $fail -Value "BUILD FAILED (backend). ExitCode=$LASTEXITCODE`r`n$buildOut"
  Write-Error "backend build failed ($LASTEXITCODE)"
  exit 1
}

# ---- start backend minimized ----
Write-Info "Starting backend…"
$startPs = @"
`$env:PORT='$($envMap.PORT)';
Set-Location `"$root\backend`";
node dist/index.js
"@
$backendProc = Start-Process -PassThru -WindowStyle Minimized powershell -ArgumentList "-NoProfile","-Command",$startPs

# ---- wait for /health ----
Write-Info "Waiting for /health…"
$healthUrl = "http://127.0.0.1:$($envMap.PORT)/health"
$ready = $false
for ($i=0; $i -lt 90; $i++){
  try {
    $r = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    if ($r.ok -eq $true) { $ready = $true; break }
  } catch {}
  Start-Sleep -Seconds 1
}
if (-not $ready){
  $fail = Join-Path $art 'FAIL.txt'
  Set-Content -Path $fail -Value "HEALTH TIMEOUT: $healthUrl"
  Write-Error "Backend not healthy"
  exit 1
}

# ---- admin headers ----
$H = @{ Authorization = "Bearer $($envMap.ADMIN_TOKEN)"; "X-Admin-Token" = $envMap.ADMIN_API_TOKEN }

# ---- admin: clear demotions (try both paths) ----
function Try-POST($url){
  try { Invoke-WebRequest -Uri $url -Headers $H -Method Post -TimeoutSec 5 | Out-Null; return $true }
  catch { return $false }
}
$base = "http://127.0.0.1:$($envMap.PORT)"
if (-not (Try-POST "$base/admin/clear-demotions")) { Try-POST "$base/admin/breaking/clear-demotions" | Out-Null }

# ---- admin: scheduler nudge ----
if (-not (Try-POST "$base/admin/scheduler/run-once?lane=breaking")) { Try-POST "$base/admin/scheduler/poke" | Out-Null }

# ---- probe quick sanity (optional) ----
try {
  $ml = Invoke-RestMethod -Uri "$base/metrics-lite" -TimeoutSec 5
  Save-Json $ml (Join-Path $art 'metrics_lite_T0.json')
} catch {}

# ---- run soak (prefer npm script; fallback to node script) ----
Write-Info "Starting 20-min soak…"
$soakOk = $true
try {
  cmd /c "npm --prefix `"$root\backend`" run soak:breaking" | Tee-Object -FilePath (Join-Path $art 'soak_console.txt')
} catch { $soakOk = $false }

if (-not $soakOk) {
  Write-Info "npm soak script missing, running node fallback…"
  node "$root\backend\scripts\soak-breaking.js" | Tee-Object -FilePath (Join-Path $art 'soak_console.txt')
}

# ---- collect KPI ----
Write-Info "Collecting KPI…"
try {
  $summary = Invoke-RestMethod -Uri "$base/metrics-summary" -TimeoutSec 5
  $kpi = Invoke-RestMethod -Uri "$base/kpi-breaking?window_min=30" -TimeoutSec 5
  Save-Json $summary (Join-Path $art 'metrics_summary_final.json')
  Save-Json $kpi (Join-Path $art 'kpi_breaking_final.json')
} catch {
  $fail = Join-Path $art 'FAIL.txt'
  Set-Content -Path $fail -Value "KPI UNAVAILABLE"
  # allow script to finish gracefully with artifacts present
}

# ---- print concise result to console ----
function Extract-KPI($kpiObj){
  $win = $kpiObj.window_min
  $p50 = $kpiObj.breaking_p50_ms
  $p90 = $kpiObj.breaking_p90_ms
  $p50c = $kpiObj.breaking_p50_ms_corrected
  $p90c = $kpiObj.breaking_p90_ms_corrected
  return @{ window_min=$win; p50_ms=$p50; p90_ms=$p90; p50_ms_corrected=$p50c; p90_ms_corrected=$p90c }
}
$flat = Extract-KPI $kpi
Write-Host ""
Write-Host "====== LATENCY (Pulse Exposure) ======"
Write-Host ("Window(min): {0}" -f $flat.window_min)
Write-Host ("p50(ms):     {0}" -f $flat.p50_ms)
Write-Host ("p90(ms):     {0}" -f $flat.p90_ms)
Write-Host ("p50c(ms):    {0}" -f $flat.p50_ms_corrected)
Write-Host ("p90c(ms):    {0}" -f $flat.p90_ms_corrected)
Write-Host "Artifacts: $art"
Write-Host "======================================"


