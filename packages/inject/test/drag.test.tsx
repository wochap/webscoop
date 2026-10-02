// @vitest-environment jsdom
import './drag-event';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropIndex, isNoop, slotFor, useDragList, type DragRow, type DragSlot } from '../src/ui/drag';

afterEach(cleanup);

const rect = { left: 0, top: 0, width: 100, height: 20 };

describe('drag slot math', () => {
  it('picks the gap before a row in its first half and after it in its second half', () => {
    expect(slotFor(2, rect, 5, 'y')).toBe(2);
    expect(slotFor(2, rect, 15, 'y')).toBe(3);
    expect(slotFor(2, rect, 40, 'x')).toBe(2);
    expect(slotFor(2, rect, 60, 'x')).toBe(3);
    expect(slotFor(2, { ...rect, height: 0 }, 15, 'y')).toBe(2);
  });

  it('treats the gaps next to the dragged row as no-ops', () => {
    expect(isNoop(1, 1)).toBe(true);
    expect(isNoop(1, 2)).toBe(true);
    expect(isNoop(1, 0)).toBe(false);
    expect(isNoop(1, 3)).toBe(false);
  });

  it('converts a gap into a remove-then-insert index in both directions', () => {
    expect(dropIndex(0, 3)).toBe(2);
    expect(dropIndex(2, 0)).toBe(0);
  });
});

function List({ list, items, onMove }: { list: string; items: string[]; onMove: (from: DragRow, slot: DragSlot) => void }) {
  const drag = useDragList({ list, axis: 'y', onMove });
  return (
    <div data-testid={list} {...drag.containerProps}>
      {items.map((name, i) => {
        const { props, state } = drag.row(i);
        return (
          <div key={name} draggable data-name={name} data-dragging={state.dragging || undefined} data-before={state.lineBefore || undefined} data-after={state.lineAfter || undefined} {...props}>
            {name}
          </div>
        );
      })}
    </div>
  );
}

/** Rows at y 0, 20, 40, ... with height 20. */
function layout(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-name]').forEach((el, i) => {
    el.getBoundingClientRect = () => ({ left: 0, top: i * 20, width: 100, height: 20, right: 100, bottom: i * 20 + 20, x: 0, y: i * 20, toJSON: () => ({}) });
  });
}

describe('useDragList', () => {
  it('shows the line on the hovered row and moves into that gap', () => {
    const onMove = vi.fn();
    const { container } = render(<List list="a" items={['title', 'price', 'url']} onMove={onMove} />);
    layout(container);
    const rows = [...container.querySelectorAll<HTMLElement>('[data-name]')];
    fireEvent.dragStart(rows[0]!);
    expect(rows[0]!.dataset.dragging).toBe('true');
    fireEvent.dragOver(rows[1]!, { clientY: 35 });
    expect(rows[1]!.dataset.after).toBe('true');
    expect(container.querySelectorAll('[data-before], [data-after]')).toHaveLength(1);
    fireEvent.drop(rows[1]!, { clientY: 35 });
    expect(onMove).toHaveBeenCalledWith({ container: '', index: 0 }, { container: '', index: 2 });
    expect(container.querySelectorAll('[data-before], [data-after], [data-dragging]')).toHaveLength(0);
  });

  it('shows no line and moves nothing for a no-op gap', () => {
    const onMove = vi.fn();
    const { container } = render(<List list="a" items={['title', 'price', 'url']} onMove={onMove} />);
    layout(container);
    const rows = [...container.querySelectorAll<HTMLElement>('[data-name]')];
    fireEvent.dragStart(rows[1]!);
    fireEvent.dragOver(rows[0]!, { clientY: 15 });
    expect(container.querySelectorAll('[data-before], [data-after]')).toHaveLength(0);
    fireEvent.drop(rows[0]!, { clientY: 15 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('ignores rows dragged from another list', () => {
    const onMove = vi.fn();
    const { getByTestId } = render(
      <>
        <List list="a" items={['title', 'price']} onMove={onMove} />
        <List list="b" items={['click', 'fill']} onMove={onMove} />
      </>,
    );
    const a = getByTestId('a');
    const b = getByTestId('b');
    layout(a);
    layout(b);
    fireEvent.dragStart(a.querySelector<HTMLElement>('[data-name]')!);
    const target = b.querySelectorAll<HTMLElement>('[data-name]')[1]!;
    expect(fireEvent.dragOver(target, { clientY: 35 })).toBe(true);
    expect(b.querySelectorAll('[data-before], [data-after]')).toHaveLength(0);
    fireEvent.drop(target, { clientY: 35 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('clears the line when the cursor leaves the list and on drag end', () => {
    const { container, getByTestId } = render(<List list="a" items={['title', 'price', 'url']} onMove={() => {}} />);
    layout(container);
    const rows = [...container.querySelectorAll<HTMLElement>('[data-name]')];
    fireEvent.dragStart(rows[2]!);
    fireEvent.dragOver(rows[0]!, { clientY: 5 });
    expect(rows[0]!.dataset.before).toBe('true');
    fireEvent.dragLeave(getByTestId('a'), { relatedTarget: rows[1]! });
    expect(rows[0]!.dataset.before).toBe('true');
    fireEvent.dragLeave(getByTestId('a'), { relatedTarget: document.body });
    expect(rows[0]!.dataset.before).toBeUndefined();
    fireEvent.dragEnd(rows[2]!);
    expect(rows[2]!.dataset.dragging).toBeUndefined();
  });
});
