# AI Safety Field Map

An interactive bubble chart of AI-safety research branches. Each branch is a
bubble sized by a metric (people/FTEs or papers/year), grouped into Technical /
Governance / Cross-cutting. A year slider animates the bubbles growing as the
field scales (≈304 FTEs in 2022 → ≈1,040 in 2025). Hover for a tooltip, click a
bubble to follow a link. Light/dark theme aware via CSS custom properties.

No framework, no build dependencies, no external libraries — the page is a
single self-contained HTML file that works offline and from `file://`.

## Layout

```
data/field-map.json            Hand-curated data (edit this)
src/field-map.css              Component styles + group colors
src/field-map.js               The interactive component (vanilla JS)
scripts/build.mjs              Inlines data + CSS + JS → public/field-map/index.html
scripts/fetch-field-map.mjs    Pulls the "papers / year" metric from arXiv
public/field-map/index.html    Built, self-contained page (generated)
.github/workflows/field-map-refresh.yml   Monthly arXiv refresh + rebuild
```

## Build

```sh
npm run build      # node scripts/build.mjs → public/field-map/index.html
```

Then open `public/field-map/index.html` in any browser.

## Data

Edit `data/field-map.json` and rebuild. Each bucket needs at least two `people`
points to animate over time. `"estimated": true` flags a rough value. The
`papers` series is optional and filled by the fetch script; the metric toggle
only appears once that series has data.

## Refreshing the "papers / year" metric

`scripts/fetch-field-map.mjs` queries the arXiv API for the number of papers
matching each branch's search terms per year and writes the counts back into
`data/field-map.json`. The hand-curated `people` (FTE) numbers are never
touched.

```sh
npm run fetch            # current year only
npm run fetch:dry        # print, don't write
node scripts/fetch-field-map.mjs --from 2018   # backfill from a year
node scripts/fetch-field-map.mjs --year 2024   # a single specific year
```

arXiv asks for ≤ 1 request / 3s and a descriptive User-Agent; the script honours
both. After fetching, run `npm run build` to regenerate the page. The monthly
GitHub Action (`field-map-refresh.yml`) does both and commits the result.

## Embedding in a host site

The component reads its data from an inlined
`<script type="application/json" id="field-map-data">` element and renders into:

```html
<div class="field-map" data-field-map hidden>
  <div class="field-map-controls" data-field-map-controls></div>
  <div class="field-map-stage" data-field-map-stage></div>
  <p class="field-map-note" data-field-map-note></p>
</div>
```

`src/field-map.css` relies on host CSS variables (`--surface`, `--text`,
`--muted`, `--border`, `--accent`, `--accent-text`, `--on-accent`,
`--shadow-soft`, …); the built page ships a default set so it works stand-alone.

## License

MIT
