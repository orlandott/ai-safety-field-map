#!/usr/bin/env node
//
// Build the standalone field-map page.
//
// Inlines the data (data/field-map.json), styles (src/field-map.css) and the
// component (src/field-map.js) into a single self-contained, zero-dependency
// HTML file at public/field-map/index.html. A no-JS fallback table and a
// sources list are generated from the data so the page is useful even with
// scripting disabled or before the bundle hydrates.
//
// Usage:
//   node scripts/build.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_PATH = path.join(ROOT, "data", "field-map.json");
const CSS_PATH = path.join(ROOT, "src", "field-map.css");
const JS_PATH = path.join(ROOT, "src", "field-map.js");
const OUT_DIR = path.join(ROOT, "public", "field-map");
const OUT_PATH = path.join(OUT_DIR, "index.html");

// Host theme variables the component relies on (--surface, --text, …). Shipped
// with the page so it renders correctly stand-alone; a host site can drop these
// and rely on its own design tokens instead.
const THEME_CSS = `:root{
  --bg:#f4f1ea; --surface:#fff; --surface-soft:#f9f7f1; --text:#382110;
  --muted:#6f6659; --border:#e6ddce; --border-strong:#d5cab7; --accent:#409d69;
  --on-accent:#fff; --accent-soft:#eef8f1; --accent-soft-border:#b5d6bf;
  --accent-text:#2f7a52; --link:#166b4c; --shadow-soft:0 4px 14px rgba(56,33,16,.07);
}
[data-theme="dark"]{
  --bg:#15110d; --surface:#1f1913; --surface-soft:#251e17; --text:#ede4d3;
  --muted:#a99b85; --border:#3b3128; --border-strong:#4d4034; --accent:#4fb87e;
  --on-accent:#0e231a; --accent-soft:rgba(79,184,126,.14); --accent-soft-border:rgba(79,184,126,.42);
  --accent-text:#7fd2a4; --link:#7fd2a4; --shadow-soft:0 4px 14px rgba(0,0,0,.35);
}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);}
.wrap{max-width:1100px;margin:0 auto;padding:1.5rem 1rem 3rem;}
h1{font-size:1.9rem;margin:.2rem 0 .4rem;}
.lead{color:var(--muted);max-width:42rem;line-height:1.55;margin:0 0 1rem;}
.theme-btn{float:right;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:999px;padding:.35rem .7rem;cursor:pointer;font-size:.8rem;}`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Latest snapshot value for a metric series (the no-JS table shows "now").
function latest(series) {
  if (!series || !series.length) return null;
  return series[series.length - 1];
}

// Build the no-JS fallback table: one section per group, each branch as a row
// with its current headcount and blurb. Mirrors the interactive view's data.
function buildTable(data) {
  const metric = data.meta.defaultMetric;
  const unit = data.meta.metrics[metric].unit;
  let rows = "";
  for (const group of data.meta.groups) {
    const buckets = data.buckets.filter((b) => b.group === group.key);
    if (!buckets.length) continue;
    rows +=
      `        <tr class="field-map-group-row"><th colspan="3" scope="rowgroup">` +
      `${escapeHtml(group.label)}</th></tr>\n`;
    for (const b of buckets) {
      const pt = latest(b[metric]);
      const value = pt ? Math.round(pt.value).toLocaleString() : "—";
      const est = pt && pt.estimated ? ` <span class="field-map-est">(est.)</span>` : "";
      const label = b.topic
        ? `<a href="${escapeHtml(b.topic)}">${escapeHtml(b.label)}</a>`
        : escapeHtml(b.label);
      rows +=
        `        <tr>\n` +
        `          <th scope="row">${label}</th>\n` +
        `          <td class="field-map-num">${value} ${escapeHtml(unit)}${est}</td>\n` +
        `          <td>${escapeHtml(b.blurb)}</td>\n` +
        `        </tr>\n`;
    }
  }
  const m = data.meta.metrics[metric];
  return (
    `      <table class="field-map-table">\n` +
    `        <caption>${escapeHtml(m.label)} by branch (${escapeHtml(data.meta.updated)}). ` +
    `${escapeHtml(m.note)}</caption>\n` +
    `        <thead>\n` +
    `          <tr><th scope="col">Branch</th><th scope="col">${escapeHtml(m.label)}</th>` +
    `<th scope="col">What it covers</th></tr>\n` +
    `        </thead>\n` +
    `        <tbody>\n${rows}        </tbody>\n` +
    `      </table>\n`
  );
}

function buildSources(data) {
  const items = (data.meta.sources || [])
    .map(
      (s) =>
        `<a href="${escapeHtml(s.url)}" rel="noopener noreferrer">${escapeHtml(s.label)}</a>`
    )
    .join(" · ");
  if (!items) return "";
  return `      <p class="field-map-sources">Sources: ${items}</p>\n`;
}

// Short abbreviations for the per-cell source markers in the provenance table.
const SRC_ABBR = {
  mcaleese: "M",
  estimating: "E",
  "eightyk-tech": "8t",
  "eightyk-count": "8c",
  "larsen-lifland": "L",
  aiwatch: "W",
  eto: "ETO",
};

function abbr(id) {
  return SRC_ABBR[id] || id;
}

// Full per-year sourcing table: every (branch, year) FTE value with a link to
// the source(s) backing it. This is the verifiable record behind the chart —
// it gives "a link for every FTE, every year, every category" the chart's
// hover tooltips show one at a time. Wrapped in <details> so it doesn't
// overwhelm the page.
function buildProvenance(data) {
  const metric = data.meta.defaultMetric;
  const srcById = Object.fromEntries((data.meta.sources || []).map((s) => [s.id, s]));

  // Collect the full sorted set of years present in the people series.
  const yearSet = new Set();
  for (const b of data.buckets) for (const p of b[metric] || []) yearSet.add(p.year);
  const years = Array.from(yearSet).sort((a, b) => a - b);
  if (!years.length) return "";

  // One linked cell per (branch, year): the value, plus a superscript of
  // source abbreviations each linking to that source. Anchored points (a
  // published per-category figure) are marked distinctly from modeled ones.
  function cell(pt) {
    if (!pt) return `<td class="fm-prov-cell">—</td>`;
    const ids = pt.src && pt.src.length ? pt.src : [];
    const primary = ids.length ? srcById[ids[0]] : null;
    const sup = ids
      .map((id) => {
        const s = srcById[id];
        if (!s) return "";
        return (
          `<a href="${escapeHtml(s.url)}" rel="noopener noreferrer" ` +
          `title="${escapeHtml(s.label)}">${escapeHtml(abbr(id))}</a>`
        );
      })
      .join("");
    const basisClass = pt.basis === "anchor" ? " is-anchor" : " is-modeled";
    const basisTitle = pt.basis === "anchor" ? "Anchored to a published figure" : "Modeled / interpolated";
    const num = Math.round(pt.value).toLocaleString();
    // The number itself links to its primary source; the superscript exposes
    // any additional corroborating sources.
    const valHtml = primary
      ? `<a class="fm-prov-val" href="${escapeHtml(primary.url)}" rel="noopener noreferrer" ` +
        `title="${escapeHtml((pt.basis === "anchor" ? "anchor · " : "modeled · ") + primary.label)}">${num}</a>`
      : `<span class="fm-prov-val">${num}</span>`;
    return (
      `<td class="fm-prov-cell${basisClass}" title="${escapeHtml(basisTitle)}">` +
      valHtml +
      (sup ? `<sup class="fm-prov-src">${sup}</sup>` : "") +
      `</td>`
    );
  }

  let rows = "";
  for (const group of data.meta.groups) {
    const buckets = data.buckets.filter((b) => b.group === group.key);
    if (!buckets.length) continue;
    rows +=
      `          <tr class="field-map-group-row"><th colspan="${years.length + 1}" scope="rowgroup">` +
      `${escapeHtml(group.label)}</th></tr>\n`;
    for (const b of buckets) {
      const byYear = Object.fromEntries((b[metric] || []).map((p) => [p.year, p]));
      const label = b.topic
        ? `<a href="${escapeHtml(b.topic)}">${escapeHtml(b.label)}</a>`
        : escapeHtml(b.label);
      rows +=
        `          <tr><th scope="row">${label}</th>` +
        years.map((y) => cell(byYear[y])).join("") +
        `</tr>\n`;
    }
  }

  const yearCols = years.map((y) => `<th scope="col">${y}</th>`).join("");

  // Legend: every abbreviation → its full, linked source, plus the anchor /
  // modeled key.
  const legend = (data.meta.sources || [])
    .map(
      (s) =>
        `<a class="fm-prov-key-item fm-prov-key-link" href="${escapeHtml(s.url)}" rel="noopener noreferrer">` +
        `<b>${escapeHtml(abbr(s.id))}</b> ${escapeHtml(s.label)}</a>`
    )
    .join("");

  const unit = data.meta.metrics[metric].unit;
  return (
    `      <details class="field-map-provenance">\n` +
    `        <summary>Per-year sourcing — every ${escapeHtml(unit)} value, every year, with its source</summary>\n` +
    `        <div class="fm-prov-scroll">\n` +
    `        <table class="fm-prov-table">\n` +
    `          <thead><tr><th scope="col">Branch</th>${yearCols}</tr></thead>\n` +
    `          <tbody>\n${rows}          </tbody>\n` +
    `        </table>\n` +
    `        </div>\n` +
    `        <p class="fm-prov-key"><span class="fm-prov-key-item"><b class="fm-prov-val is-anchor">n</b> anchored to a published per-category figure</span>` +
    `<span class="fm-prov-key-item"><b class="fm-prov-val is-modeled">n</b> modeled (our split or interpolation of a published total)</span>${legend}</p>\n` +
    `      </details>\n`
  );
}

function main() {
  const dataRaw = fs.readFileSync(DATA_PATH, "utf8");
  const data = JSON.parse(dataRaw);
  const css = fs.readFileSync(CSS_PATH, "utf8");
  const js = fs.readFileSync(JS_PATH, "utf8");

  // Guard against a stray "</script>" inside inlined JSON/JS breaking the page.
  const safeData = dataRaw.replace(/<\/script>/gi, "<\\/script>");
  const safeJs = js.replace(/<\/script>/gi, "<\\/script>");

  const title = escapeHtml(data.meta.title);

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>
${THEME_CSS}

${css}</style>
</head>
<body class="site-body field-map-page">
<div class="wrap">
  <button class="theme-btn" type="button" onclick="var h=document.documentElement;h.setAttribute('data-theme',h.getAttribute('data-theme')==='dark'?'light':'dark')">Toggle theme</button>
  <h1 class="hero-title">${title}</h1>
  <p class="lead">Each branch of AI safety research as a line: years across the bottom, headcount up the side. Press play (or drag the slider) to watch every branch grow over time.</p>
  <div class="field-map" data-field-map hidden>
    <div class="field-map-controls" data-field-map-controls></div>
    <div class="field-map-stage" data-field-map-stage></div>
    <p class="field-map-note" data-field-map-note></p>
  </div>
${buildTable(data)}${buildProvenance(data)}${buildSources(data)}  <script type="application/json" id="field-map-data">${safeData}</script>
  <script>${safeJs}</script>
</div>
</body>
</html>
`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, html);
  console.log(`✓ Wrote ${path.relative(ROOT, OUT_PATH)} (${html.length.toLocaleString()} bytes)`);
}

main();
