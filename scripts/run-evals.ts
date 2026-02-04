/* Simple evaluation runner for Forge prompts. */
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

async function run(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..');
  const promptsPath = path.join(repoRoot, 'eval', 'prompts.json');
  const raw = fs.readFileSync(promptsPath, 'utf8');
  const prompts = JSON.parse(raw) as EvalPrompt[];

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
    results.push({
      id: prompt.id,
      ok,
      output,
      error,
      checks: prompt.expect
    });

    const status = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${prompt.id}`);
  }

  const resultsDir = path.join(repoRoot, 'eval', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsPath = path.join(resultsDir, `${timestamp}.json`);
  fs.writeFileSync(resultsPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  fs.writeFileSync(path.join(resultsDir, 'latest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
}

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

function stripFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : text;
}

void run();
