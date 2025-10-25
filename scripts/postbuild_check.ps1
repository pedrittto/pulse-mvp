if (Test-Path .\frontend\.next\server\pages\_error.js) {
  Write-Host "❌ Detected Pages _error fallback (should not exist in App Router)" -ForegroundColor Red
  exit 1
}
Write-Host "✅ No Pages fallback detected."


