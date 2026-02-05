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
  isExplicitEditRequest,
  maybeClarifyInstruction,
  maybeSuggestClarificationAnswers,
  parseDisambiguationPick,
  shouldContinueAfterValidationPass
} from '../forge/intent';
import { formatDuration, logOutput } from '../forge/logging';
import { answerQuestion } from '../forge/questions';
import { getForgeSetting } from '../forge/settings';
import { endTrace, recordPayload, recordStep, startTrace } from '../forge/trace';
import { buildContextBundle } from '../forge/contextBundle';
import { generateHumanSummary } from '../forge/humanSummary';
import { generatePlanSummary } from '../forge/planSummary';
import { verifyChanges } from '../forge/verification';
import type { ChatHistoryItem, FileUpdate, Intent } from '../forge/types';
import type { ScaffoldType } from '../forge/updates';
import {
  applyFileUpdates,
  attemptAutoFix,
  decideScaffoldStack,
  requestMultiFileUpdate,
  requestSingleFileUpdate
} from '../forge/updates';
import { buildValidationFailureContext, maybeRunValidation, runValidationFirstFix } from '../forge/validationFlow';
import { listWorkspaceFiles } from '../forge/workspaceFiles';
import {
  buildChangeSummaryText,
  formatClarificationFollowup,
  formatClarificationProposal,
  parseClarificationDecision,
  runToolAwarePreflight
} from './runtimeHelpers';
import type { ForgeUiApi } from '../ui/api';
import type { ForgePanel } from '../ui/panel';
import type { ForgeViewProvider } from '../ui/view';
import { appendRunMemory, loadMemoryContext, type MemoryEntry, type MemoryOptions } from '../forge/memory';

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
  let rootPath: string | null = null;
  let intent: Intent | null = null;
  let planSummary: string[] | null = null;
  let changeSummaryText = '';
  let changeDetailText = '';
  let appliedUpdates: FileUpdate[] = [];
  let verificationResult: { status: 'pass' | 'fail'; issues: string[]; confidence?: string } | null = null;
  let validationSummary: { ok: boolean; command: string | null; label: string | null } | null = null;
  let memoryContext: string | null = null;
  let memoryEntry: MemoryEntry | null = null;
  let memoryOptions: MemoryOptions | null = null;
  let memoryOutcome: MemoryEntry['outcome'] = 'completed';
  const decisions: string[] = [];
  const constraints: string[] = [];

  state.activeAbortController?.abort();
  state.activeAbortController = new AbortController();
  const signal = state.activeAbortController.signal;
  startTrace();
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

    rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    // Load persisted memory (best-effort) to ground prompts across runs.
    const memoryEnabled = getForgeSetting<boolean>('enableMemory') !== false;
    memoryOptions = {
      maxEntries: Math.max(1, getForgeSetting<number>('memoryMaxEntries') ?? 30),
      maxChars: Math.max(2000, getForgeSetting<number>('memoryMaxChars') ?? 12000),
      compactionTargetEntries: Math.max(1, getForgeSetting<number>('memoryCompactionTargetEntries') ?? 12),
      includeCompacted: getForgeSetting<boolean>('memoryIncludeCompacted') !== false
    };
    if (memoryEnabled && rootPath) {
      memoryContext = loadMemoryContext(rootPath, memoryOptions);
      memoryEntry = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        instruction
      };
    }
    const gitActions = await maybeDetectGitActions(instruction, output);
    if (gitActions.length > 0) {
      recordStep('Git intent', gitActions.map((action) => action.type).join(', '));
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
          memoryOutcome = 'cancelled';
          setStatus('Cancelled');
          return;
        }
      }
      await runGitActions(gitActions, rootPath, output);
      setStatus('Done');
      return;
    }

    intent = await determineIntent(instruction, output, panelApi, signal, history);
    if (forceEditAfterClarification) {
      intent = 'edit';
    }
    if (isExplicitEditRequest(instruction) && intent !== 'edit') {
      recordStep('Intent override', 'Explicit edit request detected.');
      intent = 'edit';
    }
    recordStep('Intent', intent);
    if (memoryEntry) {
      memoryEntry.intent = intent;
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
      await answerQuestion(instruction, rootPath, output, panelApi, signal, history, memoryContext ?? undefined);
      if (memoryEntry) {
        memoryEntry.summary = 'Answered a question.';
        memoryEntry.decisions = decisions;
        memoryEntry.constraints = constraints;
        memoryEntry.outcome = memoryOutcome;
      }
      setStatus('Done');
      return;
    }

    let assumptionsUsed: string[] = [];
    let scaffoldTypeOverride: ScaffoldType | null = null;
    const clarifyFirst = getForgeSetting<boolean>('clarifyBeforeEdit') !== false && intent !== 'fix';
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
        recordStep('Clarification questions', clarification.map((item) => `- ${item}`).join('\n'));
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
                recordStep(
                  'Proposed answers',
                  suggestion.answers.map((item) => `- ${item}`).join('\n')
                );
                if (suggestion.plan.length > 0) {
                  recordStep('Proposed plan', suggestion.plan.map((item) => `- ${item}`).join('\n'));
                }
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
            assumptionsUsed = assumptions;
            if (assumptions.length > 0) {
              decisions.push(`Assumptions: ${assumptions.join(' | ')}`);
            }
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

    if (enableMultiFile && intent === 'edit') {
      const workspaceFiles = listWorkspaceFiles(rootPath, 3, 200);
      const scaffoldDecision = decideScaffoldStack(instruction, workspaceFiles);
      if (scaffoldDecision) {
        scaffoldTypeOverride = scaffoldDecision.type;
        recordStep(
          'Scaffold decision',
          `${scaffoldDecision.type} (${scaffoldDecision.source}): ${scaffoldDecision.reason}`
        );
        instruction += `\n\nSelected scaffold stack: ${scaffoldDecision.type}. Reason: ${scaffoldDecision.reason}`;
      }
    }

    planSummary = await generatePlanSummary(
      instruction,
      rootPath,
      output,
      panelApi,
      signal,
      history,
      memoryContext ?? undefined
    );
    if (planSummary && planSummary.length > 0) {
      logOutput(output, panelApi, 'Plan summary:');
      planSummary.forEach((step) => logOutput(output, panelApi, `- ${step}`));
      decisions.push(`Plan: ${planSummary.join(' | ')}`);
    }

    if (intent === 'fix') {
      recordStep('Validation strategy', 'validate-first');
      const handled = await runValidationFirstFix(
        rootPath,
        instruction,
        output,
        panelApi,
        signal,
        history,
        { continueOnPass: shouldContinueAfterValidationPass(instruction) }
      );
      if (handled) {
        setStatus('Done');
        return;
      }
      logOutput(output, panelApi, 'Validation passed; continuing with edit request.');
    }

    if (!enableMultiFile && (!activeFilePath || !relativePath)) {
      log('No active editor. Open a file to edit first.');
      void vscode.window.showErrorMessage('Forge: Open a file to edit first.');
      if (memoryEntry) {
        memoryEntry.summary = 'No active file available for editing.';
      }
      memoryOutcome = 'error';
      setStatus('Idle');
      return;
    }

    const skipConfirmations = getForgeSetting<boolean>('skipConfirmations') === true;
    const skipTargetConfirmation = getForgeSetting<boolean>('skipTargetConfirmation') === true;
    const toolContext = await runToolAwarePreflight(
      instruction,
      rootPath,
      activeFilePath,
      output,
      panelApi,
      signal,
      memoryContext ?? undefined
    );
    const contextBundle = await buildContextBundle(instruction, rootPath, 3, 2000, signal);
    if (contextBundle && contextBundle.files.length > 0) {
      recordStep('Context bundle', contextBundle.files.join('\n'));
    }
    // Combine memory, retrieval snippets, and tool output for prompt grounding.
    const memoryBlock = memoryContext ? `Project memory:\n${memoryContext}` : null;
    const combinedContext = [memoryBlock, contextBundle?.text, toolContext].filter(Boolean).join('\n\n');

    if (!enableMultiFile && !(skipConfirmations || skipTargetConfirmation)) {
      const confirmTarget = await vscode.window.showWarningMessage(
        `Forge will edit: ${relativePath}. Continue?`,
        'Continue',
        'Cancel'
      );

      if (confirmTarget !== 'Continue') {
        void vscode.window.showInformationMessage('Forge: Cancelled.');
        memoryOutcome = 'cancelled';
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
        combinedContext,
        signal,
        scaffoldTypeOverride ?? undefined
      );

      if (!updatedFiles || updatedFiles.length === 0) {
        void vscode.window.showInformationMessage('Forge: No changes produced.');
        if (memoryEntry) {
          memoryEntry.summary = 'No changes produced.';
        }
        setStatus('No changes');
        return;
      }
      appliedUpdates = updatedFiles;

      await logActionPurpose(
        instruction,
        updatedFiles.map((file) => file.relativePath),
        output,
        panelApi,
        signal
      );

      const summaries: string[] = [];
      const diffSnippets: string[] = [];
      for (const file of updatedFiles) {
        const summary = getLineChangeSummary(file.original, file.updated, file.relativePath);
        if (summary) {
          summaries.push(summary);
        }
        const inlineDiff = buildInlineDiffPreview(file.original, file.updated, file.relativePath);
        if (inlineDiff && panelApi) {
          panelApi.appendDiff(inlineDiff);
        }
        if (inlineDiff) {
          diffSnippets.push(inlineDiff.join('\n'));
        }
        if (inlineDiff) {
          recordPayload(`Inline diff: ${file.relativePath}`, inlineDiff.join('\n'));
        }
      }
      summaries.forEach((line) => log(line));
      const summaryBlock = buildChangeSummaryText(updatedFiles, summaries);
      changeSummaryText = summaryBlock.text;
      changeDetailText = diffSnippets.join('\n\n');

      if (!skipConfirmations) {
        const confirmApply = await vscode.window.showWarningMessage(
          `Apply changes to ${updatedFiles.length} files?`,
          'Apply',
          'Cancel'
        );

        if (confirmApply !== 'Apply') {
          void vscode.window.showInformationMessage('Forge: Changes not applied.');
          memoryOutcome = 'cancelled';
          setStatus('Cancelled');
          return;
        }
      }

      const writeOk = applyFileUpdates(updatedFiles, output, panelApi);
      if (!writeOk) {
        if (memoryEntry) {
          memoryEntry.summary = 'Failed to write updated files.';
        }
        memoryOutcome = 'error';
        setStatus('Error');
        return;
      }
    } else {
      if (!activeFilePath || !relativePath) {
        log('No active editor. Open a file to edit first.');
        void vscode.window.showErrorMessage('Forge: Open a file to edit first.');
        if (memoryEntry) {
          memoryEntry.summary = 'No active file available for editing.';
        }
        memoryOutcome = 'error';
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
        combinedContext,
        signal
      );

      if (!updatedFile) {
        void vscode.window.showInformationMessage('Forge: No changes produced.');
        if (memoryEntry) {
          memoryEntry.summary = 'No changes produced.';
        }
        setStatus('No changes');
        return;
      }
      appliedUpdates = [updatedFile];

      await logActionPurpose(instruction, [updatedFile.relativePath], output, panelApi, signal);

      const summary = getLineChangeSummary(
        updatedFile.original,
        updatedFile.updated,
        updatedFile.relativePath
      );
      if (summary) {
        log(summary);
      }
      const summaryBlock = buildChangeSummaryText([updatedFile], summary ? [summary] : []);
      changeSummaryText = summaryBlock.text;
      const inlineDiff = buildInlineDiffPreview(
        updatedFile.original,
        updatedFile.updated,
        updatedFile.relativePath
      );
      if (inlineDiff && panelApi) {
        panelApi.appendDiff(inlineDiff);
      }
      if (inlineDiff) {
        recordPayload(`Inline diff: ${updatedFile.relativePath}`, inlineDiff.join('\n'));
        changeDetailText = inlineDiff.join('\n');
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
          memoryOutcome = 'cancelled';
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
        if (memoryEntry) {
          memoryEntry.summary = 'Failed to write updated file.';
        }
        memoryOutcome = 'error';
        setStatus('Error');
        return;
      }
    }

    if (memoryEntry && appliedUpdates.length > 0) {
      memoryEntry.filesChanged = appliedUpdates.map((update) => update.relativePath);
    }

    if (rootPath) {
      const autoFixValidation = getForgeSetting<boolean>('autoFixValidation') === true;
      const maxFixRetries = Math.max(0, getForgeSetting<number>('autoFixMaxRetries') ?? 0);
      let remainingFixRetries = maxFixRetries;
      verificationResult = null;

      setStatus('Running validation...');
      let validationResult = await maybeRunValidation(rootPath, output, instruction);

      while (true) {
        if (!validationResult.ok) {
          if (autoFixValidation && remainingFixRetries > 0) {
            const attempt = maxFixRetries - remainingFixRetries + 1;
            log(`Auto-fix attempt ${attempt} of ${maxFixRetries}...`);
            setStatus(`Auto-fix ${attempt}/${maxFixRetries}`);
            // Provide validation failures + memory context to guide the auto-fix pass.
            const failureContext = buildValidationFailureContext(validationResult);
            const autoFixContext = [failureContext, memoryContext ? `Project memory:\n${memoryContext}` : null]
              .filter(Boolean)
              .join('\n\n') || undefined;
            const fixed = await attemptAutoFix(
              rootPath,
              instruction,
              validationResult.output,
              output,
              panelApi,
              history,
              signal,
              autoFixContext
            );
            if (!fixed) {
              break;
            }
            appliedUpdates = fixed;
            changeSummaryText = buildChangeSummaryText(fixed, []).text;
            remainingFixRetries -= 1;
            setStatus('Re-running validation...');
            validationResult = await maybeRunValidation(rootPath, output, instruction);
            continue;
          }
          break;
        }

        verificationResult = await verifyChanges(
          instruction,
          changeSummaryText,
          validationResult.output,
          changeDetailText,
          signal
        );
        if (memoryEntry) {
          memoryEntry.verification = {
            status: verificationResult.status,
            confidence: verificationResult.confidence,
            issues: verificationResult.issues
          };
        }
        if (verificationResult.status === 'pass') {
          break;
        }

        if (autoFixValidation && remainingFixRetries > 0) {
          const attempt = maxFixRetries - remainingFixRetries + 1;
          log(`Auto-fix (verification) ${attempt} of ${maxFixRetries}...`);
          setStatus(`Auto-fix ${attempt}/${maxFixRetries}`);
          const failureContext = buildValidationFailureContext(validationResult);
          const extraContextParts = [
            verificationResult.issues.join('\n'),
            failureContext,
            memoryContext ? `Project memory:\n${memoryContext}` : null
          ].filter(Boolean);
          const extraContext = extraContextParts.join('\n\n');
          const fixed = await attemptAutoFix(
            rootPath,
            instruction,
            validationResult.output,
            output,
            panelApi,
            history,
            signal,
            extraContext
          );
          if (!fixed) {
            break;
          }
          appliedUpdates = fixed;
          changeSummaryText = buildChangeSummaryText(fixed, []).text;
          remainingFixRetries -= 1;
          setStatus('Re-running validation...');
          validationResult = await maybeRunValidation(rootPath, output, instruction);
          continue;
        }
        break;
      }

      if (!validationResult.ok) {
        void vscode.window.showErrorMessage('Forge: Validation failed.');
        memoryOutcome = 'error';
        setStatus('Validation failed');
        return;
      }

      validationSummary = {
        ok: validationResult.ok,
        command: validationResult.command,
        label: validationResult.label
      };
      if (memoryEntry) {
        memoryEntry.validation = validationSummary;
      }

      if (verificationResult && verificationResult.status === 'fail') {
        log('Verification failed. Review the issues and consider another pass.');
        verificationResult.issues.forEach((issue) => log(`- ${issue}`));
        setStatus('Verification failed');
      } else {
        log('Validation passed.');
      }

      const summary = await generateHumanSummary(
        instruction,
        changeSummaryText,
        signal,
        history
      );
      if (summary) {
        if (memoryEntry) {
          memoryEntry.summary = summary;
        }
        logOutput(output, panelApi, 'Summary:');
        summary.split(/\r?\n/).forEach((line) => {
          if (line.trim().length > 0) {
            logOutput(output, panelApi, line);
          }
        });
      } else if (changeSummaryText) {
        if (memoryEntry) {
          memoryEntry.summary = changeSummaryText;
        }
        logOutput(output, panelApi, 'Summary:');
        changeSummaryText.split(/\r?\n/).forEach((line) => {
          if (line.trim().length > 0) {
            logOutput(output, panelApi, line);
          }
        });
      }
      if (assumptionsUsed.length > 0) {
        logOutput(output, panelApi, 'Assumptions used (please confirm or correct):');
        assumptionsUsed.forEach((line) => logOutput(output, panelApi, `- ${line}`));
        logOutput(output, panelApi, 'Reply with corrections if any, and I will adjust.');
      }

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
    if (panelApi?.appendPeek) {
      const entries = endTrace();
      if (entries.length > 0) {
        panelApi.appendPeek(entries);
      }
    } else {
      endTrace();
    }
    if (memoryEntry && memoryOptions && rootPath && !signal.aborted) {
      if (!memoryEntry.summary) {
        if (memoryOutcome === 'cancelled') {
          memoryEntry.summary = 'Run cancelled before applying changes.';
        } else if (memoryOutcome === 'error') {
          memoryEntry.summary = 'Run failed before completion.';
        } else if (changeSummaryText) {
          memoryEntry.summary = changeSummaryText;
        } else if (appliedUpdates.length > 0) {
          memoryEntry.summary = 'Changes applied.';
        } else {
          memoryEntry.summary = 'Run completed with no changes.';
        }
      }
      memoryEntry.decisions = decisions.length > 0 ? decisions : undefined;
      memoryEntry.constraints = constraints.length > 0 ? constraints : undefined;
      memoryEntry.outcome = memoryOutcome;
      try {
        await appendRunMemory(rootPath, memoryEntry, memoryOptions, signal);
      } catch {
        // Memory is best-effort and should never block the core workflow.
      }
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
