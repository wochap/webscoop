# Sidebar v4 design reference

Claude Design frames for the recorder sidebar with flows, the sequence, iframes, popup windows, and forms. The `.dc.html` files open in Chromium; frame labels are the `label` attributes in the files. The main file is `Webscoop Sidebar v4 - Flows.dc.html`; it links to the v3 and v2 files, which are kept here unchanged so the links work. Frames are drawn 376px wide; the panel is 400px wide.

The design is implemented by three OpenSpec changes: `frame-support` (elements inside iframes, frame targets), `flows` (flows replacing steps, the sequence replacing pagination, popup windows and panel ownership, await-user, the run-time banner), and `forms` (fill on every input kind, variables with secret and path, pick to prefill, recipes without tables).

## Frame index

### `Webscoop Sidebar v4 - Flows.dc.html`

| Frame | Change | Status |
|---|---|---|
| `Turn 3 flows sequence` (canvas) | — | container of the frames below; intro and badge colors |
| `A Full panel` | `flows` | todo |
| `B1 Flows collapsed` | `flows` | todo |
| `B2 Switcher` | `flows` | todo |
| `B3 Step rows` | `flows` (kinds, window badge), `frame-support` (frame badge) | todo |
| `B4 Await user` | `flows` | todo |
| `B5 Trigger editor` | `flows` | todo |
| `B6 Flow menu` | `flows` | todo |
| `B7 Step edit` | `flows` (window, optional), `frame-support` (frame) | todo |
| `C1 Default` | `flows` | todo |
| `C2 Typical` | `flows` | todo |
| `C3 Drag` | `flows` | todo |
| `C4 Errors` | `flows` | todo |
| `D1 Pick to fill` | `forms` | todo |
| `D2 Password secret` | `forms` | todo |
| `D3 File path` | `forms` | todo |
| `D4 Variables` | `forms` | todo |
| `E Iframe` | `frame-support` | todo |
| `E2 Frame target` | `frame-support` | todo |
| `G Automation only` | `forms` | todo |
| `F1 Multi window` | `flows` | todo |
| `F2 Popup expanded` | `flows` | todo |
| `F3 Popup inactive` | `flows` | todo |
| `H1 Banner full` | `flows` | todo |
| `H2 Banner popup` | `flows` | todo |

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
| `E2` "Changing it re-targets every step and field that shares this frame" | The recipe stores the frame on each step and field; the panel applies an edit to every identical frame target | No shared frame entity in the recipe |
| `B2` list shows only the called group | The switcher lists every flow, grouped called and reactive | Reactive flows can be recorded into too |
| Footer counts differ between `A` and `C4` | One format: tables · fields · flows · steps | One footer |
| `D4` "from config: command" | "from config" or "from CLI" | The panel only knows where the value is bound |
| `A` note "'every page' is gone from steps" | Not shown | The panel describes what is, not what changed |
| Phosphor glyphs from unpkg | Inline SVG subset, as in v3 | The panel runs inside third-party pages and loads nothing remote |
| 376px frame width | 400px panel | The recorder spec fixes the panel width |
