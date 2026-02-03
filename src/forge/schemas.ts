/** Shared JSON schemas for structured LLM responses. */
export const FILE_SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['files'],
  additionalProperties: false
} as const;

export const FILE_UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  required: ['files'],
  additionalProperties: false
} as const;

export const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['edit', 'question', 'fix'] },
    confidence: { type: 'number' }
  },
  required: ['intent'],
  additionalProperties: false
} as const;

export const CLARIFICATION_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { const: 'proceed' }
      },
      required: ['kind'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'clarification' },
        questions: {
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['kind', 'questions'],
      additionalProperties: false
    }
  ]
} as const;

export const CLARIFICATION_SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: { type: 'string' }
    },
    plan: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['answers', 'plan'],
  additionalProperties: false
} as const;

export const DISAMBIGUATION_SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          instruction: { type: 'string' }
        },
        required: ['label'],
        additionalProperties: false
      }
    }
  },
  required: ['options'],
  additionalProperties: false
} as const;

export const PLAN_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    plan: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['plan'],
  additionalProperties: false
} as const;

export const VERIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail'] },
    issues: {
      type: 'array',
      items: { type: 'string' }
    },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
  },
  required: ['status', 'issues'],
  additionalProperties: false
} as const;

export const GIT_INTENT_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          branch: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          staged: { type: 'boolean' },
          full: { type: 'boolean' },
          includeUntracked: { type: 'boolean' },
          message: { type: 'string' },
          ref: { type: 'string' }
        },
        required: ['type'],
        additionalProperties: true
      }
    }
  },
  required: ['actions'],
  additionalProperties: false
} as const;

export const TASK_PLAN_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { const: 'clarification' },
        questions: { type: 'array', items: { type: 'string' } }
      },
      required: ['kind', 'questions'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        kind: { const: 'plan' },
        steps: { type: 'array', items: { type: 'string' } }
      },
      required: ['kind', 'steps'],
      additionalProperties: false
    }
  ]
} as const;

export const TOOL_CALL_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        tool: { const: 'read_file' },
        path: { type: 'string' }
      },
      required: ['tool', 'path'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        tool: { const: 'request_diff' }
      },
      required: ['tool'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: {
        tool: { const: 'run_validation_command' },
        command: { type: 'string' }
      },
      required: ['tool', 'command'],
      additionalProperties: false
    }
  ]
} as const;
