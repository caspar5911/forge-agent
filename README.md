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

**Core Flow**
- Understand intent (edit, question, fix) with LLM + rules
- Explicit file edits override fix intent when a prompt names files
- Clarify missing requirements (optional)
- Plan summary (short, user-visible)
- Tool-aware preflight (read/diff/validate) for grounding
- Edit single or multiple files with strict JSON output
- Validate and auto-fix if requested
- Verify changes against requirements
- Produce a human summary

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
- Structured JSON outputs validated against JSON Schema (Ajv), with repair fallback + silent retries
- Two-call flow: machine JSON first, then a separate human summary
- Chunked update requests for reliability on large edits
- Plan-then-execute summaries (short plan shown before edits)
- Model routing for plan/verify/summary calls (optional stronger model for reasoning)
- Self-verification pass after edits (flags unmet requirements)
- Agent loop for fixes (diagnose -> edit -> re-test -> repeat)
- Context-first editing (auto-snippets from relevant files)
- Optional embeddings index for repo retrieval with relevance gating (`.forge/embeddings.json`)
- Semantic re-ranking for retrieval (LLM-assisted fallback when embeddings are disabled)
- Persistent run memory with compaction (`.forge/memory.json`) injected into prompts
- Token budget enforcement (auto-trim + retry on context-length errors)
- Tool-aware preflight (read file / diff / validation to ground edits)
- Evaluation harness with regression snapshots (`eval/results/`)
- Repo-specific eval harness (`eval/repo-tasks.json`, `npm run eval:repo`)
- Inline "Peek" panel showing steps, prompts, raw JSON payloads, diffs, and validation output (system prompts hidden; secrets redacted)
- Basename disambiguation (prefers `src/` when duplicates exist)
- Assumptions are surfaced for confirmation after edits

**Limits**
- No hidden Git actions
- No background code execution
- No file edits without explicit approval (unless `forge.skipConfirmations` is enabled)
- File edits require JSON payloads (no partial patch streaming)
- Depth-limited workspace scan for large repos
- Peek output truncates large payloads for safety
- Backends vary in structured-output features; Forge enforces JSON via prompts, validates against JSON Schema, and retries with stricter instructions when needed
- Planning/verification adds extra LLM calls (slower but more reliable)
- Token trimming can drop older context when requests exceed the model limit
- Embeddings index build is best-effort and can be slow on large repos
- Validation-first fix mode continues with edits if the prompt explicitly requests changes

**Architecture**
- `src/extension.ts`: command wiring, UI registration, lifecycle hooks
- `src/extension/runtime.ts`: run orchestration and state management
- `src/extension/lifecycle.ts`: settings sync + keep-alive
- `src/forge/`: intent detection, file selection, updates, validation, Git actions
- `src/forge/memory.ts`: persistent run memory + compaction
- `src/forge/embeddingsIndex.ts`: repo embeddings index + vector search
- `src/ui/`: webview UI, panel, sidebar view
- `src/llm/`: LangChain-based OpenAI-compatible chat adapter, structured JSON (Ajv), token budget
- `src/context/`, `src/indexer/`, `src/validation/`, `src/git/`: context, symbol index, validation, Git helpers

## Quickstart (Local Setup)

**1) Prereqs**
- Node.js 18+
- VS Code
- Docker Desktop (WSL2 engine enabled)
- NVIDIA drivers with WSL2 GPU support

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

Example settings (minimal):
```json
{
  "forge.profile": "auto",
  "forge.llmEndpoint": "http://127.0.0.1:8000/v1",
  "forge.llmModel": "Qwen/Qwen2.5-Coder-32B-Instruct-AWQ",
  "forge.enableMultiFile": true
}
```

**Profiles**
- `auto`: fastest flow, minimal prompts, auto-accepts clarification proposals, still confirms Git actions
- `balanced`: safer defaults with confirmations and clarification checks
- `manual`: ask before most actions

## LLM Backends

**Ollama (local, OpenAI-compatible API)**
Ollama exposes an OpenAI-compatible API at `http://localhost:11434/v1` and expects a local model name that you have pulled.

Pull a model:
```bash
ollama pull gpt-oss:20b
```

Point Forge at Ollama:
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

## Evaluation
Run the built-in prompt suite and write snapshots to `eval/results/`:
```bash
npm run eval
```
The latest run is stored in `eval/results/latest.json`.

Run the repo-specific task suite from `eval/repo-tasks.json`:
```bash
npm run eval:repo
```
The latest run is stored in `eval/results/repo-latest.json`.

## Settings Reference

**Core LLM**
- `forge.llmEndpoint`: Base URL for the local LLM server (OpenAI-compatible)
- `forge.llmModel`: Model name to send in chat completion requests
- `forge.llmApiKey`: Optional API key for the local LLM server
- `forge.llmTimeoutMs`: Timeout in milliseconds for LLM requests
- `forge.profile`: Behavior profile (`auto`, `balanced`, `manual`)

**Model Routing**
- `forge.llmPlanModel`: Override model for planning calls
- `forge.llmPlanEndpoint`: Override endpoint for planning calls
- `forge.llmPlanApiKey`: Override API key for planning calls
- `forge.llmVerifyModel`: Override model for verification calls
- `forge.llmVerifyEndpoint`: Override endpoint for verification calls
- `forge.llmVerifyApiKey`: Override API key for verification calls
- `forge.llmSummaryModel`: Override model for summary calls
- `forge.llmSummaryEndpoint`: Override endpoint for summary calls
- `forge.llmSummaryApiKey`: Override API key for summary calls

**Editing and Confirmation**
- `forge.enableMultiFile`: Allow the LLM to edit multiple files in one run
- `forge.skipTargetConfirmation`: Skip the confirmation prompt before editing the active file
- `forge.skipConfirmations`: Automatically accept confirmation prompts
- `forge.showDiffPreview`: Show a diff preview tab before applying changes
- `forge.skipCreateFilePicker`: Skip the file picker when creating new files
- `forge.maxFilesPerUpdate`: Maximum files per update request
- `forge.maxUpdateChars`: Maximum approximate characters per update request

**Validation and Auto-fix**
- `forge.autoValidation`: Automatically select and run the best validation command
- `forge.autoValidationMode`: Run `all` checks or `smart` checks inferred from the instruction
- `forge.autoFixValidation`: Attempt auto-fix on validation failures
- `forge.autoFixMaxRetries`: Maximum auto-fix attempts
- `forge.bestEffortFix`: Allow best-effort fixes (deps + missing files)
- `forge.autoAddDependencies`: Auto-add missing dependencies to package.json
- `forge.autoCreateMissingFiles`: Auto-create missing files for relative imports
- `forge.autoInstallDependencies`: Run install when package.json changes

**Clarification**
- `forge.clarifyBeforeEdit`: Ask clarifying questions for ambiguous prompts
- `forge.clarifySuggestAnswers`: Propose best-guess answers
- `forge.clarifyConfirmSuggestions`: Require user confirmation of proposed answers
- `forge.clarifyMaxQuestions`: Maximum clarification questions per round
- `forge.clarifyMaxRounds`: Maximum clarification rounds
- `forge.clarifyOnlyIf`: Block only when very unclear (`always` or `very-unclear`)
- `forge.clarifyAutoAssume`: Proceed with safe defaults after clarification limit

**Q&A**
- `forge.qaMinSources`: Minimum sources required for answers
- `forge.qaMaxFiles`: Maximum files to scan for Q&A
- `forge.qaMaxSnippets`: Maximum snippets to include in Q&A prompts
- `forge.qaSnippetLines`: Context lines above/below a hit
- `forge.qaMaxFileBytes`: Maximum file size to read for Q&A

**Memory**
- `forge.enableMemory`: Persist run memory to `.forge/memory.json`
- `forge.memoryMaxEntries`: Maximum recent memory entries to keep
- `forge.memoryMaxChars`: Maximum characters injected from memory
- `forge.memoryCompactionTargetEntries`: Entries to keep when compacting memory
- `forge.memoryIncludeCompacted`: Include compacted summary in prompts

**Embeddings**
- `forge.embeddingEnabled`: Enable embeddings-based retrieval
- `forge.embeddingModel`: Embedding model name (OpenAI-compatible)
- `forge.embeddingEndpoint`: Embedding endpoint base URL
- `forge.embeddingApiKey`: Embedding API key
- `forge.embeddingTimeoutMs`: Timeout in milliseconds for embedding requests
- `forge.embeddingMaxFiles`: Maximum files to embed for the repo index
- `forge.embeddingMaxFileBytes`: Maximum file size to embed
- `forge.embeddingChunkChars`: Approximate characters per embedding chunk
- `forge.embeddingTopK`: Maximum embedding hits to inject
- `forge.embeddingMinScore`: Minimum cosine similarity score for a hit

**Git**
- `forge.enableGitWorkflow`: Enable the Git workflow after changes
- `forge.gitStageMode`: Stage all files or select files
- `forge.gitAutoMessage`: Generate a commit message
- `forge.gitMessageStyle`: Commit style (`conventional` or `plain`)
- `forge.gitAutoPush`: Allow automatic push when confirmations are skipped
- `forge.gitIntentMode`: Git intent detection (`disabled`, `explicit`, `smart`)
- `forge.gitConfirmActions`: Confirm before running Git actions

**Context and History**
- `forge.projectSummaryMaxChars`: Maximum chars for project summary
- `forge.projectSummaryMaxFiles`: Maximum files for project summary
- `forge.projectSummaryMaxFileBytes`: Maximum size of a summary file
- `forge.projectSummaryChunkChars`: Max chars per summary chunk
- `forge.projectSummaryMaxChunks`: Maximum summary chunks
- `forge.chatHistoryMaxMessages`: Max chat messages to include
- `forge.chatHistoryMaxChars`: Max total chars of chat history

**Flags and Logging**
- `forge.intentUseLLM`: Use LLM to classify prompt intent
- `forge.verboseLogs`: Enable verbose diagnostic logs
- `forge.keepAliveSeconds`: Ping LLM every N seconds to keep it warm

## Environment Variables
- `FORGE_LLM_ENDPOINT`
- `FORGE_LLM_MODEL`
- `FORGE_LLM_API_KEY`
- `FORGE_LLM_TIMEOUT_MS`
- `FORGE_LLM_MAX_INPUT_TOKENS` (auto-trim input before send)
- `FORGE_LLM_MODEL_PLAN`
- `FORGE_LLM_ENDPOINT_PLAN`
- `FORGE_LLM_API_KEY_PLAN`
- `FORGE_LLM_MODEL_VERIFY`
- `FORGE_LLM_ENDPOINT_VERIFY`
- `FORGE_LLM_API_KEY_VERIFY`
- `FORGE_LLM_MODEL_SUMMARY`
- `FORGE_LLM_ENDPOINT_SUMMARY`
- `FORGE_LLM_API_KEY_SUMMARY`

## Known Issues / Limitations
- JSON payloads can still fail on very large outputs, even with retries
- Very large diffs may slow down LLM responses
- Embeddings are optional; retrieval falls back to keyword + LLM re-ranking when disabled
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

## Security and Privacy
- Runs fully on-prem
- No telemetry by default
- API keys stored in VS Code settings or environment variables

## Release Notes
v0.1
- Phase 0-6 complete
- UI panel + sidebar
- Multi-file edits + file picker
- Validation + auto-fix
