# Registry submission draft (DO NOT submit yet)

Draft for including **Production Graph** in the official Mindustry mod browser
([Anuken/MindustryMods](https://github.com/Anuken/MindustryMods)). This is a runbook + draft text
only - do not run the submission steps until `m5` is merged to `main` and play-tested in-game.

## How the registry actually works

Inclusion is **fully automated** - there is no PR and no application form
([MindustryMods README](https://github.com/Anuken/MindustryMods)):

1. A crawler scans GitHub for public repos carrying the topic **`mindustry-mod`**.
2. It reads `mod.hjson` / `mod.json` from the **default branch** (`main`).
3. It refreshes roughly every 2 hours.

So "submitting" = (a) make sure `main` has a compliant `mod.hjson`, then (b) add the `mindustry-mod`
topic to the repo. That's it.

## Requirements checklist (verified against `mod.hjson` on this branch)

| Requirement                                  | Status                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| Public GitHub repo                           | OK - `VadymChan/mindustry-production-graph`                            |
| Topic `mindustry-mod` on the repo            | **PENDING** - repo currently has no topics (`gh api .../topics` -> `[]`) |
| `mod.hjson` in root of default branch        | OK                                                                     |
| `name` in kebab-case                         | OK - `production-graph`                                                |
| `minGameVersion` >= 136 (crawler floor)      | OK - `159`                                                             |
| `main` field                                 | N/A - pure-JS mod, no Java entry class                                 |
| No crash-causing / griefing code             | OK - client-side UI only, no gameplay/save/logic changes               |

## Submission steps (run only after merge + in-game test)

```bash
# 0. Prerequisites: m5 merged to main, tagged, play-tested on v159.2.

# 1. Add the topic (this is the actual "submission"):
gh api -X PUT repos/VadymChan/mindustry-production-graph/topics \
  -f names[]=mindustry-mod
#   (or add more topics, e.g. names[]=ui names[]=statistics - optional)

# 2. Wait ~2h, then verify the mod appears in the in-game browser
#    (Mods -> Browse, or check mods.json in Anuken/MindustryMods).
```

To **exclude** the mod from the browser at any point, add `"hideBrowser": true` to `mod.hjson`.

## Draft release blurb (for Reddit r/Mindustry / Discord, optional)

> **Production Graph - a Factorio-style production statistics panel for Mindustry**
>
> Press F8 in a loaded map to open a panel with three tabs:
>
> - **Items** - produced/consumed rates over time, with a *Global* series that sees every crafter
>   and drill (including intermediates that never reach the core) and a *Net core* series for core
>   stock change.
> - **Electricity** - your whole team's power network: production/consumption graph, stored energy,
>   battery capacity, satisfaction, charge bar - the same numbers the vanilla power bar shows.
> - **Fluids** - produced/consumed liquid rates from crafters and pumps.
>
> Time windows from 5s to 10h, filterable list, hover tooltips. Pure-JS, client-side only - no
> gameplay or save changes. Requires Mindustry v159+.
>
> Install in-game: Mods -> Import From GitHub -> `vadymchan/mindustry-production-graph`.
> Repo: https://github.com/VadymChan/mindustry-production-graph

## Notes / caveats

- The crawler reads the **default branch**. Keep `mod.hjson` correct on `main`; the `m5` branch copy
  is the dev version (v0.2) and only matters once merged.
- Liquids are a *computed rate* of working machines, not a measured flow (output into a full buffer
  still reads as the nominal rate) - worth stating if asked, but not a blocker.
- M5/M6/M7 are implemented and syntax-validated but **not yet tested in-game**; submit only after a
  clean play-test, otherwise a crash could get the mod delisted.
