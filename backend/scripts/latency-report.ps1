#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

function Ensure-Dir($p){ if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null } }
function Save-Json($obj,$path){ $obj | ConvertTo-Json -Depth 50 | Out-File -Encoding UTF8 $path }
function Read-Json($path){ if (Test-Path $path) { $txt = Get-Content -Path $path -Raw -ErrorAction SilentlyContinue; if ($txt -and $txt.Trim().Length -gt 0) { try { return $txt | ConvertFrom-Json -Depth 50 } catch {} } } return $null }
function Coerce-Num($v){ if ($null -eq $v) { return $null }; try { return [double]$v } catch { return $null } }
function To-Seconds1($ms){ if ($null -eq $ms) { return $null }; return [math]::Round(($ms/1000.0),1) }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$art = Join-Path $root 'artifacts/latency_oneclick'
Ensure-Dir $art

$kpiPath = Join-Path $art 'kpi_breaking_final.json'
$sumPath = Join-Path $art 'metrics_summary_final.json'
$reportPath = Join-Path $art 'LATENCY_REPORT.txt'

# Try read artifacts
$kpi = Read-Json $kpiPath
$sum = Read-Json $sumPath

# Poll for up to 25 minutes, checking artifacts or falling back to live endpoints every 30s
$base = 'http://127.0.0.1:4000'
$deadline = (Get-Date).AddMinutes(25)
while (($null -eq $kpi -or $null -eq $sum) -and (Get-Date) -lt $deadline) {
  # Check artifacts if exist and non-empty
  if ($null -eq $kpi -and (Test-Path $kpiPath)) {
    try {
      $fi = Get-Item $kpiPath -ErrorAction SilentlyContinue
      if ($fi -and $fi.Length -gt 0) { $kpi = Read-Json $kpiPath }
    } catch {}
  }
  if ($null -eq $sum -and (Test-Path $sumPath)) {
    try {
      $fi2 = Get-Item $sumPath -ErrorAction SilentlyContinue
      if ($fi2 -and $fi2.Length -gt 0) { $sum = Read-Json $sumPath }
    } catch {}
  }

  # Fallback to live endpoints
  if ($null -eq $kpi) {
    try { $tmp = Invoke-RestMethod -Uri "$base/kpi-breaking?window_min=30" -TimeoutSec 5; if ($tmp) { $kpi = $tmp; Save-Json $kpi $kpiPath } } catch {}
  }
  if ($null -eq $sum) {
    try { $tmp2 = Invoke-RestMethod -Uri "$base/metrics-summary" -TimeoutSec 5; if ($tmp2) { $sum = $tmp2; Save-Json $sum $sumPath } } catch {}
  }

  if ($null -ne $kpi -and $null -ne $sum) { break }
  Start-Sleep -Seconds 30
}

# Extract globals
$windowMin = $kpi.window_min
$g_p50 = Coerce-Num ($kpi.breaking_p50_ms)
$g_p90 = Coerce-Num ($kpi.breaking_p90_ms)
$g_p50c = Coerce-Num ($kpi.breaking_p50_ms_corrected)
$g_p90c = Coerce-Num ($kpi.breaking_p90_ms_corrected)

if ($null -eq $g_p50 -and $null -eq $g_p90 -and $null -eq $g_p50c -and $null -eq $g_p90c) {
  $noSamples = $true
} else { $noSamples = $false }

# Per-source from metrics summary (prefer pulse exposure p50/p90 if present)
$perLines = @()
if ($sum -and $sum.by_source) {
  foreach ($kv in $sum.by_source.GetEnumerator()) {
    $name = [string]$kv.Key
    $rec = $kv.Value
    $p50 = $null; $p90 = $null
    if ($rec.pulse_p50 -ne $null -or $rec.pulse_p90 -ne $null) {
      $p50 = Coerce-Num $rec.pulse_p50
      $p90 = Coerce-Num $rec.pulse_p90
    } elseif ($rec.publisher_p50 -ne $null -or $rec.publisher_p90 -ne $null) {
      $p50 = Coerce-Num $rec.publisher_p50
      $p90 = Coerce-Num $rec.publisher_p90
    }
    $p50s = if ($p50 -ne $null) { To-Seconds1 $p50 } else { $null }
    $p90s = if ($p90 -ne $null) { To-Seconds1 $p90 } else { $null }
    $perLines += ("$name: p50_ms={0}, p90_ms={1}, p50_s={2}, p90_s={3}" -f `
      ($p50 -ne $null ? [string][int]$p50 : 'null'), `
      ($p90 -ne $null ? [string][int]$p90 : 'null'), `
      ($p50s -ne $null ? [string]$p50s : 'n/a'), `
      ($p90s -ne $null ? [string]$p90s : 'n/a'))
  }
}

# Build report text
$lines = @()
$lines += '=== GLOBAL LATENCY (Pulse Exposure) ==='
$lines += ('window_min: {0}' -f ($windowMin -ne $null ? [string][int]$windowMin : 'unknown'))
$lines += ('p50_ms: {0}' -f ($g_p50 -ne $null ? [string][int]$g_p50 : 'null'))
$lines += ('p90_ms: {0}' -f ($g_p90 -ne $null ? [string][int]$g_p90 : 'null'))
$lines += ('p50_corrected_ms: {0}' -f ($g_p50c -ne $null ? [string][int]$g_p50c : 'null'))
$lines += ('p90_corrected_ms: {0}' -f ($g_p90c -ne $null ? [string][int]$g_p90c : 'null'))
$lines += ('p50_s: {0}' -f ($g_p50 -ne $null ? [string](To-Seconds1 $g_p50) : 'n/a'))
$lines += ('p90_s: {0}' -f ($g_p90 -ne $null ? [string](To-Seconds1 $g_p90) : 'n/a'))
$lines += ('p50c_s: {0}' -f ($g_p50c -ne $null ? [string](To-Seconds1 $g_p50c) : 'n/a'))
$lines += ('p90c_s: {0}' -f ($g_p90c -ne $null ? [string](To-Seconds1 $g_p90c) : 'n/a'))
$lines += ''
$lines += '--- PER-SOURCE (Pulse Exposure) ---'
if ($perLines.Count -gt 0) { $lines += $perLines } else { $lines += '(no per-source metrics found)' }
if ($noSamples) { $lines += 'NO SAMPLES IN WINDOW' }

$content = ($lines -join "`r`n") + "`r`n"
$content | Out-File -FilePath $reportPath -Encoding UTF8
Write-Host $content

