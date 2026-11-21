Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "   CICADA 2026 - AIOPS OBSERVABILITY PLATFORM STARTING          " -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Cyan

$env:ELECTRON_RUN_AS_NODE = "1"
& "C:\Users\ABHI\AppData\Local\Programs\antigravity\Antigravity.exe" index.js
