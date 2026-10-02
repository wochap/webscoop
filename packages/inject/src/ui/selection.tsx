import { useState } from "react";
import {
  currentTable,
  scopeForTable,
  tableMode,
  type Crumb,
  type FieldOptions,
  type RecorderState,
  type SelectedView,
} from "@webscoop/core/page";
import {
  CoverageHint,
  EditActions,
  PickActionGrid,
  SelectorCandidateList,
} from "./candidates";
import { useActions } from "./context";
import { FieldOptionsForm, formPatch, nameProblem } from "./fields";
import { FillPick } from "./fill-pick";
import { NumberedSamples } from "./items";
import { Icon } from "./icons";
import { FrameCard } from "./frame";
import { ElementInspector } from "./picking";
import { SelectorInput } from "./selector-input";
import { SelectorStack, stackLevels } from "./selector-stack";
import { Kbd } from "./shell";
import { newTableName, tableNameProblem } from "./tables";
import { TargetPickPanel, targetBack } from "./target-editor";

type Suggestion = NonNullable<SelectedView["suggestion"]>;

/** The step "Add to flow" makes from a picked element: a fill with its current value for form fields, a click for anything else. */
export function recordAsStep(
  tag: string,
  attrs: Record<string, string>,
): { kind: "click" } | { kind: "fill"; value: string } {
  const type = (attrs.type ?? "").toLowerCase();
  const filled =
    tag === "textarea" ||
    tag === "select" ||
    attrs.contenteditable === "true" ||
    (tag === "input" &&
      [
        "",
        "text",
        "search",
        "email",
        "url",
        "tel",
        "password",
        "number",
      ].includes(type));
  return filled ? { kind: "fill", value: attrs.value ?? "" } : { kind: "click" };
}

/**
 * The selection panel: the inspector, the candidates, the typed selector,
 * the field options form, and the actions, for a new selection or a saved
 * field being edited. With nothing selected it offers only the typed
 * selector, when the active table is a list. The list setup replaces it
 * while open.
 */
export function SelectionPanel({
  host,
  trail,
}: {
  host: RecorderState;
  trail: Crumb[];
}) {
  const actions = useActions();
  const { selected, editing, draft, proposal } = host;
  // A target edit's pick shows its own details: page scope, Use for the target.
  if (host.targetEdit && host.targetEdit.phase !== "typing") {
    const edit = host.targetEdit;
    return <TargetPickPanel edit={edit} trail={trail} onBack={() => targetBack(edit, host, actions)} />;
  }
  if (proposal) return null;
  if (!selected && !editing) {
    return (
      <>
        <PickNotice host={host} />
        {currentTable(draft).item && <TypedSelector host={host} scope="item" />}
      </>
    );
  }
  const seed: FieldOptions = editing
    ? editing.options
    : {
        name: selected!.defaults.name,
        type: selected!.defaults.type,
        scope: selected!.scope,
        attr: selected!.defaults.attr ?? "",
        optional: false,
        key: false,
        hover: false,
      };
  // The form starts over for each new selection, and stays through re-picks while editing.
  const key = editing
    ? `edit-${editing.index}`
    : `select-${selected!.selection.path.join(".")}-${selected!.scope}-${selected!.defaults.name}`;
  return <SelectionBody key={key} host={host} trail={trail} seed={seed} />;
}

/** Typed selector text for the selection, through the selector input. */
export function TypedSelector({
  host,
  scope,
}: {
  host: RecorderState;
  scope: "item" | "page";
}) {
  const actions = useActions();
  return (
    <SelectorInput
      label="Selection selector"
      testId="pick-selector"
      errorTestId="pick-selector-error"
      scope={scope}
      error={host.selectorError}
      placeholder={
        scope === "item"
          ? "selector inside each item, e.g. h3"
          : "selector on the page, e.g. h1"
      }
      submitLabel="Select"
      onSubmit={(selector) =>
        void actions.send({ kind: "selection.setSelector", selector, scope })
      }
    />
  );
}

/** The one-shot message after a list is accepted without a pick inside an item. */
export function PickNotice({ host }: { host: RecorderState }) {
  if (!host.notice) return null;
  return (
    <div className="ws-notice" role="status" data-ws="pick-list-ready">
      <Icon name="check" size={12} />
      <span>{host.notice}</span>
    </div>
  );
}

/** "Repeats N× on this page — make this table a list?", with three samples and the two answers (04a). */
export function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const actions = useActions();
  return (
    <section
      className="ws-card ws-suggest ws-col"
      data-ws="pick-cta"
      data-count={suggestion.count}
    >
      <div className="ws-row" style={{ alignItems: "flex-start" }}>
        <Icon name="rows" size={14} />
        <div className="ws-col" style={{ gap: 2 }}>
          <span className="ws-title">
            Repeats {suggestion.count}× on this page
          </span>
          <span className="ws-meta">
            Make this table a list? One row per item.
          </span>
        </div>
      </div>
      <NumberedSamples
        samples={suggestion.samples}
        more={suggestion.more}
        plain
      />
      <div className="ws-row">
        <button
          type="button"
          className="ws-btn ws-btn-outline"
          onClick={() =>
            void actions.send({ kind: "list.open", from: "suggestion" })
          }
          data-ws="pick-cta-setup"
        >
          <Icon name="rows" size={12} />
          Set up list <Kbd>L</Kbd>
        </button>
        <button
          type="button"
          className="ws-btn ws-btn-ghost"
          onClick={() => void actions.send({ kind: "list.dismiss" })}
          data-ws="pick-cta-single"
        >
          No, single value
        </button>
      </div>
    </section>
  );
}

/** A quiet link to set a list up by hand, when the pick does not repeat. */
export function ManualLink() {
  const actions = useActions();
  return (
    <button
      type="button"
      className="ws-link"
      onClick={() => void actions.send({ kind: "list.open", from: "manual" })}
      data-ws="pick-cta-manual"
    >
      <Icon name="rows" size={12} />
      Set up list manually…
    </button>
  );
}

/** In a page table, one quiet line for a repeating pick (04e). */
export function RepeatLine({ count }: { count: number }) {
  const actions = useActions();
  return (
    <div className="ws-row ws-meta" data-ws="pick-repeat">
      <Icon name="rows" size={12} />
      <span>Repeats {count}× —</span>
      <button
        type="button"
        className="ws-link"
        onClick={() =>
          void actions.send({ kind: "list.open", from: "newTable" })
        }
        data-ws="pick-repeat-start"
      >
        start a list table
        <Icon name="arrow-right" size={11} />
      </button>
    </div>
  );
}

/** A pick outside every container of the active list (04c, 04c2): add it to a page table, start a list table, or re-pick. */
export function OutsideBanner({
  host,
  outside,
}: {
  host: RecorderState;
  outside: NonNullable<SelectedView["outside"]>;
}) {
  const actions = useActions();
  const { tables } = host.draft;
  const list = tables[outside.table]?.name ?? currentTable(host.draft).name;
  const page = outside.pageTable === null ? null : tables[outside.pageTable];
  const [name, setName] = useState(() => newTableName(tables));
  const problem = page ? null : tableNameProblem(name, tables);
  return (
    <section
      className="ws-banner ws-banner-warn ws-col"
      role="status"
      data-ws="pick-outside-banner"
      data-repeats={outside.repeats ?? undefined}
    >
      <div className="ws-row">
        <span className="ws-banner-icon">
          <Icon name="warning" weight="bold" size={13} />
        </span>
        <span className="ws-title">Outside the {list} list</span>
        {outside.repeats !== null && (
          <span className="ws-badge ws-tone-warn" data-ws="pick-outside-repeats">
            repeats {outside.repeats}×
          </span>
        )}
      </div>
      <span className="ws-meta ws-banner-text">
        {outside.repeats !== null ? (
          <>
            This repeats on its own, outside <b>{list}</b> — probably a separate
            list.
          </>
        ) : (
          <>
            <b>{list}</b> reads inside each item. This element isn’t in one —
            keep it in a page table.
          </>
        )}
      </span>
      <div className="ws-row">
        {outside.repeats !== null && (
          <button
            type="button"
            className="ws-btn ws-btn-outline"
            onClick={() =>
              void actions.send({ kind: "list.open", from: "newTable" })
            }
            data-ws="pick-outside-new-list"
          >
            <Icon name="rows" size={12} />
            New list table
          </button>
        )}
        {page ? (
          <button
            type="button"
            className="ws-btn"
            onClick={() =>
              void actions.send({
                kind: "draft.selectTable",
                index: outside.pageTable!,
              })
            }
            data-ws="pick-outside-add-to"
            data-table={page.name}
          >
            <Icon name="rectangle" size={12} />
            Add to {page.name}
          </button>
        ) : (
          <>
            {outside.repeats === null && (
              <input
                className={`ws-input ws-mono-sm ws-spacer${problem ? " ws-invalid" : ""}`}
                value={name}
                aria-label="New page table name"
                aria-invalid={problem ? true : undefined}
                title={problem ?? undefined}
                onChange={(e) => setName(e.target.value)}
                data-ws="pick-outside-table-name"
              />
            )}
            <button
              type="button"
              className={`ws-btn${outside.repeats === null ? " ws-btn-outline" : ""}`}
              disabled={problem !== null}
              onClick={() =>
                void actions.send({ kind: "draft.addTable", name: name.trim() })
              }
              data-ws="pick-outside-new-page"
            >
              <Icon name="rectangle" size={12} />
              New page table
            </button>
          </>
        )}
      </div>
      <div className="ws-row">
        <button
          type="button"
          className="ws-btn"
          onClick={actions.startPicking}
          data-ws="pick-outside-repick"
        >
          Re-pick <Kbd>P</Kbd>
        </button>
      </div>
    </section>
  );
}

/** A pick inside a container of another list table (04d): switch to it with the pick, or re-pick. */
export function BelongsBanner({
  host,
  belongs,
}: {
  host: RecorderState;
  belongs: NonNullable<SelectedView["belongs"]>;
}) {
  const actions = useActions();
  const other = host.draft.tables[belongs.table];
  if (!other) return null;
  return (
    <section
      className="ws-banner ws-banner-accent ws-col"
      role="status"
      data-ws="pick-belongs-banner"
      data-table={other.name}
    >
      <div className="ws-row">
        <span className="ws-banner-icon">
          <Icon name="rows" size={13} />
        </span>
        <span className="ws-title">Belongs to the {other.name} list</span>
      </div>
      <span className="ws-meta ws-banner-text" data-ws="pick-belongs-item">
        This is inside item {belongs.index + 1} of {belongs.of} in{" "}
        <b>{other.name}</b>
      </span>
      <div className="ws-inset">
        <SelectorStack
          levels={stackLevels(belongs.stack.within, belongs.stack.item, {
            within: other.item?.withinCount ?? null,
            item: belongs.of,
          })}
          testId="pick-belongs-stack"
        />
      </div>
      <div className="ws-row">
        <button
          type="button"
          className="ws-btn ws-btn-outline"
          onClick={() =>
            void actions.send({
              kind: "draft.selectTable",
              index: belongs.table,
            })
          }
          data-ws="pick-belongs-switch"
        >
          <Icon name="arrow-right" size={12} />
          Switch to {other.name}
        </button>
        <button
          type="button"
          className="ws-btn ws-btn-ghost"
          onClick={actions.startPicking}
          data-ws="pick-belongs-repick"
        >
          Re-pick <Kbd>P</Kbd>
        </button>
        <span className="ws-spacer" />
        <span className="ws-meta">pick carries over</span>
      </div>
    </section>
  );
}

function SelectionBody({
  host,
  trail,
  seed,
}: {
  host: RecorderState;
  trail: Crumb[];
  seed: FieldOptions;
}) {
  const actions = useActions();
  const [form, setForm] = useState(seed);
  const { selected, editing, draft } = host;
  const candidates = selected
    ? selected.selection.candidates
    : editing!.candidates;
  const primaryIndex = selected ? selected.primary : editing!.primary;
  const primary = candidates[primaryIndex];
  const scope = selected?.scope ?? editing!.options.scope;
  // The selection is computed for the active table: the tabs choose it.
  const target =
    selected && selected.table !== null
      ? (draft.tables[selected.table] ?? currentTable(draft))
      : currentTable(draft);
  const item = target.item;
  const mode = tableMode(target);
  const containers = scope === "item" ? (item?.count ?? null) : null;
  const taken = target.fields
    .filter((_, i) => i !== editing?.index)
    .map((f) => f.name);
  const nameError = nameProblem(form.name, taken);
  const clear = () => void actions.send({ kind: "selection.clear" });
  // Banners and the suggestion speak about a new pick, not a field edit or a re-pick.
  const fresh = selected !== null && !editing && host.repick === null;
  const outside = fresh ? selected.outside : null;
  const belongs = fresh ? selected.belongs : null;
  const suggestion = fresh ? selected.suggestion : null;
  const blocked = outside !== null || belongs !== null;
  const frameRefusal = fresh ? selected.frameRefusal : null;
  const hint = frameRefusal
    ? `${frameRefusal[0]!.toUpperCase()}${frameRefusal.slice(1)}.`
    : blocked
    ? `Pick inside an item of ${target.name} to add here.`
    : mode === "list"
      ? `Reads inside each of ${item?.count ?? "…"} items.`
      : mode === "page"
        ? "Reads the first match on the page."
        : `Adds one value — ${target.name} becomes a page table (1 row).`;
  return (
    <>
      {selected ? (
        <ElementInspector
          selection={selected.selection}
          trail={trail}
          onSelectPath={actions.selectPath}
          onClear={clear}
          chain={
            selected.scope === "item" && item
              ? stackLevels(
                  item.within?.[0],
                  item.selectors[0],
                  { within: item.withinCount ?? null, item: item.count },
                  {
                    candidate: primary,
                    count:
                      primary?.items !== undefined && containers !== null
                        ? `${primary.items}/${containers}`
                        : null,
                  },
                ).map((l) =>
                  l.level === "list" && item.withinInferred
                    ? { ...l, badge: { text: "inferred", testId: "rows-parent-inferred" } }
                    : l,
                )
              : []
          }
        />
      ) : (
        <div className="ws-warning" role="alert" data-ws="pick-edit-zero">
          <span className="ws-spacer">
            This field matches nothing on this page. Pick its element or type a
            selector.
          </span>
        </div>
      )}
      {selected?.selection.frame && <FrameCard frame={selected.selection.frame} />}
      {outside && (
        <OutsideBanner
          key={`${selected!.selection.path.join(".")}`}
          host={host}
          outside={outside}
        />
      )}
      {belongs && <BelongsBanner host={host} belongs={belongs} />}
      {!blocked && (
        <>
          <SelectorCandidateList
            candidates={candidates}
            primary={primaryIndex}
            containers={containers}
            onPrimary={(index) =>
              void actions.send({ kind: "inspect.primary", index })
            }
            level={scope === "item" ? "field" : "page"}
          />
          {primary?.items !== undefined &&
            containers !== null &&
            (primary.count ?? 0) > 0 && (
              <CoverageHint
                items={primary.items}
                containers={containers}
                optional={form.optional}
                onOptional={() => setForm({ ...form, optional: true })}
              />
            )}
          <TypedSelector
            host={host}
            scope={editing ? scope : scopeForTable(target)}
          />
          <FieldOptionsForm
            value={form}
            onChange={setForm}
            nameError={nameError}
          />
        </>
      )}
      {suggestion && mode === "none" && (
        <SuggestionCard suggestion={suggestion} />
      )}
      {suggestion && mode === "page" && <RepeatLine count={suggestion.count} />}
      {fresh && !suggestion && mode === "none" && <ManualLink />}
      {editing ? (
        <EditActions
          canUpdate={nameError === null}
          onUpdate={() =>
            void actions.send({
              kind: "draft.updateEditedField",
              patch: formPatch(form),
            })
          }
          onCancel={() => void actions.send({ kind: "draft.cancelEdit" })}
        />
      ) : (
        <>
        {selected!.selection.fill && !host.repick && (
          <FillPick
            fill={selected!.selection.fill}
            flowName={host.draft.activeFlow !== null ? (host.draft.flows[host.draft.activeFlow]?.name ?? null) : null}
          />
        )}
        <PickActionGrid
          repicking={host.repick !== null}
          canAdd={nameError === null && !blocked && !frameRefusal && !host.popup}
          hint={host.popup ? "Fields extract from the main window" : hint}
          onAddField={() =>
            void actions.send({
              kind: "draft.addField",
              patch: formPatch(form),
            })
          }
          onRecordStep={() =>
            void actions.send({
              kind: "draft.addStep",
              step: recordAsStep(
                selected!.selection.tag,
                selected!.selection.attrs,
              ),
            })
          }
          onAwaitUser={() =>
            void actions.send({
              kind: "draft.addStep",
              step: { kind: "await-user", until: "disappears" },
            })
          }
          flowName={host.draft.activeFlow !== null ? (host.draft.flows[host.draft.activeFlow]?.name ?? null) : null}
          onPagination={() =>
            void actions.send({ kind: "draft.markPagination" })
          }
          onDismiss={actions.startPicking}
        />
        </>
      )}
    </>
  );
}
