/* Valchiusella Trail — static front end (Leaflet + Chart.js, no build step). */
(() => {
  "use strict";

  const DIFF_COLOR = { T: "#2e9e6a", E: "#e2a614", EE: "#e0602c", EEA: "#8b2f5c" };
  const NO_DIFF_COLOR = "#3c5257";
  const INK = "#12262b";
  const NOW_MONTH = new Date().getMonth() + 1;
  const MOBILE = () => window.matchMedia("(max-width: 820px)").matches;

  const ICON = {
    dist: '<svg viewBox="0 0 24 24"><path d="M4 18c3 0 4-12 8-12s5 12 8 12"/></svg>',
    up: '<svg viewBox="0 0 24 24"><path d="M4 19 10 9l4 5 6-9"/><path d="M15 5h5v5"/></svg>',
    peak: '<svg viewBox="0 0 24 24"><path d="M3 20 10 7l4 6 2-3 5 10Z"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    dl: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-5-5m5 5 5-5M5 20h14"/></svg>',
    drop: '<svg viewBox="0 0 24 24"><path d="M12 2C9 7 5 10.5 5 15a7 7 0 0 0 14 0c0-4.5-4-8-7-13Z"/></svg>',
    flag: '<svg viewBox="0 0 24 24"><path d="M6 21V4h11l-2 4 2 4H8v9Z"/></svg>',
    snow: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#2b7fc4" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 2 3-2M9 20l3-2 3 2"/></svg>',
    hub: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"><path d="M3 19 9.5 8l3.5 5 2.5-3L21 19Z"/></svg>',
  };

  const state = {
    cfg: null,
    trails: [],
    lang: "it",
    selected: null,
    filters: { q: "", type: "all", dmin: null, dmax: null, diff: new Set(), act: new Set(), season: false, hub: false },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const t = (key) => I18N[state.lang][key];
  const loc = (obj) => (obj && (obj[state.lang] || obj.it || obj.en)) || "";
  const colorOf = (trail) => DIFF_COLOR[trail.difficulty] || NO_DIFF_COLOR;
  const fmt = (n, d = 0) => (n == null ? "–" : Number(n).toLocaleString(state.lang === "it" ? "it-IT" : "en-GB", { maximumFractionDigits: d, minimumFractionDigits: d }));

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // ------------------------------------------------------------ map
  let map, layerControl, cursorMarker, poiLayer, chart;
  const trailLayers = new Map(); // slug -> { casing, line, hit, start }

  function fitPadding() {
    if (MOBILE()) {
      return { paddingTopLeft: [24, 80], paddingBottomRight: [24, $("#panel").offsetHeight + 24] };
    }
    return { paddingTopLeft: [$("#panel").offsetWidth + 50, 90], paddingBottomRight: [50, 40] };
  }

  function baseLayers() {
    const L_ = I18N[state.lang].layers;
    const layers = {};
    layers[L_.topo] = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | Style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    });
    const key = state.cfg.map && state.cfg.map.thunderforest_key;
    if (key) {
      layers[L_.outdoors] = L.tileLayer(`https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=${encodeURIComponent(key)}`, {
        maxZoom: 22,
        attribution: 'Maps © <a href="https://www.thunderforest.com">Thunderforest</a>, Data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      });
    }
    layers[L_.osm] = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    layers[L_.sat] = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    });
    return layers;
  }

  let currentBase = 0;
  function setupLayerControl() {
    const layers = baseLayers();
    const names = Object.keys(layers);
    map.eachLayer((l) => { if (l instanceof L.TileLayer) map.removeLayer(l); });
    if (layerControl) layerControl.remove();
    layers[names[Math.min(currentBase, names.length - 1)]].addTo(map);
    layerControl = L.control.layers(layers, null, { position: "topright" }).addTo(map);
    map.off("baselayerchange").on("baselayerchange", (e) => { currentBase = names.indexOf(e.name); });
  }

  function initMap() {
    const m = state.cfg.map || {};
    map = L.map("map", { zoomControl: false }).setView(m.center || [45.515, 7.72], m.zoom || 12);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);
    setupLayerControl();

    const hub = state.cfg.hub;
    if (hub && hub.lat != null) {
      const icon = L.divIcon({ className: "", html: `<div class="hub-pin">${ICON.hub}</div>`, iconSize: [40, 40], iconAnchor: [20, 20] });
      L.marker([hub.lat, hub.lon], { icon, zIndexOffset: 1000, title: hub.name })
        .addTo(map)
        .bindPopup(() => `<strong>${esc(hub.name)}</strong><br><span class="muted">${esc(t("hub"))}</span>` +
          (hub.url ? `<br><a href="${esc(hub.url)}" target="_blank" rel="noopener">${esc(hub.url.replace(/^https?:\/\//, ""))}</a>` : ""));
    }

    for (const tr of state.trails) {
      const color = colorOf(tr);
      const casing = L.polyline(tr.line, { color: INK, weight: 8, opacity: 0.55, interactive: false, lineJoin: "round" });
      const line = L.polyline(tr.line, { color, weight: 5, opacity: 1, interactive: false, lineJoin: "round" });
      const hit = L.polyline(tr.line, { color: "#000", weight: 20, opacity: 0, interactive: true });
      const start = L.marker(tr.start, {
        icon: L.divIcon({ className: "", html: `<div class="start-pin" style="--c:${color}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
      });
      hit.on("click", () => go(tr.slug));
      start.on("click", () => go(tr.slug));
      hit.on("mouseover", () => hoverTrail(tr.slug, true));
      hit.on("mouseout", () => { hoverTrail(tr.slug, false); hideCursor(); });
      hit.on("mousemove", (e) => { if (state.selected === tr.slug) syncChartToLatLng(e.latlng); });
      hit.bindTooltip(() => loc(tr.title), { sticky: true, className: "trail-tip" });
      trailLayers.set(tr.slug, { casing, line, hit, start });
    }

    poiLayer = L.layerGroup().addTo(map);
    cursorMarker = L.marker([0, 0], {
      icon: L.divIcon({ className: "", html: '<div class="cursor-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false, zIndexOffset: 2000,
    });
  }

  function hoverTrail(slug, on) {
    const lay = trailLayers.get(slug);
    if (!lay) return;
    if (!state.selected) {
      lay.line.setStyle({ weight: on ? 7 : 5 });
      lay.casing.setStyle({ weight: on ? 11 : 8 });
      if (on) { lay.casing.bringToFront(); lay.line.bringToFront(); lay.hit.bringToFront(); }
    }
    const card = $(`.card[data-slug="${CSS.escape(slug)}"]`);
    if (card) card.classList.toggle("hl", on);
  }

  function showOnMap(visibleSlugs) {
    for (const [slug, lay] of trailLayers) {
      const show = visibleSlugs.has(slug);
      for (const l of [lay.casing, lay.line, lay.hit, lay.start]) {
        if (show && !map.hasLayer(l)) l.addTo(map);
        if (!show && map.hasLayer(l)) map.removeLayer(l);
      }
    }
  }

  function styleForSelection() {
    for (const [slug, lay] of trailLayers) {
      const tr = state.trails.find((x) => x.slug === slug);
      const sel = state.selected;
      const isSel = sel === slug;
      const dim = sel && !isSel;
      lay.line.setStyle({ color: dim ? "#8a9799" : colorOf(tr), weight: isSel ? 7 : 5, opacity: dim ? 0.55 : 1 });
      lay.casing.setStyle({ weight: isSel ? 12 : 8, opacity: dim ? 0.15 : 0.55 });
      if (isSel) { lay.casing.bringToFront(); lay.line.bringToFront(); lay.hit.bringToFront(); }
    }
  }

  // ------------------------------------------------------------ filters
  function matches(tr) {
    const f = state.filters;
    if (f.q) {
      const hay = [tr.title.it, tr.title.en, tr.description.it, tr.description.en].join(" ").toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    if (f.type !== "all" && tr.type !== f.type) return false;
    if (f.dmin != null && tr.distance_km < f.dmin) return false;
    if (f.dmax != null && tr.distance_km > f.dmax) return false;
    if (f.diff.size && !f.diff.has(tr.difficulty)) return false;
    if (f.act.size && !tr.activity.some((a) => f.act.has(a))) return false;
    if (f.season && tr.season.length && !tr.season.includes(NOW_MONTH)) return false;
    if (f.hub && !tr.from_hub) return false;
    return true;
  }

  function syncQuickChips() {
    const f = state.filters;
    const on = { loop: f.type === "loop", point: f.type === "point", season: f.season, hub: f.hub, trail: f.act.has("trail"), hike: f.act.has("hike") };
    $$("#quick button").forEach((b) => b.classList.toggle("on", !!on[b.dataset.q]));
    const adv = (f.dmin != null) + (f.dmax != null) + f.diff.size;
    const badge = $("#filter-badge");
    badge.hidden = !adv;
    badge.textContent = adv;
  }

  function bindFilters() {
    const f = state.filters;
    $("#f-search").addEventListener("input", (e) => {
      f.q = e.target.value.trim().toLowerCase();
      if (state.selected) go(null);
      renderList();
    });

    $$("#quick button").forEach((b) => b.addEventListener("click", () => {
      const q = b.dataset.q;
      if (q === "loop" || q === "point") f.type = f.type === q ? "all" : q;
      else if (q === "season") f.season = !f.season;
      else if (q === "hub") f.hub = !f.hub;
      else f.act.has(q) ? f.act.delete(q) : f.act.add(q);
      renderList();
    }));

    $("#filter-toggle").addEventListener("click", (e) => {
      const form = $("#filters");
      form.hidden = !form.hidden;
      e.currentTarget.setAttribute("aria-expanded", String(!form.hidden));
    });

    const num = (v) => (v === "" ? null : Math.max(0, Number(v)));
    $("#f-dmin").addEventListener("input", (e) => { f.dmin = num(e.target.value); renderList(); });
    $("#f-dmax").addEventListener("input", (e) => { f.dmax = num(e.target.value); renderList(); });
    $$("#f-diff button").forEach((b) => {
      b.style.setProperty("--c", DIFF_COLOR[b.dataset.v]);
      b.addEventListener("click", () => {
        f.diff.has(b.dataset.v) ? f.diff.delete(b.dataset.v) : f.diff.add(b.dataset.v);
        b.classList.toggle("on", f.diff.has(b.dataset.v));
        renderList();
      });
    });
    $("#filters").addEventListener("reset", () => {
      Object.assign(f, { type: "all", dmin: null, dmax: null, season: false, hub: false });
      f.diff.clear(); f.act.clear();
      $$("#f-diff button").forEach((b) => b.classList.remove("on"));
      setTimeout(renderList, 0);
    });
    $("#filters").addEventListener("submit", (e) => e.preventDefault());

    const used = new Set(state.trails.map((x) => x.difficulty));
    $$("#f-diff button").forEach((b) => { b.hidden = !used.has(b.dataset.v); });
  }

  // ------------------------------------------------------------ rendering
  function sparkline(tr) {
    const pts = tr.profile.filter((p) => p[1] != null);
    if (pts.length < 2) return '<svg class="spark"></svg>';
    const W = 92, H = 64, pad = 6;
    const maxD = pts[pts.length - 1][0];
    const ys = pts.map((p) => p[1]);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const span = Math.max(hi - lo, 150); // flat routes stay flat-looking
    const step = Math.max(1, Math.floor(pts.length / 46));
    const coords = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p) =>
      [(p[0] / maxD) * W, H - pad - ((p[1] - lo) / span) * (H - pad * 2.4)]);
    const d = coords.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join("");
    const c = colorOf(tr);
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${d}L${W},${H}L0,${H}Z" fill="${c}" fill-opacity=".22"/>
      <path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  function tagsHTML(tr) {
    const b = [];
    if (tr.difficulty) b.push(`<span class="tag diff" style="--c:${colorOf(tr)}" title="${esc(t("diffNames")[tr.difficulty])}">${tr.difficulty}</span>`);
    b.push(`<span class="tag">${esc(t(tr.type))}</span>`);
    for (const a of tr.activity) b.push(`<span class="tag">${esc(t(a))}</span>`);
    if (tr.from_hub) b.push(`<span class="tag hub">${esc(t("startsHub"))}</span>`);
    return `<div class="tags">${b.join("")}</div>`;
  }

  function renderList() {
    syncQuickChips();
    const visible = state.trails.filter(matches);
    $("#count").textContent = t("count")(visible.length);
    $("#cards").innerHTML = visible.length
      ? visible.map((tr) => `
        <li class="card" data-slug="${esc(tr.slug)}" style="--c:${colorOf(tr)}" tabindex="0">
          ${sparkline(tr)}
          <div>
            <h3>${esc(loc(tr.title))}</h3>
            <div class="meta">
              <span>${ICON.dist}${fmt(tr.distance_km, 1)} km</span>
              <span>${ICON.up}${fmt(tr.ele_gain)} m</span>
              <span>${ICON.peak}${fmt(tr.ele_max)} m</span>
            </div>
            ${tagsHTML(tr)}
          </div>
        </li>`).join("")
      : `<li class="empty">${esc(t("none"))}</li>`;

    $$(".card").forEach((c) => {
      const slug = c.dataset.slug;
      c.addEventListener("click", () => go(slug));
      c.addEventListener("keydown", (e) => { if (e.key === "Enter") go(slug); });
      c.addEventListener("mouseenter", () => hoverTrail(slug, true));
      c.addEventListener("mouseleave", () => hoverTrail(slug, false));
    });

    if (!state.selected) showOnMap(new Set(visible.map((x) => x.slug)));
  }

  function monthsHTML(season) {
    const all = !season.length;
    return `<div class="months">${t("months").map((m, i) =>
      `<span class="${all || season.includes(i + 1) ? "ok" : ""} ${i + 1 === NOW_MONTH ? "now" : ""}" title="${esc(t("monthsLong")[i])}">${m}</span>`).join("")}</div>`;
  }

  function renderDetail(tr) {
    const water = tr.pois.filter((p) => p.kind === "water");
    const other = tr.pois.filter((p) => p.kind !== "water");
    const poiList = (arr, kind) => `<ul class="pois">${arr.map((p) =>
      `<li><button data-lat="${p.lat}" data-lon="${p.lon}"><span class="dot ${kind}">${kind === "water" ? ICON.drop : ICON.flag}</span>${esc(p.name || "—")}</button></li>`).join("")}</ul>`;
    const snow = loc(tr.snow);
    const desc = loc(tr.description);

    $("#detail-view").innerHTML = `
      <div class="hero">
        <button class="back" id="back">${ICON.back}${esc(t("back"))}</button>
        <h2>${esc(loc(tr.title))}</h2>
        ${tagsHTML(tr)}
      </div>
      <div class="bigstats">
        <div><small>${esc(t("dist"))}</small><b>${fmt(tr.distance_km, 1)}<span>km</span></b></div>
        <div><small>${esc(t("gain"))}</small><b>${fmt(tr.ele_gain)}<span>m</span></b></div>
        <div><small>${esc(t("max"))}</small><b>${fmt(tr.ele_max)}<span>m</span></b></div>
      </div>
      <section class="block">
        <h4>${esc(t("profile"))}</h4>
        <div class="chart-box"><canvas id="profile"></canvas></div>
        <div class="subline">
          <span>${esc(t("loss"))} ${fmt(tr.ele_loss)} m</span>
          <span>${esc(t("min"))} ${fmt(tr.ele_min)} m</span>
          <span>${esc(tr.difficulty ? t("diffNames")[tr.difficulty] : "")}</span>
        </div>
      </section>
      ${desc ? `<section class="block"><p>${esc(desc)}</p></section>` : ""}
      <section class="block">
        <h4>${esc(t("season"))}</h4>
        ${monthsHTML(tr.season)}
        ${snow ? `<div class="snow">${ICON.snow}<span><strong>${esc(t("snow"))}:</strong> ${esc(snow)}</span></div>` : ""}
      </section>
      <section class="block">
        <h4>${esc(t("water"))}</h4>
        ${water.length ? poiList(water, "water") : `<p class="muted">${esc(t("noWater"))}</p>`}
      </section>
      ${other.length ? `<section class="block"><h4>${esc(t("poi"))}</h4>${poiList(other, "poi")}</section>` : ""}
      <div class="dl-bar">
        <a class="download" href="${esc(tr.gpx)}" download="${esc(tr.slug)}.gpx">${ICON.dl}${esc(t("download"))}</a>
      </div>`;

    $("#back").addEventListener("click", () => go(null));
    $$("#detail-view .pois button").forEach((b) => b.addEventListener("click", () => {
      if (MOBILE()) setExpanded(false);
      map.setView([+b.dataset.lat, +b.dataset.lon], Math.max(map.getZoom(), 15));
    }));

    drawChart(tr);
    drawPois(tr);
  }

  function drawPois(tr) {
    poiLayer.clearLayers();
    for (const p of tr.pois) {
      const water = p.kind === "water";
      L.marker([p.lat, p.lon], {
        icon: L.divIcon({
          className: "",
          html: water ? `<div class="water-pin">${ICON.drop}</div>` : '<div class="poi-pin"></div>',
          iconSize: water ? [26, 26] : [14, 14],
          iconAnchor: water ? [13, 13] : [7, 7],
        }),
        title: p.name,
      }).bindPopup(esc(p.name || t(water ? "water" : "poi"))).addTo(poiLayer);
    }
  }

  // ------------------------------------------------------------ elevation chart <-> map
  function drawChart(tr) {
    if (chart) { chart.destroy(); chart = null; }
    const pts = tr.profile.filter((p) => p[1] != null);
    if (!pts.length || !window.Chart) { $(".chart-box").innerHTML = '<p class="muted">–</p>'; return; }

    const canvas = $("#profile");
    const ctx = canvas.getContext("2d");
    const color = colorOf(tr);
    const grad = ctx.createLinearGradient(0, 0, 0, 180);
    grad.addColorStop(0, color + "70");
    grad.addColorStop(1, color + "08");

    chart = new Chart(ctx, {
      type: "line",
      data: { datasets: [{ data: pts.map((p) => ({ x: p[0], y: p[1] })), borderColor: color, backgroundColor: grad, fill: true, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 6, pointHoverBackgroundColor: "#fff", pointHoverBorderColor: INK, pointHoverBorderWidth: 3, tension: 0.2 }] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false, parsing: false,
        interaction: { mode: "index", intersect: false, axis: "x" },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false, backgroundColor: INK, padding: 8, cornerRadius: 8,
            titleFont: { family: "Manrope, system-ui, sans-serif", weight: "700" },
            callbacks: {
              title: (items) => `${fmt(items[0].parsed.x, 2)} km`,
              label: (item) => `${fmt(item.parsed.y)} m`,
            },
          },
        },
        scales: {
          x: { type: "linear", min: 0, max: pts[pts.length - 1][0], border: { display: false }, ticks: { color: "#6d7f82", callback: (v) => `${fmt(v, 0)} km`, maxTicksLimit: 6, font: { size: 11 } }, grid: { display: false } },
          y: { border: { display: false }, ticks: { color: "#6d7f82", callback: (v) => `${fmt(v)}`, maxTicksLimit: 4, font: { size: 11 } }, grid: { color: "#efebe4" } },
        },
        onHover: (_evt, items) => {
          if (items.length) showCursor(pts[items[0].index]);
        },
      },
    });
    chart.$pts = pts;
    canvas.addEventListener("mouseleave", hideCursor);
    canvas.addEventListener("touchend", () => setTimeout(hideCursor, 1500));
  }

  function showCursor(p) {
    cursorMarker.setLatLng([p[2], p[3]]);
    if (!map.hasLayer(cursorMarker)) cursorMarker.addTo(map);
  }
  function hideCursor() {
    if (map.hasLayer(cursorMarker)) map.removeLayer(cursorMarker);
    if (chart) { chart.setActiveElements([]); chart.tooltip.setActiveElements([], { x: 0, y: 0 }); chart.update("none"); }
  }

  function syncChartToLatLng(latlng) {
    if (!chart) return;
    const pts = chart.$pts;
    const k = Math.cos((latlng.lat * Math.PI) / 180);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dy = pts[i][2] - latlng.lat, dx = (pts[i][3] - latlng.lng) * k;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    const el = chart.getDatasetMeta(0).data[best];
    chart.setActiveElements([{ datasetIndex: 0, index: best }]);
    chart.tooltip.setActiveElements([{ datasetIndex: 0, index: best }], { x: el.x, y: el.y });
    chart.update("none");
    showCursor(pts[best]);
  }

  // ------------------------------------------------------------ mobile sheet
  function setExpanded(on) {
    $("#panel").classList.toggle("expanded", on);
    $("#grip").setAttribute("aria-expanded", String(on));
  }

  // ------------------------------------------------------------ routing
  function go(slug) { location.hash = slug ? `#/trail/${encodeURIComponent(slug)}` : "#/"; }

  function route() {
    const m = location.hash.match(/^#\/trail\/(.+)$/);
    const slug = m ? decodeURIComponent(m[1]) : null;
    const tr = slug && state.trails.find((x) => x.slug === slug);

    hideCursor();
    if (tr) {
      state.selected = tr.slug;
      $("#list-view").hidden = true;
      $("#detail-view").hidden = false;
      showOnMap(new Set(state.trails.map((x) => x.slug)));
      styleForSelection();
      renderDetail(tr);
      $("#panel").scrollTop = 0;
      if (MOBILE()) setExpanded(false);
      map.fitBounds(tr.bounds, fitPadding());
      document.title = `${loc(tr.title)} · ${state.cfg.site.title}`;
    } else {
      state.selected = null;
      if (chart) { chart.destroy(); chart = null; }
      poiLayer.clearLayers();
      $("#detail-view").hidden = true;
      $("#list-view").hidden = false;
      styleForSelection();
      renderList();
      document.title = state.cfg.site.title;
      if (slug) $("#cards").insertAdjacentHTML("afterbegin", `<li class="empty">${esc(t("notFound"))}</li>`);
    }
  }

  // ------------------------------------------------------------ language
  function applyLang(lang) {
    state.lang = I18N[lang] ? lang : "it";
    store.set("lang", state.lang);
    document.documentElement.lang = state.lang;
    $$(".lang button").forEach((b) => b.classList.toggle("on", b.dataset.lang === state.lang));
    $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    $("#site-subtitle").textContent = loc(state.cfg.site.subtitle);
    if (map) { setupLayerControl(); route(); }
  }

  function initialLang() {
    const q = new URLSearchParams(location.search).get("lang");
    if (q && I18N[q]) return q;
    const saved = store.get("lang");
    if (saved && I18N[saved]) return saved;
    return (navigator.language || "it").toLowerCase().startsWith("it") ? "it" : "en";
  }

  // ------------------------------------------------------------ boot
  async function boot() {
    const [cfg, trails] = await Promise.all([
      fetch("data/config.json").then((r) => r.json()),
      fetch("data/trails.json").then((r) => r.json()),
    ]);
    state.cfg = cfg;
    state.trails = trails;
    $("#site-title").textContent = cfg.site.title;

    applyLang(initialLang());
    initMap();
    bindFilters();
    $$(".lang button").forEach((b) => b.addEventListener("click", () => applyLang(b.dataset.lang)));
    $("#grip").addEventListener("click", () => setExpanded(!$("#panel").classList.contains("expanded")));
    window.addEventListener("hashchange", route);
    route();
    if (!state.selected && trails.length) {
      map.fitBounds(L.latLngBounds(trails.flatMap((x) => x.bounds)), fitPadding());
    }
  }

  boot().catch((err) => {
    console.error(err);
    document.getElementById("cards").innerHTML =
      `<li class="empty">Errore nel caricamento dei dati. Hai eseguito <code>uv run scripts/build.py</code>?</li>`;
  });
})();
