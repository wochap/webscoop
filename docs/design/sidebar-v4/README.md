# Sidebar v4 design reference

Claude Design frames for the recorder sidebar with flows, the sequence, iframes, popup windows, and forms. The `.dc.html` files open in Chromium; frame labels are the `label` attributes in the files. The main file is `Webscoop Sidebar v4 - Flows.dc.html`; it links to the v3 and v2 files, which are kept here unchanged so the links work. Frames are drawn 376px wide, except section `I`, drawn 400px wide; the panel is 400px wide.

The design is implemented by four OpenSpec changes: `frame-support` (elements inside iframes, frame targets), `flows` (flows replacing steps, the sequence replacing pagination, popup windows and panel ownership, await-user, the run-time banner), `forms` (fill on every input kind, variables with secret and path, pick to prefill, recipes without tables), and `step-target-editor` (typed selectors and full selection details when editing step, trigger, and paginate targets).

## Frame index

### `Webscoop Sidebar v4 - Flows.dc.html`

| Frame | Change | Status |
|---|---|---|
| `Turn 3 flows sequence` (canvas) | — | container of the frames below; intro and badge colors |
| `A Full panel` | `flows` | done |
| `B1 Flows collapsed` | `flows` | done |
| `B2 Switcher` | `flows` | done |
| `B3 Step rows` | `flows` (kinds, window badge), `frame-support` (frame badge) | done |
| `B4 Await user` | `flows` | done |
| `B5 Trigger editor` | `flows` | done |
| `B6 Flow menu` | `flows` | done |
| `B7 Step edit` | `flows` (window, optional), `frame-support` (frame) | done |
| `C1 Default` | `flows` | done |
| `C2 Typical` | `flows` | done |
| `C3 Drag` | `flows` | done |
| `C4 Errors` | `flows` | done |
| `D1 Pick to fill` | `forms` | done |
| `D2 Password secret` | `forms` | done |
| `D3 File path` | `forms` | done |
| `D4 Variables` | `forms` | done |
| `E Iframe` | `frame-support` | done |
| `E2 Frame target` | `frame-support` | done |
| `G Automation only` | `forms` | done |
| `F1 Multi window` | `flows` | done |
| `F2 Popup expanded` | `flows` | done |
| `F3 Popup inactive` | `flows` | done |
| `H1 Banner full` | `flows` | done |
| `H2 Banner popup` | `flows` | done |
| `I Step target editor` (section) | — | container of the frames below; drawn 400px wide |
| `I1 Step edit` | `step-target-editor` | done |
| `I2 Typed states` | `step-target-editor` | done |
| `I3 Repick in progress` | `step-target-editor` | done |
| `I4 Selection details for step` | `step-target-editor` | done |
| `I5 Layout a` | — | rejected alternative (inline in the flow card); layout (b) in `I4` is built |
| `I6 Trigger editor` | `step-target-editor` | done |
| `I7a Iframe repick` | `step-target-editor` | done |
| `I7b Popup picking` | `step-target-editor` | done |
| `I7b Popup details` | `step-target-editor` | done |

### Earlier rounds

`Webscoop Sidebar v2.dc.html` and `Webscoop Sidebar v3 - List flow.dc.html` are the same files as in `docs/design/sidebar-v3`, which indexes them.

### Components

| File | Used for |
|---|---|
| `SelectorChip.dc.html` | `ui/selector-chip.tsx` |
| `SelectorInput.dc.html` | `ui/selector-input.tsx`; also the frame target editor in `E2` |
| `WebscoopScreen.dc.html` | frame wrapper used by the sidebar files |

## Deviations

Agreed differences between the frames and the panel.

| Design | Panel | Reason |
|---|---|---|
| `C2` paginate stop rules "no new rows / target disabled or missing" | The recipe's stop rules: `no-new-items`, `first-item-repeats`, `target-missing` | Stop rules are defined by the pagination spec |
| `D3` "Browse…" button on a path variable | Text input with a host-side "file exists" check | The page only sees `C:\fakepath\…`; a real path needs a host-side dialog |
| `E2` "Changing it re-targets every step and field that shares this frame" | The recipe stores one frame per table and per step or pagination target; the panel applies an edit to every identical frame target | No shared frame entity in the recipe |
| `B2` list shows only the called group | The switcher lists every flow, grouped called and reactive | Reactive flows can be recorded into too |
| Footer counts differ between `A` and `C4` | One format: tables · fields · flows · steps | One footer |
| `D4` "from config: command" | "from config" or "from CLI" | The panel only knows where the value is bound |
| `D1` "After adding" step preview and "make variable → name it" rows | "make variable" turns into a name input next to the value; the new step shows in the flow list | The flow list already shows the added step |
| `D4` "shown as" as a label | A select (text, secret, path) on variables bound in the recipe; "external" as a label | Marking a variable secret and changing its type happen in the same column |
| `A` note "'every page' is gone from steps" | Not shown | The panel describes what is, not what changed |
| Phosphor glyphs from unpkg | Inline SVG subset, as in v3 | The panel runs inside third-party pages and loads nothing remote |
| 376px frame width | 400px panel | The recorder spec fixes the panel width |
| `B4`, `H2` the await-user element is looked for in the step's window | The condition is checked in every window of the run; the banner shows in the step's window | A login popup closes itself once the user is done, while the element to watch is in the main window |
| `B6` shortcut hints (`Shift R`, `F2`) in the flow menu | No hints | No such shortcuts exist in the panel |
| `C2` "+ block" under the sequence | No add button | Blocks come from flows and tables; the default sequence adds them, and a custom one appends new tables and flows |
| `C4` "Remove 4.2" and "Remove" on each error | Errors listed on their blocks and under the sequence | Moving a block or Reset to default fixes them |
| `F1` rail with a "Panel" label | 30px rail with "Panel active in another window" written vertically | Same meaning in the rail's width |
| `G` "Add a table" creates a table | "Add a table" shows the tab bar and the first table, which picks fill | A recipe with flows keeps its one empty table unsaved until it has fields |
| `I3` back link to the step | "← back" opens the step's edit form again (the trigger's flow, or the paginate settings) | The Pick section keeps the pick while the user looks at the target |
| `I4` "Use for step" carries the candidates | The host keeps the pick; Use sends only which target and whether the typed or the picked selector is saved | The host already holds the counted, verified candidates |
| `I6` new trigger | A flow without a trigger keeps "Pick"; the target editor shows once the flow is reactive | The editor edits an existing target |
