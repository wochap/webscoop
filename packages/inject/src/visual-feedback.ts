export interface VisualRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WebscoopVisuals {
  flashRect(rect: VisualRect, label?: string): void;
  ripple(x: number, y: number): void;
  trail(from: { x: number; y: number }, to: { x: number; y: number }): void;
  destroy(): void;
}

declare global {
  interface Window {
    __webscoopVisuals?: WebscoopVisuals;
  }
}

export const VISUAL_FEEDBACK_STYLE = `
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
`;

export function setupVisualFeedback(win: Window & typeof globalThis = window): WebscoopVisuals {
  if (win.__webscoopVisuals) return win.__webscoopVisuals;

  const doc = win.document;
  const host = doc.createElement('webscoop-visuals');
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = VISUAL_FEEDBACK_STYLE;
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

  const observer = new win.MutationObserver(() => {
    attach();
  });
  if (doc.documentElement) {
    observer.observe(doc.documentElement, { childList: true });
  }

  const visuals: WebscoopVisuals = {
    flashRect(rect: VisualRect, label?: string) {
      attach();
      const el = doc.createElement('div');
      el.className = 'ws-visuals-flash';
      el.style.left = `${rect.x}px`;
      el.style.top = `${rect.y}px`;
      el.style.width = `${rect.w}px`;
      el.style.height = `${rect.h}px`;

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

    ripple(x: number, y: number) {
      attach();
      const el = doc.createElement('div');
      el.className = 'ws-visuals-ripple';
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      container.appendChild(el);
      setTimeout(() => {
        el.remove();
      }, 400);
    },

    trail(from: { x: number; y: number }, to: { x: number; y: number }) {
      attach();
      const steps = 4;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = from.x + (to.x - from.x) * t;
        const y = from.y + (to.y - from.y) * t;
        setTimeout(() => {
          const dot = doc.createElement('div');
          dot.className = 'ws-visuals-trail';
          dot.style.left = `${x}px`;
          dot.style.top = `${y}px`;
          container.appendChild(dot);
          setTimeout(() => dot.remove(), 300);
        }, i * 20);
      }
    },

    destroy() {
      observer.disconnect();
      host.remove();
      delete win.__webscoopVisuals;
    },
  };

  win.__webscoopVisuals = visuals;
  return visuals;
}
