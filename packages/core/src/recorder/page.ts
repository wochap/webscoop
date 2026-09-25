/** What the injected recorder bundle needs from core: pure, no runner, no Node. */
export type { SerializedElement, SerializedNode, SerializedText } from '../ports';
export * from './protocol';
export * from './selection';
export * from '../selectors';
export { scoreFingerprint, scoreParts, SCORE_WEIGHTS, type ScoreParts } from '../healing/score';
export { collapseWhitespace, defaultAttr } from '../convert';
export { templateVariables } from '../template';
export { FIELD_SCOPES, FIELD_TYPES, PAGINATION_KINDS, STEP_KINDS, STEP_WHENS, STOP_RULES } from '../recipe/constants';
