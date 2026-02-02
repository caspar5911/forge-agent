import { execFile } from 'child_process';
import type { OutputChannel } from 'vscode';

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function getGitStatus(cwd: string): Promise<string[]> {
  const status = await execGit(['status', '--porcelain'], cwd);
  return status.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

export async function getDiffStat(cwd: string): Promise<string> {
  return execGit(['diff', '--stat'], cwd);
}

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

export async function getLog(cwd: string, count = 10): Promise<string> {
  return execGit(['log', `-n`, String(count), '--oneline', '--decorate'], cwd);
}

export async function getBranches(cwd: string): Promise<string> {
  return execGit(['branch', '--all'], cwd);
}

export async function getLocalBranches(cwd: string): Promise<string[]> {
  const output = await execGit(['branch', '--format=%(refname:short)'], cwd);
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

export async function getRemoteInfo(cwd: string): Promise<string> {
  return execGit(['remote', '-v'], cwd);
}

export async function fetchRemotes(cwd: string): Promise<string> {
  return execGit(['fetch', '--all', '--prune'], cwd);
}

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

export async function checkoutBranch(cwd: string, branch: string): Promise<string> {
  return execGit(['checkout', branch], cwd);
}

export async function unstageFiles(cwd: string, files: string[]): Promise<string> {
  const args = ['restore', '--staged', '--'];
  if (files.length === 0) {
    args.push('.');
  } else {
    args.push(...files);
  }
  return execGit(args, cwd);
}

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

export async function getStashList(cwd: string): Promise<string> {
  return execGit(['stash', 'list'], cwd);
}

export async function stashApply(cwd: string, ref: string): Promise<string> {
  return execGit(['stash', 'apply', ref], cwd);
}

export async function stashPop(cwd: string, ref: string): Promise<string> {
  return execGit(['stash', 'pop', ref], cwd);
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const branch = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return branch.trim();
}

export async function getRemotes(cwd: string): Promise<string[]> {
  const remotes = await execGit(['remote'], cwd);
  return remotes.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

export async function commitAll(cwd: string, message: string, output: OutputChannel): Promise<void> {
  output.appendLine('> git add -A');
  await execGit(['add', '-A'], cwd);
  output.appendLine(`> git commit -m "${message.replace(/\"/g, '')}"`);
  await execGit(['commit', '-m', message], cwd);
}

export async function addFiles(cwd: string, files: string[], output: OutputChannel): Promise<void> {
  if (files.length === 0) {
    return;
  }
  output.appendLine(`> git add -- ${files.join(' ')}`);
  await execGit(['add', '--', ...files], cwd);
}

export async function commitStaged(cwd: string, message: string, output: OutputChannel): Promise<void> {
  output.appendLine(`> git commit -m "${message.replace(/\"/g, '')}"`);
  await execGit(['commit', '-m', message], cwd);
}

export async function getStagedDiffStat(cwd: string): Promise<string> {
  return execGit(['diff', '--stat', '--cached'], cwd);
}

export async function push(cwd: string, remote: string, branch: string, output: OutputChannel): Promise<void> {
  output.appendLine(`> git push ${remote} ${branch}`);
  await execGit(['push', remote, branch], cwd);
}

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
