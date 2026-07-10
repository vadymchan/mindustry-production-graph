# Production Graph (Mindustry mod)

A Factorio-style production graph for [Mindustry](https://mindustrygame.github.io/): per-item
produced/consumed throughput over time, with selectable time windows and a filterable item list.

Pure-JS, client-side mod. It only adds a UI overlay - no gameplay, blocks, or save changes.

## Status

**Working MVP** (v0.1), tested in-game on v159.2.

Features:

- Produced (green) / consumed (red) rates on a live graph, sampled once per game-second.
- Time windows **5s / 1m / 10m / 1h / 10h** - Factorio's 300-samples-per-window model with a
  1-second granularity floor; longer windows downsample by summing.
- Sortable item list (name / produced / consumed) with average rates over the selected window.
- Filtering: click rows or use the **Items...** checkbox dialog to multi-select; the graph shows
  the sum over selected items. **Reset** clears the filter.
- Hover the graph for exact values at any sample; drag handles resize the list and its columns.

## Install

Requires Mindustry **v159+** (desktop).

- **In-game:** Mods -> Import Mod -> Import From GitHub -> `vadymchan/mindustry-production-graph`
- **Manual:** drop this folder into `%APPDATA%\Mindustry\mods\` and restart the game.

Press **F8** inside a loaded map to toggle the panel.

## How it works

Mindustry has no built-in production-statistics API, so the mod samples the core's item totals
(`core().items`) once per second and diffs successive snapshots to derive produced/consumed rates.
This measures net flow through the core, not global factory-to-factory production.

## License

[MIT](./LICENSE)
