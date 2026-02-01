# Forge

Forge is an on-prem, agentic AI coding system that turns short natural-language instructions into safe, validated code changes inside real repositories. The system is deterministic, auditable, and runs locally without hidden automation.

## What Forge Does
- Reads real project state
- Plans step-by-step actions
- Generates unified diffs and applies them safely
- Enforces validation gates
- Integrates with Git only with explicit approval
- Fails honestly when requirements are unclear

## Roadmap (Phased Delivery)

Phase 0 - Foundation + LLM Connectivity + Safe Diff Editing
- VS Code extension shell
- forge.run command
- Local LLM connection (vLLM OpenAI-compatible API)
- Single-file unified diff generation
- Diff validation + user approval + apply

Phase 1 - Context Harvester
- Detect workspace root
- List files (depth-limited)
- Read package.json
- Detect package manager and basic frameworks
- Detect active editor file
- Output structured context object
- Log context to Output panel

Phase 2 - Task Compressor
- Turn short instructions into explicit steps
- Ask clarifying questions when ambiguous
- Output structured task plan

Phase 3 - Planner Hardening
- Read plan + context
- Emit one tool call at a time
- Strict tool contracts (read file / request diff / run validation)

Phase 4 - Validation and Git Integration
- Validation gate (build/test/typecheck)
- Git commit workflow with explicit approval
- Optional push with explicit consent

Phase 5 - UX and Polish
- Progress indicators
- Clear logs and confirmations
- Documentation and usability improvements

## Milestones
- M1: Single-file safe edit via agent command (Phase 0)
- M2: Short prompts expand reliably (Phases 1-2)
- M3: Multi-file changes validated by build/tests (Phase 4)
- M4: Git commit generation with approval (Phase 4)
- M5: End-to-end Copilot-like workflow on a real project

## Local Setup (From Scratch)

### 1) Prerequisites
- Node.js 18+
- VS Code
- Docker Desktop
  - Enable the WSL 2 engine in Docker Desktop settings
- NVIDIA GPU drivers with WSL2 GPU support

### 2) Clone and install
```bash
npm install
```

### 3) Start the local LLM (vLLM)
This project uses vLLM with a quantized 32B model that fits in 32 GB VRAM.

PowerShell (detached container):
```powershell
$env:HUGGING_FACE_HUB_TOKEN="<HF_TOKEN>"

docker run --name forge-vllm -d --gpus all `
  -v $env:USERPROFILE\.cache\huggingface:/root/.cache/huggingface `
  -e HUGGING_FACE_HUB_TOKEN=$env:HUGGING_FACE_HUB_TOKEN `
  -p 8000:8000 `
  --ipc=host `
  vllm/vllm-openai:latest `
  Qwen/Qwen2.5-Coder-32B-Instruct-AWQ `
  --quantization awq_marlin `
  --dtype auto `
  --max-model-len 8192 `
  --gpu-memory-utilization 0.85
```

Wait for:
```
Uvicorn running on http://0.0.0.0:8000
```

Verify:
```powershell
Invoke-RestMethod http://127.0.0.1:8000/v1/models
```

### 4) Configure Forge in VS Code
Open Settings:
- Ctrl+, (comma)
- Or Ctrl+Shift+P -> Preferences: Open Settings

Search for "Forge" and set:
- forge.llmEndpoint (default: http://127.0.0.1:8000/v1)
- forge.llmModel (default: Qwen/Qwen2.5-Coder-32B-Instruct-AWQ)
- forge.llmApiKey (optional)

You can also use environment variables:
- FORGE_LLM_ENDPOINT
- FORGE_LLM_MODEL
- FORGE_LLM_API_KEY

Example settings.json:
```json
{
  "forge.llmEndpoint": "http://127.0.0.1:8000/v1",
  "forge.llmModel": "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ",
  "forge.llmApiKey": ""
}
```

### 5) Build the extension
```bash
npm run compile
```

### 6) Run the extension
- Press F5 to open the Extension Development Host.
- In the new window, open a file you want to edit.
- Run the command: Forge: Run

### 7) Test a change
- Enter a short instruction when prompted.
- Review the proposed diff.
- Approve to apply the change.

## Project Structure
- src/extension.ts
- src/compressor/
- src/planner/
- phase0-setup.txt (full vLLM setup and troubleshooting)

## Safety Rules
- Single-file diffs only
- Unified diff format only
- Explicit user approval before writing changes
- No hidden Git actions

## LLM Usage Policy
- Context Harvester: NO
- Task Compressor: YES
- Planner: YES
- Tool Executor: NO
- Validation: NO
- Git Execution: NO
- Commit Messages: YES
