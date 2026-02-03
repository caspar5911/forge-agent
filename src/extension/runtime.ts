/** Forge runtime orchestration for a single instruction run. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logActionPurpose } from '../forge/actionPurpose';
import { buildInlineDiffPreview, getLineChangeSummary } from '../forge/diff';
import {
  detectGitActions,
  maybeRunGitWorkflow,
  runGitActions
} from '../forge/gitActions';
import {
  buildDefaultAssumptions,
  clearPendingDisambiguation,
  determineIntent,
  getPendingDisambiguation,
  maybeClarifyInstruction,
  parseDisambiguationPick
} from '../forge/intent';
import { formatDuration, logOutput } from '../forge/logging';
import { answerQuestion } from '../forge/questions';
import type { ChatHistoryItem } from '../forge/types';
import {
  applyFileUpdates,
  attemptAutoFix,
  requestMultiFileUpdate,
  requestSingleFileUpdate
} from '../forge/updates';
import { maybeRunValidation, runValidationFirstFix } from '../forge/validationFlow';
import type { ForgeUiApi } from '../ui/api';
import type { ForgePanel } from '../ui/panel';
import type { ForgeViewProvider } from '../ui/view';

export type ForgeRuntimeState = {
  lastActiveFile: string | null;
  activeAbortController: AbortController | null;
  panelInstance: ForgePanel | null;
  viewProviderInstance: ForgeViewProvider | null;
  runTimer: NodeJS.Timeout | null;
  pendingClarification: {
    instruction: string;
    questions: string[];
    rounds: number;
  } | null;
};

/** Create a fresh runtime state container for a Forge session. */
export function createForgeRuntimeState(): ForgeRuntimeState {
  return {
    lastActiveFile: null,
    activeAbortController: null,
    panelInstance: null,
    viewProviderInstance: null,
    runTimer: null,
    pendingClarification: null
  };
}

/** Keep the UI updated with the current active file path. */
export function updateActiveFile(state: ForgeRuntimeState, panelApi?: ForgeUiApi): void {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    if (state.lastActiveFile) {
      panelApi?.setActiveFile(state.lastActiveFile);
    } else {
      panelApi?.setActiveFile('None');
    }
    return;
  }

  const activeFilePath = activeEditor.document.uri.fsPath;
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const relativePath = rootPath ? path.relative(rootPath, activeFilePath) : path.basename(activeFilePath);
  state.lastActiveFile = relativePath;
  panelApi?.setActiveFile(relativePath);
}

/** Run the full Forge pipeline for a single instruction. */
export async function runForge(
  state: ForgeRuntimeState,
  instruction: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  history?: ChatHistoryItem[]
): Promise<void> {
  state.activeAbortController?.abort();
  state.activeAbortController = new AbortController();
  const signal = state.activeAbortController.signal;
  const startedAt = Date.now();
  if (state.runTimer) {
    clearInterval(state.runTimer);
  }
  if (panelApi) {
    state.runTimer = setInterval(() => {
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

    setStatus('Checking active editor...');

    const config = vscode.workspace.getConfiguration('forge');
    const enableMultiFile = config.get<boolean>('enableMultiFile') === true;
    let clarificationRounds = 0;
    if (state.pendingClarification) {
      const pendingClarification = state.pendingClarification;
      state.pendingClarification = null;
      clarificationRounds = pendingClarification.rounds;
      instruction = formatClarificationFollowup(
        pendingClarification.instruction,
        pendingClarification.questions,
        instruction
      );
      logOutput(output, panelApi, 'Received clarification answers. Continuing...');
    } else {
      const pending = getPendingDisambiguation();
      if (pending) {
        const pick = parseDisambiguationPick(instruction, pending.length);
        if (pick !== null) {
          const chosen = pending[pick];
          clearPendingDisambiguation();
          instruction = chosen.instruction;
          logOutput(output, panelApi, `Selected option ${pick + 1}: ${chosen.label}`);
        }
      }
    }

    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const gitActions = detectGitActions(instruction);
    if (gitActions.length > 0) {
      if (!rootPath) {
        log('No workspace folder open.');
        void vscode.window.showErrorMessage('Forge: Open a workspace folder first.');
        setStatus('Idle');
        return;
      }
      await runGitActions(gitActions, rootPath, output);
      setStatus('Done');
      return;
    }

    const intent = await determineIntent(instruction, output, panelApi, signal, history);

    const activeEditor = vscode.window.activeTextEditor;
    let activeFilePath: string | null = activeEditor?.document.uri.fsPath ?? null;
    let relativePath: string | null = null;

    if (activeFilePath) {
      relativePath = rootPath ? path.relative(rootPath, activeFilePath) : path.basename(activeFilePath);
    } else if (state.lastActiveFile && rootPath) {
      activeFilePath = path.join(rootPath, state.lastActiveFile);
      relativePath = state.lastActiveFile;
    }

    if (!rootPath) {
      log('No workspace folder open.');
      void vscode.window.showErrorMessage('Forge: Open a workspace folder first.');
      setStatus('Idle');
      return;
    }

    if (intent === 'question') {
      await answerQuestion(instruction, rootPath, output, panelApi, signal, history);
      setStatus('Done');
      return;
    }

    if (intent === 'fix') {
      await runValidationFirstFix(rootPath, instruction, output, panelApi, signal, history);
      setStatus('Done');
      return;
    }

    const clarifyFirst = config.get<boolean>('clarifyBeforeEdit') !== false;
    if (clarifyFirst) {
      const clarification = await maybeClarifyInstruction(
        instruction,
        rootPath,
        output,
        panelApi,
        signal,
        history
      );
      if (clarification && clarification.length > 0) {
        const maxClarifyRounds = Math.max(1, config.get<number>('clarifyMaxRounds') ?? 3);
        const gate = config.get<string>('clarifyOnlyIf') ?? 'very-unclear';
        const shouldBlock =
          gate === 'always' || (gate === 'very-unclear' && clarification.length >= 2);
        if (shouldBlock) {
          const reachedClarifyLimit = clarificationRounds >= maxClarifyRounds;
          if (!reachedClarifyLimit) {
            clearPendingDisambiguation();
            state.pendingClarification = {
              instruction,
              questions: clarification,
              rounds: clarificationRounds + 1
            };
            logOutput(output, panelApi, 'Need clarification before editing:');
            clarification.forEach((question) => logOutput(output, panelApi, `- ${question}`));
            logOutput(output, panelApi, 'Reply with your answers to continue.');
            setStatus('Waiting for clarification');
            return;
          }
          logOutput(
            output,
            panelApi,
            `Clarification limit reached (${maxClarifyRounds}). Proceeding with best effort.`
          );
          const autoAssume = config.get<boolean>('clarifyAutoAssume') === true;
          if (autoAssume || reachedClarifyLimit) {
            const assumptions = buildDefaultAssumptions(clarification, relativePath);
            logOutput(output, panelApi, 'Ambiguous prompt detected. Proceeding with assumptions:');
            assumptions.forEach((line) => logOutput(output, panelApi, `- ${line}`));
            instruction = `${instruction}\n\nAssumptions:\n${assumptions.map((line) => `- ${line}`).join('\n')}`;
          } else if (gate === 'always') {
            logOutput(output, panelApi, 'Need clarification before editing:');
            clarification.forEach((question) => logOutput(output, panelApi, `- ${question}`));
            setStatus('Waiting for clarification');
            return;
          }
        }
      }
    }

    if (!enableMultiFile && (!activeFilePath || !relativePath)) {
      log('No active editor. Open a file to edit first.');
      void vscode.window.showErrorMessage('Forge: Open a file to edit first.');
      setStatus('Idle');
      return;
    }

    const skipConfirmations = config.get<boolean>('skipConfirmations') === true;
    const skipTargetConfirmation = config.get<boolean>('skipTargetConfirmation') === true;

    if (!enableMultiFile && !(skipConfirmations || skipTargetConfirmation)) {
      const confirmTarget = await vscode.window.showWarningMessage(
        `Forge will edit: ${relativePath}. Continue?`,
        'Continue',
        'Cancel'
      );

      if (confirmTarget !== 'Continue') {
        void vscode.window.showInformationMessage('Forge: Cancelled.');
        setStatus('Cancelled');
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
        state.panelInstance,
        state.viewProviderInstance,
        history,
        undefined,
        signal
      );

      if (!updatedFiles || updatedFiles.length === 0) {
        void vscode.window.showInformationMessage('Forge: No changes produced.');
        setStatus('No changes');
        return;
      }

      await logActionPurpose(
        instruction,
        updatedFiles.map((file) => file.relativePath),
        output,
        panelApi,
        signal
      );

      const summaries: string[] = [];
      for (const file of updatedFiles) {
        const summary = getLineChangeSummary(file.original, file.updated, file.relativePath);
        if (summary) {
          summaries.push(summary);
        }
        const inlineDiff = buildInlineDiffPreview(file.original, file.updated, file.relativePath);
        if (inlineDiff && panelApi) {
          panelApi.appendDiff(inlineDiff);
        }
      }
      summaries.forEach((line) => log(line));

      if (!skipConfirmations) {
        const confirmApply = await vscode.window.showWarningMessage(
          `Apply changes to ${updatedFiles.length} files?`,
          'Apply',
          'Cancel'
        );

        if (confirmApply !== 'Apply') {
          void vscode.window.showInformationMessage('Forge: Changes not applied.');
          setStatus('Cancelled');
          return;
        }
      }

      const writeOk = applyFileUpdates(updatedFiles, output, panelApi);
      if (!writeOk) {
        setStatus('Error');
        return;
      }
    } else {
      if (!activeFilePath || !relativePath) {
        log('No active editor. Open a file to edit first.');
        void vscode.window.showErrorMessage('Forge: Open a file to edit first.');
        setStatus('Idle');
        return;
      }
      const updatedFile = await requestSingleFileUpdate(
        activeFilePath,
        relativePath,
        instruction,
        output,
        panelApi,
        history,
        signal
      );

      if (!updatedFile) {
        void vscode.window.showInformationMessage('Forge: No changes produced.');
        setStatus('No changes');
        return;
      }

      await logActionPurpose(instruction, [updatedFile.relativePath], output, panelApi, signal);

      const summary = getLineChangeSummary(
        updatedFile.original,
        updatedFile.updated,
        updatedFile.relativePath
      );
      if (summary) {
        log(summary);
      }
      const inlineDiff = buildInlineDiffPreview(
        updatedFile.original,
        updatedFile.updated,
        updatedFile.relativePath
      );
      if (inlineDiff && panelApi) {
        panelApi.appendDiff(inlineDiff);
      }

      const showDiffPreview = config.get<boolean>('showDiffPreview') !== false;
      if (showDiffPreview) {
        setStatus('Reviewing diff...');
        try {
          const originalUri = vscode.Uri.file(updatedFile.fullPath);
          const updatedDoc = await vscode.workspace.openTextDocument({ content: updatedFile.updated });
          await vscode.commands.executeCommand(
            'vscode.diff',
            originalUri,
            updatedDoc.uri,
            `Forge: Proposed Changes (${updatedFile.relativePath})`
          );
        } catch (error) {
          log(`Diff view error: ${String(error)}`);
        }
      }

      if (!skipConfirmations) {
        const confirmApply = await vscode.window.showWarningMessage(
          'Apply the proposed changes to the file?',
          'Apply',
          'Cancel'
        );

        if (confirmApply !== 'Apply') {
          void vscode.window.showInformationMessage('Forge: Changes not applied.');
          setStatus('Cancelled');
          return;
        }
      }

      try {
        fs.writeFileSync(updatedFile.fullPath, updatedFile.updated, 'utf8');
        void vscode.window.showInformationMessage('Forge: Changes applied.');
      } catch (error) {
        log(`Write error: ${String(error)}`);
        void vscode.window.showErrorMessage('Forge: Failed to write the file.');
        setStatus('Error');
        return;
      }
    }

    if (rootPath) {
      const config = vscode.workspace.getConfiguration('forge');
      const autoFixValidation = config.get<boolean>('autoFixValidation') === true;
      const maxFixRetries = Math.max(0, config.get<number>('autoFixMaxRetries') ?? 0);

      setStatus('Running validation...');
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
            signal
          );
          if (!fixed) {
            break;
          }

          setStatus('Re-running validation...');
          validationResult = await maybeRunValidation(rootPath, output);
          if (validationResult.ok) {
            log('Validation passed after auto-fix.');
            setStatus('Validation passed');
            break;
          }
        }
      }

      if (!validationResult.ok) {
        void vscode.window.showErrorMessage('Forge: Validation failed.');
        setStatus('Validation failed');
        return;
      }

      log('Validation passed.');

      const enableGitWorkflow = config.get<boolean>('enableGitWorkflow') === true;
      if (enableGitWorkflow) {
        setStatus('Git workflow...');
        await maybeRunGitWorkflow(rootPath, output);
      }
    }
  } finally {
    const elapsedMs = Date.now() - startedAt;
    if (state.runTimer) {
      clearInterval(state.runTimer);
      state.runTimer = null;
    }
    if (panelApi) {
      panelApi.setStatus('Done');
    }
    if (!signal.aborted) {
      const doneMessage = `Done in ${formatDuration(elapsedMs)}.`;
      output.appendLine(doneMessage);
      panelApi?.appendLog(doneMessage);
    }
    state.activeAbortController = null;
  }
}

/** Abort any in-flight run and update UI status/logs. */
export function cancelActiveRun(
  state: ForgeRuntimeState,
  panelApi: ForgeUiApi,
  output: vscode.OutputChannel
): void {
  if (state.activeAbortController) {
    state.activeAbortController.abort();
    state.activeAbortController = null;
    panelApi.setStatus('Stopped');
    logOutput(output, panelApi, 'Run stopped.');
  }
}

function formatClarificationFollowup(
  originalInstruction: string,
  questions: string[],
  answers: string
): string {
  const trimmedAnswers = answers.trim();
  const questionBlock = questions.map((item) => `- ${item}`).join('\n');
  return (
    `${originalInstruction}\n\nClarification questions:\n${questionBlock}\n\n` +
    `Clarification answers:\n${trimmedAnswers.length > 0 ? trimmedAnswers : '(no answer provided)'}`
  );
}
