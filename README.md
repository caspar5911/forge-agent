# Forge (Phase 0)

Minimal VS Code extension shell for Forge. This phase only verifies the extension activates and a single command runs.

## Requirements
- Node.js 18+
- VS Code

## Setup
```bash
npm install
```

## Build
```bash
npm run compile
```

## Run (Extension Development Host)
1. Open this folder in VS Code.
2. Press `F5` to start the Extension Development Host.
3. In the new window, open the Command Palette (`Ctrl+Shift+P`).
4. Run **Forge: Run**.

You should see the message: `Forge is alive`.

## Stop
- Close the Extension Development Host window.
- In the original VS Code window, click Stop or press `Shift+F5`.
