import { CHAIN_SEPARATOR, type ChainLevel } from '../chain';

/**
 * A composed selector chain as a path of chips, one per level, outermost
 * first. Chips wrap onto more lines instead of truncating. Display only: the
 * chips are not focusable and do not react to clicks.
 */
export function SelectorPath({ levels, testId = 'selector-path', className }: { levels: readonly ChainLevel[]; testId?: string; className?: string }) {
  if (levels.length === 0) return null;
  return (
    <div className={`ws-path${className ? ` ${className}` : ''}`} data-ws={testId} data-chain={levels.map((l) => l.value).join(CHAIN_SEPARATOR)}>
      {levels.map((level, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && (
            <span className="ws-crumb-sep" aria-hidden="true">
              ›
            </span>
          )}
          <span className="ws-path-chip" title={level.label} data-ws="path-chip">
            {level.value}
          </span>
        </span>
      ))}
    </div>
  );
}
