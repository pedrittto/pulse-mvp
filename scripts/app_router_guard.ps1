$ErrorActionPreference = "Stop"

$offenders = @()

function Add-Offender {
    param([string]$message)
    $script:offenders += $message
}

# Exclude generated/vendor directories
$excludePattern = "\\.next|node_modules|\\.firebase"

# 1) pages/ directories (legacy Pages Router)
$pagesDirs = Get-ChildItem -Path frontend -Recurse -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'pages' -and $_.FullName -notmatch $excludePattern }
if ($pagesDirs) {
    foreach ($d in $pagesDirs) { Add-Offender ("pages dir: " + $d.FullName) }
}

# 2) _document.* files (legacy Document)
$documentFiles = Get-ChildItem -Path frontend -Recurse -File -Include _document.tsx,_document.ts,_document.jsx,_document.js -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch $excludePattern }
if ($documentFiles) {
    foreach ($f in $documentFiles) { Add-Offender ("_document file: " + $f.FullName) }
}

# 3) next/document imports and Document primitives
$allFiles = Get-ChildItem -Path frontend -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch $excludePattern } |
    Select-Object -ExpandProperty FullName

foreach ($f in $allFiles) {
    $hits = @()
    $hits += Select-String -Path $f -SimpleMatch -Pattern "from 'next/document'" -ErrorAction SilentlyContinue
    $hits += Select-String -Path $f -SimpleMatch -Pattern 'from "next/document"' -ErrorAction SilentlyContinue
    $hits += Select-String -Path $f -SimpleMatch -Pattern "require('next/document')" -ErrorAction SilentlyContinue
    $hits += Select-String -Path $f -SimpleMatch -Pattern "<Html" -ErrorAction SilentlyContinue
    $hits += Select-String -Path $f -SimpleMatch -Pattern "<Head" -ErrorAction SilentlyContinue
    $hits += Select-String -Path $f -SimpleMatch -Pattern "NextScript" -ErrorAction SilentlyContinue
    $hits += Select-String -Path $f -SimpleMatch -Pattern "Main" -ErrorAction SilentlyContinue

    if ($hits) {
        foreach ($h in $hits) {
            Add-Offender ("next/document or Document primitive: " + $h.Path + ":" + $h.LineNumber + ":" + ($h.Line.Trim()))
        }
    }
}

# 4) Non-standard 404/500 app directories (App Router should use not-found.tsx and error/global-error)
if (Test-Path "frontend/src/app/404") { Add-Offender "non-standard dir: frontend/src/app/404" }
if (Test-Path "frontend/src/app/500") { Add-Offender "non-standard dir: frontend/src/app/500" }

if ($offenders.Count -gt 0) {
    Write-Host "[App Router Guard] FAILED. Offenders detected:" -ForegroundColor Red
    $offenders | ForEach-Object { Write-Host " - $_" }
    exit 1
} else {
    Write-Host "[App Router Guard] PASSED. No legacy artifacts detected." -ForegroundColor Green
    exit 0
}


