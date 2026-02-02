# Forge

Forge is an on-prem, agentic coding assistant built as a VS Code extension. It turns short instructions into safe, validated code changes using a local LLM and keeps control explicit and auditable.

## Status
- Phase 0-5: complete (UI + workflows)
- Phase 6: planned (Git Manager hardening)

## What Forge Does
- VS Code UI panel + sidebar view
- Single-file or multi-file edits
- File picker for multi-file confirmation
- Inline diff preview in chat
- Action + purpose summaries before edits
- Automatic validation and auto-fix retries
- Q&A about project context
- Optional Git workflow (explicit approval only)
- Local vLLM (OpenAI-compatible) integration

## Capabilities and Limits
Capabilities:
- Edit files via LLM-generated full-file updates
- Select targets automatically or via file picker
- Validate changes and attempt auto-fixes
- Answer project questions using harvested context

Limits:
- No hidden Git actions
- No background code execution
- No file edits without explicit approval (unless skipConfirmations is enabled)
- File edits require JSON payloads (no partial patch streaming)
- Depth-limited workspace scan for large repos

## Technical Specifications
- Architecture: VS Code extension + webview UI + local LLM server
- LLM API: OpenAI-compatible `/v1/chat/completions`
- Data flow: prompt → file selection → update generation → apply → validation
- OS: Windows + WSL2 (recommended)
- GPU: NVIDIA with WSL2 GPU support (32 GB VRAM recommended for 32B models)
- Config: VS Code settings + environment variables
- Security: local-only, no telemetry, no external network calls unless configured

## Example Prompts
- "Add comments to App.tsx"
- "Remove unused imports in Timesheet.tsx"
- "Fix validation errors for this project"
- "How many files are in this repo?"
- "Show me the content of src/main.tsx"

## Performance Notes
- First run includes model warmup (can take minutes)
- Subsequent requests are faster if the model stays loaded
- Large multi-file updates can be slower due to JSON output size

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
- JSON payloads can fail if the model emits invalid JSON
- Very large diffs may slow down LLM responses
- File selection relies on file list + symbol index (no semantic search yet)

## FAQ
**Why does Forge ask me to confirm files?**  
To avoid unintended edits and keep changes explicit.

**Why does validation run automatically?**  
To ensure changes compile/test successfully. You can disable autoValidation.

**Why are multi-file edits slower?**  
The LLM must generate full file contents and JSON for each file.

## Release Notes
v0.1
- Phase 0-5 complete
- UI panel + sidebar
- Multi-file edits + file picker
- Validation + auto-fix

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

Phase 6 - Git Manager (planned)
- Harden commit flow and approvals
- Better diff summaries
- Optional push with explicit consent

## Local Setup

### 1) Prereqs
- Node.js 18+
- VS Code
- Docker Desktop (WSL2 engine enabled)
- NVIDIA drivers with WSL2 GPU support

### 2) Install
```bash
npm install
```

### 3) Start vLLM (Docker Compose)
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

### 4) Configure Forge (VS Code Settings)
Open Settings and search for "Forge".

Key settings:
- forge.llmEndpoint (default: http://127.0.0.1:8000/v1)
- forge.llmModel (default: Qwen/Qwen2.5-Coder-32B-Instruct-AWQ)
- forge.llmApiKey (optional)
- forge.enableMultiFile
- forge.autoValidation
- forge.autoFixValidation
- forge.autoFixMaxRetries
- forge.skipTargetConfirmation
- forge.skipConfirmations
- forge.showDiffPreview
- forge.llmTimeoutMs
- forge.verboseLogs
- forge.keepAliveSeconds
- forge.enableGitWorkflow
- forge.projectSummaryMaxChars
- forge.projectSummaryMaxFiles
- forge.projectSummaryMaxFileBytes
- forge.projectSummaryChunkChars
- forge.projectSummaryMaxChunks
- forge.chatHistoryMaxMessages
- forge.chatHistoryMaxChars
- forge.intentUseLLM

Environment variables:
- FORGE_LLM_ENDPOINT
- FORGE_LLM_MODEL
- FORGE_LLM_API_KEY
- FORGE_LLM_TIMEOUT_MS

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
  "forge.showDiffPreview": false,
  "forge.llmTimeoutMs": 120000,
  "forge.verboseLogs": false,
  "forge.keepAliveSeconds": 0,
  "forge.enableGitWorkflow": false,
  "forge.projectSummaryMaxChars": 12000,
  "forge.projectSummaryMaxFiles": 60,
  "forge.projectSummaryMaxFileBytes": 60000,
  "forge.projectSummaryChunkChars": 6000,
  "forge.projectSummaryMaxChunks": 6,
  "forge.chatHistoryMaxMessages": 8,
  "forge.chatHistoryMaxChars": 8000,
  "forge.intentUseLLM": true
}
```

### 5) Build & Run
```bash
npm run compile
```

- Press F5 to open the Extension Development Host.
- Run "Forge: UI" or click the Forge Activity Bar icon.

## Usage
1) Open a file (single-file mode) or enable multi-file mode.
2) Enter an instruction in the UI.
3) Confirm file selection (multi-file).
4) Review inline diff preview.
5) Apply changes and optionally run validation.

## UI Shortcuts
- Enter: send
- Shift+Enter: newline
- Esc: stop
- Ctrl/Cmd+L: clear
- Ctrl/Cmd+/: focus prompt

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

## Safety Rules
- Multi-file edits require file selection
- No hidden Git actions
- Confirmations are optional (settings)
- Comments are only added when explicitly requested

## LLM Usage Policy
- Context Harvester: NO
- Task Compressor: YES
- Planner: YES
- Tool Executor: NO
- Validation: NO
- Git Execution: NO
- Commit Messages: YES

## Troubleshooting
- If the model fails to start, verify GPU access in Docker and set HUGGING_FACE_HUB_TOKEN.
- If the UI seems stuck, use Esc (stop) and check Output: "Forge".

## Next
If you want to proceed with Phase 6, say the word and I will implement the Git Manager hardening.
