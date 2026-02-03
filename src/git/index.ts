/** Thin Git command wrappers used by Forge workflows. */
import { execFile } from 'child_process';
import type { OutputChannel } from 'vscode';

/** Check whether the current directory is inside a Git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Return porcelain status lines for the repo. */
export async function getGitStatus(cwd: string): Promise<string[]> {
  const status = await execGit(['status', '--porcelain'], cwd);
  return status.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/** Return a diff stat for the working tree. */
export async function getDiffStat(cwd: string): Promise<string> {
  return execGit(['diff', '--stat'], cwd);
}

/** Return a diff or diff stat for the working tree or staged changes. */
export async function getDiff(
  cwd: string,
  options: { staged?: boolean; full?: boolean } = {}
): Promise<string> {
  const args = ['diff'];
  if (options.staged) {
    args.push('--cached');
  }
  if (!options.full) {
    args.push('--stat');
  }
  return execGit(args, cwd);
}

/** Return a short decorated log for the last N commits. */
export async function getLog(cwd: string, count = 10): Promise<string> {
  return execGit(['log', `-n`, String(count), '--oneline', '--decorate'], cwd);
}

/** Return a list of local and remote branches. */
export async function getBranches(cwd: string): Promise<string> {
  return execGit(['branch', '--all'], cwd);
}

/** Return local branch names as a string array. */
export async function getLocalBranches(cwd: string): Promise<string[]> {
  const output = await execGit(['branch', '--format=%(refname:short)'], cwd);
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Return `git remote -v` output. */
export async function getRemoteInfo(cwd: string): Promise<string> {
  return execGit(['remote', '-v'], cwd);
}

/** Fetch all remotes with pruning. */
export async function fetchRemotes(cwd: string): Promise<string> {
  return execGit(['fetch', '--all', '--prune'], cwd);
}

/** Pull with fast-forward only, optionally targeting remote/branch. */
export async function pullFastForward(
  cwd: string,
  remote?: string,
  branch?: string
): Promise<string> {
  const args = ['pull', '--ff-only'];
  if (remote) {
    args.push(remote);
  }
  if (branch) {
    args.push(branch);
  }
  return execGit(args, cwd);
}

/** Checkout a branch by name. */
export async function checkoutBranch(cwd: string, branch: string): Promise<string> {
  return execGit(['checkout', branch], cwd);
}

/** Unstage the provided files (or all if empty). */
export async function unstageFiles(cwd: string, files: string[]): Promise<string> {
  const args = ['restore', '--staged', '--'];
  if (files.length === 0) {
    args.push('.');
  } else {
    args.push(...files);
  }
  return execGit(args, cwd);
}

/** Create a stash with optional untracked files included. */
export async function stashPush(
  cwd: string,
  message: string,
  includeUntracked: boolean
): Promise<string> {
  const args = ['stash', 'push', '-m', message];
  if (includeUntracked) {
    args.push('-u');
  }
  return execGit(args, cwd);
}

/** List stashes in the repo. */
export async function getStashList(cwd: string): Promise<string> {
  return execGit(['stash', 'list'], cwd);
}

/** Apply a stash reference without dropping it. */
export async function stashApply(cwd: string, ref: string): Promise<string> {
  return execGit(['stash', 'apply', ref], cwd);
}

/** Apply and drop a stash reference. */
export async function stashPop(cwd: string, ref: string): Promise<string> {
  return execGit(['stash', 'pop', ref], cwd);
}

/** Return the current branch name. */
export async function getCurrentBranch(cwd: string): Promise<string> {
  const branch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return branch.trim();
}

/** Return configured remote names. */
export async function getRemotes(cwd: string): Promise<string[]> {
  const remotes = await execGit(['remote'], cwd);
  return remotes.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/** Stage everything and commit with the provided message. */
export async function commitAll(cwd: string, message: string, output: OutputChannel): Promise<void> {
  output.appendLine('> git add -A');
  await execGit(['add', '-A'], cwd);
  output.appendLine(`> git commit -m "${message.replace(/\"/g, '')}"`);
  await execGit(['commit', '-m', message], cwd);
}

/** Stage a set of files. */
export async function addFiles(cwd: string, files: string[], output: OutputChannel): Promise<void> {
  if (files.length === 0) {
    return;
  }
  output.appendLine(`> git add -- ${files.join(' ')}`);
  await execGit(['add', '--', ...files], cwd);
}

/** Commit already-staged changes with a message. */
export async function commitStaged(cwd: string, message: string, output: OutputChannel): Promise<void> {
  output.appendLine(`> git commit -m "${message.replace(/\"/g, '')}"`);
  await execGit(['commit', '-m', message], cwd);
}

/** Return a diff stat for staged changes. */
export async function getStagedDiffStat(cwd: string): Promise<string> {
  return execGit(['diff', '--stat', '--cached'], cwd);
}

/** Push the current branch to the given remote. */
export async function push(cwd: string, remote: string, branch: string, output: OutputChannel): Promise<void> {
  output.appendLine(`> git push ${remote} ${branch}`);
  await execGit(['push', remote, branch], cwd);
}

/** Execute a git command and return stdout or throw on error. */
function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
