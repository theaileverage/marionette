// Sanitized native catalogs extracted 2026-09-08. Availability remains unverified until an account probe.
export const catalogSnapshot = {
  codex: [
    {
      model: 'gpt-6-astra',
      displayName: 'GPT-6-Astra',
      description: 'Our most capable model for complex, demanding work.',
      hidden: false,
      supportedReasoningEfforts: [
        {
          reasoningEffort: 'low',
          description: 'Fast responses with lighter reasoning',
        },
        {
          reasoningEffort: 'medium',
          description: 'Balances speed and reasoning depth for everyday tasks',
        },
        {
          reasoningEffort: 'high',
          description: 'Greater reasoning depth for complex problems',
        },
        {
          reasoningEffort: 'xhigh',
          description: 'Extra high reasoning depth for complex problems',
        },
        {
          reasoningEffort: 'max',
          description: 'Maximum reasoning depth for the hardest problems',
        },
        {
          reasoningEffort: 'ultra',
          description: 'Maximum reasoning with automatic task delegation',
        },
      ],
      defaultReasoningEffort: 'medium',
      inputModalities: ['text', 'image'],
    },
    {
      model: 'gpt-5.6-sol',
      displayName: 'GPT-5.6-Sol',
      description: 'Reliable agentic workhorse for everyday tasks.',
      hidden: false,
      supportedReasoningEfforts: [
        {
          reasoningEffort: 'low',
          description: 'Fast responses with lighter reasoning',
        },
        {
          reasoningEffort: 'medium',
          description: 'Balances speed and reasoning depth for everyday tasks',
        },
        {
          reasoningEffort: 'high',
          description: 'Greater reasoning depth for complex problems',
        },
        {
          reasoningEffort: 'xhigh',
          description: 'Extra high reasoning depth for complex problems',
        },
        {
          reasoningEffort: 'max',
          description: 'Maximum reasoning depth for the hardest problems',
        },
        {
          reasoningEffort: 'ultra',
          description: 'Maximum reasoning with automatic task delegation',
        },
      ],
      defaultReasoningEffort: 'low',
      inputModalities: ['text', 'image'],
    },
    {
      model: 'gpt-5.6-terra',
      displayName: 'GPT-5.6-Terra',
      description: 'Balanced agentic coding model for everyday work.',
      hidden: false,
      supportedReasoningEfforts: [
        {
          reasoningEffort: 'low',
          description: 'Fast responses with lighter reasoning',
        },
        {
          reasoningEffort: 'medium',
          description: 'Balances speed and reasoning depth for everyday tasks',
        },
        {
          reasoningEffort: 'high',
          description: 'Greater reasoning depth for complex problems',
        },
        {
          reasoningEffort: 'xhigh',
          description: 'Extra high reasoning depth for complex problems',
        },
        {
          reasoningEffort: 'max',
          description: 'Maximum reasoning depth for the hardest problems',
        },
        {
          reasoningEffort: 'ultra',
          description: 'Maximum reasoning with automatic task delegation',
        },
      ],
      defaultReasoningEffort: 'medium',
      inputModalities: ['text', 'image'],
    },
    {
      model: 'gpt-5.6-luna',
      displayName: 'GPT-5.6-Luna',
      description: 'Fast and affordable agentic coding model.',
      hidden: false,
      supportedReasoningEfforts: [
        {
          reasoningEffort: 'low',
          description: 'Fast responses with lighter reasoning',
        },
        {
          reasoningEffort: 'medium',
          description: 'Balances speed and reasoning depth for everyday tasks',
        },
        {
          reasoningEffort: 'high',
          description: 'Greater reasoning depth for complex problems',
        },
        {
          reasoningEffort: 'xhigh',
          description: 'Extra high reasoning depth for complex problems',
        },
        {
          reasoningEffort: 'max',
          description: 'Maximum reasoning depth for the hardest problems',
        },
      ],
      defaultReasoningEffort: 'medium',
      inputModalities: ['text', 'image'],
    },
    {
      model: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: 'Proven previous-generation model for coding and general work.',
      hidden: false,
      supportedReasoningEfforts: [
        {
          reasoningEffort: 'low',
          description: 'Fast responses with lighter reasoning',
        },
        {
          reasoningEffort: 'medium',
          description: 'Balances speed and reasoning depth for everyday tasks',
        },
        {
          reasoningEffort: 'high',
          description: 'Greater reasoning depth for complex problems',
        },
        {
          reasoningEffort: 'xhigh',
          description: 'Extra high reasoning depth for complex problems',
        },
      ],
      defaultReasoningEffort: 'medium',
      inputModalities: ['text', 'image'],
    },
    {
      model: 'gpt-5.4-mini',
      displayName: 'GPT-5.4-Mini',
      description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      hidden: false,
      supportedReasoningEfforts: [
        {
          reasoningEffort: 'low',
          description: 'Fast responses with lighter reasoning',
        },
        {
          reasoningEffort: 'medium',
          description: 'Balances speed and reasoning depth for everyday tasks',
        },
        {
          reasoningEffort: 'high',
          description: 'Greater reasoning depth for complex problems',
        },
        {
          reasoningEffort: 'xhigh',
          description: 'Extra high reasoning depth for complex problems',
        },
      ],
      defaultReasoningEffort: 'medium',
      inputModalities: ['text', 'image'],
    },
    {
      model: 'gpt-5.3-codex-spark',
      displayName: 'GPT-5.3-Codex-Spark',
      description: 'Ultra-fast coding model.',
      hidden: false,
      supportedReasoningEfforts: [
        {
          reasoningEffort: 'low',
          description: 'Fast responses with lighter reasoning',
        },
        {
          reasoningEffort: 'medium',
          description: 'Balances speed and reasoning depth for everyday tasks',
        },
        {
          reasoningEffort: 'high',
          description: 'Greater reasoning depth for complex problems',
        },
        {
          reasoningEffort: 'xhigh',
          description: 'Extra high reasoning depth for complex problems',
        },
      ],
      defaultReasoningEffort: 'high',
      inputModalities: ['text'],
    },
  ],
  claude: [
    {
      value: 'default',
      resolvedModel: 'claude-opus-5[1m]',
      displayName: 'Default (recommended)',
      description: 'Opus 5 with 1M context \u00b7 Best for everyday, complex tasks',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: 'opus[1m]',
      resolvedModel: 'claude-opus-5[1m]',
      displayName: 'Opus (1M context)',
      description: 'Opus 5 with 1M context \u00b7 Best for everyday, complex tasks',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
    {
      value: 'claude-fable-5-1[1m]',
      resolvedModel: 'claude-fable-5-1',
      displayName: 'Fable',
      description: 'Fable 5.1 \u00b7 Most capable for your hardest and longest-running tasks',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    {
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-5',
      displayName: 'Sonnet',
      description: 'Sonnet 5 \u00b7 Efficient for routine tasks',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
      supportsAutoMode: true,
    },
    {
      value: 'haiku',
      resolvedModel: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku',
      description: 'Haiku 4.5 \u00b7 Fastest for quick answers',
    },
    {
      value: 'opus',
      resolvedModel: 'claude-opus-5',
      displayName: 'Opus',
      description: 'Opus 5 \u00b7 Best for everyday, complex tasks',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportsAdaptiveThinking: true,
      supportsFastMode: true,
      supportsAutoMode: true,
    },
  ],
  agy: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.7-flash-high\tGemini 3.7 Flash (High)\ngemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\ngemini-3.7-flash-low\tGemini 3.7 Flash (Low)\ngemini-3.6-flash-high\tGemini 3.6 Flash (High)\ngemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)\ngemini-3.6-flash-low\tGemini 3.6 Flash (Low)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n',
};
