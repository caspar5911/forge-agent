/** Repo-aware evaluation harness with contextual prompts and optional commands. */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { callChatCompletion } from '../src/llm/client';
import type { ChatMessage } from '../src/llm/client';

type EvalExpectation = {
  contains?: string[];
  notContains?: string[];
  json?: boolean;
};

type RepoEvalTask = {
  id: string;
  kind: 'qa' | 'edit' | 'command';
  instruction?: string;
  contextFiles?: string[];
  command?: string;
  expectExitCode?: number;
  expect?: EvalExpectation;
  maxCharsPerFile?: number;
};

type RepoEvalResult = {
  id: string;
  kind: RepoEvalTask['kind'];
  ok: boolean | null;
  score: number | null;
  output?: string;
  error?: string;
  checks?: EvalExpectation;
};

const defaultSystemQa =
  'You are answering a repo question. Use ONLY the provided context. Be concise.';
const defaultSystemEdit =
  'You are editing a file. Return ONLY the full updated file content. No code fences or extra text.';

async function run(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  const tasks = loadTasks(repoRoot);
  const results: RepoEvalResult[] = [];

  for (const task of tasks) {
    if (task.kind === 'command') {
      const command = task.command ?? '';
      const expectedCode = task.expectExitCode ?? 0;
      const { code, output } = await runCommand(command, repoRoot);
      const ok = code === expectedCode;
      results.push({
        id: task.id,
        kind: task.kind,
        ok,
        score: ok ? 1 : 0,
        output,
        checks: task.expect
      });
      const status = ok ? 'PASS' : 'FAIL';
      console.log(`[${status}] ${task.id}`);
      continue;
    }

    const context = buildContext(repoRoot, task.contextFiles ?? [], task.maxCharsPerFile ?? 4000);
    const messages = buildMessages(task, context);
    let output = '';
    let error: string | undefined;

    try {
      const response = await callChatCompletion({}, messages);
      output = response.choices?.[0]?.message?.content?.trim() ?? '';
    } catch (err) {
      error = String(err);
    }

    const evaluation = evaluateTask(task.expect, output, error);
    results.push({
      id: task.id,
      kind: task.kind,
      ok: evaluation.ok,
      score: evaluation.score,
      output,
      error,
      checks: task.expect
    });
    const status = evaluation.ok === null ? 'SKIP' : evaluation.ok ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${task.id}`);
  }

  writeResults(repoRoot, results);
}

function loadTasks(repoRoot: string): RepoEvalTask[] {
  const tasksPath = path.join(repoRoot, 'eval', 'repo-tasks.json');
  const raw = fs.readFileSync(tasksPath, 'utf8');
  return JSON.parse(raw) as RepoEvalTask[];
}

function buildContext(repoRoot: string, files: string[], maxChars: number): string {
  if (!files || files.length === 0) {
    return '';
  }
  const snippets: string[] = [];
  files.forEach((relativePath) => {
    const fullPath = path.join(repoRoot, relativePath);
    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const content = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n... (truncated)` : raw;
      snippets.push(`File: ${relativePath}\n${content}`);
    } catch {
      snippets.push(`File: ${relativePath}\n(Unable to read file)`);
    }
  });
  return snippets.join('\n\n---\n\n');
}

function buildMessages(task: RepoEvalTask, context: string): ChatMessage[] {
  if (task.kind === 'edit') {
    const target = task.contextFiles?.[0] ?? 'unknown';
    return [
      { role: 'system', content: defaultSystemEdit },
      {
        role: 'user',
        content:
          `Instruction: ${task.instruction}\n` +
          `Target file: ${target}\n` +
          'Current file content:\n' +
          '---\n' +
          `${context}\n` +
          '---\n' +
          'Return the full updated file content only.'
      }
    ];
  }

  return [
    { role: 'system', content: defaultSystemQa },
    {
      role: 'user',
      content:
        `Instruction: ${task.instruction}\n\n` +
        `Context:\n${context}`
    }
  ];
}

function evaluateTask(expect: EvalExpectation | undefined, output: string, error?: string): { ok: boolean | null; score: number | null } {
  if (error) {
    return { ok: false, score: 0 };
  }
  if (!expect) {
    return { ok: null, score: null };
  }

  let totalChecks = 0;
  let passedChecks = 0;

  if (expect.json) {
    totalChecks += 1;
    try {
      JSON.parse(stripFences(output));
      passedChecks += 1;
    } catch {
      // fail
    }
  }
  if (expect.contains) {
    for (const token of expect.contains) {
      totalChecks += 1;
      if (output.includes(token)) {
        passedChecks += 1;
      }
    }
  }
  if (expect.notContains) {
    for (const token of expect.notContains) {
      totalChecks += 1;
      if (!output.includes(token)) {
        passedChecks += 1;
      }
    }
  }

  const score = totalChecks > 0 ? passedChecks / totalChecks : null;
  const ok = totalChecks > 0 ? passedChecks === totalChecks : null;
  return { ok, score };
}

function writeResults(repoRoot: string, results: RepoEvalResult[]): void {
  const resultsDir = path.join(repoRoot, 'eval', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const payload = JSON.stringify({ generatedAt: now.toISOString(), results }, null, 2);
  fs.writeFileSync(path.join(resultsDir, `repo-${timestamp}.json`), payload);
  fs.writeFileSync(path.join(resultsDir, 'repo-latest.json'), payload);
}

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : text;
}

async function runCommand(command: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let output = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });
    child.stderr.on('data', (data) => {
      output += data.toString();
    });
    child.on('close', (code) => resolve({ code: code ?? 0, output }));
  });
}

void run();
