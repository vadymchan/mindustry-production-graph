# Review guide

Per-milestone test instructions for the owner. **Everything below is UNTESTED in-game** - code was
written and self-reviewed against the pinned Mindustry v159.2 sources (Arc `12840e4a21`), but never
executed. Each milestone lives on its own branch, stacked on the previous one; `main` stays at the
M0 skeleton.

## How to test any branch

1. `git -C "C:/Users/vadym/source/repos/mindustry-production-graph" checkout <branch>`
2. Fully restart Mindustry (no hot-reload). The junction at
   `...\steamapps\common\Mindustry\saves\mods\production-graph` makes the checked-out working tree
   the live mod.
3. Load a sandbox map. Press **F8** to toggle the panel.
4. On any red error dialog or weirdness: check `...\steamapps\common\Mindustry\saves\last_log.txt`
   for `Exception` / `at org.mozilla`.

## Branches

| Branch | Tag | One-line test |
| --- | --- | --- |
| `m1-sampling` | `v0.1-m1` | F8 panel lists per-item produced/consumed/core numbers that track core stock changes |
| `m2-graph` | `v0.1-m2` | Panel shows a 1-minute graph; a production spike appears as a green bump moving left |
| `m3-list-filter` | `v0.1-m3` | Clicking an item in the left list filters the graph to it; Reset shows all |
| `m4-windows` | `v0.1-m4` | Window buttons 5s-10h rescale the graph; list shows avg/s; hovering the graph shows a tooltip (MVP) |

---

## M1 - per-second sampling (`m1-sampling`, tag `v0.1-m1`)

**What it does:** once per game-second (60 ticks of `Time.delta`, so paused game = paused sampling)
diffs `core().items` across all `Vars.content.items()`. Positive delta accumulates into "produced",
negative into "consumed". The F8 panel shows a live table: item / produced / consumed / current core
count.

**Test steps:**

1. Load a sandbox map with a core. Press F8 - panel opens with all items at 0 (core count column
   shows the actual inventory).
2. Feed the core (e.g. item source → core, or mine into it): the item's **Produced** number should
   grow by roughly the throughput per second, and **Core** should match the real core inventory.
3. Take items out (e.g. unloader → vault/incinerator): **Consumed** grows.
4. Acceptance criterion from the plan: numbers match the core inventory arithmetic when you
   build/break factories.
5. Destroy the core / switch to a coreless state, then restore: no giant fake spike (sampling
   re-baselines after a core gap), no red dialog, clean `last_log.txt`.

**Semantics caveat (intentional):** this measures NET core-stock change, not global factory
production. Items produced and consumed between factories (belts, buffers) never reach the core and
are invisible. Produced and consumed within the same second for the same item show only the net.

**Assumptions I could not verify in-game:**

- `Trigger.update` fires in the main menu too; `currentCore()` guards with `Vars.state.isGame()`, so
  menu ticks are no-ops. If F8 is pressed in the menu the empty panel still opens (harmless).
- `Time.delta` accumulation as "1 game-second" - at 2x game speed sampling runs 2x per real second;
  that is intended (production is also 2x).
- Multi-core teams: `team().core()` returns one core, but `core().items` is the team-shared
  `ItemModule` on v159.2 storage mechanics, so numbers should cover all linked cores. Not verified.

---

## M2 - 1-minute history + graph (`m2-graph`, tag `v0.1-m2`)

**What it does:** every sample also records the per-second totals (all items summed) into a
60-slot ring buffer. The panel gains a graph above the M1 table: green line = produced/s, red =
consumed/s, newest second at the right edge, vertical scale = max sample in the window (shown under
the graph as "scale max: N/s").

**Test steps:**

1. Checkout `m2-graph`, restart the game, load a sandbox map, press F8.
2. With no factories both lines should be flat at the bottom.
3. Set up steady item flow into the core (item source → core): a green plateau should appear and
   crawl left; after ~60s it fills the window.
4. Spike test (acceptance criterion): dump a burst of items into the core (e.g. briefly connect
   several sources) - a green spike should appear at the right and travel left over the next minute.
5. Pull items out of the core - red line rises the same way.
6. No red dialog on load, clean `last_log.txt`, no visible FPS drop with the panel open.

**Assumptions I could not verify in-game (biggest Rhino risks of this branch):**

- `extend(Element, {draw: ...})` - subclassing `arc.scene.Element` via Rhino's JavaAdapter and
  overriding `draw()`. This is the standard JS-mod pattern and `extend` + `Element` are both
  provided by v159.2 `global.js`, but it is the first JavaAdapter use in this mod. If the mod fails
  to load, this is the first suspect (`last_log.txt` would show a JavaAdapter/ClassNotFound trace).
- Inside `draw()` I use `this.getX()/getY()/getWidth()/getHeight()` (stage coordinates; Arc groups
  offset children before drawing). If the graph draws in a wrong corner of the screen, this
  assumption failed.
- `Lines.beginLine()/linePoint()/endLine()`, `Fill.crect`, `Draw.color(r,g,b,a)` - signatures
  verified against Arc `12840e4a21` (the exact commit v159.2 builds against), not executed.
- Color markup `[#6bd68a]text[]` in labels - standard Mindustry font markup, assumed enabled in
  dialog labels.

---

## M3 - item list + click-filter (`m3-list-filter`, tag `v0.1-m3`)

**What it does:** history becomes per-item (a 60-slot ring buffer per item plus the aggregate).
Factorio-style layout: left column = sortable item list (icon, name, produced and consumed totals
over the 1m window), right = the graph. Clicking an item filters the graph to that item (row is
highlighted, header shows "filter: <item>"); clicking it again or pressing **Reset** returns to
all items. Sort buttons above the list: **Item** (name), **Prod**, **Cons**; clicking the active
one flips the direction. The list re-sorts itself every second as new samples arrive. The M1
cumulative table is gone - the list shows window totals instead, like Factorio.

**Test steps:**

1. Checkout `m3-list-filter`, restart, load sandbox, F8.
2. List shows all items with icons; numbers are totals over the last 60s (0 with no factories).
3. Feed copper into the core, pull lead out: copper climbs the Prod sort, lead appears under Cons.
4. Acceptance criterion: click copper - graph shows only copper's lines (green bump, no lead
   red); header says "filter: Copper"; row highlights. Click again (or Reset) - back to all items.
5. Sort buttons: click Item / Prod / Cons and verify the order changes; clicking the same button
   twice reverses it.
6. No red dialog, clean `last_log.txt`.

**Assumptions I could not verify in-game:**

- Rows are `Table`s with `touchable = Touchable.enabled` (Table defaults to `childrenOnly`; the
  field is public in Arc `12840e4a21`) and a `clicked(Runnable)` listener. If clicking a row does
  nothing, this wiring is the suspect.
- The list rebuilds inside its own `update()` callback (`clearChildren()` + re-add, once per
  second, ~20 rows). Standard Mindustry-mod pattern, but if the game crashes while the panel is
  open with items flowing, suspect this rebuild-during-act.
- `item.uiIcon` is loaded by the time the dialog is first built (F8 in a running map - icons are
  atlas-loaded long before). `Styles.flatDown` used as the selected-row highlight.

---

## M4 - time windows + downsampling + tooltip (`m4-windows`, tag `v0.1-m4`) = MVP

**What it does:** replicates the Factorio window model with a 1-second floor (base sampling is
1/s, so 5s and 1m windows cannot have Factorio's sub-second granularity - documented deviation):

| Window | Bucket (granularity) | Samples kept |
| --- | --- | --- |
| 5s | 1s | 5 |
| 1m | 1s | 60 |
| 10m | 2s | 300 |
| 1h | 12s | 300 |
| 10h | 120s | 300 |

All five windows record simultaneously (aggregate + per item); longer windows downsample by summing
base samples into buckets. The header gains toggle buttons 5s/1m/10m/1h/10h. Item labels show the
**average rate** (units/s) over the selected window while the graph draws the **precise samples**
(Factorio: smoothed label, jittery curve). Hovering the graph draws a vertical marker and a floating
tooltip: time offset + exact produced/consumed rates at that sample.

**Test steps:**

1. Checkout `m4-windows`, restart, load sandbox, F8.
2. Set up a steady flow into the core. Check each window button: 5s is jumpy, 1m matches M3
   behavior, 10m/1h/10h are progressively smoother and mostly empty until history accrues.
3. List numbers now read like "12.5/s" and stay roughly constant for a steady flow regardless of
   window (that is the point of averaging); right after a spike, short windows react first.
4. Hover the graph: vertical marker follows the mouse; tooltip shows "-30s  12/s  0/s" style
   values; at the right edge it shows "now". Move off the graph - marker and tooltip disappear.
5. Filter + windows combined: click an item, switch windows - the graph stays filtered.
6. Acceptance criterion: UX matches the Factorio production screen (list with averages on the
   left, precise two-line graph with hover on the right, window selector, filter + reset).
7. No red dialog, clean `last_log.txt`; watch FPS with the panel open on the 10m+ windows (draw
   iterates up to 300 points per line per frame).

**Deviations from Factorio (intentional, documented):**

- Granularity floor is 1s (Factorio 5s window = ~1 tick/sample). Sub-second sampling would need
  per-frame core reads; out of MVP scope.
- Windows 50h/250h/1000h/all omitted (10h max). Trivial to add rows to `WINDOWS` later.
- Single-item filter (Factorio multi-selects); multiselect is M5 material.
- Tooltip shows both series at the hovered sample, not per-line hit detection.

**Assumptions I could not verify in-game:**

- `InputListener` subclassed via `extend` for mouseMoved/exit hover tracking - local coordinates
  assumed to be element-local pixels with origin at the element's bottom-left. If the marker is
  mirrored or offset, this is the suspect.
- `arc.scene.ui.Tooltip(Cons<Table>)` with a live label; `cons()` wrapper from global.js. If the
  game crashes on first hover, suspect the Tooltip wiring.
- `Button.setChecked(boolean)` inside an `update()` callback for the window selector toggle state
  (signature verified against Arc `12840e4a21`).
- Mobile has no mouseMoved: the tooltip/marker simply will not appear there; everything else works.
- 10h window keeps 300 buckets of 120s; before the first 120s elapse the ring is all zeros - the
  graph is honest about missing history rather than stretching it.
