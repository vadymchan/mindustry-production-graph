// Production Graph - M1: per-second sampling of core item flow.
//
// Mindustry has no always-on production API (getFlowRate is lazy / hover-only), so we diff the core's
// item totals once per game-second. For each item: a positive delta = produced (net into the core), a
// negative delta = consumed (net out of the core). This measures NET CORE-STOCK CHANGE, not global
// factory production - items produced and consumed between factories (belts, buffers) never touch the
// core and are invisible here. That is the intended M1 approximation.
//
// Press F8 in a loaded map to toggle the panel. Sampling runs whenever a game is active, even with the
// panel closed.

// --- accumulators (keyed by item.id) ---
var producedById = {};
var consumedById = {};
var prevCountById = {};
var haveBaseline = false;

// Return the player's core if a game is active and the core (with its item module) exists, else null.
function currentCore() {
  if (!Vars.state.isGame()) return null;
  var player = Vars.player;
  if (player == null) return null;
  var team = player.team();
  if (team == null) return null;
  var core = team.core();
  if (core == null || core.items == null) return null; // both are @Nullable
  return core;
}

function sample() {
  var core = currentCore();
  if (core == null) {
    // no core (menu, spectating, core destroyed) - re-baseline on the next valid sample so the gap
    // does not register as a huge produced/consumed spike.
    haveBaseline = false;
    return;
  }
  var items = Vars.content.items();
  for (var i = 0; i < items.size; i++) {
    var item = items.get(i);
    var cur = core.items.get(item);
    if (haveBaseline) {
      var d = cur - (prevCountById[item.id] || 0);
      if (d > 0) {
        producedById[item.id] = (producedById[item.id] || 0) + d;
      } else if (d < 0) {
        consumedById[item.id] = (consumedById[item.id] || 0) - d;
      }
    }
    prevCountById[item.id] = cur;
  }
  haveBaseline = true;
}

// Per-second cadence off game time: Time.delta is in ticks (60 ticks = 1 second at normal speed), so
// sampling pauses when the game is paused - which is correct, production is paused too.
var tickAcc = 0;
Events.run(Trigger.update, run(function () {
  tickAcc += Time.delta;
  if (tickAcc >= 60) {
    tickAcc -= 60;
    sample();
  }
}));

// --- read helpers for the UI ---
function getProduced(item) { return producedById[item.id] || 0; }
function getConsumed(item) { return consumedById[item.id] || 0; }
function getCoreCount(item) {
  var core = currentCore();
  return core == null ? 0 : core.items.get(item);
}

// --- panel ---
var dialog = null;

function buildDialog() {
  var d = new BaseDialog("Production Graph");

  // header row
  d.cont.add("Item").left().width(150);
  d.cont.add("Produced").right().width(90);
  d.cont.add("Consumed").right().width(90);
  d.cont.add("Core").right().width(90);
  d.cont.row();

  // one live row per item, inside a scroll pane
  var list = new Table();
  var items = Vars.content.items();
  for (var i = 0; i < items.size; i++) {
    (function (item) {
      list.add(item.localizedName).left().width(150);
      list.label(prov(function () { return "" + getProduced(item); })).right().width(90);
      list.label(prov(function () { return "" + getConsumed(item); })).right().width(90);
      list.label(prov(function () { return "" + getCoreCount(item); })).right().width(90);
      list.row();
    })(items.get(i));
  }

  d.cont.add(new ScrollPane(list)).colspan(4).grow().maxHeight(500);
  d.cont.row();
  d.cont.add("M1: produced/consumed = net core-stock change (not global factory output).")
    .colspan(4).left().padTop(8);

  d.addCloseButton();
  return d;
}

Events.run(Trigger.update, run(function () {
  if (Core.input.keyTap(KeyCode.f8)) {
    if (dialog == null) dialog = buildDialog();
    if (dialog.parent != null) {
      dialog.hide();
    } else {
      dialog.show();
    }
  }
}));
