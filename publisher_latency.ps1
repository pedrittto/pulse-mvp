param(
  [string]$Base
)

# Realne źródła (publisher→Pulse)
$real = @('prnewswire','sec_press','fed_press')

for ($i=0; $i -lt 20; $i++) {
  try {
    $m = Invoke-RestMethod "$Base/metrics-summary" -TimeoutSec 10
    $props = $m.PSObject.Properties.Name

    $by = $null
    if ($props -contains 'by_source') { $by = $m.by_source }
    elseif ($props -contains 'per_source') { $by = $m.per_source }

    if ($by -ne $null) {
      foreach ($s in $real) {
        $entry = $by.$s
        if ($entry -and $entry.p50_ms -gt 0) {
          "{0} publisher->Pulse [{1}]  p50={2} ms  p90={3} ms  (n={4})" `
            -f (Get-Date).ToString("HH:mm:ss"), $s, $entry.p50_ms, $entry.p90_ms, $entry.n_total
          exit 0
        }
      }
    }
  } catch {
    "metrics read failed: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 60
}

"Brak świeżych próbek z realnych źródeł w tym oknie czasu."
exit 1
