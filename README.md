# Forge

Forge is an on-prem, agentic coding assistant built as a VS Code extension. It turns short instructions into safe, validated code changes using a local LLM while keeping control explicit and auditable.

**Status**
- Phase 0-6 complete (UI + workflows + Git Manager)
- Phase 7: UX polish + hardening (deferred)
- Phase 8: capability upgrades (in progress; Q&A citations, JSON retries, chunked updates, clarification proposals, Git intent detection shipped)

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
- Automatic file targeting and creation for "create ..." prompts
- Inline diff preview and action/purpose summaries
- Validation runs (test/typecheck/lint/build) with optional auto-fix (runs all available commands, not fail-fast)
- Grounded Q&A about project context and file contents with citations + confidence
- Optional Git workflow (stage/commit/push) with approvals
- Git intent detection (explicit or LLM-based "smart" mode)
- Multi-round clarification when requirements are ambiguous
- Clarification proposals (Forge can propose best-guess answers and a plan)
- JSON output retries + chunked update requests for reliability
- Inline "Peek" panel showing steps, prompts, raw JSON payloads, diffs, and validation output (system prompts hidden; secrets redacted)

**Limits**
- No hidden Git actions
- No background code execution
- No file edits without explicit approval (unless `forge.skipConfirmations` is enabled)
- File edits require JSON payloads (no partial patch streaming)
- Depth-limited workspace scan for large repos
- Peek output truncates large payloads for safety

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
- `forge.profile` (`auto` | `balanced` | `manual`)
- `forge.llmEndpoint` (default: `http://127.0.0.1:8000/v1`)
- `forge.llmModel` (default: `Qwen/Qwen2.5-Coder-32B-Instruct-AWQ`)
- `forge.enableMultiFile`

**Profiles**
- `auto`: fastest flow, minimal prompts, auto-accepts clarification proposals, still confirms Git actions
- `balanced`: safer defaults with confirmations and clarification checks
- `manual`: ask before most actions

**Advanced settings (selected)**
- `forge.skipCreateFilePicker`: skip the file picker when creating new files
- `forge.maxFilesPerUpdate` / `forge.maxUpdateChars`: chunking limits for multi-file updates
- `forge.clarifySuggestAnswers` / `forge.clarifyConfirmSuggestions`: control clarification proposals
- `forge.gitIntentMode` / `forge.gitConfirmActions`: Git intent detection + confirmation
- `forge.qaMinSources` / `forge.qaMaxFiles`: Q&A grounding thresholds

Environment variables:
- `FORGE_LLM_ENDPOINT`
- `FORGE_LLM_MODEL`
- `FORGE_LLM_API_KEY`
- `FORGE_LLM_TIMEOUT_MS`

Example settings (minimal):
```json
{
  "forge.profile": "auto",
  "forge.llmEndpoint": "http://127.0.0.1:8000/v1",
  "forge.llmModel": "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ",
  "forge.enableMultiFile": true
}
```

Advanced settings are still available if you need fine-grained control.

**5) Build & Run (Dev)**
```bash
npm run compile
```

- Press `F5` to open the Extension Development Host.
- Run `Forge: UI` or click the Forge Activity Bar icon.

## LLM Backends

**Ollama (local, OpenAI-compatible API)**

Ollama exposes an OpenAI-compatible API at `http://localhost:11434/v1` and expects a local model name that you have pulled.

1. Pull a model:
```bash
ollama pull gpt-oss:20b
```


2. Point Forge at Ollama:
```json
{
  "forge.llmEndpoint": "http://127.0.0.1:11434/v1",
  "forge.llmModel": "gpt-oss:20b",
  "forge.llmApiKey": "ollama"
}
```
The `api_key` is required by the OpenAI-compatible client but is ignored by Ollama.

**OpenAI API (hosted)**

OpenAI's API uses Bearer authentication and the base endpoint `https://api.openai.com/v1`.

```json
{
  "forge.llmEndpoint": "https://api.openai.com/v1",
  "forge.llmModel": "<MODEL_NAME>",
  "forge.llmApiKey": "<OPENAI_API_KEY>"
}
```
Use a model name you have access to in your OpenAI account, and keep the API key secret.

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
- "Add comments to App.tsx"
- "Remove unused imports in Timesheet.tsx"
- "Fix validation errors for this project"
- "How many files are in this repo?"
- "Show me the content of src/main.tsx"
- "Create a landing page (Forge will auto-select/ask/assume, then propose a plan)"

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
- Peek content is truncated for very large prompts/output blocks

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
- Clarification proposals with user verification
- Git intent detection improvements

## Release Notes
v0.1
- Phase 0-6 complete
- UI panel + sidebar
- Multi-file edits + file picker
- Validation + auto-fix
