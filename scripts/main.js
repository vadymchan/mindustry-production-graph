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
// selection: item.id -> true. Empty selection = no filter = aggregate over all items.
// Multiselect: row clicks and the Items dialog checkboxes toggle the same set.
var selection = {};
var sortMode = "produced"; // "name" | "produced" | "consumed"
var sortDesc = true;

// column layout, adjustable by the drag handles; unscaled units (Cell applies Scl)
var listW = 360; // left panel width
var numW = 74;   // width of each number column (Prod / Cons)

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function selectedItems() {
  var out = [];
  var items = Vars.content.items();
  for (var i = 0; i < items.size; i++) {
    if (selection[items.get(i).id]) out.push(items.get(i));
  }
  return out;
}

function selectionText() {
  var sel = selectedItems();
  if (sel.length == 0) return "[lightgray]filter: all items[]";
  if (sel.length == 1) return "[accent]filter: " + sel[0].localizedName + "[]";
  return "[accent]filter: " + sel.length + " items[]";
}

function toggleSelected(item) {
  if (selection[item.id]) {
    delete selection[item.id];
  } else {
    selection[item.id] = true;
  }
  uiDirty = true;
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

// Returns a function i -> bucket total at sample i for the current selection: the aggregate ring
// when nothing is selected, otherwise the sum over the selected items' rings.
function makeGetter(w, aggBuf, map) {
  var ids = [];
  for (var k in selection) {
    if (selection[k]) ids.push(k);
  }
  if (ids.length == 0) {
    return function (i) { return histAt(w, aggBuf, i); };
  }
  return function (i) {
    var s = 0;
    for (var n = 0; n < ids.length; n++) s += histAt(w, map[ids[n]], i);
    return s;
  };
}

function windowAvg(buf) {
  return windowTotal(buf) / curW().seconds;
}

function hoverText() {
  var w = curW();
  if (hoverIdx < 0) return "";
  var p = makeGetter(w, w.aggP, w.perP)(hoverIdx) / w.bucket;
  var c = makeGetter(w, w.aggC, w.perC)(hoverIdx) / w.bucket;
  var ago = (w.size - 1 - hoverIdx) * w.bucket;
  return (ago > 0 ? "-" + fmtTime(ago) : "now")
    + "  [#6bd68a]" + fmtRate(p) + "/s[]  [#e55454]" + fmtRate(c) + "/s[]";
}

// Segment-by-segment on purpose: Lines.beginLine/endLine builds a polyline with miter joins
// (len = halfWidth / sin(angle)), and a sharp one-sample spike makes the angle approach 180
// degrees - sin goes to ~0 and the join shoots across the whole screen. Plain line() quads
// have no join math. Values are clamped to [0..1] so nothing can leave the graph rect.
function drawSeries(w, get, color, x, y, gw, gh) {
  Lines.stroke(2);
  Draw.color(color);
  var lastX = 0, lastY = 0;
  for (var i = 0; i < w.size; i++) {
    var px = x + gw * i / (w.size - 1);
    var v = get(i) / w.bucket / graphMax;
    if (!(v >= 0)) v = 0; // also catches NaN
    if (v > 1) v = 1;
    var py = y + 3 + (gh - 6) * v;
    if (i > 0) Lines.line(lastX, lastY, px, py);
    lastX = px;
    lastY = py;
  }
}

function makeGraphElement() {
  var elem = extend(Element, {
    draw: function () {
      // Arc's Element has no zero-arg getX/getY (only getX(int align)); the zero-arg call throws in
      // Rhino. bottomLeft returns the plain x/y corner.
      var x = this.getX(Align.bottomLeft), y = this.getY(Align.bottomLeft);
      var gw = this.getWidth(), gh = this.getHeight();
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

      var getP = makeGetter(w, w.aggP, w.perP);
      var getC = makeGetter(w, w.aggC, w.perC);

      // vertical scale = max rate in the window (>= 1 so flat zero lines sit at the bottom)
      var max = 1;
      for (var i = 0; i < w.size; i++) {
        var p = getP(i) / w.bucket;
        var c = getC(i) / w.bucket;
        if (p > max) max = p;
        if (c > max) max = c;
      }
      graphMax = max;

      drawSeries(w, getP, producedColor, x, y, gw, gh);
      drawSeries(w, getC, consumedColor, x, y, gw, gh);

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

  // Hover readout is shown in the axis line under the graph (see buildDialog) instead of a
  // floating arc Tooltip: the Tooltip container could get stuck on screen and swallow clicks.
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
      if (selection[item.id]) row.background(Styles.flatDown);
      row.add(new Image(item.uiIcon)).size(24).padRight(6);
      // ellipsis + minWidth(0): long names shrink instead of pushing the number columns around
      var name = new Label(item.localizedName);
      name.setEllipsis(true);
      row.add(name).left().growX().minWidth(0).padRight(8);
      row.add("[#6bd68a]" + fmtRate(windowAvg(w.perP[item.id])) + "/s[]").right().width(numW).padRight(8);
      row.add("[#e55454]" + fmtRate(windowAvg(w.perC[item.id])) + "/s[]").right().width(numW).padRight(4);
      row.touchable = Touchable.enabled;
      row.clicked(run(function () {
        toggleSelected(item);
      }));
      list.add(row).growX().height(32);
      list.row();
    })(arr[i]);
  }
}

// --- drag handle: a thin grabbable strip; calls onDrag with the horizontal delta in unscaled units ---
function makeHandle(onDrag) {
  var img = new Image(); // default = white texture
  img.color.set(Color.valueOf("ffffff2e"));
  img.touchable = Touchable.enabled;
  var lastStageX = 0;
  img.addListener(extend(InputListener, {
    touchDown: function (event, x, y, pointer, button) {
      lastStageX = event.stageX;
      return true; // accept the touch so touchDragged fires
    },
    touchDragged: function (event, x, y, pointer) {
      var dx = (event.stageX - lastStageX) / Scl.scl(1);
      lastStageX = event.stageX;
      onDrag(dx);
    }
  }));
  return img;
}

// --- items filter dialog: checkbox per item, same selection set as row clicks ---
var filterDialog = null;
var filterList = null;

function rebuildFilterList() {
  filterList.clearChildren();
  var items = Vars.content.items();
  for (var i = 0; i < items.size; i++) {
    (function (item) {
      filterList.add(new Image(item.uiIcon)).size(24).padRight(8);
      filterList.check(item.localizedName, !!selection[item.id], function (checked) {
        if (checked) {
          selection[item.id] = true;
        } else {
          delete selection[item.id];
        }
        uiDirty = true;
      }).left().growX().height(36);
      filterList.row();
    })(items.get(i));
  }
}

function showFilterDialog() {
  if (filterDialog == null) {
    filterDialog = new BaseDialog("Filter items");
    filterList = new Table();
    filterList.top();
    var pane = new ScrollPane(filterList);
    pane.setScrollingDisabled(true, false);
    filterDialog.cont.add(pane).width(440).growY();
    filterDialog.cont.row();
    var btns = new Table();
    btns.button("Select all", run(function () {
      var items = Vars.content.items();
      for (var i = 0; i < items.size; i++) selection[items.get(i).id] = true;
      uiDirty = true;
      rebuildFilterList();
    })).size(140, 40).padRight(8);
    btns.button("Clear", run(function () {
      selection = {};
      uiDirty = true;
      rebuildFilterList();
    })).size(140, 40);
    filterDialog.cont.add(btns).padTop(8);
    filterDialog.addCloseButton();
  }
  rebuildFilterList(); // fresh checkbox states (row clicks share the same selection)
  filterDialog.show();
}

// --- panel ---
var dialog = null;

function buildDialog() {
  var d = new BaseDialog("Production Graph");

  // header: window selector + filter status + reset. Legend lives under the graph.
  var header = new Table();
  for (var wi = 0; wi < WINDOWS.length; wi++) {
    (function (wi) {
      var b = header.button(WINDOWS[wi].name, Styles.togglet, run(function () {
        curWindow = wi;
        uiDirty = true;
      })).minWidth(64).height(40).padRight(6).get(); // minWidth, not fixed width: "10m" must not wrap
      b.update(run(function () { b.setChecked(curWindow == wi); }));
    })(wi);
  }
  header.add().growX(); // spacer pushes the filter controls to the right edge
  header.label(prov(selectionText)).padRight(12);
  header.button("Items...", run(showFilterDialog)).size(110, 40).padRight(6);
  header.button("Reset", run(function () {
    selection = {};
    uiDirty = true;
  })).size(90, 40);
  d.cont.add(header).growX().padBottom(6);
  d.cont.row();

  // body fills the whole remaining dialog area: fixed-width (UI-scaled) list column on the left,
  // graph takes all the rest of the screen.
  var body = new Table();

  var left = new Table();

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
  // no horizontal scrolling: rows are forced to the pane width, so long names ellipsize instead
  // of widening their row (which desynced the number columns between rows)
  pane.setScrollingDisabled(true, false);

  // The pane reserves scrollbar space to the right of the rows; pad the sort header by the same
  // amount so its columns line up with the row columns. Cell.pad* re-applies Scl, so unscale first.
  var sbw = 0;
  var paneStyle = pane.getStyle();
  if (paneStyle.vScrollKnob != null) sbw = paneStyle.vScrollKnob.getMinWidth();
  if (paneStyle.vScroll != null) sbw = Math.max(sbw, paneStyle.vScroll.getMinWidth());
  var sbGutter = sbw / Scl.scl(1);

  // number-column widths follow numW; the handle between Item and Prod drags them
  var sorters = new Table();
  sorters.button("Item", run(function () { setSort("name"); })).growX().height(36).padRight(2);
  sorters.add(makeHandle(function (dx) {
    numW = clamp(numW - dx, 50, 160);
    prodHeadCell.width(numW);
    consHeadCell.width(numW);
    sorters.invalidate();
    uiDirty = true; // rows pick the new width up on rebuild
  })).width(8).height(36).padRight(2);
  var prodHeadCell = sorters.button("Prod", run(function () { setSort("produced"); }))
    .width(numW).height(36).padRight(8);
  var consHeadCell = sorters.button("Cons", run(function () { setSort("consumed"); }))
    .width(numW).height(36).padRight(4);
  left.add(sorters).growX().padRight(sbGutter);
  left.row();
  left.add(pane).grow();

  // left panel width follows listW; the handle between the list and the graph drags it
  var leftCell = body.add(left).width(listW).growY();
  body.add(makeHandle(function (dx) {
    listW = clamp(listW + dx, 260, 900);
    leftCell.width(listW);
    body.invalidate();
  })).width(10).growY().pad(0, 2, 0, 2);

  // right: graph fills all remaining space; time axis + legend + scale under it
  var right = new Table();
  right.add(makeGraphElement()).grow().pad(4);
  right.row();
  var axis = new Table();
  axis.label(prov(function () { return "[lightgray]-" + curW().name + "[]"; })).left();
  // legend + scale normally; exact values at the marker while hovering the graph
  axis.label(prov(function () {
    if (hoverIdx >= 0) return hoverText();
    return "[#6bd68a]produced[]  [#e55454]consumed[]    [lightgray]scale max: "
      + fmtRate(graphMax) + "/s[]";
  })).expandX();
  axis.add("[lightgray]now[]").right();
  right.add(axis).growX().padTop(2);
  body.add(right).grow();

  d.cont.add(body).grow();
  d.cont.row();

  d.cont.label(prov(function () {
    return "[lightgray]List shows avg/s over " + curW().name
      + ". Numbers are net core-stock change, not global factory output.[]";
  })).left().padTop(6);

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
