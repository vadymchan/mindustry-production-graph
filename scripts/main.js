// Production Graph - M3: sortable item list + click-to-filter.
//
// Mindustry has no always-on production API (getFlowRate is lazy / hover-only), so we diff the core's
// item totals once per game-second. For each item: a positive delta = produced (net into the core), a
// negative delta = consumed (net out of the core). This measures NET CORE-STOCK CHANGE, not global
// factory production - items produced and consumed between factories (belts, buffers) never touch the
// core and are invisible here.
//
// M3 layout (Factorio-style): sortable item list on the left (icon + produced/consumed over the 1m
// window), graph on the right. Clicking an item filters the graph to that item; Reset shows all items.
//
// Press F8 in a loaded map to toggle the panel. Sampling runs whenever a game is active, even with the
// panel closed.

// --- history: ring buffers of per-second values, shared head, 1m window ---
var HISTORY_SIZE = 60;
var histHead = 0; // next write position == oldest sample

// aggregate across all items
var histProduced = newBuffer();
var histConsumed = newBuffer();
// per item.id, created lazily on first sample
var histProducedById = {};
var histConsumedById = {};

var prevCountById = {};
var haveBaseline = false;
var uiDirty = false; // set by sample(), consumed by the item list rebuild

function newBuffer() {
  var b = [];
  for (var i = 0; i < HISTORY_SIZE; i++) b.push(0);
  return b;
}

function bufFor(map, id) {
  var b = map[id];
  if (b == null) {
    b = newBuffer();
    map[id] = b;
  }
  return b;
}

// i = 0..HISTORY_SIZE-1, oldest to newest
function histAt(buf, i) {
  return buf == null ? 0 : buf[(histHead + i) % HISTORY_SIZE];
}

function windowTotal(buf) {
  if (buf == null) return 0;
  var sum = 0;
  for (var i = 0; i < HISTORY_SIZE; i++) sum += buf[i];
  return sum;
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
  var items = Vars.content.items();
  var i, item;
  if (core == null) {
    // no core (menu, spectating, core destroyed) - re-baseline on the next valid sample so the gap
    // does not register as a huge produced/consumed spike. History gets zeros: nothing observable.
    haveBaseline = false;
    histProduced[histHead] = 0;
    histConsumed[histHead] = 0;
    for (i = 0; i < items.size; i++) {
      item = items.get(i);
      bufFor(histProducedById, item.id)[histHead] = 0;
      bufFor(histConsumedById, item.id)[histHead] = 0;
    }
    histHead = (histHead + 1) % HISTORY_SIZE;
    uiDirty = true;
    return;
  }
  var secProduced = 0;
  var secConsumed = 0;
  for (i = 0; i < items.size; i++) {
    item = items.get(i);
    var cur = core.items.get(item);
    var dp = 0, dc = 0;
    if (haveBaseline) {
      var d = cur - (prevCountById[item.id] || 0);
      if (d > 0) dp = d;
      else if (d < 0) dc = -d;
    }
    bufFor(histProducedById, item.id)[histHead] = dp;
    bufFor(histConsumedById, item.id)[histHead] = dc;
    secProduced += dp;
    secConsumed += dc;
    prevCountById[item.id] = cur;
  }
  histProduced[histHead] = secProduced;
  histConsumed[histHead] = secConsumed;
  histHead = (histHead + 1) % HISTORY_SIZE;
  haveBaseline = true;
  uiDirty = true;
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

// --- filter / sort state ---
var filterId = -1; // -1 = all items
var sortMode = "produced"; // "name" | "produced" | "consumed"
var sortDesc = true;

function filteredItem() {
  if (filterId < 0) return null;
  var items = Vars.content.items();
  for (var i = 0; i < items.size; i++) {
    if (items.get(i).id == filterId) return items.get(i);
  }
  return null;
}

// --- graph ---
var producedColor = Color.valueOf("6bd68a");
var consumedColor = Color.valueOf("e55454");
var graphMax = 1; // vertical scale of the last drawn frame, shown in the scale label

function graphProducedBuf() {
  return filterId < 0 ? histProduced : histProducedById[filterId];
}
function graphConsumedBuf() {
  return filterId < 0 ? histConsumed : histConsumedById[filterId];
}

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

      var pb = graphProducedBuf();
      var cb = graphConsumedBuf();

      // vertical scale = max sample in the window (>= 1 so flat zero lines sit at the bottom)
      var max = 1;
      for (var i = 0; i < HISTORY_SIZE; i++) {
        var p = histAt(pb, i);
        var c = histAt(cb, i);
        if (p > max) max = p;
        if (c > max) max = c;
      }
      graphMax = max;

      drawSeries(pb, producedColor, x, y, w, h);
      drawSeries(cb, consumedColor, x, y, w, h);
      Draw.reset();
    }
  });
}

// --- item list ---

function sortedItems() {
  var items = Vars.content.items();
  var arr = [];
  for (var i = 0; i < items.size; i++) arr.push(items.get(i));
  arr.sort(function (a, b) {
    var va, vb;
    if (sortMode == "name") {
      va = String(a.localizedName).toLowerCase();
      vb = String(b.localizedName).toLowerCase();
      if (va < vb) return sortDesc ? 1 : -1;
      if (va > vb) return sortDesc ? -1 : 1;
      return 0;
    }
    if (sortMode == "produced") {
      va = windowTotal(histProducedById[a.id]);
      vb = windowTotal(histProducedById[b.id]);
    } else {
      va = windowTotal(histConsumedById[a.id]);
      vb = windowTotal(histConsumedById[b.id]);
    }
    return sortDesc ? vb - va : va - vb;
  });
  return arr;
}

function setSort(mode) {
  if (sortMode == mode) {
    sortDesc = !sortDesc;
  } else {
    sortMode = mode;
    sortDesc = mode != "name";
  }
  uiDirty = true;
}

function rebuildList(list) {
  list.clearChildren();

  var arr = sortedItems();
  for (var i = 0; i < arr.length; i++) {
    (function (item) {
      var row = new Table();
      if (item.id == filterId) row.background(Styles.flatDown);
      row.add(new Image(item.uiIcon)).size(24).padRight(6);
      row.add(item.localizedName).left().growX();
      row.add("[#6bd68a]" + windowTotal(histProducedById[item.id]) + "[]").right().width(60);
      row.add("[#e55454]" + windowTotal(histConsumedById[item.id]) + "[]").right().width(60).padRight(4);
      row.touchable = Touchable.enabled;
      row.clicked(run(function () {
        filterId = (filterId == item.id) ? -1 : item.id;
        uiDirty = true;
      }));
      list.add(row).growX().height(32);
      list.row();
    })(arr[i]);
  }
}

// --- panel ---
var dialog = null;

function buildDialog() {
  var d = new BaseDialog("Production Graph");

  // header: window info, filter status, reset
  var header = new Table();
  header.add("Window: 1m    [#6bd68a]produced[]  [#e55454]consumed[]").left().growX();
  header.label(prov(function () {
    var it = filteredItem();
    return it == null ? "[lightgray]filter: all items[]" : "[accent]filter: " + it.localizedName + "[]";
  })).padRight(12);
  header.button("Reset", run(function () {
    filterId = -1;
    uiDirty = true;
  })).size(90, 36);
  d.cont.add(header).growX();
  d.cont.row();

  var body = new Table();

  // left: sort header + item list
  var left = new Table();
  var sorters = new Table();
  sorters.button("Item", run(function () { setSort("name"); })).growX().height(32);
  sorters.button("Prod", run(function () { setSort("produced"); })).width(64).height(32);
  sorters.button("Cons", run(function () { setSort("consumed"); })).width(64).height(32);
  left.add(sorters).growX();
  left.row();

  var list = new Table();
  list.top();
  rebuildList(list);
  // rebuild once per sample (and after clicks) instead of every frame
  list.update(run(function () {
    if (uiDirty) {
      uiDirty = false;
      rebuildList(list);
    }
  }));
  var pane = new ScrollPane(list);
  left.add(pane).width(330).growY();

  body.add(left).growY().padRight(8);
  body.add(makeGraphElement()).width(520).height(300).pad(4);
  d.cont.add(body).height(340);
  d.cont.row();

  d.cont.label(prov(function () { return "[lightgray]scale max: " + graphMax + "/s[]"; })).left();
  d.cont.row();
  d.cont.add("Numbers are net core-stock change over the window, not global factory output.")
    .left().padTop(8);

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
