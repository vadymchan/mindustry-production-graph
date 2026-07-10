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
