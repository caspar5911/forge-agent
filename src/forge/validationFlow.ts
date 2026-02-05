/** Validation flow orchestration and auto-fix support. */
import * as vscode from 'vscode';
import { harvestContext } from '../context';
import { buildValidationOptions, runCommand, type ValidationOption } from '../validation';
import { logOutput } from './logging';
import { attemptAutoFix } from './updates';
import { getForgeSetting } from './settings';
import { recordPayload, recordStep } from './trace';
import { verifyChanges } from './verification';
import { generateHumanSummary } from './humanSummary';
import { buildInlineDiffPreview, getLineChangeSummary } from './diff';
import type { FileUpdate } from './types';
import type { ChatHistoryItem } from './types';
import type { ForgeUiApi } from '../ui/api';

export type ValidationResult = {
  ok: boolean;
  output: string;
  command: string | null;
  label: string | null;
  failures?: Array<{ label: string; command: string; output: string }>;
};

/** Optionally run a validation command based on settings and package scripts. */
export async function maybeRunValidation(
  rootPath: string,
  output: vscode.OutputChannel,
  instruction?: string
): Promise<ValidationResult> {
  const autoValidation = getForgeSetting<boolean>('autoValidation') !== false;
  const autoMode = getForgeSetting<string>('autoValidationMode') ?? 'smart';
  const contextObject = harvestContext();
  const options = buildValidationOptions(contextObject.packageJson, contextObject.packageManager);

  if (options.length === 0) {
    return { ok: true, output: '', command: null, label: null };
  }

  let selected: ValidationOption | null = null;
  if (autoValidation) {
    if (autoMode === 'all') {
      recordStep('Validation selection', 'auto: all');
      return runAllValidationOptions(rootPath, output, options);
    }
    const selection = selectValidationOptions(options, instruction ?? '');
    recordStep('Validation selection', selection.reason);
    return runAllValidationOptions(rootPath, output, selection.options);
  } else {
    const items = options.map((option) => ({
      label: option.label,
      description: option.command
    }));

    items.push({ label: 'Skip validation', description: '' });

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a validation command to run'
    });

    if (!pick || pick.label === 'Skip validation') {
      return { ok: true, output: '', command: null, label: null };
    }

    selected = options.find((option) => option.label === pick.label) ?? null;
  }

  if (!selected) {
    return { ok: true, output: '', command: null, label: null };
  }

  output.appendLine(`Running validation: ${selected.label}`);
  recordStep('Validation command', `${selected.label}: ${selected.command}`);
  try {
    const result = await runCommand(selected.command, rootPath, output);
    recordStep('Validation exit code', `${selected.label}: ${result.code}`);
    recordPayload(`Validation output: ${selected.label}`, result.output || '(no output)');
    return {
      ok: result.code === 0,
      output: result.output,
      command: selected.command,
      label: selected.label
    };
  } catch (error) {
    output.appendLine(`Validation error: ${String(error)}`);
    recordStep('Validation error', `${selected.label}: ${String(error)}`);
    return { ok: false, output: String(error), command: selected.command, label: selected.label };
  }
}

/** Run all validation options in priority order without failing fast. */
async function runAllValidationOptions(
  rootPath: string,
  output: vscode.OutputChannel,
  options: ValidationOption[]
): Promise<ValidationResult> {
  const ordered = orderValidationOptions(options);
  let combinedOutput = '';
  let ok = true;
  const failures: Array<{ label: string; command: string; output: string }> = [];

  for (const option of ordered) {
    output.appendLine(`Running validation: ${option.label}`);
    recordStep('Validation command', `${option.label}: ${option.command}`);
    try {
      const result = await runCommand(option.command, rootPath, output);
      recordStep('Validation exit code', `${option.label}: ${result.code}`);
      recordPayload(`Validation output: ${option.label}`, result.output || '(no output)');
      combinedOutput += result.output;
      if (result.code !== 0) {
        ok = false;
        failures.push({ label: option.label, command: option.command, output: result.output });
      }
    } catch (error) {
      output.appendLine(`Validation error: ${String(error)}`);
      recordStep('Validation error', `${option.label}: ${String(error)}`);
      combinedOutput += String(error);
      ok = false;
      failures.push({ label: option.label, command: option.command, output: String(error) });
    }
  }

  return {
    ok,
    output: combinedOutput,
    command: ordered.map((item) => item.command).join(' && '),
    label: ordered.map((item) => item.label).join(', '),
    failures
  };
}

/** Run validation first, then attempt auto-fixes if enabled. */
export async function runValidationFirstFix(
  rootPath: string,
  instruction: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  signal?: AbortSignal,
  history?: ChatHistoryItem[],
  options?: { continueOnPass?: boolean }
): Promise<boolean> {
  logOutput(output, panelApi, 'Running validation (fix mode)...');
  recordStep('Validation mode', 'fix');
  let validationResult = await maybeRunValidation(rootPath, output, instruction);
  if (validationResult.ok) {
    logOutput(output, panelApi, 'Validation already passing.');
    return options?.continueOnPass ? false : true;
  }

  const autoFixValidation = getForgeSetting<boolean>('autoFixValidation') === true;
  const maxFixRetries = Math.max(0, getForgeSetting<number>('autoFixMaxRetries') ?? 0);
  let remainingFixRetries = maxFixRetries;
  let lastUpdates: FileUpdate[] | null = null;

  if (!autoFixValidation || maxFixRetries === 0) {
    logOutput(output, panelApi, 'Auto-fix disabled.');
    return true;
  }

  while (true) {
    if (!validationResult.ok) {
      if (remainingFixRetries <= 0) {
        break;
      }
      const attempt = maxFixRetries - remainingFixRetries + 1;
      logOutput(output, panelApi, `Auto-fix attempt ${attempt} of ${maxFixRetries}...`);
      recordStep('Auto-fix attempt', `${attempt} of ${maxFixRetries}`);
      const failureContext = buildValidationFailureContext(validationResult);
      const fixedUpdates = await attemptAutoFix(
        rootPath,
        instruction,
        validationResult.output,
        output,
        panelApi,
        history,
        signal,
        failureContext ?? undefined
      );
      if (!fixedUpdates) {
        break;
      }
      lastUpdates = fixedUpdates;
      remainingFixRetries -= 1;
      logOutput(output, panelApi, 'Re-running validation...');
      validationResult = await maybeRunValidation(rootPath, output, instruction);
      continue;
    }

    const summaryText = buildFixSummary(lastUpdates);
    const detailText = buildFixDetails(lastUpdates);
    const verification = await verifyChanges(
      instruction,
      summaryText,
      validationResult.output,
      detailText,
      signal
    );
    if (verification.status === 'pass') {
      logOutput(output, panelApi, 'Verification passed.');
      break;
    }
    if (remainingFixRetries <= 0) {
      logOutput(output, panelApi, 'Verification failed. No retries left.');
      verification.issues.forEach((issue) => logOutput(output, panelApi, `- ${issue}`));
      break;
    }
    const attempt = maxFixRetries - remainingFixRetries + 1;
    logOutput(output, panelApi, `Auto-fix (verification) ${attempt} of ${maxFixRetries}...`);
    const extraContext = verification.issues.join('\n');
    const failureContext = buildValidationFailureContext(validationResult);
    const combinedContext = [extraContext, failureContext].filter(Boolean).join('\n\n') || undefined;
    const fixedUpdates = await attemptAutoFix(
      rootPath,
      instruction,
      validationResult.output,
      output,
      panelApi,
      history,
      signal,
      combinedContext
    );
    if (!fixedUpdates) {
      break;
    }
    lastUpdates = fixedUpdates;
    remainingFixRetries -= 1;
    logOutput(output, panelApi, 'Re-running validation...');
    validationResult = await maybeRunValidation(rootPath, output, instruction);
  }

  if (!validationResult.ok) {
    logOutput(output, panelApi, 'Validation still failing after auto-fix attempts.');
    return true;
  }

  const finalSummary = buildFixSummary(lastUpdates);
  if (finalSummary) {
    const summary = await generateHumanSummary(instruction, finalSummary, signal, history);
    if (summary) {
      logOutput(output, panelApi, 'Summary:');
      summary.split(/\r?\n/).forEach((line) => logOutput(output, panelApi, line));
    }
  }
  return true;
}

function buildFixSummary(updates: FileUpdate[] | null): string {
  if (!updates || updates.length === 0) {
    return '';
  }
  const summaries: string[] = [];
  updates.forEach((file) => {
    const summary = getLineChangeSummary(file.original, file.updated, file.relativePath);
    if (summary) {
      summaries.push(summary);
    }
  });
  if (summaries.length === 0) {
    return updates.map((file) => `- ${file.relativePath}`).join('\n');
  }
  return summaries.join('\n');
}

function buildFixDetails(updates: FileUpdate[] | null): string {
  if (!updates || updates.length === 0) {
    return '';
  }
  const details: string[] = [];
  updates.forEach((file) => {
    const diff = buildInlineDiffPreview(file.original, file.updated, file.relativePath);
    if (diff && diff.length > 0) {
      details.push(diff.join('\n'));
    }
  });
  return details.join('\n\n');
}

/** Choose validation commands based on instruction hints. */
function selectValidationOptions(
  options: ValidationOption[],
  instruction: string
): { options: ValidationOption[]; reason: string } {
  const lowered = instruction.toLowerCase();
  const wantsAll = /(validate|ci|pipeline|all checks|all tests)/.test(lowered);
  const wantsTest = /(test|tests|unit|integration|e2e|spec)/.test(lowered);
  const wantsLint = /(lint|eslint|prettier|format)/.test(lowered);
  const wantsTypecheck = /(typecheck|type check|typescript|tsc)/.test(lowered);
  const wantsBuild = /(build|compile|bundle)/.test(lowered);

  if (wantsAll) {
    return { options, reason: 'auto: instruction requested full validation' };
  }

  const requested: ValidationOption[] = [];
  if (wantsTest) {
    const found = options.find((option) => option.label === 'test');
    if (found) {
      requested.push(found);
    }
  }
  if (wantsLint) {
    const found = options.find((option) => option.label === 'lint');
    if (found) {
      requested.push(found);
    }
  }
  if (wantsTypecheck) {
    const found = options.find((option) => option.label === 'typecheck');
    if (found) {
      requested.push(found);
    }
  }
  if (wantsBuild) {
    const found = options.find((option) => option.label === 'build');
    if (found) {
      requested.push(found);
    }
  }

  if (requested.length > 0) {
    return { options: requested, reason: `auto: instruction hints -> ${requested.map((item) => item.label).join(', ')}` };
  }

  const best = pickBestValidationOption(options);
  return {
    options: best ? [best] : options,
    reason: best ? `auto: default -> ${best.label}` : 'auto: default -> all'
  };
}

/** Summarize validation failures for auto-fix prompts. */
export function buildValidationFailureContext(result: ValidationResult): string | null {
  if (!result.failures || result.failures.length === 0) {
    return null;
  }
  const blocks = result.failures.map((failure) => {
    const output = failure.output?.trim();
    return [
      `Command: ${failure.command}`,
      `Label: ${failure.label}`,
      output ? `Output:\n${output}` : null
    ].filter(Boolean).join('\n');
  });
  return `Validation failures:\n${blocks.join('\n\n')}`;
}

/** Choose the highest-priority validation option. */
function pickBestValidationOption(options: ValidationOption[]): ValidationOption | null {
  const priority = ['test', 'typecheck', 'lint', 'build'];
  for (const label of priority) {
    const found = options.find((option) => option.label === label);
    if (found) {
      return found;
    }
  }
  return options[0] ?? null;
}

/** Order validation options by priority, preserving unknowns at the end. */
function orderValidationOptions(options: ValidationOption[]): ValidationOption[] {
  const priority = ['test', 'typecheck', 'lint', 'build'];
  const ordered: ValidationOption[] = [];
  const remaining = [...options];

  for (const label of priority) {
    const index = remaining.findIndex((option) => option.label === label);
    if (index >= 0) {
      ordered.push(remaining.splice(index, 1)[0]);
    }
  }

  return ordered.concat(remaining);
}
