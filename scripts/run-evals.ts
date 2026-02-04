/** Simple evaluation runner for Forge prompts. */
import * as fs from 'fs';
import * as path from 'path';
import { callChatCompletion } from '../src/llm/client';
import type { ChatMessage } from '../src/llm/client';

type EvalPrompt = {
  id: string;
  prompt: string;
  system?: string;
  expect?: {
    contains?: string[];
    notContains?: string[];
    json?: boolean;
  };
};

type EvalResult = {
  id: string;
  ok: boolean | null;
  output: string;
  error?: string;
  checks?: {
    contains?: string[];
    notContains?: string[];
    json?: boolean;
  };
};

const defaultSystem =
  'You are an assistant for evaluation. Follow the prompt exactly. If asked for JSON, return JSON only.';

/** Entry point: load prompts, run each, and write snapshot results. */
async function run(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  const prompts = loadPrompts(repoRoot);
  const results = await runPrompts(prompts);
  writeResults(repoRoot, results);
}

/** Load the eval prompt set from disk. */
function loadPrompts(repoRoot: string): EvalPrompt[] {
  const promptsPath = path.join(repoRoot, 'eval', 'prompts.json');
  const raw = fs.readFileSync(promptsPath, 'utf8');
  return JSON.parse(raw) as EvalPrompt[];
}

/** Execute each prompt and record pass/fail results. */
async function runPrompts(prompts: EvalPrompt[]): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const prompt of prompts) {
    const messages: ChatMessage[] = [
      { role: 'system', content: prompt.system ?? defaultSystem },
      { role: 'user', content: prompt.prompt }
    ];
    let output = '';
    let error: string | undefined;

    try {
      const response = await callChatCompletion({}, messages);
      output = response.choices?.[0]?.message?.content?.trim() ?? '';
    } catch (err) {
      error = String(err);
    }

    const ok = evaluatePrompt(prompt, output, error);
    results.push({ id: prompt.id, ok, output, error, checks: prompt.expect });

    const status = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${prompt.id}`);
  }

  return results;
}

/** Persist results to eval/results with a timestamp and "latest" pointer. */
function writeResults(repoRoot: string, results: EvalResult[]): void {
  const resultsDir = path.join(repoRoot, 'eval', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const payload = JSON.stringify({ generatedAt: now.toISOString(), results }, null, 2);
  fs.writeFileSync(path.join(resultsDir, `${timestamp}.json`), payload);
  fs.writeFileSync(path.join(resultsDir, 'latest.json'), payload);
}

/** Check expectations for a single prompt, returning pass/fail/skip. */
function evaluatePrompt(prompt: EvalPrompt, output: string, error?: string): boolean | null {
  if (error) {
    return false;
  }
  const expect = prompt.expect;
  if (!expect) {
    return null;
  }
  if (expect.json) {
    try {
      JSON.parse(stripFences(output));
    } catch {
      return false;
    }
  }
  if (expect.contains) {
    for (const token of expect.contains) {
      if (!output.includes(token)) {
        return false;
      }
    }
  }
  if (expect.notContains) {
    for (const token of expect.notContains) {
      if (output.includes(token)) {
        return false;
      }
    }
  }
  return true;
}

/** Remove JSON code fences if a model returns fenced output. */
function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : text;
}

void run();
