// Interactive AI-safety field map — animated multi-line chart.
//
// Reads the JSON inlined by scripts/build.mjs (#field-map-data) and plots every
// research branch as a line: time on the x-axis, the chosen metric (FTEs or
// papers/year) on the y-axis. A play/slider sweeps time so each line grows to
// the right, a dot rides the leading edge, and a label tracks it — the way Our
// World in Data animates a line chart.
//
// Vanilla, zero-dependency, theme-aware (colors come from CSS custom props).
(function () {
  "use strict";

  var root = document.querySelector("[data-field-map]");
  var dataEl = document.getElementById("field-map-data");
  if (!root || !dataEl) return;

  var DATA;
  try {
    DATA = JSON.parse(dataEl.textContent);
  } catch (e) {
    return; // leave the no-JS fallback table in place
  }

  var SVG_NS = "http://www.w3.org/2000/svg";
  var prefersReduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── Data helpers ──────────────────────────────────────────────────────────

  // Linear interpolation of a metric series at an arbitrary (possibly
  // fractional) year. Clamps at the ends; returns 0 when the branch has no data.
  function valueAt(bucket, metric, year) {
    var series = bucket[metric];
    if (!series || !series.length) return 0;
    if (year <= series[0].year) return series[0].value;
    var last = series[series.length - 1];
    if (year >= last.year) return last.value;
    for (var i = 0; i < series.length - 1; i++) {
      var a = series[i],
        b = series[i + 1];
      if (year >= a.year && year <= b.year) {
        var t = (year - a.year) / (b.year - a.year);
        return a.value + t * (b.value - a.value);
      }
    }
    return last.value;
  }

  // Estimated if either snapshot bracketing this year is flagged — so the
  // marker reflects the year you're viewing, not the whole series.
  function isEstimated(bucket, metric, year) {
    var series = bucket[metric];
    if (!series || !series.length) return false;
    if (year <= series[0].year) return !!series[0].estimated;
    var last = series[series.length - 1];
    if (year >= last.year) return !!last.estimated;
    for (var i = 0; i < series.length - 1; i++) {
      if (year >= series[i].year && year <= series[i + 1].year) {
        return !!(series[i].estimated || series[i + 1].estimated);
      }
    }
    return !!last.estimated;
  }

  // Source lookup by id, for per-point provenance in the tooltip.
  var SRC_BY_ID = {};
  (DATA.meta.sources || []).forEach(function (s) {
    SRC_BY_ID[s.id] = s;
  });

  // Short badges for the per-source links (mirrors scripts/build.mjs).
  var SRC_ABBR = {
    mcaleese: "M",
    estimating: "E",
    "eightyk-tech": "8t",
    "eightyk-count": "8c",
    "larsen-lifland": "L",
    aiwatch: "W",
    eto: "ETO",
  };
  function srcAbbr(id) {
    return SRC_ABBR[id] || id;
  }

  // The snapshot whose provenance (basis + sources) applies at a given year —
  // the point on or just before it. Used to cite the value the tooltip shows.
  function pointAt(bucket, metric, year) {
    var series = bucket[metric];
    if (!series || !series.length) return null;
    var yr = Math.round(year);
    var best = null;
    for (var i = 0; i < series.length; i++) {
      if (series[i].year === yr) return series[i];
      if (series[i].year <= yr) best = series[i];
    }
    return best || series[0];
  }

  // Metric keys actually present in the data, preserving meta order.
  var METRICS = Object.keys(DATA.meta.metrics).filter(function (k) {
    return DATA.buckets.some(function (b) {
      return b[k] && b[k].length;
    });
  });
  if (!METRICS.length) return;
  var metric =
    METRICS.indexOf(DATA.meta.defaultMetric) >= 0 ? DATA.meta.defaultMetric : METRICS[0];

  function yearRange(m) {
    var min = Infinity,
      max = -Infinity;
    DATA.buckets.forEach(function (b) {
      (b[m] || []).forEach(function (p) {
        if (p.year < min) min = p.year;
        if (p.year > max) max = p.year;
      });
    });
    return { min: min, max: max };
  }

  // Largest value across ALL years for the active metric — fixes the y-axis so
  // growth reads as growth (the scale doesn't rescale under you).
  function maxValueFor(m) {
    var mv = 0;
    var r = yearRange(m);
    DATA.buckets.forEach(function (b) {
      for (var y = r.min; y <= r.max; y++) {
        var v = valueAt(b, m, y);
        if (v > mv) mv = v;
      }
    });
    return mv || 1;
  }

  // Round a raw maximum up to a clean axis ceiling (…, 40, 50, 100, 200, …).
  function niceCeil(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var r = v / mag;
    var nice = r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10;
    return nice * mag;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  var range = yearRange(metric);
  var year = range.max; // integer target driven by the slider
  var displayYear = range.max; // eased/animated position (the leading edge)
  var lastNoteYear = null;

  var nodes = DATA.buckets.map(function (b) {
    return { b: b, el: null, path: null, hit: null, dot: null, lbl: null };
  });

  // ── DOM scaffold ──────────────────────────────────────────────────────────

  root.hidden = false;
  var controls = root.querySelector("[data-field-map-controls]");
  var stage = root.querySelector("[data-field-map-stage]");
  var noteEl = root.querySelector("[data-field-map-note]");

  // Live per-branch breakdown for the year you're viewing — every value is a
  // link to its source, and the whole list re-renders as the slider moves.
  // Inserted right under the chart so the numbers track the year you scrub to.
  var breakdown = root.querySelector("[data-field-map-breakdown]");
  if (!breakdown) {
    breakdown = document.createElement("div");
    breakdown.className = "field-map-breakdown";
    breakdown.setAttribute("data-field-map-breakdown", "");
    stage.parentNode.insertBefore(breakdown, stage.nextSibling);
  }

  // Metric toggle
  var metricWrap = document.createElement("div");
  metricWrap.className = "field-map-metric";
  METRICS.forEach(function (m) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "field-map-metric-btn" + (m === metric ? " is-active" : "");
    btn.textContent = DATA.meta.metrics[m].label;
    btn.setAttribute("aria-pressed", m === metric ? "true" : "false");
    btn.addEventListener("click", function () {
      if (m === metric) return;
      setMetric(m);
    });
    metricWrap.appendChild(btn);
  });

  // Year slider + play
  var timeWrap = document.createElement("div");
  timeWrap.className = "field-map-time";
  var playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "field-map-play";
  playBtn.setAttribute("aria-label", "Play through the years");
  playBtn.textContent = "▶";
  var slider = document.createElement("input");
  slider.type = "range";
  slider.className = "field-map-slider";
  slider.min = String(range.min);
  slider.max = String(range.max);
  slider.step = "1";
  slider.value = String(year);
  slider.setAttribute("aria-label", "Year");
  var yearOut = document.createElement("output");
  yearOut.className = "field-map-year";
  yearOut.textContent = String(year);
  timeWrap.appendChild(playBtn);
  timeWrap.appendChild(slider);
  timeWrap.appendChild(yearOut);

  // Legend
  var legend = document.createElement("div");
  legend.className = "field-map-legend";
  DATA.meta.groups.forEach(function (g) {
    var item = document.createElement("span");
    item.className = "field-map-legend-item";
    item.setAttribute("data-group", g.key);
    var dot = document.createElement("span");
    dot.className = "field-map-legend-dot";
    item.appendChild(dot);
    item.appendChild(document.createTextNode(g.label));
    legend.appendChild(item);
  });

  // The metric toggle only matters once more than one metric has data (the
  // "papers" series is empty until the monthly arXiv job populates it).
  if (METRICS.length > 1) controls.appendChild(metricWrap);
  controls.appendChild(timeWrap);
  controls.appendChild(legend);

  // SVG
  var svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "field-map-svg");
  svg.setAttribute("role", "img");
  function axisLabel() {
    return (
      "Line chart of AI safety research branches over time, sized by " +
      DATA.meta.metrics[metric].label
    );
  }
  svg.setAttribute("aria-label", axisLabel());
  stage.appendChild(svg);

  // Layered groups: axes behind, then lines, dots, labels.
  var gAxes = document.createElementNS(SVG_NS, "g");
  gAxes.setAttribute("class", "fm-axis");
  var gLines = document.createElementNS(SVG_NS, "g");
  svg.appendChild(gAxes);
  svg.appendChild(gLines);

  // Tooltip
  var tip = document.createElement("div");
  tip.className = "field-map-tip";
  tip.setAttribute("role", "status");
  tip.hidden = true;
  stage.appendChild(tip);

  // One <g> per branch: visible line + transparent hit line + dot + end label.
  nodes.forEach(function (n) {
    var g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "fm-node");
    g.setAttribute("tabindex", "0");
    g.setAttribute("data-group", n.b.group);
    if (n.b.topic) g.setAttribute("data-href", n.b.topic);
    g.setAttribute("role", n.b.topic ? "link" : "img");

    var hit = document.createElementNS(SVG_NS, "path");
    hit.setAttribute("class", "fm-hit");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("class", "fm-line");
    var dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("class", "fm-dot");
    dot.setAttribute("r", "3.2");
    var lbl = document.createElementNS(SVG_NS, "text");
    lbl.setAttribute("class", "fm-endlabel");
    lbl.setAttribute("dy", "0.32em");

    g.appendChild(hit);
    g.appendChild(path);
    g.appendChild(dot);
    g.appendChild(lbl);

    n.el = g;
    n.path = path;
    n.hit = hit;
    n.dot = dot;
    n.lbl = lbl;

    g.addEventListener("mouseenter", function () {
      highlight(n, true);
      showTip(n);
    });
    g.addEventListener("mousemove", positionTip);
    g.addEventListener("mouseleave", function () {
      highlight(n, false);
      hideTip();
    });
    g.addEventListener("focus", function () {
      highlight(n, true);
      showTip(n, true);
    });
    g.addEventListener("blur", function () {
      highlight(n, false);
      hideTip();
    });
    g.addEventListener("click", function () {
      if (n.b.topic) window.location.href = n.b.topic;
    });
    g.addEventListener("keydown", function (ev) {
      if ((ev.key === "Enter" || ev.key === " ") && n.b.topic) {
        ev.preventDefault();
        window.location.href = n.b.topic;
      }
    });

    gLines.appendChild(g);
  });

  // ── Scales / layout ────────────────────────────────────────────────────────

  var W = 900,
    H = 520,
    yMax = niceCeil(maxValueFor(metric));
  var M = { top: 20, right: 142, bottom: 30, left: 50 };
  var plotW = 0,
    plotH = 0;

  function years() {
    var ys = [];
    for (var y = range.min; y <= range.max; y++) ys.push(y);
    return ys;
  }

  function measure() {
    W = Math.max(360, stage.clientWidth || 900);
    H = W < 560 ? 420 : 520;
    M.right = W < 560 ? 104 : 158; // room for the tracking labels
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    plotW = W - M.left - M.right;
    plotH = H - M.top - M.bottom;
    buildAxes();
  }

  function xScale(yr) {
    if (range.max === range.min) return M.left + plotW;
    return M.left + ((yr - range.min) / (range.max - range.min)) * plotW;
  }
  function yScale(v) {
    return M.top + plotH - (v / yMax) * plotH;
  }

  // Redraw axis gridlines + tick labels (cheap; only on resize / metric change).
  function buildAxes() {
    while (gAxes.firstChild) gAxes.removeChild(gAxes.firstChild);

    var nTicks = 4;
    for (var i = 0; i <= nTicks; i++) {
      var v = (yMax * i) / nTicks;
      var y = yScale(v);
      var grid = document.createElementNS(SVG_NS, "line");
      grid.setAttribute("class", "fm-axis-grid");
      grid.setAttribute("x1", M.left);
      grid.setAttribute("x2", M.left + plotW);
      grid.setAttribute("y1", y.toFixed(1));
      grid.setAttribute("y2", y.toFixed(1));
      gAxes.appendChild(grid);

      var yt = document.createElementNS(SVG_NS, "text");
      yt.setAttribute("x", M.left - 8);
      yt.setAttribute("y", y.toFixed(1));
      yt.setAttribute("text-anchor", "end");
      yt.setAttribute("dy", "0.32em");
      yt.textContent = Math.round(v).toLocaleString();
      gAxes.appendChild(yt);
    }

    // y-axis unit caption
    var unit = document.createElementNS(SVG_NS, "text");
    unit.setAttribute("class", "fm-axis-unit");
    unit.setAttribute("x", M.left - 8);
    unit.setAttribute("y", M.top - 7);
    unit.setAttribute("text-anchor", "start");
    unit.textContent = DATA.meta.metrics[metric].unit;
    gAxes.appendChild(unit);

    years().forEach(function (yr) {
      var x = xScale(yr);
      var xt = document.createElementNS(SVG_NS, "text");
      xt.setAttribute("x", x.toFixed(1));
      xt.setAttribute("y", H - M.bottom + 16);
      xt.setAttribute("text-anchor", "middle");
      xt.textContent = String(yr);
      gAxes.appendChild(xt);
    });
  }

  // Shorten a branch label so the tracking label fits the right margin.
  function shortLabel(s) {
    var cap = W < 560 ? 11 : 15;
    if (s.length <= cap) return s;
    var first = s.split(/\s*&\s*/)[0];
    if (first.length <= cap) return first;
    return first.slice(0, cap - 1) + "…";
  }

  // ── Render one frame at the current displayYear ────────────────────────────

  function render() {
    var dy = Math.min(displayYear, range.max);
    var ends = [];

    nodes.forEach(function (n) {
      var series = n.b[metric] || [];
      var v = valueAt(n.b, metric, dy);
      // A branch that hasn't emerged yet (still zero) is hidden — branches
      // appear as the field grows into them.
      if (v <= 0) {
        n.el.setAttribute("opacity", "0");
        n.el.style.pointerEvents = "none";
        return;
      }
      n.el.setAttribute("opacity", "1");
      n.el.style.pointerEvents = "";

      // Start the line one point before the first non-zero year so its rise
      // from ~0 reads, without dragging a long flat run along the axis.
      var startIdx = 0;
      while (startIdx < series.length && series[startIdx].value <= 0) startIdx++;
      if (startIdx > 0) startIdx--;

      var d = "";
      var started = false;
      for (var i = startIdx; i < series.length; i++) {
        var p = series[i];
        if (p.year < dy) {
          d += (started ? "L" : "M") + xScale(p.year).toFixed(1) + " " + yScale(p.value).toFixed(1);
          started = true;
        }
      }
      var ex = xScale(dy);
      var ey = yScale(v);
      d += (started ? "L" : "M") + ex.toFixed(1) + " " + ey.toFixed(1);

      n.path.setAttribute("d", d);
      n.hit.setAttribute("d", d);
      n.dot.setAttribute("cx", ex.toFixed(1));
      n.dot.setAttribute("cy", ey.toFixed(1));
      n._ex = ex;
      n._v = v;
      ends.push(n);
    });

    // De-collide the tracking labels vertically: clamp into the plot, then
    // enforce a minimum gap with a down-pass and an up-pass.
    var gap = 13;
    ends.forEach(function (n) {
      n._ly = clamp(yScale(n._v), M.top + 6, M.top + plotH);
    });
    ends.sort(function (a, b) {
      return a._ly - b._ly;
    });
    for (var i = 1; i < ends.length; i++) {
      if (ends[i]._ly - ends[i - 1]._ly < gap) ends[i]._ly = ends[i - 1]._ly + gap;
    }
    for (var j = ends.length - 2; j >= 0; j--) {
      if (ends[j + 1]._ly - ends[j]._ly < gap) ends[j]._ly = ends[j + 1]._ly - gap;
    }
    ends.forEach(function (n) {
      n.lbl.setAttribute("x", (n._ex + 8).toFixed(1));
      n.lbl.setAttribute("y", n._ly.toFixed(1));
      n.lbl.textContent = shortLabel(n.b.label) + " " + Math.round(n._v).toLocaleString();
      n.el.setAttribute(
        "aria-label",
        n.b.label + ": " + Math.round(n._v).toLocaleString() + " " + DATA.meta.metrics[metric].unit
      );
    });

    var yNow = Math.round(dy);
    if (yNow !== lastNoteYear) {
      lastNoteYear = yNow;
      updateNote(yNow);
      updateBreakdown(yNow);
      yearOut.textContent = String(yNow);
      slider.value = String(yNow);
    }
  }

  // ── Animation loop ─────────────────────────────────────────────────────────
  // Idle: ease displayYear toward the slider's `year`. Playing: sweep it
  // continuously to range.max so every line grows rightward in one motion.

  var rafId = null;
  var PLAY_PER_YEAR_MS = 1100;

  function frame() {
    if (playing) {
      displayYear += 16 / PLAY_PER_YEAR_MS;
      if (displayYear >= range.max) {
        displayYear = range.max;
        render();
        stopPlay();
        return;
      }
      render();
      rafId = requestAnimationFrame(frame);
      return;
    }
    var diff = year - displayYear;
    displayYear += diff * 0.2;
    if (Math.abs(diff) < 0.01) displayYear = year;
    render();
    if (Math.abs(year - displayYear) < 0.005) {
      rafId = null;
      return;
    }
    rafId = requestAnimationFrame(frame);
  }

  function kick() {
    if (prefersReduced && !playing) {
      displayYear = year;
      render();
      return;
    }
    if (rafId == null) rafId = requestAnimationFrame(frame);
  }

  // ── Highlight / tooltip ────────────────────────────────────────────────────

  function highlight(n, on) {
    svg.classList.toggle("is-hovering", on);
    n.el.classList.toggle("is-active", on);
    if (on) n.el.parentNode.appendChild(n.el); // raise to front
  }

  function showTip(n, keyboard) {
    var m = DATA.meta.metrics[metric];
    var yNow = Math.round(Math.min(displayYear, range.max));
    var v = valueAt(n.b, metric, yNow);
    var est = isEstimated(n.b, metric, yNow);
    var pt = pointAt(n.b, metric, yNow);
    var srcHtml = "";
    if (pt && pt.src && pt.src.length) {
      var links = pt.src
        .map(function (id) {
          var s = SRC_BY_ID[id];
          return s
            ? '<a href="' +
                escapeHtml(s.url) +
                '" rel="noopener noreferrer">' +
                escapeHtml(s.label) +
                "</a>"
            : "";
        })
        .filter(Boolean)
        .join(" · ");
      var basis = pt.basis === "anchor" ? "anchor" : "modeled";
      srcHtml =
        '<span class="field-map-tip-src">' +
        '<span class="field-map-tip-basis ' +
        (pt.basis === "anchor" ? "is-anchor" : "is-modeled") +
        '">' +
        basis +
        "</span> · " +
        links +
        "</span>";
    }
    tip.innerHTML =
      "<strong>" +
      escapeHtml(n.b.label) +
      "</strong>" +
      '<span class="field-map-tip-num">' +
      Math.round(v).toLocaleString() +
      " " +
      escapeHtml(m.unit) +
      (est ? " <em>(est.)</em>" : "") +
      " · " +
      yNow +
      "</span>" +
      '<span class="field-map-tip-blurb">' +
      escapeHtml(n.b.blurb) +
      "</span>" +
      srcHtml +
      (n.b.topic ? '<span class="field-map-tip-cta">Open topic →</span>' : "");
    tip.hidden = false;
    if (keyboard) {
      var rect = stage.getBoundingClientRect();
      placeTip((n._ex / W) * rect.width, (clamp(yScale(n._v), M.top, M.top + plotH) / H) * rect.height);
    }
  }
  function positionTip(ev) {
    var rect = stage.getBoundingClientRect();
    placeTip(ev.clientX - rect.left, ev.clientY - rect.top);
  }
  // Keep the tooltip fully inside the stage (which clips overflow): offset from
  // the cursor, but flip to the other side when it would run off an edge.
  function placeTip(x, y) {
    var pad = 6;
    var tw = tip.offsetWidth || 0;
    var th = tip.offsetHeight || 0;
    var maxX = stage.clientWidth - tw - pad;
    var maxY = stage.clientHeight - th - pad;
    var left = x + 14;
    if (left > maxX) left = x - 14 - tw; // flip to the left of the cursor
    var top = y + 14;
    if (top > maxY) top = y - 14 - th; // flip above the cursor
    tip.style.left = clamp(left, pad, Math.max(pad, maxX)) + "px";
    tip.style.top = clamp(top, pad, Math.max(pad, maxY)) + "px";
  }
  function hideTip() {
    tip.hidden = true;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ── Note / caption ─────────────────────────────────────────────────────────

  function updateNote(yNow) {
    var m = DATA.meta.metrics[metric];
    var total = 0,
      live = 0;
    nodes.forEach(function (n) {
      var v = valueAt(n.b, metric, yNow);
      total += v;
      if (v > 0) live++;
    });
    noteEl.innerHTML =
      "<strong>" +
      Math.round(total).toLocaleString() +
      " " +
      escapeHtml(m.unit) +
      "</strong> across " +
      live +
      " branches in " +
      yNow +
      ". " +
      escapeHtml(m.note);
  }

  // Re-render the live breakdown for `yNow`: every active branch as a row whose
  // number links to the source backing that exact year's figure. Sorted high to
  // low so the biggest branches read first.
  function updateBreakdown(yNow) {
    var m = DATA.meta.metrics[metric];
    var rows = nodes
      .map(function (n) {
        return { n: n, v: valueAt(n.b, metric, yNow) };
      })
      .filter(function (r) {
        return r.v > 0;
      })
      .sort(function (a, b) {
        return b.v - a.v;
      });

    var items = rows
      .map(function (r) {
        var pt = pointAt(r.n.b, metric, yNow);
        var num = Math.round(r.v).toLocaleString();
        var ids = pt && pt.src ? pt.src : [];
        var primary = ids.length ? SRC_BY_ID[ids[0]] : null;
        var basis = pt && pt.basis === "anchor" ? "anchor" : pt ? "modeled" : "";
        var numTitle = primary
          ? (basis ? basis + " · " : "") + primary.label
          : "";
        var numHtml = primary
          ? '<a class="fm-bd-num" href="' +
            escapeHtml(primary.url) +
            '" rel="noopener noreferrer" title="' +
            escapeHtml(numTitle) +
            '">' +
            num +
            "</a>"
          : '<span class="fm-bd-num">' + num + "</span>";
        var badges = ids
          .map(function (id) {
            var s = SRC_BY_ID[id];
            return s
              ? '<a class="fm-bd-src" href="' +
                  escapeHtml(s.url) +
                  '" rel="noopener noreferrer" title="' +
                  escapeHtml(s.label) +
                  '">' +
                  escapeHtml(srcAbbr(id)) +
                  "</a>"
              : "";
          })
          .filter(Boolean)
          .join("");
        var basisTag = basis
          ? '<span class="fm-bd-basis ' +
            (basis === "anchor" ? "is-anchor" : "is-modeled") +
            '">' +
            basis +
            "</span>"
          : "";
        return (
          '<li class="fm-bd-item" data-group="' +
          escapeHtml(r.n.b.group) +
          '">' +
          '<span class="fm-bd-dot"></span>' +
          '<span class="fm-bd-label">' +
          escapeHtml(r.n.b.label) +
          "</span>" +
          numHtml +
          basisTag +
          '<span class="fm-bd-srcs">' +
          badges +
          "</span>" +
          "</li>"
        );
      })
      .join("");

    breakdown.innerHTML =
      '<div class="fm-bd-head">' +
      escapeHtml(m.label) +
      " by branch in " +
      yNow +
      ' <span class="fm-bd-hint">— click a number for its source</span></div>' +
      '<ol class="fm-bd-list">' +
      items +
      "</ol>";
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  // Scrubbing the slider maps straight to the leading edge — the dots track
  // your drag exactly (no easing lag). The eased sweep is reserved for Play.
  function setYear(y) {
    year = y;
    displayYear = y;
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    render();
  }

  function setMetric(m) {
    metric = m;
    range = yearRange(metric);
    yMax = niceCeil(maxValueFor(metric));
    if (year < range.min) year = range.min;
    if (year > range.max) year = range.max;
    displayYear = year;
    lastNoteYear = null;
    slider.min = String(range.min);
    slider.max = String(range.max);
    slider.value = String(year);
    yearOut.textContent = String(year);
    Array.prototype.forEach.call(metricWrap.children, function (btn, i) {
      var active = METRICS[i] === m;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    svg.setAttribute("aria-label", axisLabel());
    buildAxes();
    render();
    kick();
  }

  slider.addEventListener("input", function () {
    if (playing) stopPlay();
    setYear(parseInt(slider.value, 10));
  });

  // Play / pause sweeps time from the start so the lines draw rightward.
  var playing = false;
  function stopPlay() {
    playing = false;
    playBtn.textContent = "▶";
    playBtn.classList.remove("is-playing");
    year = Math.round(Math.min(displayYear, range.max));
    slider.value = String(year);
    yearOut.textContent = String(year);
  }
  function startPlay() {
    if (displayYear >= range.max) displayYear = range.min;
    year = range.max;
    playing = true;
    playBtn.textContent = "❚❚";
    playBtn.classList.add("is-playing");
    if (prefersReduced) {
      displayYear = range.max;
      render();
      stopPlay();
      return;
    }
    if (rafId == null) rafId = requestAnimationFrame(frame);
  }
  playBtn.addEventListener("click", function () {
    if (playing) stopPlay();
    else startPlay();
  });

  // ── Init ───────────────────────────────────────────────────────────────────

  measure();
  render();

  var resizeT = null;
  window.addEventListener("resize", function () {
    if (resizeT) clearTimeout(resizeT);
    resizeT = setTimeout(function () {
      measure();
      render();
    }, 150);
  });
})();
