document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('prevDestMap');
  if (!el || typeof L === 'undefined') return;

  if (window.__PREV_DEST_MAP_INITIALIZED__) return;
  window.__PREV_DEST_MAP_INITIALIZED__ = true;

  /* ---- Map ---- */
  const map = L.map(el, { zoomControl: true, preferCanvas: true });

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    { subdomains: 'abcd', maxZoom: 19 }
  ).addTo(map);

  map.setView([20, 0], 3);
  requestAnimationFrame(() => map.invalidateSize(true));

  /* ---- Loading overlay ---- */
  function ensureOverlay(container) {
    if (!container.style.position) container.style.position = 'relative';
    let o = container.querySelector('.wf-map-loading');
    if (!o) {
      o = document.createElement('div');
      o.className = 'wf-map-loading';
      o.innerHTML = `
        <div class="panel">
          <div class="title">Loading previous destinations...</div>
          <div class="msg" id="prevDestLoadingMsg">Requesting data</div>
        </div>`;
      container.appendChild(o);
    }
    return o;
  }

  function setOverlay(o, show, msg) {
    o.style.display = show ? 'flex' : 'none';
    const m = o.querySelector('#prevDestLoadingMsg');
    if (m && msg) m.textContent = msg;
  }

  /* ---- Airport label icon (DOM - only used when zoomed in) ---- */
  function airportIcon(label) {
    return L.divIcon({
      className: 'wf-airport-label',
      html: `
        <div class="wf-airport-pin"></div>
        <div class="wf-airport-text">${label}</div>`,
      iconSize: [1, 1]
    });
  }

  /* ---- Popup ---- */
  function popupHtml(icao, data) {
    const visitLines = data.visits
      .map(v => `<div class="wf-airport-leg">${v.year}${v.eventName ? ' — ' + v.eventName : ''}</div>`)
      .join('');

    return `
      <div class="wf-airport-popup">
        <div class="wf-airport-popup-header">${icao}${data.name ? ' — ' + data.name : ''}</div>
        <div class="wf-airport-section">
          <div class="wf-airport-section-title">Visited ${data.visits.length} time${data.visits.length !== 1 ? 's' : ''}</div>
          ${visitLines}
        </div>
        <div class="wf-airport-popup-actions">
          <button class="wf-airport-action-btn" data-icao="${icao}">
            View Airport Details
          </button>
        </div>
      </div>
    `;
  }

  /* ---- Click handler for popup buttons ---- */
  document.addEventListener('click', e => {
    const btn = e.target.closest('.wf-airport-action-btn');
    if (!btn) return;
    const icao = btn.getAttribute('data-icao');
    if (icao) window.location.href = `/icao/${icao}`;
  });

  /* ---- Sidebar toggle ---- */
  window.addEventListener('sidebar:toggle', () => {
    requestAnimationFrame(() => map.invalidateSize(true));
  });

  /* ---- Search box (centred top, below the site banner) ---- */
  function injectSearchBox(mapRef) {
    const mapContainer = mapRef.getContainer();
    const wrap = L.DomUtil.create('div', 'wf-search-box', mapContainer);
    wrap.innerHTML = `
      <div class="wf-search-inner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:#94a3b8;flex-shrink:0;">
          <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <input type="search" class="wf-search-input" placeholder="Search ICAO or airport name..." autocomplete="off" spellcheck="false" />
      </div>
      <div class="wf-search-results" role="listbox"></div>
    `;
    L.DomEvent.disableClickPropagation(wrap);
    L.DomEvent.disableScrollPropagation(wrap);
    return wrap;
  }

  function injectSearchStyles() {
    if (document.getElementById('wf-search-styles')) return;
    const st = document.createElement('style');
    st.id = 'wf-search-styles';
    st.textContent = `
      .wf-search-box {
        position:absolute; top:72px; left:50%; transform:translateX(-50%);
        z-index:500; width:min(320px, calc(100% - 60px));
        font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
        pointer-events:auto;
      }
      .wf-search-inner {
        display:flex; align-items:center; gap:8px;
        background:rgba(11,18,32,0.92); border:1px solid rgba(56,189,248,0.25);
        border-radius:10px; padding:8px 12px;
        box-shadow:0 8px 24px rgba(0,0,0,0.4);
        backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
      }
      .wf-search-inner:focus-within { border-color:#38bdf8; box-shadow:0 8px 24px rgba(0,0,0,0.4), 0 0 0 2px rgba(56,189,248,0.15); }
      .wf-search-input {
        flex:1; background:transparent; border:0; color:#e2e8f0; font-size:13px;
        font-family:inherit; outline:none; padding:0;
      }
      .wf-search-input::placeholder { color:#64748b; }
      .wf-search-results {
        margin-top:6px; max-height:320px; overflow-y:auto;
        background:rgba(11,18,32,0.96); border:1px solid rgba(56,189,248,0.2);
        border-radius:10px; display:none;
        box-shadow:0 12px 32px rgba(0,0,0,0.5);
        backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
      }
      .wf-search-results.open { display:block; }
      .wf-search-item {
        display:flex; align-items:center; gap:10px; padding:9px 12px;
        cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.04);
      }
      .wf-search-item:last-child { border-bottom:0; }
      .wf-search-item:hover, .wf-search-item.active { background:rgba(56,189,248,0.1); }
      .wf-search-icao { font-family:monospace; font-weight:700; color:#38bdf8; font-size:13px; min-width:46px; }
      .wf-search-name { flex:1; color:#e2e8f0; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .wf-search-meta { font-size:11px; color:#64748b; white-space:nowrap; }
      .wf-search-empty { padding:12px; font-size:12px; color:#64748b; text-align:center; }
    `;
    document.head.appendChild(st);
  }

  /* ---- Load data ---- */
  async function load() {
    const overlay = ensureOverlay(el);
    setOverlay(overlay, true, 'Requesting destination data...');

    const res = await fetch('/api/previous-destinations', { credentials: 'same-origin' });
    if (!res.ok) {
      setOverlay(overlay, true, `Failed (${res.status})`);
      return;
    }

    const payload = await res.json();
    const airports = payload.airports || {};
    const allBounds = [];

    /* Pre-build data array */
    const airportList = [];
    Object.entries(airports).forEach(([icao, data]) => {
      const ll = L.latLng(data.lat, data.lon);
      allBounds.push(ll);
      airportList.push({ icao, data, ll });
    });

    /*
     * Two layers:
     *  1. dotLayer   – canvas-rendered circleMarkers, always visible, fast
     *  2. labelLayer – DOM divIcon markers with ICAO text, only when zoomed in
     */
    const dotLayer = L.layerGroup().addTo(map);
    const labelLayer = L.layerGroup();
    const LABEL_ZOOM = 5;
    let labelsBuilt = false;
    let labelsShown = false;

    // Dots: primary marker + two copies at lon±360 so the dots repeat on
    // every horizontal iteration of the world, not just the centre copy.
    const WORLD_SHIFTS = [-360, 0, 360];
    for (const ap of airportList) {
      WORLD_SHIFTS.forEach((shift, idx) => {
        const ll = L.latLng(ap.data.lat, ap.data.lon + shift);
        const m = L.circleMarker(ll, {
          radius: 3,
          color: '#00e5a0',
          fillColor: '#00e5a0',
          fillOpacity: 0.85,
          weight: 1
        })
          .addTo(dotLayer)
          .bindPopup(popupHtml(ap.icao, ap.data), {
            closeButton: true,
            autoPan: true,
            maxWidth: 320,
            className: 'wf-airport-leaflet-popup'
          });
        // Only keep a reference to the centre copy for the search "fly to"
        if (shift === 0) ap.marker = m;
      });
    }

    // Labels: built lazily on first zoom-in, then toggled.
    // Same world-copy trick as the dots so the ICAO labels repeat too.
    function buildLabels() {
      if (labelsBuilt) return;
      labelsBuilt = true;
      for (const ap of airportList) {
        WORLD_SHIFTS.forEach(shift => {
          L.marker(L.latLng(ap.data.lat, ap.data.lon + shift), { icon: airportIcon(ap.icao) })
            .bindPopup(popupHtml(ap.icao, ap.data), {
              closeButton: true,
              autoPan: true,
              maxWidth: 320,
              className: 'wf-airport-leaflet-popup'
            })
            .addTo(labelLayer);
        });
      }
    }

    function updateLabels() {
      const zoom = map.getZoom();
      if (zoom >= LABEL_ZOOM && !labelsShown) {
        buildLabels();
        map.addLayer(labelLayer);
        labelsShown = true;
      } else if (zoom < LABEL_ZOOM && labelsShown) {
        map.removeLayer(labelLayer);
        labelsShown = false;
      }
    }

    map.on('zoomend', updateLabels);

    if (allBounds.length) {
      const sidebarWidth = document.body.classList.contains('sidebar-collapsed') ? 72 : 220;

      map.fitBounds(allBounds, {
        paddingTopLeft: [sidebarWidth + 24, 24],
        paddingBottomRight: [24, 24],
        animate: false
      });

      requestAnimationFrame(() => map.invalidateSize(true));
    }

    updateLabels();
    setOverlay(overlay, false);

    /* ---- Search UI ---- */
    injectSearchStyles();
    const searchBox = injectSearchBox(map);
    const searchInput = searchBox.querySelector('.wf-search-input');
    const resultsBox = searchBox.querySelector('.wf-search-results');
    let activeIdx = -1;
    let currentResults = [];

    function render(results, query) {
      currentResults = results;
      activeIdx = -1;
      if (!results.length) {
        var q = (query || '').trim().toUpperCase();
        var msg = q && /^[A-Z0-9]{1,4}$/.test(q)
          ? 'WorldFlight has never visited ' + q
          : 'No matching airports';
        resultsBox.innerHTML = '<div class="wf-search-empty">' + msg + '</div>';
        resultsBox.classList.add('open');
        return;
      }
      resultsBox.innerHTML = results.map((r, i) => {
        const name = (r.data.name || '').replace(/"/g, '&quot;');
        const visits = r.data.visits.length;
        return '<div class="wf-search-item" data-idx="' + i + '" role="option">' +
          '<span class="wf-search-icao">' + r.icao + '</span>' +
          '<span class="wf-search-name">' + (name || '&mdash;') + '</span>' +
          '<span class="wf-search-meta">' + visits + ' visit' + (visits !== 1 ? 's' : '') + '</span>' +
          '</div>';
      }).join('');
      resultsBox.classList.add('open');
    }

    function hide() {
      resultsBox.classList.remove('open');
      activeIdx = -1;
    }

    function setActive(idx) {
      const items = resultsBox.querySelectorAll('.wf-search-item');
      items.forEach(it => it.classList.remove('active'));
      if (idx >= 0 && idx < items.length) {
        items[idx].classList.add('active');
        items[idx].scrollIntoView({ block: 'nearest' });
      }
      activeIdx = idx;
    }

    function select(entry) {
      if (!entry) return;
      hide();
      searchInput.value = '';
      searchInput.blur();
      // Ensure label layer loads if we're jumping deep
      map.flyTo(entry.ll, Math.max(map.getZoom(), 9), { duration: 0.8 });
      setTimeout(() => {
        updateLabels();
        if (entry.marker) entry.marker.openPopup();
      }, 820);
    }

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) { hide(); return; }
      const matches = airportList.filter(ap => {
        const icao = ap.icao.toLowerCase();
        const name = (ap.data.name || '').toLowerCase();
        return icao.indexOf(q) !== -1 || name.indexOf(q) !== -1;
      }).slice(0, 12);
      render(matches, q);
    });

    searchInput.addEventListener('keydown', e => {
      if (!resultsBox.classList.contains('open')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, currentResults.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const idx = activeIdx >= 0 ? activeIdx : 0;
        if (currentResults[idx]) select(currentResults[idx]);
      } else if (e.key === 'Escape') { hide(); searchInput.blur(); }
    });

    resultsBox.addEventListener('click', e => {
      const item = e.target.closest('.wf-search-item');
      if (!item) return;
      const idx = Number(item.dataset.idx);
      if (Number.isFinite(idx)) select(currentResults[idx]);
    });

    document.addEventListener('click', e => {
      if (!searchBox.contains(e.target)) hide();
    });
  }

  load().catch(console.error);
});
