/**
 * Interactive virtualized HTML Developer Guide renderer styled with Valve's Steam Deck / SteamUI color guide.
 * Supports split Pages mode (`index.html` + `data.json`) and `--single-file` embedded mode.
 */
import { readFileSync } from "node:fs";
import { VALVE_PALETTE, type GuideData } from "./dev_guide_schema";

const GUIDE_APP_JS = readFileSync(new URL("./dev_guide_client.js", import.meta.url), "utf8");

function escapeEmbeddedJson(data: GuideData): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const GUIDE_CSS = `
:root {
  --gp-darkest: ${VALVE_PALETTE.bgDarkest};
  --gp-header: ${VALVE_PALETTE.bgHeader};
  --gp-store-dark: ${VALVE_PALETTE.bgStoreDark};
  --gp-surface: ${VALVE_PALETTE.bgSurface};
  --gp-card: ${VALVE_PALETTE.bgCard};
  --gp-elevated: ${VALVE_PALETTE.bgElevated};
  --gp-border: ${VALVE_PALETTE.border};
  --gp-border-subtle: ${VALVE_PALETTE.borderSubtle};
  --gp-muted: ${VALVE_PALETTE.textMuted};
  --gp-sub: ${VALVE_PALETTE.textSub};
  --gp-body: ${VALVE_PALETTE.textBody};
  --gp-text: ${VALVE_PALETTE.textPrimary};
  --gp-bright: ${VALVE_PALETTE.textBright};
  --gp-blue: ${VALVE_PALETTE.accentBlue};
  --gp-blue-hi: ${VALVE_PALETTE.accentBlueHi};
  --gp-blue-soft: ${VALVE_PALETTE.accentBlueSoft};
  --gp-blue-tint: ${VALVE_PALETTE.accentBlueTint};
  --gp-green: ${VALVE_PALETTE.verifiedGreen};
  --gp-green-hi: ${VALVE_PALETTE.verifiedGreenHi};
  --gp-green-tint: ${VALVE_PALETTE.verifiedGreenTint};
  --gp-amber: ${VALVE_PALETTE.inferredAmber};
  --gp-amber-tint: ${VALVE_PALETTE.inferredAmberTint};
  --gp-red: ${VALVE_PALETTE.unmatchedRed};
  --gp-red-tint: ${VALVE_PALETTE.unmatchedRedTint};
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  height: 100%;
  background: radial-gradient(ellipse 110% 45% at 50% -10%, var(--gp-store-dark) 0%, var(--gp-darkest) 62%);
  background-color: var(--gp-darkest);
  color: var(--gp-text);
  font-family: "Motiva Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  overflow: hidden;
}
code, pre, .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
button { font: inherit; color: inherit; cursor: pointer; }
a { color: var(--gp-blue-hi); text-decoration: none; }
a:hover { text-decoration: underline; }

.app-shell { display: flex; flex-direction: column; height: 100vh; }

.topbar {
  background: var(--gp-header);
  border-bottom: 1px solid var(--gp-border);
  padding: 10px 18px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 18px;
  z-index: 20;
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 240px; }
.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  background: linear-gradient(135deg, var(--gp-blue) 0%, var(--gp-elevated) 100%);
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 13px;
  color: var(--gp-bright);
  letter-spacing: 0.04em;
  box-shadow: 0 2px 10px rgba(26, 159, 255, 0.25);
}
.brand h1 { margin: 0; font-size: 15px; font-weight: 700; color: var(--gp-bright); letter-spacing: 0.01em; }
.brand-sub { font-size: 11px; color: var(--gp-sub); }

.omnibox-wrap { flex: 1 1 340px; max-width: 680px; position: relative; }
#omnibox {
  width: 100%;
  background: var(--gp-darkest);
  color: var(--gp-bright);
  border: 1px solid var(--gp-border);
  border-radius: 6px;
  padding: 8px 68px 8px 12px;
  font-size: 13.5px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
#omnibox:focus { border-color: var(--gp-blue); box-shadow: 0 0 0 2px rgba(26, 159, 255, 0.22); }
#omnibox::placeholder { color: var(--gp-muted); }
.omnibox-hint {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 11px;
  color: var(--gp-muted);
  background: var(--gp-surface);
  border: 1px solid var(--gp-border-subtle);
  border-radius: 4px;
  padding: 1px 6px;
  pointer-events: none;
}

.kpi-strip { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
.kpi {
  background: var(--gp-card);
  border: 1px solid var(--gp-border-subtle);
  border-radius: 5px;
  padding: 4px 9px;
  font-size: 11.5px;
  color: var(--gp-body);
}
.kpi strong { color: var(--gp-bright); font-weight: 700; }

.toolbar {
  background: rgba(23, 26, 33, 0.85);
  border-bottom: 1px solid var(--gp-border-subtle);
  padding: 7px 18px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}
.tabs, .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.tab-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--gp-body);
  padding: 5px 10px;
  border-radius: 5px;
  font-size: 12.5px;
  font-weight: 600;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.tab-btn:hover { background: var(--gp-surface); color: var(--gp-bright); }
.tab-btn.active { background: var(--gp-blue-tint); border-color: var(--gp-blue); color: var(--gp-blue-soft); }
.tab-count { font-size: 11px; color: var(--gp-sub); margin-left: 4px; font-weight: 500; }
.tab-btn.active .tab-count { color: var(--gp-blue-hi); }

.divider-v { width: 1px; height: 20px; background: var(--gp-border-subtle); }
.chip {
  background: var(--gp-card);
  border: 1px solid var(--gp-border-subtle);
  color: var(--gp-sub);
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  transition: all 0.12s;
}
.chip:hover { border-color: var(--gp-border); color: var(--gp-text); }
.chip.active[data-conf="verified"] { background: var(--gp-green-tint); border-color: var(--gp-green); color: var(--gp-green-hi); }
.chip.active[data-conf="inferred"] { background: var(--gp-amber-tint); border-color: var(--gp-amber); color: var(--gp-amber); }
.chip.active[data-conf="unmatched"] { background: var(--gp-red-tint); border-color: var(--gp-red); color: var(--gp-red); }
.chip.active[data-mig] { background: var(--gp-blue-tint); border-color: var(--gp-blue-hi); color: var(--gp-blue-soft); }

.workspace { flex: 1 1 auto; display: flex; min-height: 0; overflow: hidden; }

.sidebar {
  width: 225px;
  flex: 0 0 225px;
  background: rgba(14, 20, 27, 0.72);
  border-right: 1px solid var(--gp-border-subtle);
  overflow-y: auto;
  padding: 10px 8px;
}
.sidebar-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--gp-muted);
  padding: 4px 10px 8px;
  font-weight: 700;
}
.area-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 6px 10px;
  margin-bottom: 2px;
  text-align: left;
  font-size: 12.5px;
  color: var(--gp-body);
}
.area-btn:hover { background: var(--gp-card); color: var(--gp-bright); }
.area-btn.active { background: var(--gp-elevated); border-color: var(--gp-blue); color: var(--gp-bright); font-weight: 600; }
.area-badge { font-size: 11px; color: var(--gp-sub); background: var(--gp-darkest); padding: 1px 6px; border-radius: 999px; }

.main-pane { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.list-status {
  padding: 6px 16px;
  background: rgba(27, 40, 56, 0.45);
  border-bottom: 1px solid var(--gp-border-subtle);
  font-size: 12px;
  color: var(--gp-sub);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
#virtual-viewport { flex: 1 1 auto; overflow-y: auto; position: relative; }
#virtual-spacer { position: relative; width: 100%; }
#virtual-items { position: absolute; top: 0; left: 0; right: 0; }

.row {
  height: 54px;
  padding: 7px 16px;
  border-bottom: 1px solid var(--gp-border-subtle);
  display: grid;
  grid-template-columns: 94px minmax(180px, 1.4fr) minmax(170px, 1.1fr) minmax(140px, 0.9fr) 150px;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  transition: background 0.08s;
}
.row:hover { background: rgba(42, 71, 94, 0.35); }
.row.selected { background: rgba(26, 159, 255, 0.16); box-shadow: inset 3px 0 0 var(--gp-blue); }
.row-name { font-weight: 600; color: var(--gp-bright); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-sub { font-size: 11.5px; color: var(--gp-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: var(--gp-blue-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-meta { font-size: 11.5px; color: var(--gp-body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-badges { display: flex; gap: 5px; justify-content: flex-end; flex-wrap: nowrap; }

.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  white-space: nowrap;
}
.b-verified { background: var(--gp-green-tint); color: var(--gp-green-hi); border: 1px solid rgba(91, 163, 43, 0.5); }
.b-inferred { background: var(--gp-amber-tint); color: var(--gp-amber); border: 1px solid rgba(255, 197, 61, 0.45); }
.b-unmatched { background: var(--gp-red-tint); color: var(--gp-red); border: 1px solid rgba(236, 93, 94, 0.45); }
.b-kind { background: var(--gp-surface); color: var(--gp-blue-hi); border: 1px solid var(--gp-border); }
.b-mig-changed { background: var(--gp-blue-tint); color: var(--gp-blue-soft); border: 1px solid rgba(26, 159, 255, 0.4); }
.b-mig-new { background: var(--gp-green-tint); color: var(--gp-green-hi); border: 1px solid rgba(91, 163, 43, 0.4); }
.b-mig-unchanged { background: var(--gp-surface); color: var(--gp-sub); border: 1px solid var(--gp-border-subtle); }

#detail-drawer {
  width: 460px;
  flex: 0 0 460px;
  background: var(--gp-card);
  border-left: 1px solid var(--gp-border);
  overflow-y: auto;
  padding: 16px 18px 28px;
  display: none;
}
#detail-drawer.open { display: block; }
.drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid var(--gp-border-subtle);
  padding-bottom: 12px;
  margin-bottom: 14px;
}
.drawer-title { margin: 0; font-size: 17px; color: var(--gp-bright); word-break: break-word; }
.drawer-close { background: var(--gp-surface); border: 1px solid var(--gp-border); border-radius: 5px; padding: 3px 9px; font-size: 12px; color: var(--gp-body); }
.drawer-close:hover { background: var(--gp-elevated); color: var(--gp-bright); }
.drawer-section { margin-bottom: 16px; }
.drawer-section h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--gp-blue-hi); }
.kv-grid { display: grid; grid-template-columns: 112px 1fr; gap: 5px 10px; font-size: 12.5px; }
.kv-k { color: var(--gp-sub); }
.kv-v { color: var(--gp-text); word-break: break-word; }

.code-box {
  background: var(--gp-darkest);
  border: 1px solid var(--gp-border-subtle);
  border-radius: 5px;
  padding: 9px 10px;
  font-size: 12px;
  color: var(--gp-blue-soft);
  position: relative;
  word-break: break-all;
  white-space: pre-wrap;
}
.copy-btn {
  margin-top: 6px;
  background: var(--gp-store-dark);
  border: 1px solid var(--gp-border);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 11.5px;
  color: var(--gp-blue-soft);
}
.copy-btn:hover { background: var(--gp-elevated); border-color: var(--gp-blue); }

.pill-list { display: flex; flex-wrap: wrap; gap: 5px; }
.pill {
  background: var(--gp-surface);
  border: 1px solid var(--gp-border-subtle);
  border-radius: 4px;
  padding: 3px 8px;
  font-size: 11.5px;
  color: var(--gp-text);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pill.link { cursor: pointer; border-color: rgba(26, 159, 255, 0.35); color: var(--gp-blue-soft); }
.pill.link:hover { background: var(--gp-blue-tint); border-color: var(--gp-blue); }

#translator-view { display: none; flex: 1 1 auto; overflow-y: auto; padding: 18px 22px 32px; }
#translator-view.active { display: block; }
.translator-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 18px; }
.translator-box { display: flex; flex-direction: column; gap: 6px; }
.translator-box label { font-size: 12px; font-weight: 700; color: var(--gp-blue-hi); text-transform: uppercase; letter-spacing: 0.06em; }
#translator-input, #translator-output {
  width: 100%;
  min-height: 210px;
  background: var(--gp-darkest);
  color: var(--gp-blue-soft);
  border: 1px solid var(--gp-border);
  border-radius: 6px;
  padding: 12px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12.5px;
  resize: vertical;
}
.trans-table { width: 100%; border-collapse: collapse; font-size: 12.5px; background: var(--gp-card); border: 1px solid var(--gp-border-subtle); }
.trans-table th, .trans-table td { padding: 8px 10px; border-bottom: 1px solid var(--gp-border-subtle); text-align: left; }
.trans-table th { background: var(--gp-store-dark); color: var(--gp-blue-soft); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
.trans-table tr.clickable:hover { background: rgba(42, 71, 94, 0.4); cursor: pointer; }

.empty-state { padding: 40px 24px; text-align: center; color: var(--gp-sub); }

/* Visual Gallery & Icon Grid */
#gallery-view {
  display: none;
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 16px 20px 36px;
}
#gallery-view.active { display: block; }
.gallery-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  gap: 12px;
  flex-wrap: wrap;
}
.gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(390px, 1fr));
  gap: 14px;
}
.comp-card {
  background: var(--gp-card);
  border: 1px solid var(--gp-border-subtle);
  border-radius: 7px;
  padding: 13px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: pointer;
  transition: border-color 0.12s, transform 0.08s;
}
.comp-card:hover { border-color: var(--gp-blue); background: rgba(27, 40, 56, 0.55); }
.comp-card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.comp-card-title { margin: 0; font-size: 14.5px; font-weight: 700; color: var(--gp-bright); }
.comp-card-desc { margin: 0; font-size: 12px; color: var(--gp-body); line-height: 1.4; }
.preview-stage {
  background: var(--gp-surface);
  border: 1px solid var(--gp-border-subtle);
  border-radius: 5px;
  padding: 12px;
  overflow: auto;
  position: relative;
  isolation: isolate;
  color: var(--gp-text);
  min-height: 44px;
}
.preview-inner { position: relative; max-width: 100%; }
.preview-stage button:not([class]) { background: var(--gp-border); color: var(--gp-text); border: 1px solid var(--gp-muted); border-radius: 3px; padding: 4px 10px; }

.icon-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 9px;
}
.icon-card {
  background: var(--gp-card);
  border: 1px solid var(--gp-border-subtle);
  border-radius: 6px;
  padding: 11px 8px 9px;
  text-align: center;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  transition: border-color 0.12s, background 0.12s;
}
.icon-card:hover { border-color: var(--gp-blue); background: var(--gp-store-dark); }
.icon-svg-box {
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--gp-text);
}
.icon-svg-box svg { width: 36px !important; height: 36px !important; display: block; position: static !important; }
.icon-svg-box > div { position: relative !important; width: 36px !important; height: 36px !important; top: auto !important; left: auto !important; margin: 0 !important; }
.icon-svg-label { font-size: 11px; color: var(--gp-body); word-break: break-word; line-height: 1.25; }
.icon-drawer-stage {
  background: var(--gp-surface);
  border: 1px solid var(--gp-border-subtle);
  border-radius: 6px;
  padding: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--gp-bright);
}
.icon-drawer-stage svg { width: 72px !important; height: 72px !important; position: static !important; }
.icon-drawer-stage > div { position: relative !important; width: 72px !important; height: 72px !important; top: auto !important; left: auto !important; margin: 0 !important; }

/* Steam Deck Screen Map Schematic */
.deck-map {
  background: var(--gp-darkest);
  border: 1px solid var(--gp-border);
  border-radius: 7px;
  padding: 10px;
}
.deck-screen {
  position: relative;
  aspect-ratio: 16 / 10;
  width: 100%;
  background: #121822;
  border: 1px solid var(--gp-border-subtle);
  border-radius: 5px;
  display: grid;
  grid-template-rows: 16% 1fr 14%;
  grid-template-columns: 22% 1fr 24%;
  gap: 3px;
  padding: 4px;
  overflow: hidden;
}
.dm-zone {
  background: rgba(61, 68, 80, 0.25);
  border: 1px solid rgba(61, 68, 80, 0.55);
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--gp-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 2px;
}
.dm-zone.on {
  background: rgba(26, 159, 255, 0.28);
  border-color: var(--gp-blue);
  color: var(--gp-blue-soft);
  box-shadow: inset 0 0 10px rgba(26, 159, 255, 0.35);
}
.dm-top { grid-column: 1 / 4; grid-row: 1; }
.dm-left { grid-column: 1; grid-row: 2; }
.dm-main { grid-column: 2; grid-row: 2; }
.dm-qam { grid-column: 3; grid-row: 2; }
.dm-footer { grid-column: 1 / 4; grid-row: 3; }
.dm-float {
  position: absolute;
  display: none;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  border-radius: 4px;
  background: #133558;
  border: 1.5px solid var(--gp-blue);
  color: var(--gp-bright);
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.65);
  padding: 2px 6px;
  z-index: 2;
}
.dm-float.on { display: flex; }
.dm-modal { inset: 22% 24%; }
.dm-ctx { top: 26%; right: 26%; width: 24%; height: 34%; }
.dm-kbd { left: 10%; right: 10%; bottom: 12%; height: 34%; }
.dm-toast { top: 18%; right: 5%; width: 28%; height: 18%; }
.dm-legend { margin-top: 7px; font-size: 11.5px; color: var(--gp-body); display: flex; flex-wrap: wrap; gap: 4px 10px; }
.desc-box {
  background: rgba(27, 40, 56, 0.55);
  border-left: 3px solid var(--gp-blue);
  border-radius: 0 5px 5px 0;
  padding: 9px 11px;
  font-size: 12.5px;
  color: var(--gp-text);
  margin-bottom: 14px;
  line-height: 1.45;
}

@media (max-width: 1040px) {
  .sidebar { display: none; }
  #detail-drawer { width: 100%; flex: 0 0 auto; position: fixed; inset: 0; z-index: 50; }
  .row { grid-template-columns: 84px 1fr 130px; }
  .row-meta, .row-code { display: none; }
  .translator-grid { grid-template-columns: 1fr; }
}
`;

export function renderGuideHtml(opts: { embeddedData?: GuideData; dataUrl?: string }): string {
  const embeddedTag = opts.embeddedData
    ? `<script id="guide-data" type="application/json">${escapeEmbeddedJson(opts.embeddedData)}</script>`
    : "";
  const dataAttr = opts.embeddedData ? "" : ` data-json-url="${(opts.dataUrl ?? "./data.json").replace(/"/g, "&quot;")}"`;
  const titleSuffix = opts.embeddedData ? ` — ${opts.embeddedData.beta.branch} ${opts.embeddedData.beta.version}` : "";

  return `<!DOCTYPE html>
<html lang="en"${dataAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SteamUI Vite Developer Guide${titleSuffix}</title>
<style>${GUIDE_CSS}</style>
</head>
<body>
<div class="app-shell">
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark">UI</div>
      <div>
        <h1>SteamUI Vite Developer Guide</h1>
        <div class="brand-sub" id="build-subtitle">Loading Steam Deck beta semantic index…</div>
      </div>
    </div>
    <div class="omnibox-wrap">
      <input id="omnibox" type="search" autocomplete="off" spellcheck="false" placeholder="Search Vite hash, Webpack hash, semantic CSS class, component, prop, store field, or chunk…" />
      <span class="omnibox-hint">/ to search</span>
    </div>
    <div class="kpi-strip" id="kpi-strip"></div>
  </header>

  <nav class="toolbar">
    <div class="tabs">
      <button class="tab-btn active" data-tab="all">All <span class="tab-count"></span></button>
      <button class="tab-btn" data-tab="gallery" id="tab-gallery" style="display:none">Visual Gallery <span class="tab-count"></span></button>
      <button class="tab-btn" data-tab="components">Components <span class="tab-count"></span></button>
      <button class="tab-btn" data-tab="stores">Stores <span class="tab-count"></span></button>
      <button class="tab-btn" data-tab="css-modules">CSS Modules <span class="tab-count"></span></button>
      <button class="tab-btn" data-tab="css-classes">CSS Classes <span class="tab-count"></span></button>
      <button class="tab-btn" data-tab="icons">Icons <span class="tab-count"></span></button>
      <button class="tab-btn" data-tab="chunks">Chunks <span class="tab-count"></span></button>
      <button class="tab-btn" data-tab="translate">CSS Paste Translator</button>
    </div>
    <div class="divider-v"></div>
    <div class="filters">
      <button class="chip" data-conf="verified">Verified</button>
      <button class="chip" data-conf="inferred">Inferred</button>
      <button class="chip" data-conf="unmatched">Unmatched</button>
      <div class="divider-v"></div>
      <button class="chip" data-mig="changed">Changed</button>
      <button class="chip" data-mig="new">New</button>
      <button class="chip" data-mig="unmatched">Unmatched</button>
    </div>
  </nav>

  <div class="workspace">
    <aside class="sidebar">
      <div class="sidebar-title">Feature Areas</div>
      <div id="sidebar-areas"></div>
    </aside>

    <main class="main-pane" id="list-view">
      <div class="list-status">
        <span id="list-count">Loading…</span>
        <span>Click any row to open cross-linked Visual, Placement &amp; CSS Drawer · Press <kbd>Esc</kbd> to clear</span>
      </div>
      <div id="virtual-viewport">
        <div id="virtual-spacer">
          <div id="virtual-items"></div>
        </div>
      </div>
    </main>

    <section id="gallery-view">
      <div class="gallery-header">
        <div>
          <div id="gallery-title" style="font-size:13px;color:var(--gp-sub)"></div>
          <div id="gallery-note" style="font-size:11.5px;color:var(--gp-muted)"></div>
        </div>
        <button class="chip" id="toggle-gpfocus" style="display:none" title="Toggle Steam Deck gamepad focus highlight (.gpfocus / .gpfocuswithin) on rendered components">Simulate Gamepad Focus (gpfocus)</button>
      </div>
      <div id="gallery-body"></div>
    </section>

    <section id="translator-view">
      <div class="translator-grid">
        <div class="translator-box">
          <label for="translator-input">Paste CSS snippet, old Webpack hashes, or Vite hashes</label>
          <textarea id="translator-input" spellcheck="false" placeholder="Example:\n._1OldKbHash { background: #1b2838; }\n.cpMYQEmzrwE- { opacity: 0.9; }"></textarea>
        </div>
        <div class="translator-box">
          <label for="translator-output">Migrated &amp; Semantically Annotated Output</label>
          <textarea id="translator-output" readonly spellcheck="false"></textarea>
          <div><button class="copy-btn" id="copy-translated">Copy translated CSS</button></div>
        </div>
      </div>
      <table class="trans-table">
        <thead>
          <tr><th>Input Token</th><th>Detected As</th><th>Semantic Name</th><th>Vite Hash</th><th>Confidence</th></tr>
        </thead>
        <tbody id="translator-rows"></tbody>
      </table>
    </section>

    <aside id="detail-drawer" aria-label="Symbol details"></aside>
  </div>
</div>
${embeddedTag}
<script>${GUIDE_APP_JS}</script>
</body>
</html>
`;
}
