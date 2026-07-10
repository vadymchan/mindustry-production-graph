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
