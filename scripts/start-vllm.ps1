$ErrorActionPreference = "Stop"

if (-not $env:HUGGING_FACE_HUB_TOKEN) {
  Write-Host "HUGGING_FACE_HUB_TOKEN is not set." -ForegroundColor Yellow
  Write-Host "Set it first: `$env:HUGGING_FACE_HUB_TOKEN = '<token>'" -ForegroundColor Yellow
}

docker compose up -d
docker logs -f forge-vllm
