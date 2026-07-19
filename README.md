# Production Graph (Mindustry mod)

A Factorio-style production graph for [Mindustry](https://mindustrygame.github.io/): per-item,
per-fluid and per-network-power throughput over time, with selectable time windows and a
filterable list. Three tabs modelled on Factorio's production statistics.

Pure-JS, client-side mod. It only adds a UI overlay - no gameplay, blocks, or save changes.

## Status

- **Items tab** - produced (green) / consumed (red) rates, with two toggleable series:
  - **Global** - machine-level output of every crafter and drill, including intermediates that
    are produced and consumed between factories and never reach the core. *[M6]*
  - **Net core** - net change of the core's stock (the original MVP behaviour).
- **Electricity tab** - team-wide power-network readout (production/consumption graph, stored
  energy, capacity, satisfaction, charge bar). *[M5]*
- **Fluids tab** - produced/consumed liquid rates from crafters and pumps (computed rate, not
  measured flow). *[M7]*

The Items core-diff series, time windows, sortable list, multi-select filter and hover tooltip
are tested in-game on v159.2 (shipped as v0.1 on `main`). The M5/M6/M7 features (Electricity,
Global items, Fluids) are implemented on the `m5` branch and pass syntax validation, but are
**not yet tested in-game** - pending an owner play-test.

### Electricity tab (M5)

Shows the team's power network the way Factorio's electric-network view does:

- Production and consumption graphs (per second), plus a live readout of production, consumption,
  balance, stored energy, battery capacity and satisfaction %, and a battery charge bar.

**How it matches the vanilla power bar:** each game-second the mod walks the team's buildings,
keeps those whose block uses power, dedupes their power networks by id, and sums the same public
getters the vanilla power UI reads - `getLastScaledPowerIn()/Out() * 60` (per-second),
`getLastPowerStored()`, `getTotalBatteryCapacity()`, `getSatisfaction()`. Acceptance check:
production / consumption / stored should match the vanilla power bar for the same network.

## Time windows & UI

- Time windows **5s / 1m / 10m / 1h / 10h** - Factorio's 300-samples-per-window model with a
  1-second granularity floor; longer windows downsample by summing.
- Sortable list (name / produced / consumed) with average rates over the selected window.
- Filtering: click rows or use the **Items...** checkbox dialog to multi-select; the graph shows
  the sum over selected items. **Reset** clears the filter.
- Hover the graph for exact values at any sample; drag handles resize the list and its columns.

## Install

Requires Mindustry **v159+** (desktop).

- **In-game:** Mods -> Import Mod -> Import From GitHub -> `vadymchan/mindustry-production-graph`
- **Manual:** drop this folder into `%APPDATA%\Mindustry\mods\` and restart the game.

Press **F8** inside a loaded map to toggle the panel.

## How it works

Mindustry has no built-in production-statistics API and fires no production events, so everything
is polled. The Items **Net core** series diffs the core's item totals once per second. The
**Global** items, **Fluids** and **Electricity** series poll the producing buildings directly:

- **Items (global)** - each frame, visit every crafter (`GenericCrafter`) and drill via the
  per-type building index (`TeamData.getBuildings`). A craft is detected by a `progress` wrap
  (`craft()` does `progress %= 1f`), adding its outputs as produced and `ConsumeItems` inputs as
  consumed; drills integrate `lastDrillSpeed`. Sees production that never reaches the core.
- **Fluids** - integrate liquid rates: crafter `outputLiquids * getProgressIncrease(1)`,
  `ConsumeLiquid * edelta()`, pumps `amount * pumpAmount * edelta()`. Computed rate of working
  machines, not measured flow (output into a full buffer still reads as the nominal rate).
- **Electricity** - sum the team's power-network getters once per second (see above).

Every block-family poll and every Java interop call is wrapped in try/catch, so one bad call
cannot kill the update loop - a broken readout just shows zeros while the rest keeps working.

## Validation

No build step (pure-JS Rhino mod). `scripts/main.js` is syntax-checked with
`node --check scripts/main.js`. Behavioural testing is in-game (full game restart per change -
Mindustry has no JS hot-reload). Every Mindustry API used was checked against source tag `v159.2`.

## Roadmap

- [x] **M0-M4** - core-diff Items graph, time windows, filter, polish (v0.1, tested in-game).
- [x] **M5** - Electricity tab (implemented, **not yet tested in-game**).
- [x] **M6** - Global items series + Global/Net core toggle (implemented, **not yet tested in-game**).
- [x] **M7** - Fluids tab (implemented, **not yet tested in-game**).
- [ ] **M8** - perf (Android stride-scan), more block families (separators, item-filter/dynamic
      generators, turrets, unit factories), multiplayer edge cases.

## License

[MIT](./LICENSE)
