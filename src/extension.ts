// Forge extension entrypoint: wiring + orchestration only.
// Most heavy logic lives in helper modules under src/forge/.
// Node utilities for filesystem access and paths.
import * as fs from "fs";
import * as path from "path";
// VS Code extension API.
import * as vscode from "vscode";
// Context harvester for Phase 1.
import { harvestContext, type ProjectContext } from "./context";
import { logActionPurpose } from "./forge/actionPurpose";
import {
  detectGitActions,
  maybeRunGitWorkflow,
  runGitActions,
  runGitCommit,
  runGitPush,
  runGitStage,
} from "./forge/gitActions";
import {
  buildDefaultAssumptions,
  clearPendingDisambiguation,
  determineIntent,
  getPendingDisambiguation,
  maybeClarifyInstruction,
  maybePickDisambiguation,
  parseDisambiguationPick,
} from "./forge/intent";
import { answerQuestion } from "./forge/questions";
import type { ChatHistoryItem } from "./forge/types";
import {
  applyFileUpdates,
  attemptAutoFix,
  requestMultiFileUpdate,
  requestSingleFileUpdate,
} from "./forge/updates";
import {
  maybeRunValidation,
  runValidationFirstFix,
} from "./forge/validationFlow";
import { pingLLM } from "./llm/client";
import type { ForgeUiApi } from "./ui/api";
import { ForgePanel } from "./ui/panel";
import { ForgeViewProvider } from "./ui/view";
import { startWorkspaceIndexing } from "./indexer/workspaceIndex";
import { buildInlineDiffPreview, getLineChangeSummary } from "./forge/diff";
import { formatDuration, logOutput } from "./forge/logging";

let lastActiveFile: string | null = null;
let activeAbortController: AbortController | null = null;
let panelInstance: ForgePanel | null = null;
let viewProviderInstance: ForgeViewProvider | null = null;
let runTimer: NodeJS.Timeout | null = null;
let keepAliveTimer: NodeJS.Timeout | null = null;

// Extension activation: commands, UI, and watchers.
export function activate(context: vscode.ExtensionContext): void {
  // Output channel visible in View -> Output.
  const output = vscode.window.createOutputChannel("Forge");
  let panelApi: ForgeUiApi | undefined;

  // Sync VS Code settings into env vars for shared LLM configuration.
  applyLLMSettingsToEnv();
  const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("forge")) {
      applyLLMSettingsToEnv();
      startKeepAlive();
    }
  });

  startWorkspaceIndexing(context);
  startKeepAlive();

  // Register the Forge run command (input box).
  const runCommand = vscode.commands.registerCommand("forge.run", async () => {
    const instruction = await vscode.window.showInputBox({
      prompt: "What should Forge do in the active file?",
      placeHolder: "e.g., Add a create order button",
    });

    if (!instruction) {
      void vscode.window.showInformationMessage(
        "Forge: No instruction provided.",
      );
      return;
    }

    await runForge(instruction, output);
  });

  // Register the Forge UI command (webview panel).
  const uiCommand = vscode.commands.registerCommand("forge.ui", () => {
    const panel = ForgePanel.createOrShow();
    panelInstance = panel;
    const api = panel.getApi();
    panelApi = api;
    api.setStatus("Idle");
    panel.setHandler((instruction, history) => {
      void runForge(instruction, output, api, history);
    });
    panel.setStopHandler(() => {
      cancelActiveRun(api, output);
    });
    updateActiveFile(api);
  });

  const viewProvider = new ForgeViewProvider(context.extensionUri);
  viewProviderInstance = viewProvider;
  const viewRegistration = vscode.window.registerWebviewViewProvider(
    ForgeViewProvider.viewType,
    viewProvider,
  );
  viewProvider.setHandler((instruction, history) => {
    void runForge(instruction, output, viewProvider.getApi(), history);
  });
  viewProvider.setStopHandler(() => {
    cancelActiveRun(viewProvider.getApi(), output);
  });
  viewProvider.setReadyHandler(() => {
    updateActiveFile(viewProvider.getApi());
  });

  // Register the Forge context command (Phase 1 harvesting).
  const contextCommand = vscode.commands.registerCommand(
    "forge.context",
    () => {
      const contextObject = harvestContext();
      logContext(output, contextObject);
      void vscode.window.showInformationMessage("Forge context captured.");
    },
  );

  const gitStageCommand = vscode.commands.registerCommand(
    "forge.gitStage",
    async () => {
      const rootPath =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
      if (!rootPath) {
        void vscode.window.showErrorMessage(
          "Forge: Open a workspace folder first.",
        );
        return;
      }
      await runGitStage(rootPath, output);
    },
  );

  const gitCommitCommand = vscode.commands.registerCommand(
    "forge.gitCommit",
    async () => {
      const rootPath =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
      if (!rootPath) {
        void vscode.window.showErrorMessage(
          "Forge: Open a workspace folder first.",
        );
        return;
      }
      await runGitCommit(rootPath, output);
    },
  );

  const gitPushCommand = vscode.commands.registerCommand(
    "forge.gitPush",
    async () => {
      const rootPath =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
      if (!rootPath) {
        void vscode.window.showErrorMessage(
          "Forge: Open a workspace folder first.",
        );
        return;
      }
      await runGitPush(rootPath, output);
    },
  );

  const activeEditorWatcher = vscode.window.onDidChangeActiveTextEditor(() => {
    updateActiveFile(panelApi);
    updateActiveFile(viewProvider.getApi());
  });

  // Dispose commands when the extension deactivates.
  context.subscriptions.push(
    runCommand,
    uiCommand,
    viewRegistration,
    contextCommand,
    gitStageCommand,
    gitCommitCommand,
    gitPushCommand,
    configWatcher,
    activeEditorWatcher,
  );
}

export function deactivate(): void {}

// Keep the UI updated with the current active file.
function updateActiveFile(panelApi?: ForgeUiApi): void {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    if (lastActiveFile) {
      panelApi?.setActiveFile(lastActiveFile);
    } else {
      panelApi?.setActiveFile("None");
    }
    return;
  }

  const activeFilePath = activeEditor.document.uri.fsPath;
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const relativePath = rootPath
    ? path.relative(rootPath, activeFilePath)
    : path.basename(activeFilePath);
  lastActiveFile = relativePath;
  panelApi?.setActiveFile(relativePath);
}

// Main orchestration pipeline for a single instruction.
async function runForge(
  instruction: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  history?: ChatHistoryItem[],
): Promise<void> {
  activeAbortController?.abort();
  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;
  const startedAt = Date.now();
  if (runTimer) {
    clearInterval(runTimer);
  }
  if (panelApi) {
    runTimer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      panelApi.setStatus(`Running ${formatDuration(elapsedMs)}`);
    }, 1000);
  }
  try {
    output.clear();
    output.show(true);

    const setStatus = (text: string) => {
      panelApi?.setStatus(text);
    };

    const log = (text: string) => {
      output.appendLine(text);
      panelApi?.appendLog(text);
    };

    setStatus("Checking active editor...");

    const config = vscode.workspace.getConfiguration("forge");
    const enableMultiFile = config.get<boolean>("enableMultiFile") === true;
    const pending = getPendingDisambiguation();
    if (pending) {
      const pick = parseDisambiguationPick(instruction, pending.length);
      if (pick !== null) {
        const chosen = pending[pick];
        clearPendingDisambiguation();
        instruction = chosen.instruction;
        logOutput(
          output,
          panelApi,
          `Selected option ${pick + 1}: ${chosen.label}`,
        );
      }
    }

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const gitActions = detectGitActions(instruction);
    if (gitActions.length > 0) {
      if (!rootPath) {
        log("No workspace folder open.");
        void vscode.window.showErrorMessage(
          "Forge: Open a workspace folder first.",
        );
        setStatus("Idle");
        return;
      }
      await runGitActions(gitActions, rootPath, output);
      setStatus("Done");
      return;
    }

    const intent = await determineIntent(
      instruction,
      output,
      panelApi,
      signal,
      history,
    );

    const activeEditor = vscode.window.activeTextEditor;
    let activeFilePath: string | null =
      activeEditor?.document.uri.fsPath ?? null;
    let relativePath: string | null = null;

    if (activeFilePath) {
      relativePath = rootPath
        ? path.relative(rootPath, activeFilePath)
        : path.basename(activeFilePath);
    } else if (lastActiveFile && rootPath) {
      activeFilePath = path.join(rootPath, lastActiveFile);
      relativePath = lastActiveFile;
    }

    if (!rootPath) {
      log("No workspace folder open.");
      void vscode.window.showErrorMessage(
        "Forge: Open a workspace folder first.",
      );
      setStatus("Idle");
      return;
    }

    if (intent === "question") {
      await answerQuestion(
        instruction,
        rootPath,
        output,
        panelApi,
        signal,
        history,
      );
      setStatus("Done");
      return;
    }

    if (intent === "fix") {
      await runValidationFirstFix(
        rootPath,
        instruction,
        output,
        panelApi,
        signal,
        history,
      );
      setStatus("Done");
      return;
    }

    const clarifyFirst = config.get<boolean>("clarifyBeforeEdit") !== false;
    if (clarifyFirst) {
      const clarification = await maybeClarifyInstruction(
        instruction,
        rootPath,
        output,
        panelApi,
        signal,
        history,
      );
      if (clarification && clarification.length > 0) {
        const gate = config.get<string>("clarifyOnlyIf") ?? "very-unclear";
        const shouldBlock =
          gate === "always" ||
          (gate === "very-unclear" && clarification.length >= 2);
        if (shouldBlock) {
          const autoAssume = config.get<boolean>("clarifyAutoAssume") === true;
          if (gate === "very-unclear") {
            const picked = await maybePickDisambiguation(
              instruction,
              rootPath,
              output,
              panelApi,
              signal,
            );
            if (picked) {
              instruction = `${instruction}\n\nClarified intent:\n${picked}`;
            } else if (!autoAssume) {
              logOutput(output, panelApi, "Need clarification before editing:");
              clarification.forEach((question) =>
                logOutput(output, panelApi, `- ${question}`),
              );
              setStatus("Waiting for clarification");
              return;
            }
          }
          if (autoAssume) {
            const assumptions = buildDefaultAssumptions(
              clarification,
              relativePath,
            );
            logOutput(
              output,
              panelApi,
              "Ambiguous prompt detected. Proceeding with assumptions:",
            );
            assumptions.forEach((line) =>
              logOutput(output, panelApi, `- ${line}`),
            );
            instruction = `${instruction}\n\nAssumptions:\n${assumptions.map((line) => `- ${line}`).join("\n")}`;
          } else if (gate === "always") {
            logOutput(output, panelApi, "Need clarification before editing:");
            clarification.forEach((question) =>
              logOutput(output, panelApi, `- ${question}`),
            );
            setStatus("Waiting for clarification");
            return;
          }
        }
      }
    }

    if (!enableMultiFile && (!activeFilePath || !relativePath)) {
      log("No active editor. Open a file to edit first.");
      void vscode.window.showErrorMessage("Forge: Open a file to edit first.");
      setStatus("Idle");
      return;
    }

    const skipConfirmations = config.get<boolean>("skipConfirmations") === true;
    const skipTargetConfirmation =
      config.get<boolean>("skipTargetConfirmation") === true;

    if (!enableMultiFile && !(skipConfirmations || skipTargetConfirmation)) {
      const confirmTarget = await vscode.window.showWarningMessage(
        `Forge will edit: ${relativePath}. Continue?`,
        "Continue",
        "Cancel",
      );

      if (confirmTarget !== "Continue") {
        void vscode.window.showInformationMessage("Forge: Cancelled.");
        setStatus("Cancelled");
        return;
      }
    }

    if (enableMultiFile) {
      const updatedFiles = await requestMultiFileUpdate(
        rootPath,
        instruction,
        relativePath,
        output,
        panelApi,
        panelInstance,
        viewProviderInstance,
        history,
        undefined,
        signal,
      );

      if (!updatedFiles || updatedFiles.length === 0) {
        void vscode.window.showInformationMessage(
          "Forge: No changes produced.",
        );
        setStatus("No changes");
        return;
      }

      await logActionPurpose(
        instruction,
        updatedFiles.map((file) => file.relativePath),
        output,
        panelApi,
        signal,
      );

      const summaries: string[] = [];
      for (const file of updatedFiles) {
        const summary = getLineChangeSummary(
          file.original,
          file.updated,
          file.relativePath,
        );
        if (summary) {
          summaries.push(summary);
        }
        const inlineDiff = buildInlineDiffPreview(
          file.original,
          file.updated,
          file.relativePath,
        );
        if (inlineDiff && panelApi) {
          panelApi.appendDiff(inlineDiff);
        }
      }
      summaries.forEach((line) => log(line));

      if (!skipConfirmations) {
        const confirmApply = await vscode.window.showWarningMessage(
          `Apply changes to ${updatedFiles.length} files?`,
          "Apply",
          "Cancel",
        );

        if (confirmApply !== "Apply") {
          void vscode.window.showInformationMessage(
            "Forge: Changes not applied.",
          );
          setStatus("Cancelled");
          return;
        }
      }

      const writeOk = applyFileUpdates(updatedFiles, output, panelApi);
      if (!writeOk) {
        setStatus("Error");
        return;
      }
    } else {
      if (!activeFilePath || !relativePath) {
        log("No active editor. Open a file to edit first.");
        void vscode.window.showErrorMessage(
          "Forge: Open a file to edit first.",
        );
        setStatus("Idle");
        return;
      }
      const updatedFile = await requestSingleFileUpdate(
        activeFilePath,
        relativePath,
        instruction,
        output,
        panelApi,
        history,
        signal,
      );

      if (!updatedFile) {
        void vscode.window.showInformationMessage(
          "Forge: No changes produced.",
        );
        setStatus("No changes");
        return;
      }

      await logActionPurpose(
        instruction,
        [updatedFile.relativePath],
        output,
        panelApi,
        signal,
      );

      const summary = getLineChangeSummary(
        updatedFile.original,
        updatedFile.updated,
        updatedFile.relativePath,
      );
      if (summary) {
        log(summary);
      }
      const inlineDiff = buildInlineDiffPreview(
        updatedFile.original,
        updatedFile.updated,
        updatedFile.relativePath,
      );
      if (inlineDiff && panelApi) {
        panelApi.appendDiff(inlineDiff);
      }

      const showDiffPreview = config.get<boolean>("showDiffPreview") !== false;
      if (showDiffPreview) {
        setStatus("Reviewing diff...");
        try {
          const originalUri = vscode.Uri.file(updatedFile.fullPath);
          const updatedDoc = await vscode.workspace.openTextDocument({
            content: updatedFile.updated,
          });
          await vscode.commands.executeCommand(
            "vscode.diff",
            originalUri,
            updatedDoc.uri,
            `Forge: Proposed Changes (${updatedFile.relativePath})`,
          );
        } catch (error) {
          log(`Diff view error: ${String(error)}`);
        }
      }

      if (!skipConfirmations) {
        const confirmApply = await vscode.window.showWarningMessage(
          "Apply the proposed changes to the file?",
          "Apply",
          "Cancel",
        );

        if (confirmApply !== "Apply") {
          void vscode.window.showInformationMessage(
            "Forge: Changes not applied.",
          );
          setStatus("Cancelled");
          return;
        }
      }

      try {
        fs.writeFileSync(updatedFile.fullPath, updatedFile.updated, "utf8");
        void vscode.window.showInformationMessage("Forge: Changes applied.");
      } catch (error) {
        log(`Write error: ${String(error)}`);
        void vscode.window.showErrorMessage("Forge: Failed to write the file.");
        setStatus("Error");
        return;
      }
    }

    if (rootPath) {
      const config = vscode.workspace.getConfiguration("forge");
      const autoFixValidation =
        config.get<boolean>("autoFixValidation") === true;
      const maxFixRetries = Math.max(
        0,
        config.get<number>("autoFixMaxRetries") ?? 0,
      );

      setStatus("Running validation...");
      let validationResult = await maybeRunValidation(rootPath, output);

      if (!validationResult.ok && autoFixValidation && maxFixRetries > 0) {
        for (let attempt = 1; attempt <= maxFixRetries; attempt += 1) {
          log(`Auto-fix attempt ${attempt} of ${maxFixRetries}...`);
          setStatus(`Auto-fix ${attempt}/${maxFixRetries}`);
          const fixed = await attemptAutoFix(
            rootPath,
            instruction,
            validationResult.output,
            output,
            panelApi,
            history,
            signal,
          );
          if (!fixed) {
            break;
          }

          setStatus("Re-running validation...");
          validationResult = await maybeRunValidation(rootPath, output);
          if (validationResult.ok) {
            log("Validation passed after auto-fix.");
            setStatus("Validation passed");
            break;
          }
        }
      }

      if (!validationResult.ok) {
        void vscode.window.showErrorMessage("Forge: Validation failed.");
        setStatus("Validation failed");
        return;
      }

      log("Validation passed.");

      const enableGitWorkflow =
        config.get<boolean>("enableGitWorkflow") === true;
      if (enableGitWorkflow) {
        setStatus("Git workflow...");
        await maybeRunGitWorkflow(rootPath, output);
      }
    }
  } finally {
    const elapsedMs = Date.now() - startedAt;
    if (runTimer) {
      clearInterval(runTimer);
      runTimer = null;
    }
    if (panelApi) {
      panelApi.setStatus("Done");
    }
    if (!signal.aborted) {
      const doneMessage = `Done in ${formatDuration(elapsedMs)}.`;
      output.appendLine(doneMessage);
      panelApi?.appendLog(doneMessage);
    }
    activeAbortController = null;
  }
}

// Dump the harvested context into the Output panel.
function logContext(
  output: vscode.OutputChannel,
  contextObject: ProjectContext,
): void {
  output.clear();
  output.appendLine(JSON.stringify(contextObject, null, 2));
  output.show(true);
}

// Read VS Code settings and sync them into env vars for the LLM client.
function applyLLMSettingsToEnv(): void {
  const config = vscode.workspace.getConfiguration("forge");
  const endpoint = config.get<string>("llmEndpoint");
  const model = config.get<string>("llmModel");
  const apiKey = config.get<string>("llmApiKey");
  const timeoutMs = config.get<number>("llmTimeoutMs");

  if (endpoint && endpoint.trim().length > 0) {
    process.env.FORGE_LLM_ENDPOINT = endpoint.trim();
  }
  if (model && model.trim().length > 0) {
    process.env.FORGE_LLM_MODEL = model.trim();
  }
  if (apiKey && apiKey.trim().length > 0) {
    process.env.FORGE_LLM_API_KEY = apiKey.trim();
  }
  if (timeoutMs && Number.isFinite(timeoutMs)) {
    process.env.FORGE_LLM_TIMEOUT_MS = String(timeoutMs);
  }
}

// Keep the LLM warm by pinging it on a timer.
function startKeepAlive(): void {
  const config = vscode.workspace.getConfiguration("forge");
  const intervalSeconds = config.get<number>("keepAliveSeconds") ?? 0;
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (!intervalSeconds || intervalSeconds <= 0) {
    return;
  }
  keepAliveTimer = setInterval(() => {
    void pingLLM().catch(() => undefined);
  }, intervalSeconds * 1000);
}

function cancelActiveRun(
  panelApi: ForgeUiApi,
  output: vscode.OutputChannel,
): void {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
    panelApi.setStatus("Stopped");
    logOutput(output, panelApi, "Run stopped.");
  }
}
