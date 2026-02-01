// Minimal shape for any project context data.
export type ProjectContext = Record<string, unknown>;

// Output can be either clarification questions or a concrete task plan.
export type TaskPlan =
  | { kind: 'clarification'; questions: string[] }
  | { kind: 'plan'; steps: string[] };

// Convert a short instruction into either questions or an ordered plan.
export function compressTask(instruction: string, context: ProjectContext): TaskPlan {
  // Context is intentionally unused at this phase.
  void context;

  // Normalize the input.
  const trimmed = instruction.trim();
  // Empty input means we must ask for clarification.
  if (!trimmed) {
    return {
      kind: 'clarification',
      questions: [
        'What should be changed or created?',
        'Which part of the project does this apply to?',
        'What is the expected outcome?'
      ]
    };
  }

  // Tokenize basic words/paths for simple ambiguity checks.
  const tokens = trimmed.toLowerCase().match(/[a-z0-9._/\\-]+/g) ?? [];
  const wordCount = tokens.length;
  // Quoted text hints the user provided a specific target.
  const hasQuoted = /["'`].+["'`]/.test(trimmed);
  // Path-like tokens hint at a concrete location.
  const hasPathLike = tokens.some((token) => token.includes('/') || token.includes('\\') || token.includes('.'));
  // Vague pronouns often mean the request lacks a clear target.
  const hasVaguePronoun = /\b(it|this|that|these|those|them|something|stuff|anything|whatever)\b/i.test(trimmed);

  // If the request is too short or too vague, ask for clarification.
  if (wordCount < 2 || (hasVaguePronoun && !hasQuoted && !hasPathLike)) {
    return {
      kind: 'clarification',
      questions: [
        'What exactly should be changed or created?',
        'Where in the project should this apply?',
        'What does success look like?'
      ]
    };
  }

  // Split the instruction into step-like segments.
  const segments = trimmed
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/g, '')
    .split(/\b(?:and then|then|after that|afterwards|also|and)\b|[.;]/i)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const steps: string[] = [];
  // Always start by reviewing context.
  steps.push('Review the provided ProjectContext to understand the current state.');

  // If there is only one segment, keep it as a single task.
  if (segments.length <= 1) {
    steps.push(`Carry out the request: ${trimmed}.`);
  } else {
    // Otherwise, turn each segment into its own step.
    for (const segment of segments) {
      const sentence = segment.endsWith('.') ? segment : `${segment}.`;
      steps.push(sentence.charAt(0).toUpperCase() + sentence.slice(1));
    }
  }

  // Close with a verification step.
  steps.push('Verify the result matches the instruction.');

  return { kind: 'plan', steps };
}
