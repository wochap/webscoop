/** Recipe enumerations, kept free of zod so the injected page can import them cheaply. */
export const SCHEMA_VERSION = 1 as const;

export const STRATEGIES = ['role', 'testid', 'id', 'text', 'css', 'class', 'xpath'] as const;
export const STABILITIES = ['stable', 'medium', 'fragile'] as const;
export const FIELD_TYPES = ['text', 'number', 'url', 'image', 'date', 'html'] as const;
export const FIELD_SCOPES = ['item', 'page'] as const;
export const PAGINATION_KINDS = ['none', 'url', 'next', 'more', 'scroll'] as const;
export const STOP_RULES = ['no-new-items', 'first-item-repeats', 'target-missing'] as const;
export const GUARD_KINDS = ['login', 'captcha', 'zero-fields'] as const;
export const STEP_KINDS = ['click', 'type', 'select', 'press', 'wait'] as const;
export const STEP_WHENS = ['first-page', 'every-page'] as const;
