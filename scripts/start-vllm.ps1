$ErrorActionPreference = "Stop"

if (-not $env:HUGGING_FACE_HUB_TOKEN) {
  Write-Host "HUGGING_FACE_HUB_TOKEN is not set." -ForegroundColor Yellow
  Write-Host "Set it first: `$env:HUGGING_FACE_HUB_TOKEN = '<token>'" -ForegroundColor Yellow
}

$isRunning = $false
try {
  $running = docker compose ps --status running --format json 2>$null | ConvertFrom-Json
  if ($running) {
    $isRunning = @($running).Count -gt 0
  }
} catch {
  $isRunning = $false
}

if ($isRunning) {
  docker compose down
}
docker compose up -d
docker logs -f forge-vllm
