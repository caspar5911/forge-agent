/** Forge settings helpers with profile defaults. */
import * as vscode from 'vscode';

export type ForgeProfile = 'auto' | 'balanced' | 'manual';

type ProfileDefaults = Record<string, unknown>;

const PROFILE_DEFAULTS: Record<ForgeProfile, ProfileDefaults> = {
  auto: {
    enableMultiFile: true,
    skipConfirmations: true,
    skipTargetConfirmation: true,
    showDiffPreview: false,
    autoValidation: true,
    autoValidationMode: 'smart',
    autoFixValidation: true,
    autoFixMaxRetries: 3,
    bestEffortFix: true,
    autoAddDependencies: true,
    autoCreateMissingFiles: true,
    autoInstallDependencies: true,
    skipCreateFilePicker: true,
    clarifyBeforeEdit: true,
    clarifyOnlyIf: 'always',
    clarifyAutoAssume: true,
    clarifySuggestAnswers: true,
    clarifyConfirmSuggestions: false,
    clarifyMaxQuestions: 6,
    clarifyMaxRounds: 3,
    intentUseLLM: true,
    gitIntentMode: 'smart',
    gitConfirmActions: true,
    enableGitWorkflow: false
  },
  balanced: {},
  manual: {
    enableMultiFile: false,
    skipConfirmations: false,
    skipTargetConfirmation: false,
    showDiffPreview: true,
    autoValidation: false,
    autoFixValidation: false,
    skipCreateFilePicker: false,
    clarifyBeforeEdit: true,
    clarifyOnlyIf: 'always',
    clarifyAutoAssume: false,
    clarifySuggestAnswers: false,
    clarifyConfirmSuggestions: true,
    clarifyMaxQuestions: 4,
    clarifyMaxRounds: 2,
    intentUseLLM: true,
    gitIntentMode: 'explicit',
    gitConfirmActions: true,
    enableGitWorkflow: false
  }
};

/** Resolve the active Forge profile, falling back to balanced. */
export function getForgeProfile(config?: vscode.WorkspaceConfiguration): ForgeProfile {
  const cfg = config ?? vscode.workspace.getConfiguration('forge');
  const value = cfg.get<string>('profile') ?? 'balanced';
  if (value === 'auto' || value === 'manual' || value === 'balanced') {
    return value;
  }
  return 'balanced';
}

type ConfigInspect<T> = {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
};

function hasUserOverride<T>(inspect: ConfigInspect<T> | undefined): boolean {
  if (!inspect) {
    return false;
  }
  return (
    inspect.globalValue !== undefined ||
    inspect.workspaceValue !== undefined ||
    inspect.workspaceFolderValue !== undefined
  );
}

/** Get a Forge setting, honoring profile defaults unless the user explicitly overrides. */
export function getForgeSetting<T>(key: string, fallback?: T): T {
  const config = vscode.workspace.getConfiguration('forge');
  const profile = getForgeProfile(config);
  const inspect = config.inspect<T>(key);

  if (hasUserOverride(inspect)) {
    const value = config.get<T>(key, fallback as T);
    return value as T;
  }

  const profileDefaults = PROFILE_DEFAULTS[profile] ?? {};
  if (Object.prototype.hasOwnProperty.call(profileDefaults, key)) {
    return profileDefaults[key] as T;
  }

  const value = config.get<T>(key, fallback as T);
  return value as T;
}
