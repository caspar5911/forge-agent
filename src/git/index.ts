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
