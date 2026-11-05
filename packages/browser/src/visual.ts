import type { ElementRef, InteractiveSession } from '@webscoop/core';

export const VISUAL_FEEDBACK_SCRIPT = `(() => {
  if (window.__webscoopVisuals) return;

  const styleText = \`
:host {
  all: initial;
}
.ws-visuals-container {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483647;
  contain: strict;
  overflow: hidden;
}
.ws-visuals-flash {
  position: absolute;
  border: 2px solid #9184d9;
  background: rgba(145, 132, 217, 0.16);
  border-radius: 4px;
  pointer-events: none;
  box-sizing: border-box;
  animation: ws-fade-out 0.25s forwards;
}
.ws-visuals-label {
  position: absolute;
  top: -20px;
  left: 0;
  background: #9184d9;
  color: #ffffff;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 2px;
  white-space: nowrap;
}
.ws-visuals-ripple {
  position: absolute;
  width: 32px;
  height: 32px;
  border: 2px solid #9184d9;
  border-radius: 50%;
  pointer-events: none;
  transform: translate(-50%, -50%) scale(0.2);
  animation: ws-ripple-anim 0.4s ease-out forwards;
}
.ws-visuals-trail {
  position: absolute;
  width: 6px;
  height: 6px;
  background: #9184d9;
  border-radius: 50%;
  pointer-events: none;
  transform: translate(-50%, -50%);
  animation: ws-trail-anim 0.3s ease-out forwards;
}
@keyframes ws-ripple-anim {
  0% { transform: translate(-50%, -50%) scale(0.2); opacity: 0.9; }
  100% { transform: translate(-50%, -50%) scale(2.2); opacity: 0; }
}
@keyframes ws-fade-out {
  0% { opacity: 1; }
  80% { opacity: 1; }
  100% { opacity: 0; }
}
@keyframes ws-trail-anim {
  0% { opacity: 0.8; }
  100% { opacity: 0; }
}
\`;

  const doc = document;
  const host = doc.createElement('webscoop-visuals');
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = styleText;
  shadow.appendChild(style);

  const container = doc.createElement('div');
  container.className = 'ws-visuals-container';
  shadow.appendChild(container);

  const attach = () => {
    if (doc.documentElement && !doc.documentElement.contains(host)) {
      doc.documentElement.appendChild(host);
    }
  };

  attach();

  const observer = new MutationObserver(() => {
    attach();
  });
  if (doc.documentElement) {
    observer.observe(doc.documentElement, { childList: true });
  }

  window.__webscoopVisuals = {
    flashRect(rect, label) {
      attach();
      const el = doc.createElement('div');
      el.className = 'ws-visuals-flash';
      el.style.left = rect.x + 'px';
      el.style.top = rect.y + 'px';
      el.style.width = rect.w + 'px';
      el.style.height = rect.h + 'px';

      if (label) {
        const tag = doc.createElement('span');
        tag.className = 'ws-visuals-label';
        tag.textContent = label;
        el.appendChild(tag);
      }

      container.appendChild(el);
      setTimeout(() => {
        el.remove();
      }, 250);
    },

    ripple(x, y) {
      attach();
      const el = doc.createElement('div');
      el.className = 'ws-visuals-ripple';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      container.appendChild(el);
      setTimeout(() => {
        el.remove();
      }, 400);
    },

    trail(from, to) {
      attach();
      const steps = 4;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        setTimeout(() => {
          const dot = doc.createElement('div');
          dot.className = 'ws-visuals-trail';
          dot.style.left = x + 'px';
          dot.style.top = y + 'px';
          container.appendChild(dot);
          setTimeout(() => dot.remove(), 300);
        }, i * 20);
      }
    },
  };
})();`;

/** Inject visual feedback overlay into session. */
export async function injectVisualFeedback(session: InteractiveSession): Promise<void> {
  await session.inject(VISUAL_FEEDBACK_SCRIPT);
}

/** Flash a bounding box around an element for 250ms. */
export async function flashElement(
  session: InteractiveSession,
  ref: ElementRef,
  label?: string,
): Promise<void> {
  try {
    const box = await session.geometry(ref);
    if (box.w > 0 && box.h > 0) {
      await session.evaluate(
        `window.__webscoopVisuals?.flashRect(${JSON.stringify(box)}, ${JSON.stringify(label ?? '')})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch {
    // Non-fatal if visuals fail
  }
}

/** Render a click ripple animation at (x, y). */
export async function clickRipple(
  session: InteractiveSession,
  x: number,
  y: number,
): Promise<void> {
  try {
    await session.evaluate(`window.__webscoopVisuals?.ripple(${x}, ${y})`);
  } catch {
    // Non-fatal
  }
}

/** Render a drag or motion trail from `from` to `to`. */
export async function dragTrail(
  session: InteractiveSession,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  try {
    await session.evaluate(
      `window.__webscoopVisuals?.trail(${JSON.stringify(from)}, ${JSON.stringify(to)})`,
    );
  } catch {
    // Non-fatal
  }
}
