import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';

export interface DropdownOption<T extends string> {
  value: T;
  glyph: ReactNode;
  name: string;
  /** A short grey example on the right of the row. */
  hint?: string;
}

const MARGIN = 4;

/** Where the menus float: the panel root, else the trigger's shadow root or document body. */
function layerFor(el: HTMLElement): Element | DocumentFragment {
  const panel = el.closest('#ws-root');
  if (panel) return panel;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root : el.ownerDocument.body;
}

/**
 * A panel menu in place of a native `<select>`: a trigger button that shows
 * the value and a listbox floating in the panel layer with fixed positioning,
 * so no section clips it. Keys it consumes never reach the panel shortcuts.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
  renderTrigger,
  footer,
  width = 210,
  className = 'ws-dd-trigger',
  title,
}: {
  value: T;
  options: readonly DropdownOption<T>[];
  onChange: (value: T) => void;
  label: string;
  /** `data-ws` of the trigger; options get `${testId}-option`. */
  testId: string;
  renderTrigger?: (current: DropdownOption<T> | undefined) => ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));

  const close = (refocus = true) => {
    setOpen(false);
    setPos(null);
    if (refocus) trigger.current?.focus();
  };
  const choose = (index: number) => {
    const option = options[index];
    close();
    if (option && option.value !== value) onChange(option.value);
  };
  const openMenu = (index = selectedIndex) => {
    setActive(index);
    setOpen(true);
  };

  // Place the menu below the trigger, or above it when the panel has no room below.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const t = trigger.current.getBoundingClientRect();
    const height = menu.current.offsetHeight;
    const panel = trigger.current.closest('#ws-root')?.getBoundingClientRect();
    const view = trigger.current.ownerDocument.defaultView;
    const bottom = panel && panel.height > 0 ? panel.bottom : (view?.innerHeight ?? Infinity);
    const top = panel && panel.height > 0 ? panel.top : 0;
    const right = panel && panel.width > 0 ? panel.right : (view?.innerWidth ?? Infinity);
    const below = t.bottom + MARGIN;
    const flip = below + height > bottom && t.top - MARGIN - height >= top;
    const left = Math.max(panel && panel.width > 0 ? panel.left + MARGIN : 0, Math.min(t.left, right - width - MARGIN));
    // `#ws-root` has `contain: layout`, so it, not the viewport, is the containing block of the fixed menu.
    // The unplaced menu sits at left 0, top 0 of that block: its rect gives the block's origin.
    const origin = menu.current.getBoundingClientRect();
    setPos({ left: left - origin.left, top: (flip ? t.top - MARGIN - height : below) - origin.top });
  }, [open, width]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus({ preventScroll: true });
  }, [open, active, pos]);

  // Outside clicks and scrolling close the menu.
  useEffect(() => {
    if (!open || !trigger.current) return;
    const root = trigger.current.getRootNode() as Document | ShadowRoot;
    const host = root instanceof ShadowRoot ? root.host : null;
    const inside = (e: Event) => {
      const path = e.composedPath();
      return path.includes(menu.current!) || path.includes(trigger.current!);
    };
    const onDown = (e: Event) => {
      // A closed shadow root hides its nodes from the path seen by window listeners;
      // events from inside the panel are judged by the shadow root listener instead.
      if (e.currentTarget !== root && host && e.composedPath().includes(host)) return;
      if (!inside(e)) close(false);
    };
    const onScroll = (e: Event) => {
      if (!menu.current || !(e.target instanceof Node) || !menu.current.contains(e.target)) close(false);
    };
    const win = trigger.current.ownerDocument.defaultView ?? window;
    const targets: EventTarget[] = root === trigger.current.ownerDocument ? [win] : [root, win];
    // Inside a shadow root, only scrolls of the panel move the trigger; the page scrolling under a fixed panel does not.
    const scrollTarget: EventTarget = host ? root : win;
    for (const t of targets) {
      t.addEventListener('pointerdown', onDown, true);
      t.addEventListener('mousedown', onDown, true);
    }
    scrollTarget.addEventListener('scroll', onScroll, true);
    win.addEventListener('resize', onScroll);
    return () => {
      for (const t of targets) {
        t.removeEventListener('pointerdown', onDown, true);
        t.removeEventListener('mousedown', onDown, true);
      }
      scrollTarget.removeEventListener('scroll', onScroll, true);
      win.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const consume = (e: ReactKeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
  };

  const onTriggerKey = (e: ReactKeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      consume(e);
      openMenu();
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const n = options.length;
    if (e.key === 'Tab') {
      e.stopPropagation();
      close(false);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowDown':
        consume(e);
        setActive((active + 1) % n);
        return;
      case 'ArrowUp':
        consume(e);
        setActive((active - 1 + n) % n);
        return;
      case 'Home':
        consume(e);
        setActive(0);
        return;
      case 'End':
        consume(e);
        setActive(n - 1);
        return;
      case 'Enter':
      case ' ':
        consume(e);
        choose(active);
        return;
      case 'Escape':
        consume(e);
        close();
        return;
    }
    if (e.key.length === 1 && /\S/.test(e.key)) {
      consume(e);
      const letter = e.key.toLowerCase();
      for (let step = 1; step <= n; step++) {
        const i = (active + step) % n;
        if (options[i]!.name.toLowerCase().startsWith(letter) || options[i]!.value.toLowerCase().startsWith(letter)) {
          setActive(i);
          return;
        }
      }
    }
  };

  const list = open && trigger.current && (
    <div
      ref={menu}
      className="ws-dd-menu"
      role="listbox"
      aria-label={label}
      data-ws={`${testId}-menu`}
      style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, width, visibility: pos ? undefined : 'hidden' }}
      onKeyDown={onMenuKey}
    >
      {options.map((o, i) => (
        <div
          key={o.value}
          className="ws-dd-row"
          role="option"
          tabIndex={i === active ? 0 : -1}
          aria-selected={o.value === value}
          data-active={i === active ? true : undefined}
          data-index={i}
          data-value={o.value}
          data-ws={`${testId}-option`}
          onMouseEnter={() => setActive(i)}
          onClick={() => choose(i)}
        >
          <span className="ws-dd-glyph">{o.glyph}</span>
          <span className="ws-dd-name">{o.name}</span>
          <span className="ws-spacer" />
          {o.hint && <span className="ws-dd-hint">{o.hint}</span>}
        </div>
      ))}
      {footer && <div className="ws-dd-foot">{footer}</div>}
    </div>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        value={value}
        data-value={value}
        data-ws={testId}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKey}
      >
        {renderTrigger ? (
          renderTrigger(current)
        ) : (
          <>
            <span className="ws-dd-value">{current?.name ?? value}</span>
            <Icon name="caret-down" size={9} />
          </>
        )}
      </button>
      {list && createPortal(list, layerFor(trigger.current!))}
    </>
  );
}
