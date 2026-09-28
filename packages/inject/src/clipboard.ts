/**
 * Copy text to the clipboard: the async clipboard API on secure pages, else
 * `execCommand('copy')` through a hidden textarea inside `root` (the panel's
 * shadow root, so page listeners do not see it). Returns whether it copied.
 */
export async function copyText(text: string, root?: Node): Promise<boolean> {
  if (typeof window !== 'undefined' && window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the textarea path.
    }
  }
  try {
    const doc = root?.ownerDocument ?? document;
    const parent = root instanceof ShadowRoot || root instanceof Element ? root : doc.body;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    parent.appendChild(area);
    area.select();
    const ok = doc.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
