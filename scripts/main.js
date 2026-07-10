// Production Graph - M4 (MVP): time windows + downsampling + hover tooltip.
//
// Mindustry has no always-on production API (getFlowRate is lazy / hover-only), so we diff the core's
// item totals once per game-second. For each item: a positive delta = produced (net into the core), a
// negative delta = consumed (net out of the core). This measures NET CORE-STOCK CHANGE, not global
// factory production - items produced and consumed between factories (belts, buffers) never touch the
// core and are invisible here.
//
// M4 replicates the Factorio window model: each window keeps its own ring of samples, granularity =
// window / 300 with a 1-second floor (our base sampling rate), longer windows downsample by summing
// base samples into buckets. Item labels show the average rate over the window; the curve shows the
// precise samples. Hovering the graph shows a marker plus a tooltip with the exact values.
//
// Press F8 in a loaded map to toggle the panel. Sampling runs whenever a game is active, even with the
// panel closed.

// --- windows: bucket = seconds per sample, size = samples kept (Factorio: 300/window, 1s floor) ---
var WINDOWS = [
  { name: "5s",  bucket: 1,   size: 5   },
  { name: "1m",  bucket: 1,   size: 60  },
  { name: "10m", bucket: 2,   size: 300 },
  { name: "1h",  bucket: 12,  size: 300 },
  { name: "10h", bucket: 120, size: 300 }
];
var curWindow = 1; // default 1m

// Each window gets: ring head, bucket fill counter, aggregate rings, per-item rings (lazy), and the
// accumulators that sum base samples until a bucket completes. Rings store bucket TOTALS; divide by
// w.bucket for a per-second rate.
(function () {
  for (var i = 0; i < WINDOWS.length; i++) {
    var w = WINDOWS[i];
    w.seconds = w.bucket * w.size;
    w.head = 0;
    w.fill = 0;
    w.aggP = newBuffer(w.size);
    w.aggC = newBuffer(w.size);
    w.perP = {};
    w.perC = {};
    w.aggPAcc = 0;
    w.aggCAcc = 0;
    w.perPAcc = {};
    w.perCAcc = {};
  }
})();

var prevCountById = {};
var haveBaseline = false;
var uiDirty = false; // set by sample(), consumed by the item list rebuild

function newBuffer(size) {
  var b = [];
  for (var i = 0; i < size; i++) b.push(0);
  return b;
}

function bufFor(map, id, size) {
  var b = map[id];
  if (b == null) {
    b = newBuffer(size);
    map[id] = b;
  }
  return b;
}

// i = 0..w.size-1, oldest to newest
function histAt(w, buf, i) {
  return buf == null ? 0 : buf[(w.head + i) % w.size];
}

function windowTotal(buf) {
  if (buf == null) return 0;
  var sum = 0;
  for (var i = 0; i < buf.length; i++) sum += buf[i];
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

function flushWindow(w, items) {
  w.aggP[w.head] = w.aggPAcc;
  w.aggC[w.head] = w.aggCAcc;
  for (var i = 0; i < items.size; i++) {
    var id = items.get(i).id;
    bufFor(w.perP, id, w.size)[w.head] = w.perPAcc[id] || 0;
    bufFor(w.perC, id, w.size)[w.head] = w.perCAcc[id] || 0;
  }
  w.head = (w.head + 1) % w.size;
  w.fill = 0;
  w.aggPAcc = 0;
  w.aggCAcc = 0;
  w.perPAcc = {};
  w.perCAcc = {};
}

function sample() {
  var items = Vars.content.items();
  var core = currentCore();
  var secProduced = 0;
  var secConsumed = 0;
  var i, item;

  // per-second deltas; all zero while there is no core (menu, spectating, core destroyed) - and the
  // baseline resets so the gap does not register as a huge produced/consumed spike afterwards.
  var dpById = {};
  var dcById = {};
  if (core == null) {
    haveBaseline = false;
  } else {
    for (i = 0; i < items.size; i++) {
      item = items.get(i);
      var cur = core.items.get(item);
      if (haveBaseline) {
        var d = cur - (prevCountById[item.id] || 0);
        if (d > 0) {
          dpById[item.id] = d;
          secProduced += d;
        } else if (d < 0) {
          dcById[item.id] = -d;
          secConsumed -= d;
        }
      }
      prevCountById[item.id] = cur;
    }
    haveBaseline = true;
  }

  // feed every window; flush a bucket when it has collected w.bucket base samples
  for (var wi = 0; wi < WINDOWS.length; wi++) {
    var w = WINDOWS[wi];
    w.aggPAcc += secProduced;
    w.aggCAcc += secConsumed;
    for (i = 0; i < items.size; i++) {
      var id = items.get(i).id;
      if (dpById[id]) w.perPAcc[id] = (w.perPAcc[id] || 0) + dpById[id];
      if (dcById[id]) w.perCAcc[id] = (w.perCAcc[id] || 0) + dcById[id];
    }
    w.fill++;
    if (w.fill >= w.bucket) flushWindow(w, items);
  }
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

// --- formatting ---
function fmtRate(r) {
  if (r >= 100) return "" + Math.round(r);
  if (r >= 10) return "" + Math.round(r * 10) / 10;
  return "" + Math.round(r * 100) / 100;
}

function fmtTime(s) {
  if (s >= 3600) {
    var h = Math.floor(s / 3600);
    var m = Math.round((s % 3600) / 60);
    return m > 0 ? h + "h" + m + "m" : h + "h";
  }
  if (s >= 60) {
    var mm = Math.floor(s / 60);
    var ss = Math.round(s % 60);
    return ss > 0 ? mm + "m" + ss + "s" : mm + "m";
  }
  return Math.round(s) + "s";
}

// --- graph ---
var producedColor = Color.valueOf("6bd68a");
var consumedColor = Color.valueOf("e55454");
var graphMax = 1;  // vertical scale (rate/s) of the last drawn frame, shown in the scale label
var hoverX = -1;   // mouse x in graph-local pixels, -1 = not hovering
var hoverIdx = -1; // sample index under the mouse, -1 = none (set during draw)

function curW() { return WINDOWS[curWindow]; }

function graphProducedBuf() {
  var w = curW();
  return filterId < 0 ? w.aggP : w.perP[filterId];
}
function graphConsumedBuf() {
  var w = curW();
  return filterId < 0 ? w.aggC : w.perC[filterId];
}

function windowAvg(buf) {
  return windowTotal(buf) / curW().seconds;
}

function hoverText() {
  var w = curW();
  if (hoverIdx < 0) return "";
  var p = histAt(w, graphProducedBuf(), hoverIdx) / w.bucket;
  var c = histAt(w, graphConsumedBuf(), hoverIdx) / w.bucket;
  var ago = (w.size - 1 - hoverIdx) * w.bucket;
  return (ago > 0 ? "-" + fmtTime(ago) : "now")
    + "  [#6bd68a]" + fmtRate(p) + "/s[]  [#e55454]" + fmtRate(c) + "/s[]";
}

function drawSeries(w, buf, color, x, y, gw, gh) {
  Lines.stroke(2);
  Draw.color(color);
  Lines.beginLine();
  for (var i = 0; i < w.size; i++) {
    var px = x + gw * i / (w.size - 1);
    var py = y + (gh - 6) * (histAt(w, buf, i) / w.bucket / graphMax) + 3;
    Lines.linePoint(px, py);
  }
  Lines.endLine();
}

function makeGraphElement() {
  var elem = extend(Element, {
    draw: function () {
      var x = this.getX(), y = this.getY(), gw = this.getWidth(), gh = this.getHeight();
      var w = curW();

      // background + horizontal grid
      Draw.color(0, 0, 0, 0.5);
      Fill.crect(x, y, gw, gh);
      Draw.color(1, 1, 1, 0.1);
      Lines.stroke(1);
      for (var g = 1; g <= 3; g++) {
        var gy = y + gh * g / 4;
        Lines.line(x, gy, x + gw, gy);
      }

      var pb = graphProducedBuf();
      var cb = graphConsumedBuf();

      // vertical scale = max rate in the window (>= 1 so flat zero lines sit at the bottom)
      var max = 1;
      for (var i = 0; i < w.size; i++) {
        var p = histAt(w, pb, i) / w.bucket;
        var c = histAt(w, cb, i) / w.bucket;
        if (p > max) max = p;
        if (c > max) max = c;
      }
      graphMax = max;

      drawSeries(w, pb, producedColor, x, y, gw, gh);
      drawSeries(w, cb, consumedColor, x, y, gw, gh);

      // hover marker
      if (hoverX >= 0) {
        hoverIdx = Math.round(hoverX / gw * (w.size - 1));
        if (hoverIdx < 0) hoverIdx = 0;
        if (hoverIdx > w.size - 1) hoverIdx = w.size - 1;
        var mx = x + gw * hoverIdx / (w.size - 1);
        Draw.color(1, 1, 1, 0.35);
        Lines.stroke(1);
        Lines.line(mx, y, mx, y + gh);
      } else {
        hoverIdx = -1;
      }
      Draw.reset();
    }
  });

  // hover tracking: mouseMoved gives element-local coordinates, no conversion needed
  elem.addListener(extend(InputListener, {
    mouseMoved: function (event, x, y) {
      hoverX = x;
      return false;
    },
    exit: function (event, x, y, pointer, toElement) {
      hoverX = -1;
    }
  }));

  // floating tooltip with the exact values at the hovered sample
  elem.addListener(new Tooltip(cons(function (t) {
    t.background(Styles.black6);
    t.margin(6);
    t.label(prov(hoverText));
  })));

  return elem;
}

// --- item list ---

function sortedItems() {
  var w = curW();
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
      va = windowTotal(w.perP[a.id]);
      vb = windowTotal(w.perP[b.id]);
    } else {
      va = windowTotal(w.perC[a.id]);
      vb = windowTotal(w.perC[b.id]);
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

  var w = curW();
  var arr = sortedItems();
  for (var i = 0; i < arr.length; i++) {
    (function (item) {
      var row = new Table();
      if (item.id == filterId) row.background(Styles.flatDown);
      row.add(new Image(item.uiIcon)).size(24).padRight(6);
      row.add(item.localizedName).left().growX();
      row.add("[#6bd68a]" + fmtRate(windowAvg(w.perP[item.id])) + "/s[]").right().width(74);
      row.add("[#e55454]" + fmtRate(windowAvg(w.perC[item.id])) + "/s[]").right().width(74).padRight(4);
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

  // header: window selector, legend, filter status, reset
  var header = new Table();
  for (var wi = 0; wi < WINDOWS.length; wi++) {
    (function (wi) {
      var b = header.button(WINDOWS[wi].name, Styles.togglet, run(function () {
        curWindow = wi;
        uiDirty = true;
      })).size(56, 36).get();
      b.update(run(function () { b.setChecked(curWindow == wi); }));
    })(wi);
  }
  header.add("  [#6bd68a]produced[]  [#e55454]consumed[]").left().growX();
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

  // left: sort header + item list (avg rate over the selected window)
  var left = new Table();
  var sorters = new Table();
  sorters.button("Item", run(function () { setSort("name"); })).growX().height(32);
  sorters.button("Prod", run(function () { setSort("produced"); })).width(74).height(32);
  sorters.button("Cons", run(function () { setSort("consumed"); })).width(74).height(32);
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
  left.add(pane).width(360).growY();

  body.add(left).growY().padRight(8);

  // right: graph + time axis
  var right = new Table();
  right.add(makeGraphElement()).width(520).height(300).pad(4);
  right.row();
  var axis = new Table();
  axis.label(prov(function () { return "[lightgray]-" + curW().name + "[]"; })).left().growX();
  axis.add("[lightgray]now[]").right();
  right.add(axis).growX();
  body.add(right);

  d.cont.add(body).height(360);
  d.cont.row();

  d.cont.label(prov(function () {
    return "[lightgray]scale max: " + fmtRate(graphMax) + "/s    list shows avg/s over "
      + curW().name + "[]";
  })).left();
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
