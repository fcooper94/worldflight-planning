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

    // Dots: all added at once (canvas = fast)
    for (const ap of airportList) {
      L.circleMarker(ap.ll, {
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
    }

    // Labels: built lazily on first zoom-in, then toggled
    function buildLabels() {
      if (labelsBuilt) return;
      labelsBuilt = true;
      for (const ap of airportList) {
        L.marker(ap.ll, { icon: airportIcon(ap.icao) })
          .bindPopup(popupHtml(ap.icao, ap.data), {
            closeButton: true,
            autoPan: true,
            maxWidth: 320,
            className: 'wf-airport-leaflet-popup'
          })
          .addTo(labelLayer);
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
  }

  load().catch(console.error);
});
