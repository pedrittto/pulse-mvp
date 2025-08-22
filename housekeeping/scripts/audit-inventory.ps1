Param(
  [string]$OutFile = "housekeeping/INVENTORY.md"
)

function Get-Tree($Path) {
  $items = Get-ChildItem -Recurse -Force -Path $Path -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch "\\node_modules\\|\\.git\\|\\_quarantine\\|\\dist\\|\\build\\|\\.next\\|\\coverage\\|\\playwright-report\\" }
  $lines = @()
  foreach ($i in $items) {
    $rel = Resolve-Path -Relative $i.FullName
    $size = $i.Length
    $lines += "${rel}`t${size}"
  }
  return $lines
}

New-Item -ItemType Directory -Force -Path "housekeeping" | Out-Null

$root = Get-Tree "."

$content = @()
$content += "Repo Inventory (auto-generated)"
$content += ""
$content += "Root Files (path\tsize_bytes)"
$content += $root

Set-Content -Path $OutFile -Value $content -Encoding UTF8
Write-Host "Inventory written to $OutFile"


