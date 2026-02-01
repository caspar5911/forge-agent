# Forge

Forge is an **on-prem, agentic AI coding system** that turns short natural-language instructions into **safe, validated code changes** inside real repositories.

Forge is **not** a chatbot, autocomplete tool, or demo agent.

It is a **tool-driven, deterministic system** that:

- observes real project state
- plans step-by-step actions
- applies changes via validated diffs
- enforces build/test gates
- integrates with Git **only with explicit human approval**
- fails honestly when requirements are unclear

---

## Core Principles (Non-Negotiable)

- **Agentic, not chat-based**
- **Reality-grounded**
- **Diff-only edits**
- **Validation first**
- **Git is law**
- **No RAG (by design)**

---

## High-Level Architecture

User Instruction  
→ Context Harvester  
→ Task Compressor  
→ Planner (LLM)  
→ Tool Executor + Diff Guard  
→ Validation Gate  
→ Git Manager  
→ DONE or FAIL HONESTLY

---

## Project Structure

src/
extension.ts
context/
compressor/
planner/
tools/
validation/
git/
docs/

---

## Phase-Based Implementation Plan

Forge is built **strictly in phases**. Each phase defines what the system **CAN** and **MUST NOT** do.

---

### PHASE 0 — Foundation (Extension Shell)

**CAN**

- Load as a VS Code extension
- Register `forge.run`
- Show confirmation message

**MUST NOT**

- Use LLMs
- Scan files
- Modify code

Commit:
feat: scaffold minimal Forge VS Code extension shell

---

### PHASE 1 — Context Harvester

**CAN**

- Detect workspace root
- Detect active file
- List files
- Parse package.json
- Detect frameworks

**MUST NOT**

- Use LLMs
- Guess architecture
- Modify files

Commit:
feat(context): add deterministic project context harvester

---

### PHASE 2 — Task Compressor

**CAN**

- Expand short instructions into steps
- Ask clarifying questions

**MUST NOT**

- Read or modify files
- Execute tools

Commit:
feat(compressor): expand short instructions into explicit task plans

---

### PHASE 3 — Planner

**CAN**

- Emit one tool call at a time
- Use LLM for decisions

**MUST NOT**

- Modify files
- Skip steps

Commit:
feat(planner): add step-by-step planning engine

---

### PHASE 4 — Tool Executor + Diff Guard

**CAN**

- Read files
- Apply unified diffs
- Execute commands

**MUST NOT**

- Use LLMs
- Touch Git

Commit:
feat(tools): add diff-based tool executor with safety guards

---

### PHASE 5 — Validation Gate

**CAN**

- Run build/test/typecheck
- Fail on errors

**MUST NOT**

- Ignore failures
- Commit code

Commit:
feat(validation): enforce build and test validation gates

---

### PHASE 6 — Git Manager

**CAN**

- Generate commit messages
- Commit with approval
- Push branches (explicit)

**MUST NOT**

- Auto-commit
- Auto-push

Commit:
feat(git): add explicit commit and push workflow

---

### PHASE 7 — UX Polish

**CAN**

- Add progress indicators
- Improve logs

**MUST NOT**

- Add intelligence
- Add automation

Commit:
chore(ux): improve command UX and progress feedback

---

## LLM Usage Policy

| Subsystem         | LLM |
| ----------------- | --- |
| Context Harvester | ❌  |
| Task Compressor   | ✅  |
| Planner           | ✅  |
| Tool Executor     | ❌  |
| Validation        | ❌  |
| Git Execution     | ❌  |
| Commit Messages   | ✅  |

---

## Definition of Done

- Short prompts work
- Multi-file edits succeed
- Validation gates enforced
- Git approval required
- Honest failures only

---

## Philosophy

Correctness over convenience.  
No hidden automation.  
No silent failures.
