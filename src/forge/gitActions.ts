/** Git workflow + command routing for Forge. */
import * as vscode from 'vscode';
import type { ChatMessage } from '../llm/client';
import { callChatCompletion } from '../llm/client';
import { extractJsonObject } from './json';
import { getForgeSetting } from './settings';
import {
  addFiles,
  checkoutBranch,
  commitStaged,
  fetchRemotes,
  getBranches,
  getCurrentBranch,
  getDiff,
  getDiffStat,
  getGitStatus,
  getLocalBranches,
  getLog,
  getRemoteInfo,
  getRemotes,
  getStagedDiffStat,
  getStashList,
  isGitRepo,
  pullFastForward,
  push,
  stashApply,
  stashPop,
  stashPush,
  unstageFiles
} from '../git';

type GitAction =
  | { type: 'stage' }
  | { type: 'commit' }
  | { type: 'push' }
  | { type: 'status' }
  | { type: 'diff'; staged: boolean; full: boolean }
  | { type: 'log' }
  | { type: 'branch' }
  | { type: 'remote' }
  | { type: 'fetch' }
  | { type: 'pull'; branch?: string }
  | { type: 'checkout'; branch?: string }
  | { type: 'unstage'; paths: string[] }
  | { type: 'stash-save'; includeUntracked: boolean; message: string }
  | { type: 'stash-list' }
  | { type: 'stash-apply'; ref?: string }
  | { type: 'stash-pop'; ref?: string };

type GitIntentMode = 'disabled' | 'explicit' | 'smart';

/** Run the post-edit Git workflow (status, stage, commit, optional push). */
export async function maybeRunGitWorkflow(rootPath: string, output: vscode.OutputChannel): Promise<void> {
  output.appendLine(`[git] workflow root: ${rootPath}`);
  const skipConfirmations = getForgeSetting<boolean>('skipConfirmations') === true;
  const stageMode = getForgeSetting<string>('gitStageMode') ?? 'all';
  const autoMessage = getForgeSetting<boolean>('gitAutoMessage') !== false;
  const messageStyle = getForgeSetting<string>('gitMessageStyle') ?? 'conventional';
  const autoPush = getForgeSetting<boolean>('gitAutoPush') === true;

  if (!skipConfirmations) {
    const proceed = await vscode.window.showWarningMessage(
      'Start Git workflow (status, commit, optional push)?',
      'Continue',
      'Skip'
    );

    if (proceed !== 'Continue') {
      return;
    }
  }

  if (!(await isGitRepo(rootPath))) {
    void vscode.window.showInformationMessage('Forge: Not a Git repository.');
    return;
  }

  const statusLines = await getGitStatus(rootPath);
  if (statusLines.length === 0) {
    void vscode.window.showInformationMessage('Forge: No changes to commit.');
    return;
  }

  output.appendLine('Git status:');
  statusLines.forEach((line) => output.appendLine(line));
  const changes = parseGitStatusLines(statusLines);

  const diffStat = await getDiffStat(rootPath);
  if (diffStat.trim().length > 0) {
    output.appendLine('Diff summary:');
    output.appendLine(diffStat.trim());
  }

  let stagedFiles: string[] = [];
  if (stageMode === 'select' && !skipConfirmations) {
    const picks = await vscode.window.showQuickPick(
      changes.map((change) => ({
        label: `${change.status} ${change.path}`,
        description: change.path,
        picked: true
      })),
      {
        canPickMany: true,
        placeHolder: 'Select files to stage'
      }
    );
    if (!picks || picks.length === 0) {
      void vscode.window.showInformationMessage('Forge: No files selected for commit.');
      return;
    }
    stagedFiles = picks.map((item) => item.description ?? item.label.replace(/^..\s*/, ''));
  } else {
    stagedFiles = changes.map((change) => change.path);
  }

  try {
    await addFiles(rootPath, stagedFiles, output);
  } catch (error) {
    output.appendLine(`Git add error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: Failed to stage files.');
    return;
  }

  const stagedStat = await getStagedDiffStat(rootPath);
  if (stagedStat.trim().length > 0) {
    output.appendLine('Staged diff summary:');
    output.appendLine(stagedStat.trim());
  } else {
    void vscode.window.showInformationMessage('Forge: No staged changes to commit.');
    return;
  }

  let suggestedMessage = '';
  if (autoMessage) {
    suggestedMessage = await generateCommitMessage(stagedStat, stagedFiles, messageStyle);
  }

  let message = suggestedMessage;
  if (!skipConfirmations || !message) {
    const input = await vscode.window.showInputBox({
      prompt: 'Commit message',
      placeHolder: messageStyle === 'conventional' ? 'feat: describe your change' : 'Describe your change',
      value: message || ''
    });
    if (!input) {
      void vscode.window.showInformationMessage('Forge: Commit cancelled.');
      return;
    }
    message = input;
  }

  if (!message) {
    void vscode.window.showInformationMessage('Forge: Commit cancelled.');
    return;
  }

  if (!skipConfirmations) {
    const confirmCommit = await vscode.window.showWarningMessage(
      `Commit with message: "${message}"?`,
      'Commit',
      'Cancel'
    );

    if (confirmCommit !== 'Commit') {
      void vscode.window.showInformationMessage('Forge: Commit cancelled.');
      return;
    }
  }

  try {
    await commitStaged(rootPath, message, output);
    void vscode.window.showInformationMessage('Forge: Commit created.');
  } catch (error) {
    output.appendLine(`Git commit error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: Commit failed.');
    return;
  }

  const remotes = await getRemotes(rootPath);
  if (remotes.length === 0) {
    return;
  }

  const branch = await getCurrentBranch(rootPath);
  let remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!skipConfirmations && remotes.length > 1) {
    const pick = await vscode.window.showQuickPick(remotes, {
      placeHolder: 'Select a remote to push'
    });
    if (pick) {
      remote = pick;
    }
  }

  if (!skipConfirmations) {
    const confirmPush = await vscode.window.showWarningMessage(
      `Push to ${remote}/${branch}?`,
      'Push',
      'Skip'
    );

    if (confirmPush !== 'Push') {
      return;
    }
  } else if (!autoPush) {
    return;
  }

  try {
    await push(rootPath, remote, branch, output);
    void vscode.window.showInformationMessage('Forge: Push completed.');
  } catch (error) {
    output.appendLine(`Git push error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: Push failed.');
  }
}

/** Stage changes, optionally prompting for file selection. */
export async function runGitStage(rootPath: string, output: vscode.OutputChannel): Promise<void> {
  output.appendLine(`[git] root: ${rootPath}`);
  if (!(await isGitRepo(rootPath))) {
    output.appendLine('[git] Not a repository (missing .git).');
    void vscode.window.showInformationMessage('Forge: Not a Git repository.');
    return;
  }
  const statusLines = await getGitStatus(rootPath);
  output.appendLine(`[git] status entries: ${statusLines.length}`);
  if (statusLines.length === 0) {
    void vscode.window.showInformationMessage('Forge: No changes to stage.');
    return;
  }
  statusLines.forEach((line) => output.appendLine(`[git] ${line}`));
  const changes = parseGitStatusLines(statusLines);
  const stageMode = getForgeSetting<string>('gitStageMode') ?? 'all';
  let files = changes.map((change) => change.path);
  if (stageMode === 'select') {
    const picks = await vscode.window.showQuickPick(
      changes.map((change) => ({
        label: `${change.status} ${change.path}`,
        description: change.path,
        picked: true
      })),
      {
        canPickMany: true,
        placeHolder: 'Select files to stage'
      }
    );
    if (!picks || picks.length === 0) {
      void vscode.window.showInformationMessage('Forge: No files selected.');
      return;
    }
    files = picks.map((item) => item.description ?? item.label.replace(/^..\s*/, ''));
  }
  try {
    await addFiles(rootPath, files, output);
    void vscode.window.showInformationMessage(`Forge: Staged ${files.length} files.`);
  } catch (error) {
    output.appendLine(`[git] stage error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: Failed to stage files.');
  }
}

/** Stage files and create a commit with an optional suggested message. */
export async function runGitCommit(rootPath: string, output: vscode.OutputChannel): Promise<void> {
  output.appendLine(`[git] root: ${rootPath}`);
  if (!(await isGitRepo(rootPath))) {
    output.appendLine('[git] Not a repository (missing .git).');
    void vscode.window.showInformationMessage('Forge: Not a Git repository.');
    return;
  }
  const statusLines = await getGitStatus(rootPath);
  output.appendLine(`[git] status entries: ${statusLines.length}`);
  if (statusLines.length === 0) {
    void vscode.window.showInformationMessage('Forge: No changes to commit.');
    return;
  }
  statusLines.forEach((line) => output.appendLine(`[git] ${line}`));
  const changes = parseGitStatusLines(statusLines);
  const stageMode = getForgeSetting<string>('gitStageMode') ?? 'all';
  const autoMessage = getForgeSetting<boolean>('gitAutoMessage') !== false;
  const messageStyle = getForgeSetting<string>('gitMessageStyle') ?? 'conventional';

  let files = changes.map((change) => change.path);
  if (stageMode === 'select') {
    const picks = await vscode.window.showQuickPick(
      changes.map((change) => ({
        label: `${change.status} ${change.path}`,
        description: change.path,
        picked: true
      })),
      {
        canPickMany: true,
        placeHolder: 'Select files to stage'
      }
    );
    if (!picks || picks.length === 0) {
      void vscode.window.showInformationMessage('Forge: No files selected.');
      return;
    }
    files = picks.map((item) => item.description ?? item.label.replace(/^..\s*/, ''));
  }

  try {
    await addFiles(rootPath, files, output);
  } catch (error) {
    output.appendLine(`[git] stage error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: Failed to stage files.');
    return;
  }

  const stagedStat = await getStagedDiffStat(rootPath);
  if (stagedStat.trim().length === 0) {
    void vscode.window.showInformationMessage('Forge: No staged changes to commit.');
    return;
  }
  output.appendLine('[git] staged diff summary:');
  output.appendLine(stagedStat.trim());

  let suggested = '';
  if (autoMessage) {
    suggested = await generateCommitMessage(stagedStat, files, messageStyle);
  }

  const message = await vscode.window.showInputBox({
    prompt: 'Commit message',
    placeHolder: messageStyle === 'conventional' ? 'feat: describe your change' : 'Describe your change',
    value: suggested || ''
  });
  if (!message) {
    void vscode.window.showInformationMessage('Forge: Commit cancelled.');
    return;
  }

  try {
    await commitStaged(rootPath, message, output);
    void vscode.window.showInformationMessage('Forge: Commit created.');
  } catch (error) {
    output.appendLine(`[git] commit error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: Commit failed.');
  }
}

/** Push the current branch to a selected remote with confirmation. */
export async function runGitPush(rootPath: string, output: vscode.OutputChannel): Promise<void> {
  output.appendLine(`[git] root: ${rootPath}`);
  if (!(await isGitRepo(rootPath))) {
    output.appendLine('[git] Not a repository (missing .git).');
    void vscode.window.showInformationMessage('Forge: Not a Git repository.');
    return;
  }
  const remotes = await getRemotes(rootPath);
  output.appendLine(`[git] remotes: ${remotes.join(', ') || 'none'}`);
  if (remotes.length === 0) {
    void vscode.window.showInformationMessage('Forge: No Git remotes configured.');
    return;
  }
  const branch = await getCurrentBranch(rootPath);
  output.appendLine(`[git] branch: ${branch}`);
  let remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (remotes.length > 1) {
    const pick = await vscode.window.showQuickPick(remotes, {
      placeHolder: 'Select a remote to push'
    });
    if (!pick) {
      void vscode.window.showInformationMessage('Forge: Push cancelled.');
      return;
    }
    remote = pick;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Push to ${remote}/${branch}?`,
    'Push',
    'Cancel'
  );
  if (confirm !== 'Push') {
    void vscode.window.showInformationMessage('Forge: Push cancelled.');
    return;
  }
  try {
    await push(rootPath, remote, branch, output);
    void vscode.window.showInformationMessage('Forge: Push completed.');
  } catch (error) {
    output.appendLine(`[git] push error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: Push failed.');
  }
}

/** Normalize `git status --porcelain` output into status/path pairs. */
function parseGitStatusLines(lines: string[]): Array<{ status: string; path: string }> {
  return lines
    .map((line) => line.trimEnd())
    .filter((line) => line.length >= 3)
    .map((line) => {
      const status = line.slice(0, 2).trim();
      let path = line.slice(3).trim();
      if (path.includes('->')) {
        path = path.split('->').pop()?.trim() ?? path;
      }
      return { status: status || '??', path };
    })
    .filter((entry) => entry.path.length > 0);
}

/** Detect requested Git operations from a natural-language instruction. */
function detectExplicitGitActions(instruction: string): GitAction[] {
  const text = instruction.toLowerCase();
  const mentionsGit = /\bgit\b/.test(text);
  const hasGitContext =
    /\b(git|repo|repository|branch|origin|remote|commit|push|stage|pull|diff|fetch|status|log|history|remotes|sync|update|stash|unstage)\b/.test(
      text
    );

  const wantsCommit =
    /\bgit\s+commit\b/.test(text) ||
    (mentionsGit && /\bcommit\b/.test(text)) ||
    (/\bcommit\b/.test(text) && /\b(changes|code|repo|repository)\b/.test(text) && hasGitContext) ||
    /\bcheck\s*in\b/.test(text);
  const wantsPush =
    /\bgit\s+push\b/.test(text) ||
    (mentionsGit && /\bpush\b/.test(text)) ||
    (/\bpush\b/.test(text) && /\b(git|repo|branch|origin|remote)\b/.test(text));
  const wantsStage =
    /\bgit\s+add\b/.test(text) ||
    (mentionsGit && /\bstage\b/.test(text)) ||
    (/\bstage\b/.test(text) && /\b(changes|git|repo|repository)\b/.test(text));
  const wantsUnstage =
    /\bunstage\b/.test(text) ||
    /\bun-stage\b/.test(text) ||
    /\brestore\s+staged\b/.test(text) ||
    /\bgit\s+restore\s+--staged\b/.test(text);
  const unstagePaths: string[] = [];
  const unstageMatch = text.match(/\bunstage\s+(?:file\s+)?([a-z0-9._/\\-]+)\b/);
  if (unstageMatch?.[1]) {
    unstagePaths.push(unstageMatch[1]);
  }
  const wantsStatus =
    /\bgit\s+status\b/.test(text) ||
    (mentionsGit && /\bstatus\b/.test(text)) ||
    (/\bstatus\b/.test(text) && /\b(git|repo|repository|changes)\b/.test(text));
  const wantsDiff =
    /\bgit\s+diff\b/.test(text) ||
    (mentionsGit && /\bdiff\b/.test(text)) ||
    (/\bdiff\b/.test(text) && (hasGitContext || /\bchanges\b/.test(text)));
  const wantsLog =
    /\bgit\s+log\b/.test(text) ||
    (mentionsGit && /\b(log|history|commits)\b/.test(text)) ||
    (/\b(log|history|commits)\b/.test(text) && hasGitContext);
  const wantsBranch =
    /\bgit\s+branch\b/.test(text) ||
    (mentionsGit && /\bbranches?\b/.test(text)) ||
    (/\bbranches?\b/.test(text) && hasGitContext);
  const wantsRemote =
    /\bgit\s+remote\b/.test(text) ||
    (mentionsGit && /\bremotes?\b/.test(text)) ||
    (/\bremotes?\b/.test(text) && hasGitContext);
  const wantsFetch =
    /\bgit\s+fetch\b/.test(text) ||
    (mentionsGit && /\bfetch\b/.test(text)) ||
    (/\bfetch\b/.test(text) && hasGitContext);
  const wantsPull =
    /\bgit\s+pull\b/.test(text) ||
    (mentionsGit && /\bpull\b/.test(text)) ||
    /\bpull\s+from\b/.test(text) ||
    (/\bpull\b/.test(text) && hasGitContext);
  const wantsCheckout =
    /\bgit\s+checkout\b/.test(text) ||
    /\bgit\s+switch\b/.test(text) ||
    (/\b(checkout|switch)\b/.test(text) && hasGitContext);
  const branchMatch = text.match(/\b(?:checkout|switch)\s+(?:to\s+)?([a-z0-9._/-]+)\b/);
  const branch = branchMatch?.[1];
  const pullFromMatch = text.match(/\bpull\s+from\s+([a-z0-9._/-]+)\b/);
  const pullBranch = pullFromMatch?.[1];
  const wantsStashList =
    /\bstash\s+list\b/.test(text) ||
    /\blist\s+stashes\b/.test(text) ||
    /\bshow\s+stashes\b/.test(text);
  const wantsStashPop = /\bstash\s+pop\b/.test(text) || /\bpop\s+stash\b/.test(text);
  const wantsStashApply = /\bstash\s+apply\b/.test(text) || /\bapply\s+stash\b/.test(text);
  const wantsStash = /\bstash\b/.test(text) && !(wantsStashList || wantsStashPop || wantsStashApply);
  const stashRefMatch = text.match(/stash@\{\d+\}/);
  const stashRef = stashRefMatch?.[0];
  const includeUntracked = /\buntracked\b/.test(text);

  const actions: GitAction[] = [];
  if (wantsCommit) {
    actions.push({ type: 'commit' });
    if (wantsPush) {
      actions.push({ type: 'push' });
    }
    return actions;
  }
  if (wantsUnstage) {
    actions.push({ type: 'unstage', paths: unstagePaths });
    return actions;
  }
  if (wantsStashList) {
    actions.push({ type: 'stash-list' });
    return actions;
  }
  if (wantsStashPop) {
    actions.push({ type: 'stash-pop', ref: stashRef });
    return actions;
  }
  if (wantsStashApply) {
    actions.push({ type: 'stash-apply', ref: stashRef });
    return actions;
  }
  if (wantsStash) {
    const message = `Forge stash ${new Date().toLocaleString()}`;
    actions.push({ type: 'stash-save', includeUntracked, message });
    return actions;
  }
  if (wantsStage) {
    actions.push({ type: 'stage' });
    return actions;
  }
  if (wantsPush) {
    actions.push({ type: 'push' });
    return actions;
  }
  if (wantsStatus) {
    actions.push({ type: 'status' });
    return actions;
  }
  if (wantsDiff) {
    actions.push({
      type: 'diff',
      staged: /\b(staged|cached|index)\b/.test(text),
      full: /\b(full|patch|unified)\b/.test(text)
    });
    return actions;
  }
  if (wantsLog) {
    actions.push({ type: 'log' });
    return actions;
  }
  if (wantsBranch) {
    actions.push({ type: 'branch' });
    return actions;
  }
  if (wantsRemote) {
    actions.push({ type: 'remote' });
    return actions;
  }
  if (wantsFetch) {
    actions.push({ type: 'fetch' });
    return actions;
  }
  if (wantsPull) {
    actions.push({ type: 'pull', branch: pullBranch });
    return actions;
  }
  if (wantsCheckout) {
    actions.push({ type: 'checkout', branch });
    return actions;
  }
  return actions;
}

function shouldAttemptSmartGitDetection(instruction: string): boolean {
  return /\b(commit|push|pull|fetch|diff|status|branch|checkout|switch|stash|unstage|stage|git|repo|repository)\b/i.test(
    instruction
  );
}

type GitIntentPayload = {
  actions?: Array<{
    type?: string;
    branch?: string;
    paths?: string[];
    staged?: boolean;
    full?: boolean;
    includeUntracked?: boolean;
    message?: string;
    ref?: string;
  }>;
};

function normalizeGitAction(action: {
  type?: string;
  branch?: string;
  paths?: string[];
  staged?: boolean;
  full?: boolean;
  includeUntracked?: boolean;
  message?: string;
  ref?: string;
}): GitAction | null {
  const type = String(action.type ?? '').toLowerCase();
  if (type === 'stage') {
    return { type: 'stage' };
  }
  if (type === 'commit') {
    return { type: 'commit' };
  }
  if (type === 'push') {
    return { type: 'push' };
  }
  if (type === 'status') {
    return { type: 'status' };
  }
  if (type === 'diff') {
    return { type: 'diff', staged: action.staged === true, full: action.full === true };
  }
  if (type === 'log') {
    return { type: 'log' };
  }
  if (type === 'branch') {
    return { type: 'branch' };
  }
  if (type === 'remote') {
    return { type: 'remote' };
  }
  if (type === 'fetch') {
    return { type: 'fetch' };
  }
  if (type === 'pull') {
    return { type: 'pull', branch: action.branch };
  }
  if (type === 'checkout' || type === 'switch') {
    return { type: 'checkout', branch: action.branch };
  }
  if (type === 'unstage') {
    return { type: 'unstage', paths: Array.isArray(action.paths) ? action.paths : [] };
  }
  if (type === 'stash-list') {
    return { type: 'stash-list' };
  }
  if (type === 'stash-save') {
    return {
      type: 'stash-save',
      includeUntracked: action.includeUntracked === true,
      message: typeof action.message === 'string' ? action.message : `Forge stash ${new Date().toLocaleString()}`
    };
  }
  if (type === 'stash-apply') {
    return { type: 'stash-apply', ref: action.ref };
  }
  if (type === 'stash-pop') {
    return { type: 'stash-pop', ref: action.ref };
  }
  return null;
}

function buildGitIntentMessages(instruction: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are detecting whether the user is asking to run Git commands. ' +
        'Return ONLY valid JSON in the form {"actions":[...]} where each action is one of: ' +
        'status, diff, commit, push, stage, pull, fetch, checkout, switch, branch, remote, log, ' +
        'stash-list, stash-save, stash-apply, stash-pop, unstage. ' +
        'Only include actions if the user explicitly asks for Git help or commands. ' +
        'If the instruction is about application features (e.g., "checkout flow"), return {"actions": []}.'
    },
    {
      role: 'user',
      content: instruction
    }
  ];
}

export async function maybeDetectGitActions(
  instruction: string,
  output: vscode.OutputChannel
): Promise<GitAction[]> {
  const mode = (getForgeSetting<string>('gitIntentMode') ?? 'explicit') as GitIntentMode;
  if (mode === 'disabled') {
    return [];
  }

  const explicit = detectExplicitGitActions(instruction);
  if (mode === 'explicit') {
    return explicit;
  }

  if (!shouldAttemptSmartGitDetection(instruction)) {
    return explicit;
  }

  try {
    const response = await callChatCompletion({}, buildGitIntentMessages(instruction));
    const payload = extractJsonObject(response) as GitIntentPayload;
    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    const mapped = actions
      .map((action) => normalizeGitAction(action))
      .filter((action): action is GitAction => action !== null);
    return mapped.length > 0 ? mapped : explicit;
  } catch (error) {
    output.appendLine(`[git] intent detection error: ${String(error)}`);
    return explicit;
  }
}

/** Execute one or more detected Git actions with safety checks. */
export async function runGitActions(
  actions: GitAction[],
  rootPath: string,
  output: vscode.OutputChannel
): Promise<void> {
  const log = (text: string) => {
    output.appendLine(text);
  };

  if (!(await isGitRepo(rootPath))) {
    log('[git] Not a repository (missing .git).');
    void vscode.window.showInformationMessage('Forge: Not a Git repository.');
    return;
  }

  for (const action of actions) {
    log(`[git] action: ${action.type}`);
    if (action.type === 'stage') {
      await runGitStage(rootPath, output);
      continue;
    }
    if (action.type === 'commit') {
      await runGitCommit(rootPath, output);
      continue;
    }
    if (action.type === 'push') {
      await runGitPush(rootPath, output);
      continue;
    }
    if (action.type === 'status') {
      const statusLines = await getGitStatus(rootPath);
      if (statusLines.length === 0) {
        log('[git] working tree clean.');
        void vscode.window.showInformationMessage('Forge: Working tree clean.');
        continue;
      }
      statusLines.forEach((line) => log(`[git] ${line}`));
      continue;
    }
    if (action.type === 'diff') {
      const diff = await getDiff(rootPath, { staged: action.staged, full: action.full });
      if (diff.trim().length === 0) {
        log('[git] no diff to show.');
        void vscode.window.showInformationMessage('Forge: No diff to show.');
        continue;
      }
      log(diff.trim());
      continue;
    }
    if (action.type === 'log') {
      const logText = await getLog(rootPath);
      if (logText.trim().length === 0) {
        log('[git] no commits found.');
        continue;
      }
      log(logText.trim());
      continue;
    }
    if (action.type === 'branch') {
      const branches = await getBranches(rootPath);
      log(branches.trim());
      continue;
    }
    if (action.type === 'remote') {
      const remotes = await getRemoteInfo(rootPath);
      log(remotes.trim());
      continue;
    }
    if (action.type === 'fetch') {
      const result = await fetchRemotes(rootPath);
      if (result.trim().length > 0) {
        log(result.trim());
      }
      void vscode.window.showInformationMessage('Forge: Fetch completed.');
      continue;
    }
    if (action.type === 'pull') {
      const statusLines = await getGitStatus(rootPath);
      if (statusLines.length > 0) {
        log('[git] pull blocked: working tree has uncommitted changes.');
        void vscode.window.showWarningMessage('Forge: Commit or stash changes before pull.');
        continue;
      }
      let remote: string | undefined;
      let branch = action.branch;
      if (branch && branch.includes('/')) {
        const parts = branch.split('/');
        if (parts.length >= 2) {
          remote = parts[0];
          branch = parts.slice(1).join('/');
        }
      }
      if (branch) {
        const current = await getCurrentBranch(rootPath);
        if (current !== branch) {
          log(`[git] pull blocked: on ${current}, requested ${branch}.`);
          void vscode.window.showWarningMessage(`Forge: Switch to ${branch} before pulling.`);
          continue;
        }
      }
      if (!remote) {
        const remotes = await getRemotes(rootPath);
        if (remotes.includes('origin')) {
          remote = 'origin';
        }
      }
      const result = await pullFastForward(rootPath, remote, branch);
      if (result.trim().length > 0) {
        log(result.trim());
      }
      void vscode.window.showInformationMessage('Forge: Pull completed.');
      continue;
    }
    if (action.type === 'unstage') {
      const statusLines = await getGitStatus(rootPath);
      if (statusLines.length === 0) {
        log('[git] nothing to unstage.');
        void vscode.window.showInformationMessage('Forge: No staged changes to unstage.');
        continue;
      }
      const paths = action.paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      const result = await unstageFiles(rootPath, paths);
      if (result.trim().length > 0) {
        log(result.trim());
      }
      void vscode.window.showInformationMessage('Forge: Unstaged changes.');
      continue;
    }
    if (action.type === 'stash-list') {
      const list = await getStashList(rootPath);
      if (list.trim().length === 0) {
        log('[git] no stashes found.');
        void vscode.window.showInformationMessage('Forge: No stashes found.');
        continue;
      }
      log(list.trim());
      continue;
    }
    if (action.type === 'stash-save') {
      const statusLines = await getGitStatus(rootPath);
      if (statusLines.length === 0) {
        log('[git] no changes to stash.');
        void vscode.window.showInformationMessage('Forge: No changes to stash.');
        continue;
      }
      const result = await stashPush(rootPath, action.message, action.includeUntracked);
      if (result.trim().length > 0) {
        log(result.trim());
      }
      void vscode.window.showInformationMessage('Forge: Changes stashed.');
      continue;
    }
    if (action.type === 'stash-apply' || action.type === 'stash-pop') {
      let ref = action.ref;
      if (!ref) {
        const list = await getStashList(rootPath);
        const entries = list
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (entries.length === 0) {
          log('[git] no stashes found.');
          void vscode.window.showInformationMessage('Forge: No stashes found.');
          continue;
        }
        const pick = await vscode.window.showQuickPick(entries, {
          placeHolder: 'Select a stash'
        });
        if (!pick) {
          void vscode.window.showInformationMessage('Forge: Stash selection cancelled.');
          continue;
        }
        ref = pick.split(':')[0].trim();
      }
      const result =
        action.type === 'stash-pop'
          ? await stashPop(rootPath, ref)
          : await stashApply(rootPath, ref);
      if (result.trim().length > 0) {
        log(result.trim());
      }
      void vscode.window.showInformationMessage(
        action.type === 'stash-pop' ? 'Forge: Stash popped.' : 'Forge: Stash applied.'
      );
      continue;
    }
    if (action.type === 'checkout') {
      const statusLines = await getGitStatus(rootPath);
      if (statusLines.length > 0) {
        log('[git] checkout blocked: working tree has uncommitted changes.');
        void vscode.window.showWarningMessage('Forge: Commit or stash changes before checkout.');
        continue;
      }
      let targetBranch = action.branch;
      if (!targetBranch) {
        const branches = await getLocalBranches(rootPath);
        if (branches.length === 0) {
          log('[git] no local branches found.');
          continue;
        }
        const pick = await vscode.window.showQuickPick(branches, {
          placeHolder: 'Select a branch to checkout'
        });
        if (!pick) {
          void vscode.window.showInformationMessage('Forge: Checkout cancelled.');
          continue;
        }
        targetBranch = pick;
      }
      const result = await checkoutBranch(rootPath, targetBranch);
      if (result.trim().length > 0) {
        log(result.trim());
      }
      void vscode.window.showInformationMessage(`Forge: Checked out ${targetBranch}.`);
    }
  }
}

/** Ask the LLM to generate a concise commit message from diff stats. */
async function generateCommitMessage(
  diffStat: string,
  files: string[],
  style: string
): Promise<string> {
  const messages = buildCommitMessageMessages(diffStat, files, style);
  try {
    const response = await callChatCompletion({}, messages);
    const content = response.choices?.[0]?.message?.content?.trim() ?? '';
    if (!content) {
      return '';
    }
    return content.split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
}

/** Build the prompt used to generate a commit message. */
function buildCommitMessageMessages(diffStat: string, files: string[], style: string): ChatMessage[] {
  const fileList = files.slice(0, 30).join(', ');
  const styleNote =
    style === 'plain'
      ? 'Use a short plain commit message.'
      : 'Use Conventional Commits format (e.g., feat:, fix:, chore:).';
  return [
    {
      role: 'system',
      content: 'Generate a concise git commit message. ' + styleNote + ' Return only the commit message.'
    },
    {
      role: 'user',
      content:
        `Changed files: ${fileList}\n` +
        `Diff summary:\n${diffStat}\n` +
        'Return only the commit message.'
    }
  ];
}
