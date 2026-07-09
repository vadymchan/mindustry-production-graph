# Production Graph (Mindustry mod)

A Factorio-style production graph for [Mindustry](https://mindustrygame.github.io/): per-item
produced/consumed throughput over time, with selectable time windows and a filterable item list.

Pure-JS, client-side mod. It only adds a UI overlay - no gameplay, blocks, or save changes.

## Status

Early development. Current milestone: **M0** - mod skeleton; an empty panel opens on **F8**.

Roadmap: **M1** per-second sampling of core inventory -> **M2** time-series graph ->
**M3** item list + click filter -> **M4** time windows + polish (= MVP) -> **M5** optional polish.

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
