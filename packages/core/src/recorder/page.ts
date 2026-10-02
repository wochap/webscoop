/** What the injected recorder bundle needs from core: pure, no runner, no Node. */
export type { SerializedElement, SerializedNode, SerializedText } from '../ports';
export * from './protocol';
export * from './selection';
export * from '../selectors';
export { scoreFingerprint, scoreParts, SCORE_WEIGHTS, type ScoreParts } from '../healing/score';
export { collapseWhitespace, defaultAttr } from '../convert';
export {
  describeUrlDiff,
  fillTemplate,
  templateParts,
  templateProblem,
  templateVariables,
  urlDiff,
  VARIABLE_NAME,
  type UrlDiff,
} from '../template';
export { DEFAULT_MAX_RETRIES, FIELD_SCOPES, FIELD_TYPES, PAGINATE_KINDS, PAGINATION_KINDS, STEP_KINDS, STEP_UNTILS, STEP_WINDOWS, STOP_RULES } from '../recipe/constants';
