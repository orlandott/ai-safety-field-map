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
${buildTable(data)}${buildSources(data)}  <script type="application/json" id="field-map-data">${safeData}</script>
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
