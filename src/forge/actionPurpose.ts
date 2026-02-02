import type { OutputChannel } from 'vscode';
import type { ChatMessage } from '../llm/client';
import { callChatCompletion, callChatCompletionStream } from '../llm/client';
import { isAbortError, logOutput } from './logging';
import type { ForgeUiApi } from '../ui/api';

export async function logActionPurpose(
  instruction: string,
  files: string[],
  output: OutputChannel,
  panelApi: ForgeUiApi | undefined,
  signal?: AbortSignal
): Promise<void> {
  const messages = buildActionPurposeMessages(instruction, files);
  logOutput(output, panelApi, 'Summarizing actions...');
  try {
    if (panelApi?.appendStream) {
      panelApi.startStream?.('assistant');
      const content = await callChatCompletionStream(
        {},
        messages,
        (delta) => panelApi.appendStream?.(delta),
        signal
      );
      panelApi.endStream?.();
      if (!content) {
        return;
      }
      content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .forEach((line) => output.appendLine(line));
      return;
    }

    const response = await callChatCompletion({}, messages, signal);
    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return;
    }
    content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .forEach((line) => logOutput(output, panelApi, line));
  } catch (error) {
    if (isAbortError(error)) {
      panelApi?.endStream?.();
      return;
    }
    panelApi?.endStream?.();
  }
}

function buildActionPurposeMessages(instruction: string, files: string[]): ChatMessage[] {
  const fileList = files.slice(0, 20).join(', ');
  return [
    {
      role: 'system',
      content:
        'Summarize the intended changes as short bullet points. ' +
        'Each bullet must be "Action - Purpose" and must be specific. ' +
        'Do not mention that you are an AI. Return 1-3 bullets only.'
    },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n` +
        `Target files: ${fileList}\n` +
        'Return bullets only.'
    }
  ];
}
