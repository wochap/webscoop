/** What the injected recorder bundle needs from core: pure, no runner, no Node. */
export type { SerializedElement, SerializedNode, SerializedText } from '../ports';
export * from './protocol';
export * from './selection';
export * from '../selectors';
export { collapseWhitespace } from '../convert';
export { templateVariables } from '../template';
export { FIELD_TYPES, PAGINATION_KINDS, STOP_RULES } from '../recipe/constants';
