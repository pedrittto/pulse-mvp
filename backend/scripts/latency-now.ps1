#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Resolve-Path (Join-Path $here '..')
$art  = Join-Path $root 'artifacts/latency_now'
New-Item -ItemType Directory -Force -Path $art | Out-Null
function Log($m){ $t=[DateTime]::UtcNow.ToString('o'); $line="[latnow] $t $m"; $line | Out-File -FilePath (Join-Path $art 'RUN_LOG.txt') -Append -Encoding UTF8; Write-Host $line }
function SaveJson($obj,$name){ $p=Join-Path $art $name; $obj | ConvertTo-Json -Depth 30 | Out-File -FilePath $p -Encoding UTF8 }

# ---- ENV (scoped to child procs) ----
$token='pR2025xA1'
$env:PORT='4000'
$env:FASTLANE_ENABLED='1'
$env:SSE_ENABLED='1'
$env:WARMUP_TIER1='1'
$env:BULKWRITER_ENABLED='0'
$env:TRADING_ONLY_FILTER='0'
$env:FASTLANE_DRY_RUN='0'
$env:SCHEDULER_LEADER_LOCK='0'
$env:DISABLE_INGEST='0'
$env:ALLOW_PUBLISH_AT_FALLBACK='1'
$env:INGEST_STATUS_WRITER='1'
$env:DRIFT_CORRECT_METRICS='1'
$env:PUBLISH_AT_SHIM='1'     # pass pubDate/isoDate to publishStub if present
$env:ADMIN_API_ENABLED='1'
$env:ADMIN_TOKEN=$token
$env:ADMIN_API_TOKEN=$token

# ---- Kill anything on :4000 (idempotent) ----
try { netstat -ano | Select-String ':4000' | % { $pid=($_.ToString() -split '\s+')[-1]; if($pid -match '^\d+$'){ taskkill /PID $pid /F *>$null } } } catch {}

# ---- Build backend only ----
Log "Building backend…"
$build = cmd /c "npm --prefix `"$root`" run build"
if ($LASTEXITCODE -ne 0) { Set-Content (Join-Path $art 'FAIL.txt') "BUILD FAILED: $build"; exit 1 }

# ---- Start backend minimized ----
Log "Starting backend…"
$startPs = @"
`$env:PORT='$($env:PORT)'; Set-Location `"$root`"; node dist/index.js
"@
$proc = Start-Process -PassThru -WindowStyle Minimized powershell -ArgumentList "-NoProfile","-Command",$startPs

# ---- Wait /health (max 120s) ----
Log "Waiting for /health…"
$healthUrl = "http://127.0.0.1:$($env:PORT)/health"
$ok = $false
for($i=0;$i -lt 120;$i++){ try { $r=Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2; SaveJson $r 'HEALTH.json'; if($r.ok -eq $true){ $ok=$true; break } } catch {}; Start-Sleep 1 }
if(-not $ok){ Set-Content (Join-Path $art 'FAIL.txt') "HEALTH TIMEOUT $healthUrl"; exit 1 }
Log "Health OK"

# ---- Admin headers ----
$H = @{ Authorization = "Bearer $env:ADMIN_TOKEN"; "X-Admin-Token" = $env:ADMIN_API_TOKEN }

# ---- Clear demotions + poke (try both variants) ----
function TryPOST($url){ try { Invoke-WebRequest -Uri $url -Headers $H -Method Post -TimeoutSec 5 | Out-Null; return $true } catch { return $false } }
if (-not (TryPOST "http://127.0.0.1:$($env:PORT)/admin/clear-demotions")) { TryPOST "http://127.0.0.1:$($env:PORT)/admin/breaking/clear-demotions" | Out-Null }
if (-not (TryPOST "http://127.0.0.1:$($env:PORT)/admin/scheduler/run-once?lane=breaking")) { TryPOST "http://127.0.0.1:$($env:PORT)/admin/scheduler/poke" | Out-Null }
Log "Admin nudge done"

# ---- T0 metrics-lite snapshot ----
try { $ml = Invoke-RestMethod -Uri "http://127.0.0.1:$($env:PORT)/metrics-lite" -TimeoutSec 5; SaveJson $ml 'METRICS_T0.json' } catch {}

# ---- Primary path: 20-min soak using existing script ----
Log "Starting primary 20-min soak…"
$soakOk=$true
try { cmd /c "npm --prefix `"$root`" run soak:breaking" | Tee-Object -FilePath (Join-Path $art 'soak_console.txt') } catch { $soakOk=$false; Log "npm soak failed: $($_.Exception.Message)" }

# ---- Secondary path: live tracking of at least one real item (best-effort, non-fatal) ----
# Monitor /feed for new items for 5 minutes; compute earliest visible_at delta if possible.
$feedSeen=$null
try{
  for($i=0;$i -lt 300 -and -not $feedSeen;$i++){
    $feed = Invoke-RestMethod -Uri "http://127.0.0.1:$($env:PORT)/feed?limit=1" -TimeoutSec 5
    if($feed.total -ge 1 -and $feed.items.Count -ge 1){
      $item = $feed.items[0]
      if($item.visible_at){ $feedSeen = $item }
    }
    if(-not $feedSeen){ Start-Sleep 1 }
  }
  if($feedSeen){
    # naive exposure proxy if fields exist
    $fs = [datetime]::Parse($feedSeen.first_seen_at)
    $vis = [datetime]::Parse($feedSeen.visible_at)
    $expMs = [int]($vis - $fs).TotalMilliseconds
    Log ("Observed exposure candidate: {0} ms" -f $expMs)
    Set-Content (Join-Path $art 'EXPOSURE_OBS.txt') ("exp_ms="+$expMs)
  }
} catch {}

# ---- Final KPI/SUMMARY (try even if soak failed) ----
$kpiOk=$false
try { $kpi = Invoke-RestMethod -Uri "http://127.0.0.1:$($env:PORT)/kpi-breaking?window_min=30" -TimeoutSec 5; SaveJson $kpi 'KPI_FINAL.json'; $kpiOk=$true } catch { Log "KPI fetch failed" }
$sumOk=$false
try { $sum = Invoke-RestMethod -Uri "http://127.0.0.1:$($env:PORT)/metrics-summary" -TimeoutSec 5; SaveJson $sum 'SUMMARY_FINAL.json'; $sumOk=$true } catch { Log "Summary fetch failed" }

# ---- Compose final report ----
$p50=$null; $p90=$null; $p50c=$null; $p90c=$null
try { if($kpiOk){ $p50=$kpi.breaking_p50_ms; $p90=$kpi.breaking_p90_ms; $p50c=$kpi.breaking_p50_ms_corrected; $p90c=$kpi.breaking_p90_ms_corrected } } catch {}
$lines=@()
$lines += "=== LATENCY REPORT (Pulse) ==="
if($p50 -ne $null -or $p90 -ne $null){
  $lines += ("p50_ms: {0}" -f $p50)
  $lines += ("p90_ms: {0}" -f $p90)
  $lines += ("p50c_ms: {0}" -f $p50c)
  $lines += ("p90c_ms: {0}" -f $p90c)
} else {
  $lines += "No KPI samples in window (raw null)."
  if(Test-Path (Join-Path $art 'EXPOSURE_OBS.txt')){
    $lines += ("Observed exposure proxy -> " + (Get-Content (Join-Path $art 'EXPOSURE_OBS.txt')))
  }
}
Set-Content (Join-Path $art 'LATENCY_REPORT.txt') ($lines -join "`r`n")
Write-Host ($lines -join "`r`n")
exit 0


