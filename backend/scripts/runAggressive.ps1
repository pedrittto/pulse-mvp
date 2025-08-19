$ErrorActionPreference = 'Stop'
Set-Location "$PSScriptRoot\.."

# Kill existing server on 4000
try { Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } } catch {}

# Aggressive env
$env:USE_FAKE_FIRESTORE = '1'
$env:BREAKING_MODE = '0'
$env:RSS_ADAPTIVE = '1'
$env:RSS_TRANSPORT_V2 = '1'
$env:RSS_PARALLEL = '12'
$env:SOURCE_REQUEST_TIMEOUT_MS = '5000'
$env:RSS_MIN_INTERVAL_OVERRIDES = 'Reuters=30000,AP=30000,Bloomberg=30000,CNBC=30000'
$env:INGEST_EXPANSION = '1'
$env:CRON_SCHEDULE = '*/1 * * * *'

# Start server
Start-Process -FilePath node -ArgumentList 'dist/index.js' -WorkingDirectory (Resolve-Path '.').Path -NoNewWindow
Start-Sleep -Seconds 5

# Quick ingest
try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4000/admin/ingest-now' -TimeoutSec 60 | Out-Null } catch {}

# Wait ~5 minutes
Start-Sleep -Seconds 300

# Capture snapshots
$outDir = Join-Path (Resolve-Path '.').Path 'metrics_quick'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$metrics = Invoke-RestMethod -Uri 'http://127.0.0.1:4000/metrics-lite' -TimeoutSec 30
$feed = Invoke-RestMethod -Uri 'http://127.0.0.1:4000/feed?limit=10&debug=impact&debug=verif' -TimeoutSec 30

$metrics | ConvertTo-Json -Depth 10 | Out-File -Encoding UTF8 (Join-Path $outDir 'metrics_after5.json')
$feed | ConvertTo-Json -Depth 10 | Out-File -Encoding UTF8 (Join-Path $outDir 'feed_after5.json')

Write-Output '---METRICS---'
$metrics | ConvertTo-Json -Depth 10
Write-Output '---FEED---'
$feed | ConvertTo-Json -Depth 8


