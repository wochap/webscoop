/** Recipe enumerations, kept free of zod so the injected page can import them cheaply. */
export const SCHEMA_VERSION = 2 as const;
/** Longest recipe, table, or variable description. */
export const DESCRIPTION_MAX = 2000;

export const STRATEGIES = ['role', 'testid', 'id', 'text', 'css', 'class', 'xpath'] as const;
export const STABILITIES = ['stable', 'medium', 'fragile'] as const;
export const FIELD_TYPES = ['text', 'number', 'url', 'image', 'date', 'html'] as const;
export const FIELD_SCOPES = ['item', 'page'] as const;
/** `none` stands for a recipe without a paginate block. */
export const PAGINATION_KINDS = ['none', 'url', 'next', 'more', 'scroll'] as const;
export const PAGINATE_KINDS = ['url', 'next', 'more', 'scroll'] as const;
export const STOP_RULES = ['no-new-items', 'first-item-repeats', 'target-missing'] as const;
export const GUARD_KINDS = ['login', 'captcha', 'zero-fields'] as const;
export const STEP_KINDS = ['click', 'fill', 'press', 'wait', 'await-user', 'download'] as const;
export const STEP_WINDOWS = ['same', 'popup'] as const;
export const STEP_UNTILS = ['appears', 'disappears'] as const;
/** Times a reactive flow may fire between two successful extractions, unless it says otherwise. */
export const DEFAULT_MAX_RETRIES = 2;
