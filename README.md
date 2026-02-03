# Forge

Forge is an on-prem, agentic coding assistant built as a VS Code extension. It turns short instructions into safe, validated code changes using a local LLM while keeping control explicit and auditable.

**Status**
- Phase 0-6 complete (UI + workflows + Git Manager)
- Phase 7: UX polish + hardening (deferred)
- Phase 8: capability upgrades (in progress)

**Why Forge**
- On-prem and offline-friendly
- Explicit diff previews and confirmations
- Validation + auto-fix loops
- Local OpenAI-compatible LLM support (vLLM tested)

**Architecture**
- `src/extension.ts`: command wiring, UI registration, lifecycle hooks
- `src/extension/runtime.ts`: run orchestration and state management
- `src/extension/lifecycle.ts`: settings sync + keep-alive
- `src/forge/`: intent detection, file selection, updates, validation, Git actions
- `src/ui/`: webview UI, panel, sidebar view
- `src/llm/`: OpenAI-compatible HTTP client
- `src/context/`, `src/indexer/`, `src/validation/`, `src/git/`: context, symbol index, validation, Git helpers

**Capabilities**
- Single-file or multi-file edits with explicit selection
- Automatic file targeting and creation for “create …” prompts
- Inline diff preview and action/purpose summaries
- Validation runs (test/typecheck/lint/build) with optional auto-fix
- Q&A about project context and file contents
- Optional Git workflow (stage/commit/push) with approvals
- Multi-round clarification when requirements are ambiguous
- JSON output retries + chunked update requests for reliability

**Limits**
- No hidden Git actions
- No background code execution
- No file edits without explicit approval (unless `forge.skipConfirmations` is enabled)
- File edits require JSON payloads (no partial patch streaming)
- Depth-limited workspace scan for large repos

## Quickstart (Local Setup)

**1) Prereqs**
- Node.js 18+
- VS Code
- Docker Desktop (WSL2 engine enabled)
- NVIDIA drivers with WSL2 GPU support (32 GB VRAM recommended for 32B models)

**2) Install**
```bash
npm install
```

**3) Start vLLM (Docker Compose)**
Set your Hugging Face token:
```powershell
$env:HUGGING_FACE_HUB_TOKEN="<HF_TOKEN>"
```

Start:
```powershell
docker compose up -d
```

Stop:
```powershell
docker compose down
```

Logs:
```powershell
docker logs -f forge-vllm
```

Helper:
```powershell
.\scripts\start-vllm.ps1
```

Verify:
```powershell
Invoke-RestMethod http://127.0.0.1:8000/v1/models
```

**4) Configure Forge (VS Code Settings)**
Open Settings and search for `Forge`, or edit `settings.json`.

Key settings:
- `forge.llmEndpoint` (default: `http://127.0.0.1:8000/v1`)
- `forge.llmModel` (default: `Qwen/Qwen2.5-Coder-32B-Instruct-AWQ`)
- `forge.enableMultiFile`
- `forge.autoValidation`
- `forge.autoFixValidation`
- `forge.autoFixMaxRetries`
- `forge.skipTargetConfirmation`
- `forge.skipConfirmations`
- `forge.showDiffPreview`
- `forge.skipCreateFilePicker`
- `forge.maxFilesPerUpdate`
- `forge.maxUpdateChars`
- `forge.clarifyBeforeEdit`
- `forge.clarifyOnlyIf`
- `forge.clarifyAutoAssume`
- `forge.clarifyMaxQuestions`
- `forge.clarifyMaxRounds`

Environment variables:
- `FORGE_LLM_ENDPOINT`
- `FORGE_LLM_MODEL`
- `FORGE_LLM_API_KEY`
- `FORGE_LLM_TIMEOUT_MS`

Example settings:
```json
{
  "forge.llmEndpoint": "http://127.0.0.1:8000/v1",
  "forge.llmModel": "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ",
  "forge.enableMultiFile": true,
  "forge.autoValidation": true,
  "forge.autoFixValidation": true,
  "forge.autoFixMaxRetries": 5,
  "forge.skipTargetConfirmation": false,
  "forge.skipConfirmations": false,
  "forge.showDiffPreview": true,
  "forge.skipCreateFilePicker": true,
  "forge.maxFilesPerUpdate": 6,
  "forge.maxUpdateChars": 60000,
  "forge.llmTimeoutMs": 120000,
  "forge.verboseLogs": false,
  "forge.keepAliveSeconds": 0,
  "forge.enableGitWorkflow": false,
  "forge.gitStageMode": "all",
  "forge.gitAutoMessage": true,
  "forge.gitMessageStyle": "conventional",
  "forge.gitAutoPush": false,
  "forge.projectSummaryMaxChars": 12000,
  "forge.projectSummaryMaxFiles": 60,
  "forge.projectSummaryMaxFileBytes": 60000,
  "forge.projectSummaryChunkChars": 6000,
  "forge.projectSummaryMaxChunks": 6,
  "forge.chatHistoryMaxMessages": 8,
  "forge.chatHistoryMaxChars": 8000,
  "forge.intentUseLLM": true,
  "forge.clarifyBeforeEdit": true,
  "forge.clarifyOnlyIf": "always",
  "forge.clarifyAutoAssume": false,
  "forge.clarifyMaxQuestions": 6,
  "forge.clarifyMaxRounds": 3
}
```

**5) Build & Run (Dev)**
```bash
npm run compile
```

- Press `F5` to open the Extension Development Host.
- Run `Forge: UI` or click the Forge Activity Bar icon.

## LLM Backends

**Ollama (local, OpenAI-compatible API)**

Ollama exposes an OpenAI-compatible API at `http://localhost:11434/v1` and expects a local model name that you have pulled. citeturn0search0turn0search1

1. Pull a model:
```bash
ollama pull gpt-oss:20b
```
citeturn0search0

2. Point Forge at Ollama:
```json
{
  "forge.llmEndpoint": "http://127.0.0.1:11434/v1",
  "forge.llmModel": "gpt-oss:20b",
  "forge.llmApiKey": "ollama"
}
```
The `api_key` is required by the OpenAI-compatible client but is ignored by Ollama. citeturn0search0

**OpenAI API (hosted)**

OpenAI’s API uses Bearer authentication and the base endpoint `https://api.openai.com/v1`. citeturn0search3

```json
{
  "forge.llmEndpoint": "https://api.openai.com/v1",
  "forge.llmModel": "<MODEL_NAME>",
  "forge.llmApiKey": "<OPENAI_API_KEY>"
}
```
Use a model name you have access to in your OpenAI account, and keep the API key secret. citeturn0search3

## Build, Install, Deploy

**Local test install (VSIX)**
```bash
npx @vscode/vsce package
```

Install the generated `.vsix`:
```bash
code --install-extension forge-0.0.1.vsix
```

**Dev host install (no VSIX)**
- Run `npm run compile`
- Press `F5` to open the Extension Development Host

**Deployment**
- Package: `npx @vscode/vsce package`
- Publish: `npx @vscode/vsce publish` (requires publisher account and login)

## Usage
1. Open a file (single-file mode) or enable multi-file mode.
2. Enter an instruction in the UI.
3. Confirm file selection when prompted (or auto-selected).
4. Review inline diff preview.
5. Apply changes and optionally run validation.

Example prompts:
- “Add comments to App.tsx”
- “Remove unused imports in Timesheet.tsx”
- “Fix validation errors for this project”
- “How many files are in this repo?”
- “Show me the content of src/main.tsx”

## Git Commands
- `Forge: Git Stage`
- `Forge: Git Commit`
- `Forge: Git Push`
- Optional post-edit workflow via `forge.enableGitWorkflow`

## UI Shortcuts
- Enter: send
- Shift+Enter: newline
- Esc: stop
- Ctrl/Cmd+L: clear
- Ctrl/Cmd+/: focus prompt

## Performance Notes
- First run includes model warmup (can take minutes)
- Subsequent requests are faster if the model stays loaded
- Large multi-file updates may be chunked into multiple LLM calls

## Model Compatibility
Tested:
- Qwen/Qwen2.5-Coder-32B-Instruct-AWQ (vLLM)

Expected:
- OpenAI-compatible chat API
- JSON-safe outputs for update payloads

## Security and Privacy
- Runs fully on-prem
- No telemetry by default
- API keys stored in VS Code settings or environment variables

## Known Issues / Limitations
- JSON payloads can still fail on very large outputs, even with retries
- Very large diffs may slow down LLM responses
- File selection relies on file list + symbol index (no semantic search yet)

## Roadmap (Phases)
Phase 0 - Foundation
- Extension shell + command wiring
- Local LLM connectivity
- Safe single-file apply

Phase 1 - Context Harvester
- Workspace root detection
- Depth-limited file list
- package.json parsing
- Framework + package manager detection
- Active file detection

Phase 2 - Task Compressor
- Turn vague prompts into explicit steps
- Ask clarifying questions when ambiguous

Phase 3 - Planner
- Choose the next safe action
- Emit strict tool calls (read, diff, validate)

Phase 4 - Validation + Git Integration
- Run build/test/typecheck
- Optional auto-fix loop
- Git commit flow with user approval
- Workspace symbol index for file targeting

Phase 5 - UX + Polish
- UI panel and sidebar
- File picker modal
- Status steps + shortcuts
- Cleaner logs

Phase 6 - Git Manager
- Stage/commit/push commands
- Optional auto message suggestion
- Optional auto push (only when skipConfirmations is enabled)

Phase 7 - UX polish + hardening (deferred)
- UX refinement and edge-case hardening

Phase 8 - Capability upgrades (in progress)
- Grounded Q&A with retrieval and source citations
- Plan-then-execute for complex tasks
- Self-verification and requirement coverage checks
- JSON repair + stronger output validation
- Smarter file targeting confidence thresholds

## Release Notes
v0.1
- Phase 0-6 complete
- UI panel + sidebar
- Multi-file edits + file picker
- Validation + auto-fix
