/** Forge runtime orchestration for a single instruction run. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logActionPurpose } from '../forge/actionPurpose';
import { buildInlineDiffPreview, getLineChangeSummary } from '../forge/diff';
import {
  maybeDetectGitActions,
  maybeRunGitWorkflow,
  runGitActions
} from '../forge/gitActions';
import {
  buildDefaultAssumptions,
  clearPendingDisambiguation,
  determineIntent,
  getPendingDisambiguation,
  maybeClarifyInstruction,
  maybeSuggestClarificationAnswers,
  parseDisambiguationPick
} from '../forge/intent';
import { formatDuration, logOutput } from '../forge/logging';
import { answerQuestion } from '../forge/questions';
import { getForgeSetting } from '../forge/settings';
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
  pendingClarificationProposal: {
    instruction: string;
    questions: string[];
    proposedAnswers: string[];
    proposedPlan: string[];
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
    pendingClarification: null,
    pendingClarificationProposal: null
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

    const enableMultiFile = getForgeSetting<boolean>('enableMultiFile') === true;
    let clarificationRounds = 0;
    let forceEditAfterClarification = false;
    let skipClarifyCheck = false;
    if (state.pendingClarificationProposal) {
      const proposal = state.pendingClarificationProposal;
      state.pendingClarificationProposal = null;
      clarificationRounds = proposal.rounds;
      const decision = parseClarificationDecision(instruction);
      if (decision === 'accept') {
        instruction = formatClarificationProposal(
          proposal.instruction,
          proposal.questions,
          proposal.proposedAnswers,
          proposal.proposedPlan
        );
        forceEditAfterClarification = true;
        skipClarifyCheck = true;
        logOutput(output, panelApi, 'Using proposed answers. Continuing...');
      } else if (decision === 'reject') {
        state.pendingClarification = {
          instruction: proposal.instruction,
          questions: proposal.questions,
          rounds: proposal.rounds
        };
        logOutput(output, panelApi, 'Please answer the clarification questions to continue:');
        proposal.questions.forEach((question) => logOutput(output, panelApi, `- ${question}`));
        setStatus('Waiting for clarification');
        return;
      } else {
        instruction = formatClarificationFollowup(
          proposal.instruction,
          proposal.questions,
          instruction
        );
        forceEditAfterClarification = true;
        skipClarifyCheck = true;
        logOutput(output, panelApi, 'Received clarification answers. Continuing...');
      }
    } else if (state.pendingClarification) {
      const pendingClarification = state.pendingClarification;
      state.pendingClarification = null;
      clarificationRounds = pendingClarification.rounds;
      instruction = formatClarificationFollowup(
        pendingClarification.instruction,
        pendingClarification.questions,
        instruction
      );
      forceEditAfterClarification = true;
      skipClarifyCheck = true;
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
    const gitActions = await maybeDetectGitActions(instruction, output);
    if (gitActions.length > 0) {
      if (!rootPath) {
        log('No workspace folder open.');
        void vscode.window.showErrorMessage('Forge: Open a workspace folder first.');
        setStatus('Idle');
        return;
      }
      const confirmGitActions = getForgeSetting<boolean>('gitConfirmActions') !== false;
      if (confirmGitActions) {
        const label = gitActions.map((action) => action.type).join(', ');
        const confirm = await vscode.window.showWarningMessage(
          `Run Git action(s): ${label}?`,
          'Run',
          'Cancel'
        );
        if (confirm !== 'Run') {
          void vscode.window.showInformationMessage('Forge: Git actions cancelled.');
          setStatus('Cancelled');
          return;
        }
      }
      await runGitActions(gitActions, rootPath, output);
      setStatus('Done');
      return;
    }

    let intent = await determineIntent(instruction, output, panelApi, signal, history);
    if (forceEditAfterClarification) {
      intent = 'edit';
    }

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

    const clarifyFirst = getForgeSetting<boolean>('clarifyBeforeEdit') !== false;
    if (clarifyFirst && !skipClarifyCheck) {
      const clarification = await maybeClarifyInstruction(
        instruction,
        rootPath,
        output,
        panelApi,
        signal,
        history
      );
      if (clarification && clarification.length > 0) {
        const maxClarifyRounds = Math.max(1, getForgeSetting<number>('clarifyMaxRounds') ?? 3);
        const gate = getForgeSetting<string>('clarifyOnlyIf') ?? 'very-unclear';
        const shouldBlock =
          gate === 'always' || (gate === 'very-unclear' && clarification.length >= 2);
        if (shouldBlock) {
          const reachedClarifyLimit = clarificationRounds >= maxClarifyRounds;
          if (!reachedClarifyLimit) {
            const suggestAnswers = getForgeSetting<boolean>('clarifySuggestAnswers') !== false;
            const confirmSuggestions = getForgeSetting<boolean>('clarifyConfirmSuggestions') !== false;
            if (suggestAnswers) {
              const suggestion = await maybeSuggestClarificationAnswers(
                instruction,
                clarification,
                rootPath,
                output,
                panelApi,
                signal,
                history
              );
              if (suggestion && suggestion.answers.length > 0) {
                clearPendingDisambiguation();
                if (confirmSuggestions) {
                  state.pendingClarificationProposal = {
                    instruction,
                    questions: clarification,
                    proposedAnswers: suggestion.answers,
                    proposedPlan: suggestion.plan,
                    rounds: clarificationRounds + 1
                  };
                  logOutput(output, panelApi, 'Proposed answers:');
                  suggestion.answers.forEach((answer) => logOutput(output, panelApi, `- ${answer}`));
                  if (suggestion.plan.length > 0) {
                    logOutput(output, panelApi, 'Proposed plan:');
                    suggestion.plan.forEach((step) => logOutput(output, panelApi, `- ${step}`));
                  }
                  logOutput(
                    output,
                    panelApi,
                    'Reply "accept" to proceed, or reply with corrections/answers.'
                  );
                  setStatus('Waiting for clarification');
                  return;
                }
                instruction = formatClarificationProposal(
                  instruction,
                  clarification,
                  suggestion.answers,
                  suggestion.plan
                );
                logOutput(output, panelApi, 'Using proposed answers. Continuing...');
              } else {
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
            } else {
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
          }
          logOutput(
            output,
            panelApi,
            `Clarification limit reached (${maxClarifyRounds}). Proceeding with best effort.`
          );
          const autoAssume = getForgeSetting<boolean>('clarifyAutoAssume') === true;
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

    const skipConfirmations = getForgeSetting<boolean>('skipConfirmations') === true;
    const skipTargetConfirmation = getForgeSetting<boolean>('skipTargetConfirmation') === true;

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

      const showDiffPreview = getForgeSetting<boolean>('showDiffPreview') !== false;
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
      const autoFixValidation = getForgeSetting<boolean>('autoFixValidation') === true;
      const maxFixRetries = Math.max(0, getForgeSetting<number>('autoFixMaxRetries') ?? 0);

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

      const enableGitWorkflow = getForgeSetting<boolean>('enableGitWorkflow') === true;
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
  const cleanedAnswers = answers
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== 'copy')
    .join('\n');
  const trimmedAnswers = cleanedAnswers.trim();
  const questionBlock = questions.map((item) => `- ${item}`).join('\n');
  return (
    `${originalInstruction}\n\nClarification questions:\n${questionBlock}\n\n` +
    `Clarification answers:\n${trimmedAnswers.length > 0 ? trimmedAnswers : '(no answer provided)'}`
  );
}

function formatClarificationProposal(
  originalInstruction: string,
  questions: string[],
  proposedAnswers: string[],
  proposedPlan: string[]
): string {
  const questionBlock = questions.map((item) => `- ${item}`).join('\n');
  const answerBlock = proposedAnswers.length > 0
    ? proposedAnswers.map((item) => `- ${item}`).join('\n')
    : '- (no proposed answers)';
  const planBlock = proposedPlan.length > 0
    ? proposedPlan.map((item) => `- ${item}`).join('\n')
    : '- (no plan)';
  return (
    `${originalInstruction}\n\nClarification questions:\n${questionBlock}\n\n` +
    `Proposed answers:\n${answerBlock}\n\nProposed plan:\n${planBlock}`
  );
}

function parseClarificationDecision(input: string): 'accept' | 'reject' | 'answer' {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    return 'answer';
  }
  if (/^(accept|yes|y|ok|okay|proceed|continue|run)$/.test(trimmed)) {
    return 'accept';
  }
  if (/^(reject|no|n|cancel|stop)$/.test(trimmed)) {
    return 'reject';
  }
  return 'answer';
}
