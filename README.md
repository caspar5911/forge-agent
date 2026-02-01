# Forge

Forge is an on-prem, agentic AI coding system that turns short natural-language instructions into safe, validated code changes inside real repositories. It runs locally, keeps a clear audit trail, and favors explicit control.

## What Forge Does
- Reads real project state
- Lets the LLM plan and edit (single or multi-file)
- Applies full-file updates safely
- Shows action + purpose summaries before edits
- Shows inline diff previews in the chat
- Auto-selects files from the prompt and confirms in a picker (multi-file)
- Runs validation automatically and can auto-fix failures
- Integrates with Git only with explicit approval
- Answers project questions from context

## Roadmap (Phased Delivery)

Phase 0 - Foundation + LLM Connectivity + Safe Editing
- VS Code extension shell
- forge.run command
- Local LLM connection (vLLM OpenAI-compatible API)
- Single-file full-file generation (LLM returns updated file)
- Local approval + apply

Phase 1 - Context Harvester
- Detect workspace root
- List files (depth-limited)
- Read package.json
- Detect package manager and basic frameworks
- Detect active editor file
- Output structured context object
- Log context to Output panel (Forge: Context)

Phase 2 - Task Compressor
- Turn short instructions into explicit steps (LLM-backed)
- Ask clarifying questions when ambiguous
- Output structured task plan (strict JSON schema)

Phase 3 - Planner Hardening
- Read plan + context
- Emit one tool call at a time (LLM-backed)
- Strict tool contracts (read file / request diff / run validation)

Phase 4 - Validation and Git Integration
- Validation gate (build/test/typecheck)
- Git commit workflow with explicit approval
- Optional push with explicit consent
- Workspace symbol index (LSP) to improve file selection for multi-file edits

Phase 5 - UX and Polish
- Progress indicators
- Clear logs and confirmations
- Documentation and usability improvements
- Forge UI panel and sidebar view for prompts
- File selection modal for multi-file edits

## Milestones
- M1: Single-file safe edit via agent command (Phase 0)
- M2: Short prompts expand reliably (Phases 1-2)
- M3: Multi-file changes validated by build/tests (Phase 4)
- M4: Git commit generation with approval (Phase 4)
- M5: End-to-end Copilot-like workflow on a real project

## Current Status
- Phase 0: complete
- Phase 1: complete
- Phase 2: complete (LLM-backed + fallback)
- Phase 3: complete (LLM-backed + fallback)
- Phase 4: complete
- Phase 5: in progress (UI panel + sidebar + file picker complete, polish ongoing)

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

Or use Docker Compose (recommended):
```powershell
docker compose up -d
```

Stop:
```powershell
docker compose down
```

Restart:
```powershell
docker compose restart
```

Tail logs:
```powershell
docker logs -f forge-vllm
```

PowerShell helper:
```powershell
.\scripts\start-vllm.ps1
```

### 4) Configure Forge in VS Code
Open Settings:
- Ctrl+, (comma)
- Or Ctrl+Shift+P -> Preferences: Open Settings

Search for "Forge" and set:
- forge.llmEndpoint (default: http://127.0.0.1:8000/v1)
- forge.llmModel (default: Qwen/Qwen2.5-Coder-32B-Instruct-AWQ)
- forge.llmApiKey (optional)
- forge.enableMultiFile (optional)
- forge.autoValidation (optional)
- forge.autoFixValidation (optional)
- forge.autoFixMaxRetries (optional)
- forge.skipTargetConfirmation (optional)
- forge.skipConfirmations (optional)
- forge.showDiffPreview (optional)
- forge.llmTimeoutMs (optional)
- forge.verboseLogs (optional)
- forge.keepAliveSeconds (optional)
- forge.enableGitWorkflow (optional)

You can also use environment variables:
- FORGE_LLM_ENDPOINT
- FORGE_LLM_MODEL
- FORGE_LLM_API_KEY
- FORGE_LLM_TIMEOUT_MS

Example settings.json:
```json
{
  "forge.llmEndpoint": "http://127.0.0.1:8000/v1",
  "forge.llmModel": "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ",
  "forge.llmApiKey": "",
  "forge.enableMultiFile": true,
  "forge.autoValidation": true,
  "forge.autoFixValidation": true,
  "forge.autoFixMaxRetries": 5,
  "forge.skipTargetConfirmation": false,
  "forge.skipConfirmations": false,
  "forge.showDiffPreview": false,
  "forge.llmTimeoutMs": 120000,
  "forge.verboseLogs": false,
  "forge.keepAliveSeconds": 0,
  "forge.enableGitWorkflow": false
}
```

### 5) Build the extension
```bash
npm run compile
```

### 6) Run the extension
- Press F5 to open the Extension Development Host.
- In the new window, open a file you want to edit.
- Run the command: Forge: UI (recommended) or Forge: Run.
- Or open the Forge icon in the Activity Bar.

### Commands
- Forge: Run (edit from an input box)
- Forge: UI (open the Forge panel)
- Forge: Context (print ProjectContext to Output panel)
### Views
- Forge (Activity Bar sidebar)

### 7) Test a change
- Enter a short instruction when prompted.
- Use the file picker to confirm targets (multi-file).
- Review inline change preview in the chat.

## Project Structure
- src/extension.ts
- src/context/
- src/compressor/
- src/planner/
- src/llm/
- src/validation/
- src/git/
- src/indexer/
- src/ui/
- docker-compose.yml
- scripts/start-vllm.ps1
- phase0-setup.txt (full vLLM setup and troubleshooting)

## Safety Rules
- Multi-file edits are allowed, but only for selected files
- Optional confirmations (can be skipped via settings)
- No hidden Git actions
- Comments are only added when explicitly requested (and placed above code lines)

## LLM Usage Policy
- Context Harvester: NO
- Task Compressor: YES
- Planner: YES
- Tool Executor: NO
- Validation: NO
- Git Execution: NO
- Commit Messages: YES

## Possible Enhancements (Later)
- Add streaming LLM responses for long edits
- Add per-project profiles (model, endpoint, policies)
- Add richer context search (symbols + diagnostics + references)
- Add optional snapshots for revert
