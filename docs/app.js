/* Together, or just nearby? — inspector and charts. Plain JS, MapLibre for the map. */
(() => {
  const PAD = 120;                       // minutes shown before and after an encounter
  const MAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
  const HEAD = {
    meetup: "Looks like a meetup", routine: "Routine, not a meetup", coincidence: "Probably a coincidence",
    mixed: "Can't tell", visit: "Looks like a visit", duplicate: "Ids share copied data", unknown: "Not enough history",
  };
  const PILL = { meetup: "Meetup", routine: "Routine", coincidence: "Coincidence", mixed: "Unclear",
                 visit: "Visit", duplicate: "Copied data", unknown: "Unknown" };
  const FILTERS = [
    { key: "meetup", label: "Meetups", test: e => e.kind === "real" && (e.label === "meetup" || e.label === "visit") },
    { key: "routine", label: "Routine", test: e => e.kind === "real" && e.label === "routine" },
    { key: "coincidence", label: "Coincidence", test: e => e.kind === "real" && e.label === "coincidence" },
    { key: "mixed", label: "Unclear", test: e => e.kind === "real" && e.label === "mixed" },
    { key: "duplicate", label: "Copied data", test: e => e.kind === "real" && e.label === "duplicate" },
    { key: "fake", label: "Fake pairs", test: e => e.kind !== "real" },
  ];
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const id3 = n => "#" + String(n).padStart(3, "0");
  const fmt = n => n.toLocaleString("en-GB");
  const dur = m => m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, "0")} min` : `${Math.round(m)} min`;
  const svgNS = "http://www.w3.org/2000/svg";
  const sv = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

  const S = { summary: null, filter: "meetup", cache: new Map(), rec: null, t: 0, playing: false, raf: 0, map: null, ready: false };

  // ---------- time ----------
  function localBase(start) {                    // "2009-04-03 20:50" as a wall-clock Date (UTC fields)
    const [d, t] = start.split(" ");
    const [y, mo, da] = d.split("-").map(Number);
    const [h, mi] = t.split(":").map(Number);
    return Date.UTC(y, mo - 1, da, h, mi);
  }
  function clockText(rec, off) {
    const d = new Date(localBase(rec.start) + off * 60000);
    const wd = DOW[(d.getUTCDay() + 6) % 7];
    return `${wd} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  const listDate = e => clockText(e, 0).replace(/ · /, " · ");

  // ---------- geometry ----------
  function circle(lon, lat, r, n = 48) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI;
      out.push([lon + (r * Math.cos(a)) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (r * Math.sin(a)) / 110540]);
    }
    return out;
  }
  function splitLines(pts, until) {              // break a track wherever the phone was silent > 15 min
    const lines = []; let cur = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (until != null && p[2] > until) break;
      if (cur.length && p[2] - pts[i - 1][2] > 15) { if (cur.length > 1) lines.push(cur); cur = []; }
      cur.push([p[0], p[1]]);
    }
    if (cur.length > 1) lines.push(cur);
    return { type: "Feature", geometry: { type: "MultiLineString", coordinates: lines }, properties: {} };
  }
  function lastAt(pts, t) {
    let lo = 0, hi = pts.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m][2] <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }

  // ---------- hero ----------
  function renderStats(s) {
    const box = $("stats");
    const f = s.flagged, q = s.quality, m = s.modes.model, base = s.modes.baseline_median_speed;
    const cards = [
      ["meetup", `${f.real.pct}%`, `of real encounters look like meetups (${fmt(f.real.judged)} judged)`],
      ["fake", `${f.fake_test.pct}%`, `of encounters between fake pairs do. Held-back test, 95% range ${f.fake_test.ci95[0]}–${f.fake_test.ci95[1]}%`],
      ["dup", `${(s.dataset.copies_removed / 1e6).toFixed(2)} M`, `GPS fixes were copies of another id's data. Removing them cut real encounters from ${fmt(q.first_run.encounters)} to ${fmt(s.dataset.encounters)}`],
      ["", `${Math.round(m.accuracy * 100)}%`, `transport-mode accuracy on data sources it never saw (speed rule: ${Math.round(base.accuracy * 100)}%)`],
    ];
    for (const [cls, big, small] of cards) {
      const c = el("div", "stat " + cls); c.append(el("b", null, big), el("span", null, small)); box.append(c);
    }
  }

  // ---------- list ----------
  function renderFilters() {
    const box = $("filters"); box.textContent = "";
    for (const f of FILTERS) {
      const n = S.summary.showcase.filter(f.test).length;
      if (!n) continue;
      const b = el("button", "chip"); b.type = "button"; b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(S.filter === f.key));
      b.append(el("span", null, f.label), el("span", "n", String(n)));
      b.addEventListener("click", () => { S.filter = f.key; renderFilters(); renderList(true); });
      box.append(b);
    }
  }
  function renderList(selectFirst) {
    const f = FILTERS.find(x => x.key === S.filter);
    const items = S.summary.showcase.filter(f.test).sort((a, b) => b.minutes - a.minutes);
    const ol = $("items"); ol.textContent = "";
    for (const e of items) {
      const li = el("li", "item"); li.tabIndex = 0; li.dataset.id = e.id;
      const r1 = el("div", "row1");
      r1.append(el("span", "who", `${id3(e.a)} & ${id3(e.b)}`));
      const pills = el("span");
      if (e.kind !== "real") pills.append(el("span", "pill fake", "fake"), document.createTextNode(" "));
      pills.append(el("span", "pill " + e.label, PILL[e.label]));
      r1.append(pills);
      li.append(r1, el("span", "meta", `${listDate(e)} · ${dur(e.minutes)}`));
      li.addEventListener("click", () => select(e.id));
      li.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(e.id); } });
      ol.append(li);
    }
    if (selectFirst && items.length) select(items[0].id);
    markCurrent();
  }
  function markCurrent() {
    for (const li of $("items").children) {
      const on = !!S.rec && +li.dataset.id === S.rec.id;
      li.setAttribute("aria-current", String(on));
      if (on) {                                  // scroll the list only, never the page
        const ol = $("items"), r = li.getBoundingClientRect(), o = ol.getBoundingClientRect();
        if (r.top < o.top || r.bottom > o.bottom) ol.scrollTop += r.top - o.top - 8;
      }
    }
  }

  // ---------- map ----------
  function initMap() {
    S.map = new maplibregl.Map({ container: "map", style: MAP_STYLE, center: [116.32, 39.99], zoom: 12,
                                 attributionControl: { compact: true } });
    S.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    S.map.on("load", () => {
      const empty = { type: "FeatureCollection", features: [] };
      for (const src of ["spot", "stays", "fullA", "fullB", "trailA", "trailB", "pos"]) S.map.addSource(src, { type: "geojson", data: empty });
      const A = css("--a"), B = css("--b"), M = css("--meetup");
      const who = ["match", ["get", "who"], "a", A, "b", B, "#888"];
      S.map.addLayer({ id: "spot-fill", type: "fill", source: "spot", paint: { "fill-color": M, "fill-opacity": 0.08 } });
      S.map.addLayer({ id: "spot-line", type: "line", source: "spot", paint: { "line-color": M, "line-width": 2, "line-dasharray": [2, 1.5] } });
      S.map.addLayer({ id: "stays-fill", type: "fill", source: "stays", paint: { "fill-color": who, "fill-opacity": 0.1 } });
      S.map.addLayer({ id: "stays-line", type: "line", source: "stays", paint: { "line-color": who, "line-width": 1, "line-opacity": 0.55 } });
      S.map.addLayer({ id: "fullA", type: "line", source: "fullA", paint: { "line-color": A, "line-width": 2, "line-opacity": 0.22 } });
      S.map.addLayer({ id: "fullB", type: "line", source: "fullB", paint: { "line-color": B, "line-width": 2, "line-opacity": 0.22 } });
      S.map.addLayer({ id: "trailA", type: "line", source: "trailA", layout: { "line-cap": "round", "line-join": "round" },
                       paint: { "line-color": A, "line-width": 3.5, "line-opacity": 0.9 } });
      S.map.addLayer({ id: "trailB", type: "line", source: "trailB", layout: { "line-cap": "round", "line-join": "round" },
                       paint: { "line-color": B, "line-width": 3.5, "line-opacity": 0.9 } });
      S.map.addLayer({ id: "pos", type: "circle", source: "pos", paint: {
        "circle-radius": 7, "circle-color": who, "circle-stroke-color": "#fff", "circle-stroke-width": 2,
        "circle-opacity": ["case", ["get", "stale"], 0.45, 1], "circle-stroke-opacity": ["case", ["get", "stale"], 0.45, 1] } });
      S.ready = true;
      if (S.rec) drawMap(S.rec, true);
    });
  }
  function drawMap(rec, fit) {
    if (!S.ready) return;
    const spot = rec.private
      ? { type: "Feature", geometry: { type: "Polygon", coordinates: [rec.hex.concat([rec.hex[0]])] }, properties: {} }
      : { type: "Feature", geometry: { type: "Polygon", coordinates: [circle(rec.lon, rec.lat, 150)] }, properties: {} };
    S.map.getSource("spot").setData(spot);
    S.map.getSource("stays").setData({ type: "FeatureCollection", features: rec.stays.filter(s => !s.private).map(s => ({
      type: "Feature", properties: { who: s.who }, geometry: { type: "Polygon", coordinates: [circle(s.lon, s.lat, Math.max(s.r, 40))] } })) });
    S.map.getSource("fullA").setData(splitLines(rec.tracks.a));
    S.map.getSource("fullB").setData(splitLines(rec.tracks.b));
    if (fit) {
      // Frame the encounter: the spot plus fixes from 30 min either side that stay within 2.5 km of it.
      const [cx, cy] = rec.center, b = new maplibregl.LngLatBounds();
      const near = p => Math.hypot((p[0] - cx) * 111320 * Math.cos((cy * Math.PI) / 180), (p[1] - cy) * 110540) < 2500;
      for (const p of rec.tracks.a.concat(rec.tracks.b)) if (p[2] >= -30 && p[2] <= rec.minutes + 30 && near(p)) b.extend([p[0], p[1]]);
      for (const c of spot.geometry.coordinates[0]) b.extend(c);
      S.map.fitBounds(b, { padding: { top: 60, bottom: 30, left: 30, right: 30 }, maxZoom: 16, duration: 700 });
    }
    update();
  }

  // ---------- time bar ----------
  function setTime(t) {
    S.t = Math.max(-PAD, Math.min(S.rec.minutes + PAD, t));
    $("scrub").value = S.t;
    update();
  }
  function update() {
    const rec = S.rec; if (!rec) return;
    $("clock").textContent = clockText(rec, S.t);
    if (S.ready) {
      S.map.getSource("trailA").setData(splitLines(rec.tracks.a, S.t));
      S.map.getSource("trailB").setData(splitLines(rec.tracks.b, S.t));
      const feats = [];
      for (const [who, pts] of [["a", rec.tracks.a], ["b", rec.tracks.b]]) {
        const i = lastAt(pts, S.t);
        if (i >= 0) feats.push({ type: "Feature", properties: { who, stale: S.t - pts[i][2] > 10 },
                                 geometry: { type: "Point", coordinates: [pts[i][0], pts[i][1]] } });
      }
      S.map.getSource("pos").setData({ type: "FeatureCollection", features: feats });
    }
    const cur = $("lanes").querySelector(".cursor");
    if (cur) { const x = xOf(S.t); cur.setAttribute("x1", x); cur.setAttribute("x2", x); }
  }
  const xOf = t => ((t + PAD) / (S.rec.minutes + 2 * PAD)) * 600;
  function drawLanes(rec) {
    const svg = $("lanes"); svg.textContent = "";
    const lab = rec.kind !== "real" && (rec.label === "meetup" || rec.label === "visit") ? "--bad" : "--" + rec.label;
    svg.append(sv("rect", { x: xOf(0), y: 0, width: xOf(rec.minutes) - xOf(0), height: 64, fill: css(lab) || css("--meetup"), opacity: 0.13 }));
    const rows = { a: 6, b: 36 };
    for (const who of ["a", "b"]) svg.append(sv("line", { x1: 0, x2: 600, y1: rows[who] + 11, y2: rows[who] + 11, stroke: css("--line"), "stroke-width": 1 }));
    for (const t of rec.trips) {
      const r = sv("rect", { x: xOf(t.from), y: rows[t.who] + 8, width: Math.max(1, xOf(t.to) - xOf(t.from)), height: 6, rx: 2,
                             fill: css(t.who === "a" ? "--a" : "--b"), opacity: 0.35 });
      r.append(sv("title", {})); r.firstChild.textContent = `${t.who.toUpperCase()}: ${t.mode}, ${t.km} km`; svg.append(r);
    }
    for (const s of rec.stays) {
      const r = sv("rect", { x: xOf(s.from), y: rows[s.who] + 3, width: Math.max(1, xOf(s.to) - xOf(s.from)), height: 16, rx: 3,
                             fill: css(s.who === "a" ? "--a" : "--b"), opacity: s.private ? 0.35 : 0.85 });
      r.append(sv("title", {})); r.firstChild.textContent = `${s.who.toUpperCase()} stopped ${dur(s.to - s.from)}${s.private ? " (near a home, hidden)" : ""}`; svg.append(r);
    }
    svg.append(sv("line", { class: "cursor", x1: 0, x2: 0, y1: 0, y2: 64, stroke: css("--ink"), "stroke-width": 1.5 }));
  }
  function play() {
    S.playing = !S.playing;
    $("play").textContent = S.playing ? "❚❚" : "▶";
    $("play").setAttribute("aria-label", S.playing ? "Pause" : "Play");
    if (!S.playing) { cancelAnimationFrame(S.raf); return; }
    if (S.t >= S.rec.minutes + PAD - 1) S.t = -PAD;
    const span = S.rec.minutes + 2 * PAD, perSec = span / 22;       // whole window in about 22 seconds
    $("speedlabel").textContent = `${Math.round(perSec)} min per second`;
    let last = performance.now();
    const step = now => {
      if (!S.playing) return;
      setTime(S.t + ((now - last) / 1000) * perSec); last = now;
      if (S.t >= S.rec.minutes + PAD) { play(); return; }
      S.raf = requestAnimationFrame(step);
    };
    S.raf = requestAnimationFrame(step);
  }

  // ---------- evidence ----------
  function strip(rec, who) {
    const row = el("div", "strip");
    row.append(el("span", "tag", who.toUpperCase()));
    const s = sv("svg", { viewBox: "0 0 300 16", preserveAspectRatio: "none" });
    const x = d => ((d + 42) / 84) * 296 + 2;
    s.append(sv("line", { x1: x(0), x2: x(0), y1: 0, y2: 16, stroke: css("--meetup"), "stroke-width": 2 }));
    for (const [d, obs, pres] of rec.evidence[who]) {
      if (pres) s.append(sv("circle", { cx: x(d), cy: 8, r: 4, fill: css(who === "a" ? "--a" : "--b") }));
      else if (obs) s.append(sv("circle", { cx: x(d), cy: 8, r: 3, fill: css("--faint"), opacity: 0.55 }));
      else s.append(sv("circle", { cx: x(d), cy: 8, r: 2.4, fill: "none", stroke: css("--line"), "stroke-width": 1 }));
    }
    row.append(s);
    return row;
  }
  function rateLine(n, days, name) {
    const [here, seen] = days;
    if (seen === 0) return `${name}'s phone wasn't recording at this time on any comparable day.`;
    return `${name} was here on ${here} of ${seen} comparable days the phone was recording.`;
  }
  function renderEvidence(rec) {
    const box = $("evidence"); box.textContent = "";
    const P = S.summary.params;
    const A = id3(rec.a), B = id3(rec.b);
    const fake = rec.kind !== "real";
    const flagged = rec.label === "meetup" || rec.label === "visit";

    const v = el("div", "verdict");
    const pills = el("div");
    if (fake) pills.append(el("span", "pill fake", `fake pair, B shifted ${rec.shift_days} days`), document.createTextNode(" "));
    pills.append(el("span", "pill " + rec.label, PILL[rec.label]));
    v.append(pills);
    v.append(el("div", "headline", fake ? (flagged ? "False alarm" : "Correctly not a meetup") : HEAD[rec.label]));
    v.append(el("div", "sub", `${A} (A) and ${B} (B) · ${clockText(rec, 0)}–${rec.end} · ${dur(rec.minutes)} within ${P.together_radius_m} m`));
    box.append(v);

    if (rec.label === "duplicate") {
      box.append(el("p", "note dup", rec.shared_fixes > 0
        ? `These two ids share ${fmt(rec.shared_fixes)} identical GPS fixes within two hours of this encounter: same second, same coordinates to six decimal places. Two receivers never agree that exactly, so this is copied data. Excluded from every result on this page.`
        : `These two ids share copied GPS data elsewhere in the dataset, so they may be one person or one device. Rather than risk counting someone meeting themselves, encounters between linked ids are excluded from every result on this page.`));
    }
    if (fake) {
      box.append(el("p", "note fake", `Not a real pair: B's whole history is shifted by ${rec.shift_days} days (whole weeks, so weekly routines still line up). Any encounter here is coincidence by construction.${flagged ? " The detector still called this one, which is what the false-alarm rate counts." : ""}`));
    }
    if (rec.private) {
      box.append(el("p", "note", "This spot is within 300 m of someone's home, so it is shown as a hexagon of about 0.7 km² and GPS points near it are hidden."));
    }

    const q1 = el("div", "q"); q1.append(el("h4", null, "Are they usually here at this time?"));
    q1.append(strip(rec, "a"), strip(rec, "b"));
    const ticks = el("div", "ticks"); ["−6 wk", "this day", "+6 wk"].forEach(t => ticks.append(el("span", null, t))); q1.append(ticks);
    q1.append(el("p", "ans", `${rateLine(rec.a, rec.a_days, "A")} ${rateLine(rec.b, rec.b_days, "B")}`));
    q1.append(el("p", "sub note", "Comparable days: same kind (weekday or weekend) within six weeks. Filled dot: here at this time. Grey: recording, but elsewhere. Hollow: phone off."));
    box.append(q1);

    const q2 = el("div", "q"); q2.append(el("h4", null, "Did they arrive and leave together?"));
    const ans2 = el("p", "ans");
    const g = P.together_gap_minutes;
    const bit = (word, m) => { const s = el("span", m <= g ? "yes" : "no", `${m <= g ? "✓" : "✗"} ${word} ${dur(m)} apart`); return s; };
    ans2.append(bit("Arrived", rec.arrive_gap), document.createTextNode("   "), bit("Left", rec.leave_gap));
    q2.append(ans2);
    box.append(q2);

    const q3 = el("div", "q"); q3.append(el("h4", null, "Is the spot usually busy at this hour?"));
    q3.append(el("p", "ans", rec.crowd_typical === 0
      ? `Usually empty at this hour: nobody else in the dataset was here at this time on comparable days. ${rec.others_here} other people ever stop here.`
      : `${rec.crowd_typical} other ${rec.crowd_typical === 1 ? "person is" : "people are"} seen here at this hour on comparable days; ${rec.others_here} ever stop here.`));
    box.append(q3);

    if (rec.trips.length) {
      const q4 = el("div", "q"); q4.append(el("h4", null, "Trips around it (predicted mode)"));
      const t = el("div", "trips");
      for (const tr of rec.trips.slice(0, 12)) t.append(el("span", "trip", `${tr.who.toUpperCase()} · ${tr.mode} · ${tr.km} km`));
      q4.append(t); box.append(q4);
    }
  }

  // ---------- select ----------
  async function select(id) {
    if (S.playing) play();
    let rec = S.cache.get(id);
    if (!rec) { rec = await fetch(`data/enc/${id}.json`).then(r => r.json()); S.cache.set(id, rec); }
    S.rec = rec;
    const sc = $("scrub"); sc.min = -PAD; sc.max = rec.minutes + PAD; sc.value = 0; S.t = 0;
    $("speedlabel").textContent = "";
    markCurrent(); renderEvidence(rec); drawLanes(rec); drawMap(rec, true);
    const lg = $("legend"); lg.textContent = "";
    for (const [who, name] of [["--a", `A ${id3(rec.a)}`], ["--b", `B ${id3(rec.b)}`]]) {
      const s = el("span"); const sw = el("i", "sw"); sw.style.background = css(who); s.append(sw, document.createTextNode(name)); lg.append(s);
    }
    const sp = el("span"); const sw = el("i", "sw"); sw.style.background = "transparent"; sw.style.border = `2px dashed ${css("--meetup")}`;
    sp.append(sw, document.createTextNode(rec.private ? "Encounter (generalised)" : "Encounter spot, 150 m")); lg.append(sp);
  }

  // ---------- charts ----------
  function renderCalib(s) {
    const box = $("calib"); const wrap = el("div", "bars");
    const order = [["meetup", "--meetup", "Meetup or visit"], ["coincidence", "--coincidence", "Coincidence"],
                   ["routine", "--routine", "Routine"], ["mixed", "--mixed", "Unclear"]];
    const rows = [["real", "Real pairs"], ["fake", "Fake, 5-week shift (design)"], ["fake_test", "Fake, 9-week shift (held back)"]];
    for (const [kind, name] of rows) {
      const c = s.calibration[kind] || {};
      const r = el("div", "barrow"); r.append(el("span", "lab", name));
      const tr = el("div", "track");
      for (const [lab, color] of order) {
        let pct = (c[lab]?.pct || 0) + (lab === "meetup" ? (c.visit?.pct || 0) : 0);
        const i = el("i"); i.style.width = pct + "%"; i.style.background = css(color); i.title = `${lab}: ${pct.toFixed(1)}%`; tr.append(i);
      }
      r.append(tr);
      const f = s.flagged[kind];
      r.append(el("span", "val", `${f.pct}% (${f.ci95[0]}–${f.ci95[1]})`));
      wrap.append(r);
    }
    const keys = el("div", "keys");
    for (const [, color, name] of order) { const k = el("span"); const sw = el("i", "sw"); sw.style.background = css(color); k.append(sw, document.createTextNode(name)); keys.append(k); }
    box.append(wrap, keys,
      el("p", "sub", `Right column: share called a meetup or visit, with its 95% range. Real pairs: ${fmt(s.flagged.real.judged)} judged encounters (after removing duplicates and those with too little history); fake pairs: ${s.flagged.fake.judged} and ${s.flagged.fake_test.judged}.`));
  }
  function renderSignals(s) {
    const box = $("signals"); const t = el("table", "t");
    const head = el("tr"); ["", "Real pairs", "Fake pairs"].forEach((h, i) => head.append(el("th", i ? "num" : "", h))); t.append(head);
    const r = s.signals.real, f = s.signals.fake, P = s.params;
    for (const [name, key] of [[`Arrived within ${P.together_gap_minutes} min of each other`, "arrived_together"],
                               [`Left within ${P.together_gap_minutes} min of each other`, "left_together"],
                               ["Spot usually empty at that hour", "usually_empty"]]) {
      const tr = el("tr"); tr.append(el("td", "", name), el("td", "num", r[key] + "%"), el("td", "num", f[key] + "%")); t.append(tr);
    }
    box.append(t, el("p", "sub", `Based on ${fmt(r.n)} real and ${f.n} fake encounters where both people were somewhere they rarely are at that time. Leaving together is the clearest difference: strangers on independent schedules rarely leave within minutes of each other. A home visit breaks that pattern (the host stays), so visits are judged by how private the spot is.`));
  }
  function heat(grid, color, title) {
    const cell = 13, w = 24 * cell + 34, h = 7 * cell + 20;
    const s = sv("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": title });
    const max = Math.max(1, ...grid.flat());
    grid.forEach((row, d) => {
      s.append(Object.assign(sv("text", { x: 0, y: d * cell + 10, "font-size": 9, fill: css("--muted"), "font-family": "JetBrains Mono, monospace" }), { textContent: DOW[d] }));
      row.forEach((n, hr) => {
        s.append(sv("rect", { x: 30 + hr * cell, y: d * cell, width: cell - 1.5, height: cell - 1.5, rx: 2,
                              fill: n ? color : css("--soft"), "fill-opacity": n ? 0.15 + 0.85 * (n / max) : 1 }));
      });
    });
    for (const hr of [0, 6, 12, 18]) s.append(Object.assign(sv("text", { x: 30 + hr * cell, y: h - 2, "font-size": 9, fill: css("--muted"), "font-family": "JetBrains Mono, monospace" }), { textContent: String(hr).padStart(2, "0") }));
    return s;
  }
  function renderHeats(s) {
    const box = $("heats");
    for (const [lab, color, name] of [["routine", "--routine", "Routine"], ["meetup", "--meetup", "Meetups"], ["coincidence", "--coincidence", "Coincidences"]]) {
      const t = s.timing[lab]; if (!t) continue;
      const d = el("div", "heat");
      d.append(el("h4", null, `${name}: ${t.weekday_9_17}% weekday 09–17, ${t.weekend}% weekend, median ${dur(t.median_min)}`));
      d.append(heat(s.when[lab], css(color), name));
      box.append(d);
    }
  }
  function renderModes(s) {
    const m = s.modes, box = $("modes");
    $("modes-cap").textContent = `${fmt(m.segments)} labelled trips from ${m.users} people (${m.sources} independent data sources). Gradient boosting on speed, stopping, acceleration and turning; 5-fold cross-validation with each data source wholly in training or wholly in test.`;
    const top = el("p", "ans");
    top.innerHTML = "";
    top.append(el("b", null, `${(m.model.accuracy * 100).toFixed(1)}%`), document.createTextNode(` accuracy, macro F1 ${m.model.macro_f1.toFixed(2)}. A median-speed rule gets ${(m.baseline_median_speed.accuracy * 100).toFixed(1)}% and ${m.baseline_median_speed.macro_f1.toFixed(2)}.`));
    const wrap = el("div", "bars");
    for (const [mode, f1] of Object.entries(m.model.f1_by_mode)) {
      const r = el("div", "barrow"); r.append(el("span", "lab", mode));
      const tr = el("div", "track"); const i = el("i"); i.style.width = f1 * 100 + "%"; i.style.background = css("--a"); tr.append(i);
      r.append(tr, el("span", "val", `F1 ${f1.toFixed(2)} · n ${fmt(m.class_counts[mode])}`)); wrap.append(r);
    }
    box.append(top, wrap, el("p", "sub", `Split by person instead of by data source, the same model scores ${(s.quality.mode_accuracy_grouped_by_user * 100).toFixed(1)}%: copies of one device's trips sat on both sides of the split. Car against bus is the hard pair, as in the published work on this dataset.`));
  }
  function renderQuality(s) {
    const q = s.quality, d = s.dataset;
    const biggest = q.groups.reduce((a, g) => g.length > a.length ? g : a, []);
    $("quality-cap").textContent = `The first version called ${q.first_run.flagged_pct}% of real encounters meetups, and its best examples were too perfect: arrivals and departures to the minute, identical trips. ${(d.copies_removed / 1e6).toFixed(2)} million GPS fixes turned out to be copies: the same second and the same six-decimal coordinates under another id, which two receivers never produce. ${q.groups.length} groups of ids share copied data (the largest has ${biggest.length}). Each copied fix is now kept once, under the id that recorded most; that cut real encounters from ${fmt(q.first_run.encounters)} to ${fmt(d.encounters)}, and ${fmt(d.duplicate)} encounters between linked ids are excluded. The same leak inflated the transport-mode score, below.`;
    const t = el("table", "t");
    const head = el("tr"); [["Ids", ""], ["Identical fixes", "num"], ["Share of smaller id", "num"]].forEach(([h, c]) => head.append(el("th", c, h))); t.append(head);
    for (const p of q.worst_pairs) {
      const tr = el("tr"); tr.append(el("td", "", `${id3(p.a)} & ${id3(p.b)}`), el("td", "num", fmt(p.shared)), el("td", "num", `${p.pct}%`)); t.append(tr);
    }
    $("quality").append(t);
  }
  function renderHow(s) {
    const d = s.dataset, P = s.params;
    const steps = [
      ["Ingest", `DuckDB reads every raw <code>.plt</code> file straight into Parquet: ${fmt(d.points)} clean fixes from ${d.users} people.`],
      ["Clean", `dbt staging models: drop impossible coordinates and GPS spikes (faster than 250 km/h both in and out), then keep each fix copied across ids once. ${(d.copies_removed / 1e6).toFixed(2)} M copies removed.`],
      ["Stays", `dbt Python model with numba: points within ${P.stay_radius_m} m for ${P.stay_min_minutes}+ min, bridging GPS gaps indoors. ${fmt(d.stays)} stays.`],
      ["Places", `DBSCAN (100 m) over each person's stays: ${fmt(d.places)} places. Home is where the night is spent; used only to hide it.`],
      ["Encounters", `Stays within ${P.together_radius_m} m overlapping ${P.together_min_minutes}+ min, found with a DuckDB range join. Fake pairs are the same join with one side shifted by whole weeks.`],
      ["Routine test", `For each person, every comparable day within ${P.routine_window_days} days when the phone was recording: here at this time or not? Busyness via H3 cells; arrive and leave gaps from the stays.`],
      ["Modes", "Gradient boosting on 15 per-trip features, cross-validated by data source, then applied to every trip between stays."],
      ["Publish", `Privacy filter, then static JSON for this page. The dbt project has 16 models and 8 data tests.`],
    ];
    const ol = $("steps");
    for (const [b, text] of steps) { const li = el("li"); li.append(el("b", null, b)); const sp = el("span"); sp.innerHTML = text; li.append(sp); ol.append(li); }
    const unknown = s.calibration.real.unknown?.n || 0;
    const limits = [
      "GeoLife is mostly researchers and students around one Beijing district, 2007–2012. Phones sample differently today, far more often and in the background.",
      `Recording is patchy: ${fmt(unknown)} real encounters have fewer than three comparable recorded days for one of the two people, and stay unlabelled.`,
      `A stay needs ${P.stay_min_minutes} minutes in one place, so a quick coffee together is invisible, and so is walking together.`,
      "There is no ground truth for meetups. The evidence is the false-alarm rate on fake pairs and the time-of-week pattern, not a labelled test set.",
      "Thresholds (usually here 50%, rarely here 25%, 10-minute gaps, 150 m) were chosen by reasoning and checked on the design set; the held-back set was scored once.",
    ];
    const pr = [
      `Homes are inferred only to hide them: every fix within ${P.home_blur_m} m of any detected home is removed before anything is published.`,
      "Encounters near a home appear only as an H3 hexagon of about 0.7 km².",
      "Ids are GeoLife's own anonymous numbers.",
      "In a product the routine test needs only per-day presence at a place, not raw tracks, so it could run on aggregates or on the device.",
    ];
    for (const t of limits) $("limits").append(el("li", null, t));
    for (const t of pr) $("privacy").append(el("li", null, t));
  }

  // ---------- boot ----------
  async function boot() {
    S.summary = await fetch("data/summary.json").then(r => r.json());
    renderStats(S.summary);
    initMap();
    renderFilters();
    renderList(false);
    // Open on the clearest case: two people who arrive separately and leave together.
    const meetups = S.summary.showcase.filter(e => e.kind === "real" && e.label === "meetup" && !e.private);
    const first = meetups.filter(e => e.arrive_gap >= 3 && e.arrive_gap <= 45 && e.leave_gap <= 5 && e.minutes >= 30 && e.minutes <= 180)
                         .sort((a, b) => a.leave_gap - b.leave_gap || b.minutes - a.minutes)[0]
      || meetups[0] || S.summary.showcase[0];
    await select(first.id);
    $("scrub").addEventListener("input", e => setTime(+e.target.value));
    $("play").addEventListener("click", play);
    renderCalib(S.summary); renderSignals(S.summary); renderHeats(S.summary);
    renderModes(S.summary); renderQuality(S.summary); renderHow(S.summary);
  }
  boot().catch(err => { $("evidence").append(el("p", "note", "Couldn't load the data for this page. " + err.message)); });
})();
