# Start/Restart the local vLLM container used by Forge.
# - Verifies the Hugging Face token is set (required for model pulls).
# - Restarts the container if it's already running.
# - Streams logs for quick verification.
$ErrorActionPreference = "Stop"

if (-not $env:HUGGING_FACE_HUB_TOKEN) {
  Write-Host "HUGGING_FACE_HUB_TOKEN is not set." -ForegroundColor Yellow
  Write-Host "Set it first: `$env:HUGGING_FACE_HUB_TOKEN = '<token>'" -ForegroundColor Yellow
}

$isRunning = $false
try {
  # Check if any docker compose service is running.
  $running = docker compose ps --status running --format json 2>$null | ConvertFrom-Json
  if ($running) {
    $isRunning = @($running).Count -gt 0
  }
} catch {
  $isRunning = $false
}

if ($isRunning) {
  # Stop any running services to ensure a clean restart.
  docker compose down
}
# Start in detached mode, then tail logs.
docker compose up -d
docker logs -f forge-vllm
