/** Validation flow orchestration and auto-fix support. */
import * as vscode from 'vscode';
import { harvestContext } from '../context';
import { buildValidationOptions, runCommand, type ValidationOption } from '../validation';
import { logOutput } from './logging';
import { attemptAutoFix } from './updates';
import { getForgeSetting } from './settings';
import type { ChatHistoryItem } from './types';
import type { ForgeUiApi } from '../ui/api';

export type ValidationResult = {
  ok: boolean;
  output: string;
  command: string | null;
  label: string | null;
};

/** Optionally run a validation command based on settings and package scripts. */
export async function maybeRunValidation(rootPath: string, output: vscode.OutputChannel): Promise<ValidationResult> {
  const autoValidation = getForgeSetting<boolean>('autoValidation') !== false;
  const contextObject = harvestContext();
  const options = buildValidationOptions(contextObject.packageJson, contextObject.packageManager);

  if (options.length === 0) {
    return { ok: true, output: '', command: null, label: null };
  }

  let selected: ValidationOption | null = null;
  if (autoValidation) {
    return runAllValidationOptions(rootPath, output, options);
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
  try {
    const result = await runCommand(selected.command, rootPath, output);
    return {
      ok: result.code === 0,
      output: result.output,
      command: selected.command,
      label: selected.label
    };
  } catch (error) {
    output.appendLine(`Validation error: ${String(error)}`);
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

  for (const option of ordered) {
    output.appendLine(`Running validation: ${option.label}`);
    try {
      const result = await runCommand(option.command, rootPath, output);
      combinedOutput += result.output;
      if (result.code !== 0) {
        ok = false;
      }
    } catch (error) {
      output.appendLine(`Validation error: ${String(error)}`);
      combinedOutput += String(error);
      ok = false;
    }
  }

  return {
    ok,
    output: combinedOutput,
    command: ordered.map((item) => item.command).join(' && '),
    label: ordered.map((item) => item.label).join(', ')
  };
}

/** Run validation first, then attempt auto-fixes if enabled. */
export async function runValidationFirstFix(
  rootPath: string,
  instruction: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  signal?: AbortSignal,
  history?: ChatHistoryItem[]
): Promise<void> {
  logOutput(output, panelApi, 'Running validation (fix mode)...');
  let validationResult = await maybeRunValidation(rootPath, output);
  if (validationResult.ok) {
    logOutput(output, panelApi, 'Validation already passing.');
    return;
  }

  const autoFixValidation = getForgeSetting<boolean>('autoFixValidation') === true;
  const maxFixRetries = Math.max(0, getForgeSetting<number>('autoFixMaxRetries') ?? 0);

  if (!autoFixValidation || maxFixRetries === 0) {
    logOutput(output, panelApi, 'Auto-fix disabled.');
    return;
  }

  for (let attempt = 1; attempt <= maxFixRetries; attempt += 1) {
    logOutput(output, panelApi, `Auto-fix attempt ${attempt} of ${maxFixRetries}...`);
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

    logOutput(output, panelApi, 'Re-running validation...');
    validationResult = await maybeRunValidation(rootPath, output);
    if (validationResult.ok) {
      logOutput(output, panelApi, 'Validation passed after auto-fix.');
      return;
    }
  }

  logOutput(output, panelApi, 'Validation still failing after auto-fix attempts.');
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
