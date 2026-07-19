// Production Graph - M5: Power network statistics (Factorio parity).
//
// The MVP (M0-M4) sampled only the core's item totals once per game-second - "net core-stock change".
// M5 adds a team-wide Electricity tab modelled on Factorio's electric-network readout.
//
// How the numbers are obtained (Mindustry fires no production events, so everything is polling; all
// facts verified against source tag v159.2):
//   - Power: once per second, walk the team's buildings (TeamData.buildings - a Seq the engine keeps
//            up to date on every build/destroy), keep only those whose Block.hasPower is set, and
//            collect each building's PowerGraph into a set deduped by PowerGraph.getID() (many
//            buildings share one network - without dedup we'd grossly overcount). For every distinct
//            graph we read the same public getters the vanilla power bar uses:
//              getLastScaledPowerIn()  * 60  -> production,  per second
//              getLastScaledPowerOut() * 60  -> consumption, per second
//              getLastPowerStored()          -> energy stored in batteries
//              getTotalBatteryCapacity()     -> total battery capacity
//              getSatisfaction()             -> produced / needed, clamped to 0..1
//            The getters are already divided by Time.delta inside PowerGraph.update(), so the *60
//            recovers a per-second rate - the same *60 the vanilla drill bar and power UIs apply.
//            PowerGraphs are re-resolved every sample (they are recreated on network merge/split,
//            invalidating old references), so nothing holds a stale graph; the history is keyed on
//            team-wide sums only.
//
// Every interop call is wrapped in try/catch so a single bad call cannot kill the update loop or the
// shipped MVP - a broken readout just shows zeros while the rest keeps working.
//
// Press F8 in a loaded map to toggle the panel. Sampling runs whenever a game is active, panel or not.

// --- windows: bucket = seconds per sample, size = samples kept (Factorio: ~300/window, 1s floor) ---
var WINDOWS = [
  { name: "5s",  bucket: 1,   size: 5   },
  { name: "1m",  bucket: 1,   size: 60  },
  { name: "10m", bucket: 2,   size: 300 },
  { name: "1h",  bucket: 12,  size: 300 },
  { name: "10h", bucket: 120, size: 300 }
];
var curWindow = 1; // default 1m, shared across tabs

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

// --- per-key channel: aggregate produced/consumed rings + per-content-id rings, plus the accumulators
// that sum base per-second samples until a bucket completes. Rings store bucket TOTALS; divide by
// w.bucket for a per-second rate, or windowTotal / w.seconds for the window average. ---
function makeChannel(size) {
  return {
    aggP: newBuffer(size), aggC: newBuffer(size),
    perP: {}, perC: {},
    accAggP: 0, accAggC: 0, accPerP: {}, accPerC: {}
  };
}

// dp / dc: {id -> amount} for this one second
function channelAdd(ch, dp, dc) {
  var k, pTot = 0, cTot = 0;
  for (k in dp) { ch.accPerP[k] = (ch.accPerP[k] || 0) + dp[k]; pTot += dp[k]; }
  for (k in dc) { ch.accPerC[k] = (ch.accPerC[k] || 0) + dc[k]; cTot += dc[k]; }
  ch.accAggP += pTot;
  ch.accAggC += cTot;
}

function channelFlush(ch, head, size, seq) {
  ch.aggP[head] = ch.accAggP;
  ch.aggC[head] = ch.accAggC;
  for (var i = 0; i < seq.size; i++) {
    var id = seq.get(i).id;
    bufFor(ch.perP, id, size)[head] = ch.accPerP[id] || 0;
    bufFor(ch.perC, id, size)[head] = ch.accPerC[id] || 0;
  }
  ch.accAggP = 0; ch.accAggC = 0; ch.accPerP = {}; ch.accPerC = {};
}

// --- power: three aggregate rings (prod/cons rates in W, stored level), same bucket machinery ---
function makePower(size) {
  return { prod: newBuffer(size), cons: newBuffer(size), stored: newBuffer(size),
           accP: 0, accC: 0, accS: 0 };
}
function powerAdd(pw, p, c, s) { pw.accP += p; pw.accC += c; pw.accS += s; }
function powerFlush(pw, head) {
  pw.prod[head] = pw.accP; pw.cons[head] = pw.accC; pw.stored[head] = pw.accS;
  pw.accP = 0; pw.accC = 0; pw.accS = 0;
}

(function () {
  for (var i = 0; i < WINDOWS.length; i++) {
    var w = WINDOWS[i];
    w.seconds = w.bucket * w.size;
    w.head = 0;
    w.fill = 0;
    w.core = makeChannel(w.size); // net core-stock change (MVP)
    w.pow  = makePower(w.size);   // electricity
  }
})();

function flushWindow(w) {
  var items = Vars.content.items();
  channelFlush(w.core, w.head, w.size, items);
  powerFlush(w.pow, w.head);
  w.head = (w.head + 1) % w.size;
  w.fill = 0;
}

// ============================================================================
// Sampling
// ============================================================================

var prevCountById = {}; // core-diff baseline (MVP)
var haveBaseline = false;

// latest power snapshot for the readout labels
var lastPow = { prod: 0, cons: 0, stored: 0, cap: 0, sat: 0 };

function resetSampling() {
  haveBaseline = false;
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

// Once per second: core-diff (MVP), snapshot power, feed windows.
function sample() {
  var items = Vars.content.items();
  var core = currentCore();

  // (1) core diff -> maps
  var coreDp = {}, coreDc = {};
  if (core == null) {
    haveBaseline = false;
  } else {
    for (var i = 0; i < items.size; i++) {
      var item = items.get(i);
      var cur = core.items.get(item);
      if (haveBaseline) {
        var d = cur - (prevCountById[item.id] || 0);
        if (d > 0) coreDp[item.id] = d;
        else if (d < 0) coreDc[item.id] = -d;
      }
      prevCountById[item.id] = cur;
    }
    haveBaseline = true;
  }

  // (2) power snapshot: distinct graphs across the team's buildings
  var pProd = 0, pCons = 0, pStored = 0, pCap = 0, pSatSum = 0, pSatN = 0;
  if (core != null) {
    try {
      var data = Vars.player.team().data();
      var bs = data.buildings; // Seq<Building>
      var seen = {};
      for (var bi = 0; bi < bs.size; bi++) {
        var b = bs.get(bi);
        if (!b.block.hasPower) continue;
        var pm = b.power;
        if (pm == null) continue;
        var g = pm.graph;
        if (g == null) continue;
        var gid = g.getID();
        if (seen[gid]) continue;
        seen[gid] = true;
        pProd += g.getLastScaledPowerIn() * 60;
        pCons += g.getLastScaledPowerOut() * 60;
        pStored += g.getLastPowerStored();
        pCap += g.getTotalBatteryCapacity();
        pSatSum += g.getSatisfaction();
        pSatN++;
      }
    } catch (e) { /* power off this second */ }
  }
  lastPow = { prod: pProd, cons: pCons, stored: pStored, cap: pCap, sat: pSatN > 0 ? pSatSum / pSatN : 0 };

  // (3) feed every window
  for (var wi = 0; wi < WINDOWS.length; wi++) {
    var w = WINDOWS[wi];
    channelAdd(w.core, coreDp, coreDc);
    powerAdd(w.pow, pProd, pCons, pStored);
    w.fill++;
    if (w.fill >= w.bucket) flushWindow(w);
  }

  markAllDirty();
}

// per-second cadence off game time; pauses when the game pauses (production pauses too)
var tickAcc = 0;
Events.run(Trigger.update, run(function () {
  tickAcc += Time.delta;
  if (tickAcc >= 60) {
    tickAcc -= 60;
    sample();
  }
}));

// ============================================================================
// Formatting
// ============================================================================

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function fmtRate(r) {
  if (r >= 100) return "" + Math.round(r);
  if (r >= 10) return "" + Math.round(r * 10) / 10;
  return "" + Math.round(r * 100) / 100;
}

function fmtPower(w) { // watts/s -> compact
  var a = Math.abs(w);
  if (a >= 1000) return (Math.round(w / 100) / 10) + "k";
  if (a >= 100) return "" + Math.round(w);
  return "" + (Math.round(w * 10) / 10);
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

function curW() { return WINDOWS[curWindow]; }

var producedColor = Color.valueOf("6bd68a");
var consumedColor = Color.valueOf("e55454");

// ============================================================================
// Generic resource view (Items uses this on the core-diff channel)
// ============================================================================
//
// cfg: {
//   seq()      -> Seq of content (items)
//   channel(w) -> the channel to read from that window
//   note()     -> footer string
//   extraHeader(header, st) -> optional
// }

var dirtyHooks = []; // list of functions that flag their view for a list rebuild
function markAllDirty() { for (var i = 0; i < dirtyHooks.length; i++) dirtyHooks[i](); }

function makeResourceView(cfg) {
  var st = {
    selection: {}, sortMode: "produced", sortDesc: true,
    listW: 360, numW: 74, uiDirty: true,
    graphMax: 1, hoverX: -1, hoverIdx: -1,
    filterDialog: null, filterList: null
  };
  dirtyHooks.push(function () { st.uiDirty = true; });

  function selIds() {
    var ids = [];
    for (var k in st.selection) if (st.selection[k]) ids.push(k);
    return ids;
  }

  // getter i -> bucket total for the current selection (aggregate when nothing selected)
  function makeGetter(w, aggBuf, map) {
    var ids = selIds();
    if (ids.length == 0) return function (i) { return histAt(w, aggBuf, i); };
    return function (i) {
      var s = 0;
      for (var n = 0; n < ids.length; n++) s += histAt(w, map[ids[n]], i);
      return s;
    };
  }

  function selectionText() {
    var ids = selIds();
    if (ids.length == 0) return "[lightgray]filter: all[]";
    if (ids.length == 1) {
      var seq = cfg.seq();
      for (var i = 0; i < seq.size; i++) if ("" + seq.get(i).id == ids[0]) return "[accent]filter: " + seq.get(i).localizedName + "[]";
    }
    return "[accent]filter: " + ids.length + " selected[]";
  }

  function windowAvg(buf) { return windowTotal(buf) / curW().seconds; }

  // segment-by-segment (miter joins in beginLine/endLine shoot across screen on sharp spikes)
  function drawSeries(w, get, color, x, y, gw, gh) {
    Lines.stroke(2);
    Draw.color(color);
    var lastX = 0, lastY = 0;
    for (var i = 0; i < w.size; i++) {
      var px = x + gw * i / (w.size - 1);
      var v = get(i) / w.bucket / st.graphMax;
      if (!(v >= 0)) v = 0;
      if (v > 1) v = 1;
      var py = y + 3 + (gh - 6) * v;
      if (i > 0) Lines.line(lastX, lastY, px, py);
      lastX = px; lastY = py;
    }
  }

  function hoverText() {
    var w = curW();
    if (st.hoverIdx < 0) return "";
    var ch = cfg.channel(w);
    var p = makeGetter(w, ch.aggP, ch.perP)(st.hoverIdx) / w.bucket;
    var c = makeGetter(w, ch.aggC, ch.perC)(st.hoverIdx) / w.bucket;
    var ago = (w.size - 1 - st.hoverIdx) * w.bucket;
    return (ago > 0 ? "-" + fmtTime(ago) : "now")
      + "  [#6bd68a]" + fmtRate(p) + "/s[]  [#e55454]" + fmtRate(c) + "/s[]";
  }

  function makeGraphElement() {
    var elem = extend(Element, {
      draw: function () {
        var x = this.getX(Align.bottomLeft), y = this.getY(Align.bottomLeft);
        var gw = this.getWidth(), gh = this.getHeight();
        var w = curW();

        Draw.color(0, 0, 0, 0.5);
        Fill.crect(x, y, gw, gh);
        Draw.color(1, 1, 1, 0.1);
        Lines.stroke(1);
        for (var g = 1; g <= 3; g++) {
          var gy = y + gh * g / 4;
          Lines.line(x, gy, x + gw, gy);
        }

        var ch = cfg.channel(w);
        var getP = makeGetter(w, ch.aggP, ch.perP);
        var getC = makeGetter(w, ch.aggC, ch.perC);

        var max = 1;
        for (var i = 0; i < w.size; i++) {
          var p = getP(i) / w.bucket;
          var c = getC(i) / w.bucket;
          if (p > max) max = p;
          if (c > max) max = c;
        }
        st.graphMax = max;

        drawSeries(w, getP, producedColor, x, y, gw, gh);
        drawSeries(w, getC, consumedColor, x, y, gw, gh);

        if (st.hoverX >= 0) {
          st.hoverIdx = Math.round(st.hoverX / gw * (w.size - 1));
          if (st.hoverIdx < 0) st.hoverIdx = 0;
          if (st.hoverIdx > w.size - 1) st.hoverIdx = w.size - 1;
          var mx = x + gw * st.hoverIdx / (w.size - 1);
          Draw.color(1, 1, 1, 0.35);
          Lines.stroke(1);
          Lines.line(mx, y, mx, y + gh);
        } else {
          st.hoverIdx = -1;
        }
        Draw.reset();
      }
    });
    elem.addListener(extend(InputListener, {
      mouseMoved: function (event, x, y) { st.hoverX = x; return false; },
      exit: function (event, x, y, pointer, toElement) { st.hoverX = -1; }
    }));
    return elem;
  }

  // --- list ---
  function sortedContent() {
    var w = curW();
    var ch = cfg.channel(w);
    var seq = cfg.seq();
    var arr = [];
    for (var i = 0; i < seq.size; i++) arr.push(seq.get(i));
    arr.sort(function (a, b) {
      if (st.sortMode == "name") {
        var va = String(a.localizedName).toLowerCase(), vb = String(b.localizedName).toLowerCase();
        if (va < vb) return st.sortDesc ? 1 : -1;
        if (va > vb) return st.sortDesc ? -1 : 1;
        return 0;
      }
      var pa, pb;
      if (st.sortMode == "produced") { pa = windowTotal(ch.perP[a.id]); pb = windowTotal(ch.perP[b.id]); }
      else { pa = windowTotal(ch.perC[a.id]); pb = windowTotal(ch.perC[b.id]); }
      return st.sortDesc ? pb - pa : pa - pb;
    });
    return arr;
  }

  function setSort(mode) {
    if (st.sortMode == mode) st.sortDesc = !st.sortDesc;
    else { st.sortMode = mode; st.sortDesc = mode != "name"; }
    st.uiDirty = true;
  }

  function toggleSel(c) {
    if (st.selection[c.id]) delete st.selection[c.id]; else st.selection[c.id] = true;
    st.uiDirty = true;
  }

  function rebuildList(list) {
    list.clearChildren();
    var w = curW();
    var ch = cfg.channel(w);
    var arr = sortedContent();
    for (var i = 0; i < arr.length; i++) {
      (function (c) {
        var row = new Table();
        if (st.selection[c.id]) row.background(Styles.flatDown);
        row.add(new Image(c.uiIcon)).size(24).padRight(6);
        var name = new Label(c.localizedName);
        name.setEllipsis(true);
        row.add(name).left().growX().minWidth(0).padRight(8);
        row.add("[#6bd68a]" + fmtRate(windowAvg(ch.perP[c.id])) + "/s[]").right().width(st.numW).padRight(8);
        row.add("[#e55454]" + fmtRate(windowAvg(ch.perC[c.id])) + "/s[]").right().width(st.numW).padRight(4);
        row.touchable = Touchable.enabled;
        row.clicked(run(function () { toggleSel(c); }));
        list.add(row).growX().height(32);
        list.row();
      })(arr[i]);
    }
  }

  // --- filter dialog ---
  function rebuildFilterList() {
    st.filterList.clearChildren();
    var seq = cfg.seq();
    for (var i = 0; i < seq.size; i++) {
      (function (c) {
        st.filterList.add(new Image(c.uiIcon)).size(24).padRight(8);
        st.filterList.check(c.localizedName, !!st.selection[c.id], function (checked) {
          if (checked) st.selection[c.id] = true; else delete st.selection[c.id];
          st.uiDirty = true;
        }).left().growX().height(36);
        st.filterList.row();
      })(seq.get(i));
    }
  }

  function showFilterDialog() {
    if (st.filterDialog == null) {
      st.filterDialog = new BaseDialog("Filter");
      st.filterList = new Table();
      st.filterList.top();
      var pane = new ScrollPane(st.filterList);
      pane.setScrollingDisabled(true, false);
      st.filterDialog.cont.add(pane).width(440).growY();
      st.filterDialog.cont.row();
      var btns = new Table();
      btns.button("Select all", run(function () {
        var seq = cfg.seq();
        for (var i = 0; i < seq.size; i++) st.selection[seq.get(i).id] = true;
        st.uiDirty = true; rebuildFilterList();
      })).size(140, 40).padRight(8);
      btns.button("Clear", run(function () { st.selection = {}; st.uiDirty = true; rebuildFilterList(); })).size(140, 40);
      st.filterDialog.cont.add(btns).padTop(8);
      st.filterDialog.addCloseButton();
    }
    rebuildFilterList();
    st.filterDialog.show();
  }

  function makeHandle(onDrag) {
    var img = new Image();
    img.color.set(Color.valueOf("ffffff2e"));
    img.touchable = Touchable.enabled;
    var lastStageX = 0;
    img.addListener(extend(InputListener, {
      touchDown: function (event, x, y, pointer, button) { lastStageX = event.stageX; return true; },
      touchDragged: function (event, x, y, pointer) {
        var dx = (event.stageX - lastStageX) / Scl.scl(1);
        lastStageX = event.stageX;
        onDrag(dx);
      }
    }));
    return img;
  }

  // --- assemble ---
  var root = new Table();

  var header = new Table();
  if (cfg.extraHeader) cfg.extraHeader(header, st);
  header.add().growX();
  header.label(prov(selectionText)).padRight(12);
  header.button("Filter...", run(showFilterDialog)).size(110, 40).padRight(6);
  header.button("Reset", run(function () { st.selection = {}; st.uiDirty = true; })).size(90, 40);
  root.add(header).growX().padBottom(6);
  root.row();

  var body = new Table();
  var left = new Table();

  var list = new Table();
  list.top();
  rebuildList(list);
  list.update(run(function () {
    if (st.uiDirty) { st.uiDirty = false; rebuildList(list); }
  }));
  var pane = new ScrollPane(list);
  pane.setScrollingDisabled(true, false);

  var sbw = 0;
  var pstyle = pane.getStyle();
  if (pstyle.vScrollKnob != null) sbw = pstyle.vScrollKnob.getMinWidth();
  if (pstyle.vScroll != null) sbw = Math.max(sbw, pstyle.vScroll.getMinWidth());
  var sbGutter = sbw / Scl.scl(1);

  var sorters = new Table();
  sorters.button("Name", run(function () { setSort("name"); })).growX().height(36).padRight(2);
  sorters.add(makeHandle(function (dx) {
    st.numW = clamp(st.numW - dx, 50, 160);
    prodHeadCell.width(st.numW); consHeadCell.width(st.numW);
    sorters.invalidate(); st.uiDirty = true;
  })).width(8).height(36).padRight(2);
  var prodHeadCell = sorters.button("Prod", run(function () { setSort("produced"); })).width(st.numW).height(36).padRight(8);
  var consHeadCell = sorters.button("Cons", run(function () { setSort("consumed"); })).width(st.numW).height(36).padRight(4);
  left.add(sorters).growX().padRight(sbGutter);
  left.row();
  left.add(pane).grow();

  var leftCell = body.add(left).width(st.listW).growY();
  body.add(makeHandle(function (dx) {
    st.listW = clamp(st.listW + dx, 260, 900);
    leftCell.width(st.listW); body.invalidate();
  })).width(10).growY().pad(0, 2, 0, 2);

  var right = new Table();
  right.add(makeGraphElement()).grow().pad(4);
  right.row();
  var axis = new Table();
  axis.label(prov(function () { return "[lightgray]-" + curW().name + "[]"; })).left();
  axis.label(prov(function () {
    if (st.hoverIdx >= 0) return hoverText();
    return "[#6bd68a]produced[]  [#e55454]consumed[]    [lightgray]scale max: " + fmtRate(st.graphMax) + "/s[]";
  })).expandX();
  axis.add("[lightgray]now[]").right();
  right.add(axis).growX().padTop(2);
  body.add(right).grow();

  root.add(body).grow();
  root.row();
  root.label(prov(cfg.note)).left().padTop(6);
  return root;
}

// ============================================================================
// Power view (Electricity)
// ============================================================================

var storedColor = Color.valueOf("ffd37f");
var powDrawErr = ""; // last draw-time error in the power view, surfaced in the note label

function makePowerView() {
  var st = { graphMax: 1, hoverX: -1, hoverIdx: -1 };

  function drawSeries(w, get, color, x, y, gw, gh) {
    Lines.stroke(2);
    Draw.color(color);
    var lastX = 0, lastY = 0;
    for (var i = 0; i < w.size; i++) {
      var px = x + gw * i / (w.size - 1);
      var v = get(i) / w.bucket / st.graphMax;
      if (!(v >= 0)) v = 0;
      if (v > 1) v = 1;
      var py = y + 3 + (gh - 6) * v;
      if (i > 0) Lines.line(lastX, lastY, px, py);
      lastX = px; lastY = py;
    }
  }

  function makeGraphElement() {
    var elem = extend(Element, {
      draw: function () {
        try {
          var x = this.getX(Align.bottomLeft), y = this.getY(Align.bottomLeft);
          var gw = this.getWidth(), gh = this.getHeight();
          var w = curW();

          Draw.color(0, 0, 0, 0.5);
          Fill.crect(x, y, gw, gh);
          Draw.color(1, 1, 1, 0.1);
          Lines.stroke(1);
          for (var g = 1; g <= 3; g++) {
            var gy = y + gh * g / 4;
            Lines.line(x, gy, x + gw, gy);
          }

          var getP = function (i) { return histAt(w, w.pow.prod, i); };
          var getC = function (i) { return histAt(w, w.pow.cons, i); };
          var max = 1;
          for (var i = 0; i < w.size; i++) {
            var p = getP(i) / w.bucket, c = getC(i) / w.bucket;
            if (p > max) max = p;
            if (c > max) max = c;
          }
          st.graphMax = max;
          drawSeries(w, getP, producedColor, x, y, gw, gh);
          drawSeries(w, getC, consumedColor, x, y, gw, gh);

          if (st.hoverX >= 0) {
            st.hoverIdx = Math.round(st.hoverX / gw * (w.size - 1));
            if (st.hoverIdx < 0) st.hoverIdx = 0;
            if (st.hoverIdx > w.size - 1) st.hoverIdx = w.size - 1;
            var mx = x + gw * st.hoverIdx / (w.size - 1);
            Draw.color(1, 1, 1, 0.35);
            Lines.stroke(1);
            Lines.line(mx, y, mx, y + gh);
          } else st.hoverIdx = -1;
          Draw.reset();
        } catch (e) {
          powDrawErr = "graph: " + e;
          Draw.reset();
        }
      }
    });
    elem.addListener(extend(InputListener, {
      mouseMoved: function (event, x, y) { st.hoverX = x; return false; },
      exit: function (event, x, y, pointer, toElement) { st.hoverX = -1; }
    }));
    return elem;
  }

  function statRow(t, label, valueProv) {
    t.add(label).left().padRight(10).width(150);
    t.label(prov(valueProv)).left();
    t.row();
  }

  var root = new Table();

  var body = new Table();

  // left: numeric readouts
  var stats = new Table();
  stats.top().left();
  statRow(stats, "[#6bd68a]Production[]", function () { return "[#6bd68a]" + fmtPower(lastPow.prod) + "/s[]"; });
  statRow(stats, "[#e55454]Consumption[]", function () { return "[#e55454]" + fmtPower(lastPow.cons) + "/s[]"; });
  statRow(stats, "[lightgray]Balance[]", function () {
    var bal = lastPow.prod - lastPow.cons;
    var col = bal >= 0 ? "#6bd68a" : "#e55454";
    return "[" + col + "]" + (bal >= 0 ? "+" : "") + fmtPower(bal) + "/s[]";
  });
  statRow(stats, "[#ffd37f]Stored[]", function () {
    return "[#ffd37f]" + fmtPower(lastPow.stored) + (lastPow.cap > 0 ? " / " + fmtPower(lastPow.cap) : "") + "[]";
  });
  statRow(stats, "[lightgray]Satisfaction[]", function () { return "" + Math.round(lastPow.sat * 100) + "%"; });

  // charge bar
  stats.add("[lightgray]Charge[]").left().padTop(12).padRight(10);
  var barCell = stats.add(makeChargeBar(st)).width(180).height(16).padTop(12).left();
  stats.row();

  var leftCell = body.add(stats).width(360).growY().top();
  body.add().width(12);

  var right = new Table();
  right.add(makeGraphElement()).grow().pad(4);
  right.row();
  var axis = new Table();
  axis.label(prov(function () { return "[lightgray]-" + curW().name + "[]"; })).left();
  axis.label(prov(function () {
    if (st.hoverIdx >= 0) {
      var w = curW();
      var p = histAt(w, w.pow.prod, st.hoverIdx) / w.bucket;
      var c = histAt(w, w.pow.cons, st.hoverIdx) / w.bucket;
      var ago = (w.size - 1 - st.hoverIdx) * w.bucket;
      return (ago > 0 ? "-" + fmtTime(ago) : "now") + "  [#6bd68a]" + fmtPower(p) + "/s[]  [#e55454]" + fmtPower(c) + "/s[]";
    }
    return "[#6bd68a]production[]  [#e55454]consumption[]    [lightgray]scale max: " + fmtPower(st.graphMax) + "/s[]";
  })).expandX();
  axis.add("[lightgray]now[]").right();
  right.add(axis).growX().padTop(2);
  body.add(right).grow();

  root.add(body).grow();
  root.row();
  root.label(prov(function () {
    if (powDrawErr) return "[scarlet]draw error -> " + powDrawErr + "[]";
    return "[lightgray]Team power network. Production/consumption are per-second, summed over all power grids.[]";
  })).left().padTop(6);
  return root;
}

// battery charge bar element (fraction stored/capacity)
function makeChargeBar(st) {
  return extend(Element, {
    draw: function () {
      try {
        var x = this.getX(Align.bottomLeft), y = this.getY(Align.bottomLeft);
        var w = this.getWidth(), h = this.getHeight();
        Draw.color(0, 0, 0, 0.5);
        Fill.crect(x, y, w, h);
        var frac = lastPow.cap > 0 ? clamp(lastPow.stored / lastPow.cap, 0, 1) : 0;
        Draw.color(storedColor);
        Fill.crect(x, y, w * frac, h);
        Draw.color(1, 1, 1, 0.2);
        Lines.stroke(1);
        Lines.rect(x, y, w, h);
        Draw.reset();
      } catch (e) {
        powDrawErr = "bar: " + e;
        Draw.reset();
      }
    }
  });
}

// ============================================================================
// Panel with tabs
// ============================================================================

var dialog = null;

function buildDialog() {
  var d = new BaseDialog("Production Graph");

  // shared top: tab bar + window selector
  var top = new Table();

  var tabs = new Table();
  var bodies = {};      // name -> built body Table (lazy)
  var current = "Items";
  var holder = new Table();

  function showTab(name) {
    current = name;
    if (bodies[name] == null) {
      try {
        bodies[name] = builders[name]();
      } catch (e) {
        var err = new Table();
        var lbl = new Label("[scarlet]" + name + " build error ->\n" + e + "[]");
        lbl.setWrap(true);
        err.add(lbl).pad(20).width(600).left();
        bodies[name] = err;
      }
    }
    holder.clearChildren();
    holder.add(bodies[name]).grow();
  }

  var builders = {
    "Items": function () {
      return makeResourceView({
        seq: function () { return Vars.content.items(); },
        channel: function (w) { return w.core; },
        note: function () {
          return "[lightgray]Net core-stock change (items entering/leaving the core), avg/s over " + curW().name + ".[]";
        }
      });
    },
    "Electricity": function () { return makePowerView(); }
  };

  var tabNames = ["Items", "Electricity"];
  for (var t = 0; t < tabNames.length; t++) {
    (function (name) {
      var b = tabs.button(name, Styles.togglet, run(function () { showTab(name); })).minWidth(120).height(44).padRight(6).get();
      b.update(run(function () { b.setChecked(current == name); }));
    })(tabNames[t]);
  }
  top.add(tabs).left();
  top.row();

  var winRow = new Table();
  for (var wi = 0; wi < WINDOWS.length; wi++) {
    (function (wi) {
      var b = winRow.button(WINDOWS[wi].name, Styles.togglet, run(function () { curWindow = wi; markAllDirty(); }))
        .minWidth(64).height(40).padRight(6).get();
      b.update(run(function () { b.setChecked(curWindow == wi); }));
    })(wi);
  }
  top.add(winRow).left().padTop(6);

  d.cont.add(top).left().padBottom(6);
  d.cont.row();
  d.cont.add(holder).grow();

  showTab("Items");
  d.addCloseButton();
  return d;
}

Events.run(Trigger.update, run(function () {
  if (Core.input.keyTap(KeyCode.f8)) {
    if (dialog == null) dialog = buildDialog();
    if (dialog.parent != null) dialog.hide();
    else dialog.show();
  }
}));
