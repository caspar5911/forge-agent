/** Verification pass after edits to ensure requirements are met. */
import type { ChatMessage } from '../llm/client';
import { requestStructuredJson } from '../llm/structured';
import { VERIFICATION_SCHEMA } from './schemas';
import { recordPrompt, recordResponse, recordStep } from './trace';
import { getRoutedConfig } from '../llm/routing';

export type VerificationResult = {
  status: 'pass' | 'fail';
  issues: string[];
  confidence?: 'low' | 'medium' | 'high';
};

export async function verifyChanges(
  instruction: string,
  changeSummary: string,
  validationOutput: string | null,
  signal?: AbortSignal
): Promise<VerificationResult> {
  const validationBlock = validationOutput ? `\n\nValidation output:\n${validationOutput}` : '';
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are verifying whether code changes satisfy the instruction. ' +
        'Return ONLY valid JSON: {"status":"pass|fail","issues":["..."],"confidence":"low|medium|high"}. ' +
        'If any requirement is unmet or risky, set status to "fail" and list issues.'
    },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n\n` +
        `Change summary:\n${changeSummary || '(no summary)'}${validationBlock}`
    }
  ];

  recordPrompt('Verification prompt', messages, true);
  const payload = await requestStructuredJson<VerificationResult>(messages, VERIFICATION_SCHEMA, {
    signal,
    config: getRoutedConfig('verify')
  });
  recordResponse('Verification response', JSON.stringify(payload));
  const issues = Array.isArray(payload.issues) ? payload.issues.map((item) => String(item)).filter(Boolean) : [];
  const status = payload.status === 'fail' ? 'fail' : 'pass';
  const confidence =
    payload.confidence === 'high' || payload.confidence === 'medium' ? payload.confidence : 'low';
  const result: VerificationResult = { status, issues, confidence };
  recordStep('Verification status', `${status} (${confidence})`);
  if (issues.length > 0) {
    recordStep('Verification issues', issues.map((item) => `- ${item}`).join('\n'));
  }
  return result;
}
