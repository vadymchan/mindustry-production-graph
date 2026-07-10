// Production Graph - M2: 1-minute history + produced/consumed graph.
//
// Mindustry has no always-on production API (getFlowRate is lazy / hover-only), so we diff the core's
// item totals once per game-second. For each item: a positive delta = produced (net into the core), a
// negative delta = consumed (net out of the core). This measures NET CORE-STOCK CHANGE, not global
// factory production - items produced and consumed between factories (belts, buffers) never touch the
// core and are invisible here.
//
// M2 adds a ring buffer of the last 60 per-second totals (all items summed) and draws two lines in the
// panel: produced (green) and consumed (red), newest sample at the right edge.
//
// Press F8 in a loaded map to toggle the panel. Sampling runs whenever a game is active, even with the
// panel closed.

// --- accumulators (keyed by item.id) ---
var producedById = {};
var consumedById = {};
var prevCountById = {};
var haveBaseline = false;

// --- 1-minute history: ring buffers of per-second totals across all items ---
// Pre-filled with zeros so the graph always spans the full window; index math below reads the buffer
// oldest-to-newest starting at histHead.
var HISTORY_SIZE = 60;
var histProduced = [];
var histConsumed = [];
var histHead = 0; // next write position == oldest sample
for (var _i = 0; _i < HISTORY_SIZE; _i++) {
  histProduced.push(0);
  histConsumed.push(0);
}

function pushHistory(produced, consumed) {
  histProduced[histHead] = produced;
  histConsumed[histHead] = consumed;
  histHead = (histHead + 1) % HISTORY_SIZE;
}

// i = 0..HISTORY_SIZE-1, oldest to newest
function histAt(buf, i) {
  return buf[(histHead + i) % HISTORY_SIZE];
}

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
    // does not register as a huge produced/consumed spike. History gets zeros: nothing observable.
    haveBaseline = false;
    pushHistory(0, 0);
    return;
  }
  var items = Vars.content.items();
  var secProduced = 0;
  var secConsumed = 0;
  for (var i = 0; i < items.size; i++) {
    var item = items.get(i);
    var cur = core.items.get(item);
    if (haveBaseline) {
      var d = cur - (prevCountById[item.id] || 0);
      if (d > 0) {
        producedById[item.id] = (producedById[item.id] || 0) + d;
        secProduced += d;
      } else if (d < 0) {
        consumedById[item.id] = (consumedById[item.id] || 0) - d;
        secConsumed -= d;
      }
    }
    prevCountById[item.id] = cur;
  }
  haveBaseline = true;
  pushHistory(secProduced, secConsumed);
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

// --- graph ---
var producedColor = Color.valueOf("6bd68a");
var consumedColor = Color.valueOf("e55454");
var graphMax = 1; // vertical scale of the last drawn frame, shown in the scale label

function drawSeries(buf, color, x, y, w, h) {
  Lines.stroke(2);
  Draw.color(color);
  Lines.beginLine();
  for (var i = 0; i < HISTORY_SIZE; i++) {
    var px = x + w * i / (HISTORY_SIZE - 1);
    var py = y + (h - 6) * (histAt(buf, i) / graphMax) + 3;
    Lines.linePoint(px, py);
  }
  Lines.endLine();
}

function makeGraphElement() {
  return extend(Element, {
    draw: function () {
      var x = this.getX(), y = this.getY(), w = this.getWidth(), h = this.getHeight();

      // background + horizontal grid
      Draw.color(0, 0, 0, 0.5);
      Fill.crect(x, y, w, h);
      Draw.color(1, 1, 1, 0.1);
      Lines.stroke(1);
      for (var g = 1; g <= 3; g++) {
        var gy = y + h * g / 4;
        Lines.line(x, gy, x + w, gy);
      }

      // vertical scale = max sample in the window (>= 1 so flat zero lines sit at the bottom)
      var max = 1;
      for (var i = 0; i < HISTORY_SIZE; i++) {
        var p = histAt(histProduced, i);
        var c = histAt(histConsumed, i);
        if (p > max) max = p;
        if (c > max) max = c;
      }
      graphMax = max;

      drawSeries(histProduced, producedColor, x, y, w, h);
      drawSeries(histConsumed, consumedColor, x, y, w, h);
      Draw.reset();
    }
  });
}

// --- panel ---
var dialog = null;

function buildDialog() {
  var d = new BaseDialog("Production Graph");

  d.cont.add("Window: 1m    [#6bd68a]produced/s[]  [#e55454]consumed/s[]").left();
  d.cont.row();
  d.cont.add(makeGraphElement()).width(560).height(240).pad(4);
  d.cont.row();
  d.cont.label(prov(function () { return "[lightgray]scale max: " + graphMax + "/s[]"; })).left();
  d.cont.row();

  // per-item totals since load (M1), inside a scroll pane
  var list = new Table();
  list.add("Item").left().width(150);
  list.add("Produced").right().width(90);
  list.add("Consumed").right().width(90);
  list.add("Core").right().width(90);
  list.row();
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
  d.cont.add(new ScrollPane(list)).growX().maxHeight(260).padTop(8);
  d.cont.row();
  d.cont.add("Numbers are net core-stock change, not global factory output.").left().padTop(8);

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
