import type { AnnotatedNode } from '../selectors/annotated';
import type { AgentAction } from './actions';
import { accessibleName } from './outline';

/** Words on a control that make a click consequential, whatever its form. */
export const RISK_WORDS = ['pay', 'buy', 'purchase', 'order', 'checkout', 'delete', 'remove', 'send', 'submit', 'confirm', 'subscribe', 'transfer', 'book', 'sign up', 'register', 'publish', 'post'] as const;

const RISKY = new RegExp(`\\b(?:${RISK_WORDS.map((w) => w.replace(/ /g, '[\\s-]+')).join('|')})\\b`, 'i');

/** Input types that are not typed into. */
const NOT_TEXT = new Set(['checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'hidden']);

/** Whether a node is a text field: an input other than a checkbox, radio, file, or button-like one, or a textarea. */
export function isTextField(node: AnnotatedNode): boolean {
  if (node.tag === 'textarea') return true;
  return node.tag === 'input' && !NOT_TEXT.has((node.attrs.type ?? 'text').toLowerCase());
}

/** Whether a node is a control that submits its form when clicked. */
function isSubmitControl(node: AnnotatedNode): boolean {
  if (node.tag === 'button') return (node.attrs.type ?? 'submit').toLowerCase() === 'submit';
  if (node.tag === 'input') {
    const type = (node.attrs.type ?? '').toLowerCase();
    return type === 'submit' || type === 'image';
  }
  return false;
}

const rootOf = (node: AnnotatedNode): AnnotatedNode => {
  let n = node;
  while (n.parent) n = n.parent;
  return n;
};

function findById(root: AnnotatedNode, id: string): AnnotatedNode | null {
  if (root.attrs.id === id) return root;
  for (const c of root.children) {
    if (c.type !== 'element') continue;
    const found = findById(c, id);
    if (found) return found;
  }
  return null;
}

/** The form a control belongs to: its `form=` owner, else its nearest `form` ancestor. */
function formOf(node: AnnotatedNode): AnnotatedNode | null {
  const owner = node.attrs.form;
  if (owner) {
    const form = findById(rootOf(node), owner);
    if (form?.tag === 'form') return form;
  }
  for (let n = node.parent; n; n = n.parent) if (n.tag === 'form') return n;
  return null;
}

const inPostForm = (node: AnnotatedNode) => (formOf(node)?.attrs.method ?? '').toLowerCase() === 'post';

/** Whether a node's accessible name holds a risk word, as a whole word, ignoring case. */
export function hasRiskWord(node: AnnotatedNode): boolean {
  return RISKY.test(accessibleName(node));
}

/**
 * Whether an action would submit: a click on a submit control of a POST form,
 * Enter on a text field of one (without a ref, on the field the step last
 * filled), or a click on a control named with a risk word.
 */
export function classifySubmit(node: AnnotatedNode | undefined, action: AgentAction, lastFill: AnnotatedNode | undefined): boolean {
  if (action.action === 'click') {
    if (!node) return false;
    return (isSubmitControl(node) && inPostForm(node)) || hasRiskWord(node);
  }
  if (action.action === 'press') {
    if (action.key.toLowerCase() !== 'enter') return false;
    const field = action.ref !== undefined ? node : lastFill;
    return field !== undefined && isTextField(field) && inPostForm(field);
  }
  return false;
}
