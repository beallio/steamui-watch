(() => {
  const ROW_H = 54;
  const BUFFER = 12;

  const PLACEMENT_LABELS = {
    "top-bar": "Top Header Bar",
    "left-sidebar": "Left Navigation Sidebar",
    "main-content": "Main Viewport (Library / Store)",
    "qam-drawer": "Right Quick Access Menu (QAM)",
    "settings-panel": "Settings / Plugin Panels",
    "footer-bar": "Bottom Footer Bar",
    "modal-overlay": "Center Modal Dialog",
    "context-menu": "Floating Context Menu",
    "virtual-keyboard": "Bottom Virtual Keyboard",
    "toast-overlay": "Notification Toast",
    "background-store": "Background Runtime Store",
  };

  const state = {
    data: null,
    hasPreviews: false,
    hasIconSvgs: false,
    tab: "all",
    area: "all",
    conf: new Set(),
    mig: new Set(),
    query: "",
    selectedKey: null,
    allRows: [],
    filtered: [],
    byKey: new Map(),
    byHash: new Map(),
    byWebpackHash: new Map(),
    byCssId: new Map(),
    byModId: new Map(),
    byExportId: new Map(),
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function renderDeckMap(placements) {
    const set = new Set(placements || []);
    if (!set.size) return "";
    const on = (z) => (set.has(z) ? " on" : "");
    const mainOn = set.has("main-content") || set.has("settings-panel") ? " on" : "";
    const legend = [...set].map((z) => `<span class="pill">${esc(PLACEMENT_LABELS[z] || z)}</span>`).join("");
    return `
      <div class="drawer-section">
        <h3>Where It Lives (Steam Deck Gaming Mode)</h3>
        <div class="deck-map">
          <div class="deck-screen">
            <div class="dm-zone dm-top${on("top-bar")}">Top Bar</div>
            <div class="dm-zone dm-left${on("left-sidebar")}">Sidebar</div>
            <div class="dm-zone dm-main${mainOn}">${set.has("settings-panel") ? "Main / Settings" : "Main Content"}</div>
            <div class="dm-zone dm-qam${on("qam-drawer")}">QAM •••</div>
            <div class="dm-zone dm-footer${on("footer-bar")}">Footer Prompts</div>
            <div class="dm-float dm-modal${on("modal-overlay")}">Modal Dialog</div>
            <div class="dm-float dm-ctx${on("context-menu")}">Context Menu</div>
            <div class="dm-float dm-kbd${on("virtual-keyboard")}">Virtual Keyboard</div>
            <div class="dm-float dm-toast${on("toast-overlay")}">Toast</div>
          </div>
          <div class="dm-legend">${legend}</div>
        </div>
      </div>
    `;
  }

  function buildSearchIndex(data) {
    state.data = data;
    state.hasPreviews = data.exports.some((e) => Boolean(e.previewHtml));
    state.hasIconSvgs = data.icons.some((i) => Boolean(i.previewSvg));
    state.allRows = [];
    state.byKey.clear();
    state.byHash.clear();
    state.byWebpackHash.clear();
    state.byCssId.clear();
    state.byModId.clear();
    state.byExportId.clear();

    if (data.previewCss && !document.getElementById("steam-preview-css")) {
      const style = document.createElement("style");
      style.id = "steam-preview-css";
      style.textContent = data.previewCss;
      document.head.insertBefore(style, document.head.firstChild);
    }

    for (const m of data.cssModules) state.byModId.set(m.id, m);
    for (const c of data.cssClasses) {
      state.byCssId.set(c.id, c);
      if (!state.byHash.has(c.hash)) state.byHash.set(c.hash, c);
      if (c.webpackHash && !state.byWebpackHash.has(c.webpackHash)) state.byWebpackHash.set(c.webpackHash, c);
    }
    for (const e of data.exports) state.byExportId.set(e.id, e);

    const addRow = (row) => {
      state.allRows.push(row);
      state.byKey.set(row.key, row);
    };

    for (const e of data.exports) {
      const cssNames = e.cssClasses.slice(0, 12).map((cid) => state.byCssId.get(cid)?.semanticName || "").filter(Boolean);
      const cssHashes = e.cssClasses.slice(0, 12).map((cid) => state.byCssId.get(cid)?.hash || "").filter(Boolean);
      const placeWords = (e.placements || []).map((p) => PLACEMENT_LABELS[p] || p);
      const search = [
        e.name, e.id, e.kind, e.sourcePackage, e.featureArea, e.chunk, e.description || "", ...placeWords,
        ...e.viteAt, ...e.webpackAt, ...e.props, ...e.storeFields, ...e.methods, ...e.steamClientApis, ...e.evidence, ...cssNames, ...cssHashes,
      ].join(" ").toLowerCase();
      addRow({
        key: e.id,
        hashLink: "#" + e.id.replace(":", "/"),
        tab: e.kind === "store" ? "stores" : "components",
        kindLabel: e.kind,
        name: e.name,
        sub: e.description || (e.sourcePackage + " · " + e.featureArea),
        code: e.viteAt[0] || e.chunk,
        meta: e.webpackAt[0] ? "WP: " + e.webpackAt[0] : (e.evidence[0] || ""),
        area: e.featureArea,
        conf: e.confidence,
        mig: e.migration,
        search,
        item: e,
        type: "export",
      });
    }

    for (const m of data.cssModules) {
      const sample = m.classes.slice(0, 16).map((cid) => state.byCssId.get(cid)?.semanticName || "").filter(Boolean);
      addRow({
        key: m.id,
        hashLink: "#mod/" + encodeURIComponent(m.moduleId),
        tab: "css-modules",
        kindLabel: "css-mod",
        name: m.name,
        sub: m.description || ("Module " + m.moduleId + " · " + m.featureArea),
        code: m.classCount + " classes",
        meta: m.usedBy.length ? "Used by " + m.usedBy.length + " export(s)" : "Stylesheet module",
        area: m.featureArea,
        conf: "verified",
        mig: "changed",
        search: [m.name, m.moduleId, m.featureArea, m.description || "", ...sample].join(" ").toLowerCase(),
        item: m,
        type: "css-module",
      });
    }

    for (const c of data.cssClasses) {
      const label = c.semanticName ? (c.moduleName + "." + c.semanticName) : c.hash;
      addRow({
        key: c.id,
        hashLink: c.semanticName ? ("#css/" + encodeURIComponent(c.moduleId + "/" + c.semanticName)) : ("#hash/" + encodeURIComponent(c.hash)),
        tab: "css-classes",
        kindLabel: c.isKeyframe ? "keyframe" : "css",
        name: label,
        sub: c.description || (c.featureArea + (c.usedBy.length ? " · used by " + c.usedBy.length : "")),
        code: c.hash,
        meta: c.webpackHash ? ("WP: " + c.webpackHash) : (c.migration === "new" ? "New in Vite" : "Unmatched"),
        area: c.featureArea,
        conf: c.confidence,
        mig: c.migration,
        search: [label, c.hash, c.semanticName || "", c.moduleName, c.moduleId || "", c.webpackHash || "", c.chainId || "", c.featureArea, c.description || ""].join(" ").toLowerCase(),
        item: c,
        type: "css-class",
      });
    }

    for (const ic of data.icons) {
      addRow({
        key: "icon:" + ic.name,
        hashLink: "#icon/" + encodeURIComponent(ic.name),
        tab: "icons",
        kindLabel: "icon",
        name: ic.name,
        sub: "IconsModule" + (ic.directional ? " · directional" : ""),
        code: ic.viteAt[0] || "IconsModule." + ic.name,
        meta: ic.webpackAt[0] ? "WP: " + ic.webpackAt[0] : "",
        area: "CommonUI",
        conf: "verified",
        mig: ic.webpackAt.length ? "changed" : "new",
        search: ["icon", "iconsmodule", ic.name, ...ic.viteAt, ...ic.webpackAt].join(" ").toLowerCase(),
        item: ic,
        type: "icon",
      });
    }

    for (const ch of data.chunks) {
      addRow({
        key: "chunk:" + ch.name,
        hashLink: "#chunk/" + encodeURIComponent(ch.name),
        tab: "chunks",
        kindLabel: "chunk",
        name: ch.name,
        sub: ch.featureAreas.join(", ") || "Bundle chunk",
        code: ch.exportCount + " exports",
        meta: ch.cssClassCount + " CSS hashes",
        area: ch.featureAreas[0] || "System & Misc",
        conf: ch.featureAreas.length ? "inferred" : "unmatched",
        mig: "new",
        search: [ch.name, ...ch.featureAreas].join(" ").toLowerCase(),
        item: ch,
        type: "chunk",
      });
    }
  }

  function renderHeader() {
    const d = state.data;
    const s = d.stats;
    const cssPct = s.cssClasses ? ((s.cssMatched / s.cssClasses) * 100).toFixed(1) : "0.0";
    $("build-subtitle").textContent = d.beta.branch + " " + d.beta.version + " (Vite/Rolldown)  ←  Webpack " + d.webpackBaseline.version;
    const kpis = [
      `<div class="kpi"><strong>${s.cssMatched.toLocaleString()}</strong> / ${s.cssClasses.toLocaleString()} CSS (${cssPct}%)</div>`,
      `<div class="kpi"><strong>${s.exports.toLocaleString()}</strong> JS Exports (${s.verifiedExports} verified · ${s.inferredExports} inferred)</div>`,
      `<div class="kpi"><strong>${s.webpackMatchedExports.toLocaleString()}</strong> Webpack→Vite Matches</div>`,
      `<div class="kpi"><strong>${s.icons.toLocaleString()}</strong> Icons${s.renderedIcons ? ` (${s.renderedIcons} SVG)` : ""}</div>`,
    ];
    if (s.renderedPreviews) {
      kpis.unshift(`<div class="kpi" style="border-color:var(--gp-blue)"><strong>${s.renderedPreviews}</strong> Live Component Previews</div>`);
    }
    $("kpi-strip").innerHTML = kpis.join("");

    const galleryBtn = $("tab-gallery");
    if (galleryBtn && state.hasPreviews) {
      galleryBtn.style.display = "";
    }

    const counts = {
      all: state.allRows.length,
      gallery: d.exports.filter((e) => Boolean(e.previewHtml)).length,
      components: d.exports.filter((e) => e.kind !== "store").length,
      stores: d.exports.filter((e) => e.kind === "store").length,
      "css-modules": d.cssModules.length,
      "css-classes": d.cssClasses.length,
      icons: d.icons.length,
      chunks: d.chunks.length,
    };
    for (const btn of document.querySelectorAll(".tab-btn[data-tab]")) {
      const t = btn.getAttribute("data-tab");
      const span = btn.querySelector(".tab-count");
      if (span && t in counts) span.textContent = counts[t].toLocaleString();
    }

    const sb = $("sidebar-areas");
    const areaHtml = [`<button class="area-btn ${state.area === "all" ? "active" : ""}" data-area="all"><span>All Feature Areas</span><span class="area-badge">${state.allRows.length.toLocaleString()}</span></button>`];
    for (const a of d.featureAreas) {
      const total = a.componentCount + a.storeCount + a.cssClassCount;
      areaHtml.push(`<button class="area-btn ${state.area === a.name ? "active" : ""}" data-area="${esc(a.name)}"><span>${esc(a.name)}</span><span class="area-badge">${total.toLocaleString()}</span></button>`);
    }
    sb.innerHTML = areaHtml.join("");
    sb.querySelectorAll(".area-btn").forEach((b) => {
      b.addEventListener("click", () => {
        state.area = b.getAttribute("data-area") || "all";
        sb.querySelectorAll(".area-btn").forEach((x) => x.classList.toggle("active", x === b));
        if (state.tab === "translate") setTab("all");
        else applyFilters();
      });
    });
  }

  function matchesTerms(text, terms) {
    for (const t of terms) if (!text.includes(t)) return false;
    return true;
  }

  function renderVisualGallery() {
    const q = state.query.trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    const body = $("gallery-body");
    const title = $("gallery-title");
    const note = $("gallery-note");

    if (state.tab === "icons" && state.hasIconSvgs) {
      const icons = state.data.icons.filter((ic) => {
        if (!terms.length) return true;
        return matchesTerms(("icon iconsmodule " + ic.name + " " + ic.viteAt.join(" ")).toLowerCase(), terms);
      });
      title.textContent = `Showing ${icons.length.toLocaleString()} of ${state.data.icons.length.toLocaleString()} IconsModule SVG icons`;
      note.textContent = "Click any icon to copy its <IconsModule.Name /> usage & inspect Vite/Webpack locations";
      if (!icons.length) {
        body.innerHTML = `<div class="empty-state">No icons match "${esc(state.query)}".</div>`;
        return;
      }
      body.innerHTML = `<div class="icon-grid">${icons.map((ic) => `
        <div class="icon-card" data-open="icon:${esc(ic.name)}">
          <div class="icon-svg-box">${ic.previewSvg || `<span class="mono" style="font-size:10px;color:var(--gp-muted)">N/A</span>`}</div>
          <div class="icon-svg-label">${esc(ic.name)}</div>
        </div>
      `).join("")}</div>`;
      body.querySelectorAll("[data-open]").forEach((el) => {
        el.addEventListener("click", () => openDetail(el.getAttribute("data-open")));
      });
      return;
    }

    // Component Visual Gallery
    const comps = state.data.exports.filter((e) => {
      if (!e.previewHtml) return false;
      if (state.area !== "all" && e.featureArea !== state.area) return false;
      if (state.conf.size && !state.conf.has(e.confidence)) return false;
      if (terms.length) {
        const row = state.byKey.get(e.id);
        if (row && !matchesTerms(row.search, terms)) return false;
      }
      return true;
    });
    title.textContent = `Showing ${comps.length} rendered Steam Deck components (live DOM + SteamUI CSS from ${state.data.beta.branch} ${state.data.beta.version})`;
    note.textContent = "Click any component card for Steam Deck screen placement, props, recipe, and semantic CSS classes";
    if (!comps.length) {
      body.innerHTML = `<div class="empty-state">No rendered component previews match the current filters.</div>`;
      return;
    }
    body.innerHTML = `<div class="gallery-grid">${comps.map((e) => {
      const places = (e.placements || []).slice(0, 3).map((p) => `<span class="pill">${esc(PLACEMENT_LABELS[p] || p)}</span>`).join("");
      return `
        <article class="comp-card" data-open="${esc(e.id)}">
          <div class="comp-card-head">
            <h3 class="comp-card-title">${esc(e.name)}</h3>
            <span class="badge b-kind">${esc(e.sourcePackage)}</span>
          </div>
          ${e.description ? `<p class="comp-card-desc">${esc(e.description)}</p>` : ""}
          <div class="preview-stage">
            <div class="preview-inner" style="width:${Math.min(e.previewWidth || 360, 560)}px">${e.previewHtml}</div>
          </div>
          <div class="pill-list">${places}</div>
        </article>
      `;
    }).join("")}</div>`;
    body.querySelectorAll("[data-open]").forEach((el) => {
      el.addEventListener("click", () => openDetail(el.getAttribute("data-open")));
    });
  }

  function applyFilters() {
    if (state.tab === "gallery" || (state.tab === "icons" && state.hasIconSvgs)) {
      renderVisualGallery();
      return;
    }
    const q = state.query.trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    const out = [];
    for (const r of state.allRows) {
      if (state.tab !== "all" && r.tab !== state.tab) continue;
      if (state.area !== "all" && r.area !== state.area) continue;
      if (state.conf.size && !state.conf.has(r.conf)) continue;
      if (state.mig.size && !state.mig.has(r.mig)) continue;
      if (terms.length && !matchesTerms(r.search, terms)) continue;
      out.push(r);
    }
    state.filtered = out;
    $("list-count").textContent = out.length.toLocaleString() + " matching item" + (out.length === 1 ? "" : "s");
    const vp = $("virtual-viewport");
    vp.scrollTop = 0;
    renderVirtual();
  }

  function renderVirtual() {
    const vp = $("virtual-viewport");
    const spacer = $("virtual-spacer");
    const itemsEl = $("virtual-items");
    const total = state.filtered.length;
    spacer.style.height = Math.max(total * ROW_H, 120) + "px";

    if (!total) {
      itemsEl.style.transform = "translateY(0px)";
      itemsEl.innerHTML = `<div class="empty-state">No matching symbols. Try searching a Vite hash (e.g. <code>cpMYQEmzrwE-</code>), semantic CSS name, component name, or prop name.</div>`;
      return;
    }

    const scrollTop = vp.scrollTop;
    const height = vp.clientHeight || 640;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
    const end = Math.min(total, Math.ceil((scrollTop + height) / ROW_H) + BUFFER);
    itemsEl.style.transform = `translateY(${start * ROW_H}px)`;

    const parts = [];
    for (let i = start; i < end; i++) {
      const r = state.filtered[i];
      const sel = r.key === state.selectedKey ? " selected" : "";
      parts.push(
        `<div class="row${sel}" data-key="${esc(r.key)}">` +
          `<div><span class="badge b-kind">${esc(r.kindLabel)}</span></div>` +
          `<div><div class="row-name">${esc(r.name)}</div><div class="row-sub">${esc(r.sub)}</div></div>` +
          `<div class="row-code">${esc(r.code)}</div>` +
          `<div class="row-meta">${esc(r.meta)}</div>` +
          `<div class="row-badges">` +
            `<span class="badge b-${r.conf}">${esc(r.conf)}</span>` +
            (r.mig !== "unmatched" ? `<span class="badge b-mig-${r.mig}">${esc(r.mig)}</span>` : "") +
          `</div>` +
        `</div>`
      );
    }
    itemsEl.innerHTML = parts.join("");
  }

  function copyText(text, btn) {
    navigator.clipboard?.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = orig; }, 1200);
    }).catch(() => {});
  }

  function openDetail(key, pushHash = true) {
    const row = state.byKey.get(key);
    if (!row) return;
    state.selectedKey = key;
    if (pushHash && row.hashLink && location.hash !== row.hashLink) {
      history.replaceState(null, "", row.hashLink);
    }
    if (state.tab !== "gallery" && !(state.tab === "icons" && state.hasIconSvgs) && state.tab !== "translate") {
      renderVirtual();
    }

    const drawer = $("detail-drawer");
    drawer.classList.add("open");
    const it = row.item;
    let body = "";

    if (row.type === "export") {
      const cssPills = it.cssClasses.map((cid) => {
        const c = state.byCssId.get(cid);
        const lbl = c?.semanticName ? `${c.moduleName}.${c.semanticName} (${c.hash})` : (c?.hash || cid);
        return `<button class="pill link" data-jump="${esc(cid)}">${esc(lbl)}</button>`;
      }).join("");
      const modPills = it.cssModules.map((mid) => {
        const m = state.byModId.get(mid);
        return `<button class="pill link" data-jump="${esc(mid)}">${esc(m ? `${m.name} (${m.moduleId})` : mid)}</button>`;
      }).join("");
      const previewBlock = it.previewHtml
        ? `<div class="drawer-section"><h3>Visual Preview</h3><div class="preview-stage"><div class="preview-inner" style="width:${Math.min(it.previewWidth || 360, 400)}px">${it.previewHtml}</div></div>${it.previewNote ? `<div class="row-sub" style="margin-top:5px">${esc(it.previewNote)}</div>` : ""}</div>`
        : (it.previewNote ? `<div class="drawer-section"><h3>Visual Preview</h3><div class="row-sub">${esc(it.previewNote)}</div></div>` : "");
      body = `
        <div class="drawer-head">
          <div>
            <h2 class="drawer-title">${esc(it.name)}</h2>
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
              <span class="badge b-kind">${esc(it.kind)}</span>
              <span class="badge b-${it.confidence}">${esc(it.confidence)}</span>
              <span class="badge b-mig-${it.migration}">${esc(it.migration)}</span>
            </div>
          </div>
          <button class="drawer-close" id="close-drawer">Close</button>
        </div>
        ${it.description ? `<div class="desc-box">${esc(it.description)}</div>` : ""}
        ${previewBlock}
        ${renderDeckMap(it.placements)}
        <div class="drawer-section">
          <h3>Migration & Identity</h3>
          <div class="kv-grid">
            <div class="kv-k">Source</div><div class="kv-v">${esc(it.sourcePackage)}</div>
            <div class="kv-k">Feature Area</div><div class="kv-v">${esc(it.featureArea)}</div>
            <div class="kv-k">Vite ESM</div><div class="kv-v mono">${it.viteAt.map(esc).join("<br>")}</div>
            <div class="kv-k">Chunk</div><div class="kv-v"><button class="pill link" data-jump="chunk:${esc(it.chunk)}">${esc(it.chunk)}</button></div>
            <div class="kv-k">Webpack Bridge</div><div class="kv-v mono">${it.webpackAt.length ? it.webpackAt.map(esc).join("<br>") + (it.webpackMatchScore ? ` (score ${it.webpackMatchScore})` : "") : "No pre-Vite match"}</div>
            ${it.evidence.length ? `<div class="kv-k">Evidence</div><div class="kv-v">${it.evidence.map(esc).join(" · ")}</div>` : ""}
          </div>
        </div>
        <div class="drawer-section">
          <h3>Copy-Paste Recipe</h3>
          <div class="code-box">${esc(it.recipe)}</div>
          <button class="copy-btn" data-copy="${esc(it.recipe)}">Copy recipe</button>
        </div>
        ${it.props.length ? `<div class="drawer-section"><h3>Observed Props (${it.props.length})</h3><div class="pill-list">${it.props.map((p) => `<button class="pill link" data-search="${esc(p)}">${esc(p)}</button>`).join("")}</div></div>` : ""}
        ${it.storeFields.length ? `<div class="drawer-section"><h3>Store Fields (${it.storeFields.length})</h3><div class="pill-list">${it.storeFields.map((f) => `<button class="pill link mono" data-search="${esc(f)}">${esc(f)}</button>`).join("")}</div></div>` : ""}
        ${it.methods.length ? `<div class="drawer-section"><h3>Prototype Methods (${it.methods.length})</h3><div class="pill-list">${it.methods.map((m) => `<span class="pill mono">${esc(m)}</span>`).join("")}</div></div>` : ""}
        ${it.steamClientApis.length ? `<div class="drawer-section"><h3>SteamClient APIs (${it.steamClientApis.length})</h3><div class="pill-list">${it.steamClientApis.map((a) => `<button class="pill link mono" data-search="${esc(a)}">${esc(a)}</button>`).join("")}</div></div>` : ""}
        ${modPills ? `<div class="drawer-section"><h3>CSS Modules Used (${it.cssModules.length})</h3><div class="pill-list">${modPills}</div></div>` : ""}
        ${cssPills ? `<div class="drawer-section"><h3>Semantic CSS Classes Used (${it.cssClasses.length})</h3><div class="pill-list">${cssPills}</div></div>` : ""}
      `;
    } else if (row.type === "css-class") {
      const usedPills = it.usedBy.map((eid) => {
        const e = state.byExportId.get(eid);
        return `<button class="pill link" data-jump="${esc(eid)}">${esc(e ? e.name : eid)}</button>`;
      }).join("");
      const previewOwner = state.hasPreviews
        ? state.data.exports.find((e) => e.previewHtml && e.previewHtml.includes(it.hash))
        : null;
      body = `
        <div class="drawer-head">
          <div>
            <h2 class="drawer-title">${esc(it.semanticName ? `${it.moduleName}.${it.semanticName}` : it.hash)}</h2>
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
              <span class="badge b-kind">${it.isKeyframe ? "keyframe" : "css class"}</span>
              <span class="badge b-${it.confidence}">${esc(it.confidence)}</span>
              <span class="badge b-mig-${it.migration}">${esc(it.migration)}</span>
            </div>
          </div>
          <button class="drawer-close" id="close-drawer">Close</button>
        </div>
        ${it.description ? `<div class="desc-box">${esc(it.description)}</div>` : ""}
        ${previewOwner ? `<div class="drawer-section"><h3>Rendered In Component Preview (<button class="pill link" data-jump="${esc(previewOwner.id)}">${esc(previewOwner.name)}</button>)</h3><div class="preview-stage"><div class="preview-inner" style="width:${Math.min(previewOwner.previewWidth || 360, 400)}px">${previewOwner.previewHtml}</div></div></div>` : ""}
        ${renderDeckMap(it.placements)}
        <div class="drawer-section">
          <h3>Webpack → Vite CSS Bridge</h3>
          <div class="kv-grid">
            <div class="kv-k">Vite Hash</div><div class="kv-v mono">${esc(it.hash)}</div>
            <div class="kv-k">Webpack Hash</div><div class="kv-v mono">${esc(it.webpackHash || "None")}</div>
            <div class="kv-k">Semantic Name</div><div class="kv-v">${esc(it.semanticName || "Unmatched")}</div>
            <div class="kv-k">CSS Module</div><div class="kv-v">${it.moduleId ? `<button class="pill link" data-jump="mod:${esc(it.moduleId)}">${esc(it.moduleName)} (${esc(it.moduleId)})</button>` : "Unmatched"}</div>
            <div class="kv-k">Feature Area</div><div class="kv-v">${esc(it.featureArea)}</div>
            <div class="kv-k">CSS Loader Chain</div><div class="kv-v mono">${it.chainId ? `${esc(it.chainId)} (${it.chainHistoryCount} versions)` : "Not in beta.json chain"}</div>
          </div>
        </div>
        <div class="drawer-section">
          <h3>Copy-Paste Selector</h3>
          <div class="code-box">${esc(it.cssSnippet)}</div>
          <button class="copy-btn" data-copy="${esc(it.cssSnippet)}">Copy selector</button>
        </div>
        <div class="drawer-section">
          <h3>Referenced By Components / Exports (${it.usedBy.length})</h3>
          ${usedPills ? `<div class="pill-list">${usedPills}</div>` : `<div class="row-sub">No direct Vite JS reference detected (may be composed dynamically or stylesheet-only).</div>`}
        </div>
      `;
    } else if (row.type === "css-module") {
      const classPills = it.classes.map((cid) => {
        const c = state.byCssId.get(cid);
        return `<button class="pill link" data-jump="${esc(cid)}">${esc(c?.semanticName || cid)} · <span class="mono">${esc(c?.hash || "")}</span></button>`;
      }).join("");
      const usedPills = it.usedBy.map((eid) => {
        const e = state.byExportId.get(eid);
        return `<button class="pill link" data-jump="${esc(eid)}">${esc(e ? e.name : eid)}</button>`;
      }).join("");
      body = `
        <div class="drawer-head">
          <div>
            <h2 class="drawer-title">${esc(it.name)}</h2>
            <div style="margin-top:6px;display:flex;gap:6px"><span class="badge b-kind">css module ${esc(it.moduleId)}</span><span class="badge b-verified">${it.classCount} classes</span></div>
          </div>
          <button class="drawer-close" id="close-drawer">Close</button>
        </div>
        ${it.description ? `<div class="desc-box">${esc(it.description)}</div>` : ""}
        ${renderDeckMap(it.placements)}
        <div class="drawer-section">
          <h3>Overview</h3>
          <div class="kv-grid">
            <div class="kv-k">Module ID</div><div class="kv-v mono">${esc(it.moduleId)}</div>
            <div class="kv-k">Feature Area</div><div class="kv-v">${esc(it.featureArea)}</div>
            <div class="kv-k">Classes</div><div class="kv-v">${it.classCount}</div>
          </div>
        </div>
        ${usedPills ? `<div class="drawer-section"><h3>Used By Exports (${it.usedBy.length})</h3><div class="pill-list">${usedPills}</div></div>` : ""}
        <div class="drawer-section">
          <h3>Semantic Classes (${it.classes.length})</h3>
          <div class="pill-list">${classPills}</div>
        </div>
      `;
    } else if (row.type === "icon") {
      body = `
        <div class="drawer-head">
          <div>
            <h2 class="drawer-title">IconsModule.${esc(it.name)}</h2>
            <div style="margin-top:6px;display:flex;gap:6px"><span class="badge b-kind">icon</span><span class="badge b-verified">verified</span></div>
          </div>
          <button class="drawer-close" id="close-drawer">Close</button>
        </div>
        ${it.previewSvg ? `<div class="drawer-section"><h3>Icon Image</h3><div class="icon-drawer-stage">${it.previewSvg}</div></div>` : ""}
        <div class="drawer-section">
          <h3>Details</h3>
          <div class="kv-grid">
            <div class="kv-k">Directional</div><div class="kv-v">${it.directional ? "Yes (accepts direction prop: up/down/left/right)" : "No"}</div>
            <div class="kv-k">Vite ESM</div><div class="kv-v mono">${it.viteAt.map(esc).join("<br>")}</div>
            <div class="kv-k">Webpack Bridge</div><div class="kv-v mono">${it.webpackAt.map(esc).join("<br>") || "None"}</div>
          </div>
        </div>
        <div class="drawer-section">
          <h3>Copy-Paste Usage</h3>
          <div class="code-box">${esc(it.recipe)}</div>
          <button class="copy-btn" data-copy="${esc(it.recipe)}">Copy usage</button>
        </div>
      `;
    } else if (row.type === "chunk") {
      const chunkExports = state.data.exports.filter((e) => e.chunk === it.name);
      body = `
        <div class="drawer-head">
          <div>
            <h2 class="drawer-title mono">${esc(it.name)}</h2>
            <div style="margin-top:6px;display:flex;gap:6px"><span class="badge b-kind">vite chunk</span></div>
          </div>
          <button class="drawer-close" id="close-drawer">Close</button>
        </div>
        <div class="drawer-section">
          <h3>Chunk Summary</h3>
          <div class="kv-grid">
            <div class="kv-k">Exports</div><div class="kv-v">${it.exportCount}</div>
            <div class="kv-k">CSS Hashes</div><div class="kv-v">${it.cssClassCount}</div>
            <div class="kv-k">Feature Areas</div><div class="kv-v">${esc(it.featureAreas.join(", ") || "Unmatched")}</div>
          </div>
        </div>
        <div class="drawer-section">
          <h3>Exports in Chunk (${chunkExports.length})</h3>
          <div class="pill-list">${chunkExports.slice(0, 120).map((e) => `<button class="pill link" data-jump="${esc(e.id)}">${esc(e.name)}</button>`).join("")}</div>
        </div>
      `;
    }

    drawer.innerHTML = body;
    drawer.querySelector("#close-drawer")?.addEventListener("click", closeDrawer);
    drawer.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", () => copyText(btn.getAttribute("data-copy") || "", btn));
    });
    drawer.querySelectorAll("[data-jump]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-jump");
        if (target) openDetail(target);
      });
    });
    drawer.querySelectorAll("[data-search]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const term = btn.getAttribute("data-search") || "";
        $("omnibox").value = term;
        state.query = term;
        if (state.tab === "translate" || state.tab === "gallery") setTab("all");
        else applyFilters();
      });
    });
  }

  function closeDrawer() {
    state.selectedKey = null;
    $("detail-drawer").classList.remove("open");
    renderVirtual();
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab-btn[data-tab]").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-tab") === tab);
    });
    const isTrans = tab === "translate";
    const isGallery = tab === "gallery" || (tab === "icons" && state.hasIconSvgs);
    $("translator-view").classList.toggle("active", isTrans);
    $("gallery-view").classList.toggle("active", isGallery);
    $("list-view").style.display = isTrans || isGallery ? "none" : "flex";
    if (isTrans) {
      if (location.hash !== "#translate") history.replaceState(null, "", "#translate");
      runTranslator();
    } else if (isGallery) {
      renderVisualGallery();
    } else {
      applyFilters();
    }
  }

  function runTranslator() {
    const raw = $("translator-input").value || "";
    const tokenRe = /(\.)?(-?[_a-zA-Z][\w-]{3,})/g;
    const seen = new Map();
    const translated = raw.replace(tokenRe, (full, dot, tok) => {
      const byVite = state.byHash.get(tok);
      const byWp = state.byWebpackHash.get(tok);
      const match = byVite || byWp;
      if (!match) return full;
      if (!seen.has(tok)) {
        seen.set(tok, { token: tok, source: byVite ? "Vite hash" : "Webpack hash", entry: match });
      }
      const label = match.semanticName ? ` /* ${match.moduleName}.${match.semanticName} */` : " /* unmatched in Vite */";
      return `${dot || ""}${match.hash}${label}`;
    });

    $("translator-output").value = translated;
    const tbody = $("translator-rows");
    if (!seen.size) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--gp-sub)">Paste CSS rules, old Webpack hashes, or Vite hashes above to see semantic translations.</td></tr>`;
      return;
    }
    tbody.innerHTML = [...seen.values()].map(({ token, source, entry }) => {
      const sem = entry.semanticName ? `${entry.moduleName}.${entry.semanticName}` : "Unmatched";
      return `<tr class="clickable" data-jump="${esc(entry.id)}">` +
        `<td class="mono">${esc(token)}</td>` +
        `<td>${esc(source)}</td>` +
        `<td><strong>${esc(sem)}</strong></td>` +
        `<td class="mono">${esc(entry.hash)}</td>` +
        `<td><span class="badge b-${entry.confidence}">${esc(entry.confidence)}</span></td>` +
      `</tr>`;
    }).join("");
    tbody.querySelectorAll("tr[data-jump]").forEach((tr) => {
      tr.addEventListener("click", () => {
        const k = tr.getAttribute("data-jump");
        if (k) openDetail(k);
      });
    });
  }

  function routeFromHash() {
    const h = decodeURIComponent((location.hash || "").replace(/^#/, ""));
    if (!h) return;
    if (h === "translate") {
      setTab("translate");
      return;
    }
    if (h === "gallery" && state.hasPreviews) {
      setTab("gallery");
      return;
    }
    if (h.startsWith("q/")) {
      const q = h.slice(2);
      $("omnibox").value = q;
      state.query = q;
      setTab("all");
      return;
    }
    if (h.startsWith("hash/")) {
      const tok = h.slice(5);
      const c = state.byHash.get(tok) || state.byWebpackHash.get(tok);
      if (c) openDetail(c.id, false);
      return;
    }
    const colonKey = h.replace("/", ":");
    if (state.byKey.has(colonKey)) {
      openDetail(colonKey, false);
      return;
    }
    const [prefix, ...rest] = h.split("/");
    const tail = rest.join("/");
    if (prefix === "comp" || prefix === "store" || prefix === "exp") {
      const found = state.data.exports.find((e) => e.name === tail || e.id === `${prefix}:${tail}`);
      if (found) openDetail(found.id, false);
    } else if (prefix === "css") {
      const found = state.data.cssClasses.find((c) => c.id === `css:${tail}` || `${c.moduleName}/${c.semanticName}` === tail);
      if (found) openDetail(found.id, false);
    }
  }

  async function init() {
    const embedded = document.getElementById("guide-data");
    let data;
    try {
      if (embedded) {
        data = JSON.parse(embedded.textContent || "{}");
      } else {
        const url = document.documentElement.getAttribute("data-json-url") || "./data.json";
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
        data = await res.json();
      }
    } catch (err) {
      $("list-count").textContent = "Failed to load guide data: " + err;
      return;
    }

    buildSearchIndex(data);
    renderHeader();

    document.querySelectorAll(".tab-btn[data-tab]").forEach((b) => {
      b.addEventListener("click", () => setTab(b.getAttribute("data-tab") || "all"));
    });

    document.querySelectorAll(".chip[data-conf]").forEach((c) => {
      c.addEventListener("click", () => {
        const val = c.getAttribute("data-conf");
        if (state.conf.has(val)) state.conf.delete(val); else state.conf.add(val);
        c.classList.toggle("active", state.conf.has(val));
        applyFilters();
      });
    });
    document.querySelectorAll(".chip[data-mig]").forEach((c) => {
      c.addEventListener("click", () => {
        const val = c.getAttribute("data-mig");
        if (state.mig.has(val)) state.mig.delete(val); else state.mig.add(val);
        c.classList.toggle("active", state.mig.has(val));
        applyFilters();
      });
    });

    let debounceTimer;
    $("omnibox").addEventListener("input", (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.query = e.target.value;
        if (state.tab === "translate") setTab("all");
        else applyFilters();
      }, 60);
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== $("omnibox") && document.activeElement !== $("translator-input")) {
        e.preventDefault();
        $("omnibox").focus();
      } else if (e.key === "Escape") {
        if ($("detail-drawer").classList.contains("open")) closeDrawer();
        else if (state.query) { $("omnibox").value = ""; state.query = ""; applyFilters(); }
      }
    });

    $("virtual-viewport").addEventListener("scroll", () => renderVirtual());
    $("virtual-items").addEventListener("click", (e) => {
      const rowEl = e.target.closest(".row[data-key]");
      if (rowEl) openDetail(rowEl.getAttribute("data-key"));
    });

    $("translator-input").addEventListener("input", runTranslator);
    $("copy-translated").addEventListener("click", (e) => copyText($("translator-output").value, e.target));

    window.addEventListener("hashchange", routeFromHash);

    // When local visual previews are bundled, open directly onto the Visual Gallery so users immediately see Steam components!
    if (state.hasPreviews && !location.hash) {
      setTab("gallery");
    } else {
      applyFilters();
      routeFromHash();
    }
  }

  init();
})();
