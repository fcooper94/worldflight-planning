document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('wfWorldMap');
  if (!el || typeof L === 'undefined') return;

  if (window.__WF_MAP_INITIALIZED__) return;
  window.__WF_MAP_INITIALIZED__ = true;

  /* --------------------------------------------------
     MAP: single world, no wrap
  -------------------------------------------------- */
  const map = L.map(el, {
    zoomControl: true,
    maxBounds: [[-85, -180], [85, 180]],
    maxBoundsViscosity: 1.0
  });

  const baseLayer = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    {
      subdomains: 'abcd',
      maxZoom: 19,
      noWrap: true
    }
  ).addTo(map);

  map.setView([20, 0], 2);
  requestAnimationFrame(() => map.invalidateSize(true));

  /* --------------------------------------------------
     Layers
  -------------------------------------------------- */
  const atcLayer = L.layerGroup().addTo(map);
  const airportLayer = L.layerGroup().addTo(map);

  /* Keep last good payload so modal can re-render instantly */
  let lastData = null;

  /* --------------------------------------------------
     Loading overlay
  -------------------------------------------------- */
  function ensureOverlay(container) {
    // keep existing behavior; ensure position for overlay
    if (!container.style.position) container.style.position = 'relative';

    let o = container.querySelector('.wf-map-loading');
    if (!o) {
      o = document.createElement('div');
      o.className = 'wf-map-loading';
      o.innerHTML = `
        <div class="panel">
          <div class="title">Loading ATC routes…</div>
          <div class="msg" id="wfMapLoadingMsg">Requesting data</div>
        </div>`;
      container.appendChild(o);
    }
    return o;
  }

  function setOverlay(o, show, msg) {
    o.style.display = show ? 'flex' : 'none';
    const m = o.querySelector('#wfMapLoadingMsg');
    if (m && msg) m.textContent = msg;
  }

  const WF_CACHE_TTL = 1000 * 60 * 30; // 30 minutes

  function wfCacheKey(qs) {
    return `wfWorldMap:${qs || 'default'}`;
  }

  function getCachedMapData(key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;

      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts > WF_CACHE_TTL) {
        sessionStorage.removeItem(key);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  function setCachedMapData(key, data) {
    try {
      sessionStorage.setItem(
        key,
        JSON.stringify({ ts: Date.now(), data })
      );
    } catch {
      /* storage full / disabled — ignore */
    }
  }

  /* --------------------------------------------------
     Airport marker
  -------------------------------------------------- */
  function airportIcon(label) {
    return L.divIcon({
      className: 'wf-airport-label',
      html: `
        <div class="wf-airport-pin"></div>
        <div class="wf-airport-text">${label}</div>`,
      iconSize: [1, 1]
    });
  }

  /* --------------------------------------------------
     Antimeridian split (PHNL → PWAK fix)
  -------------------------------------------------- */
  function splitAtDateline(points) {
    if (points.length < 2) return [];
    const segs = [];
    let cur = [points[0]];

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (Math.abs(b[1] - a[1]) > 180) {
        if (cur.length > 1) segs.push(cur);
        cur = [b];
      } else {
        cur.push(b);
      }
    }
    if (cur.length > 1) segs.push(cur);
    return segs;
  }

  /* --------------------------------------------------
     Rendering (reusable for modal map)
  -------------------------------------------------- */
  function clearLeafletLayers(targetMap) {
    // remove marker/popup/line layers we created (leave base tiles)
    targetMap.eachLayer(layer => {
      if (layer === targetMap._wfBaseTileLayer) return;
      targetMap.removeLayer(layer);
    });
  }

function resizeMapToBoundsAspect(map, bounds, {
  minHeight = 280,
  maxHeight = 900,
  padding = 24
} = {}) {
  if (!bounds || !bounds.length) return;

  const latLngBounds = L.latLngBounds(bounds);
  const zoom = map.getZoom();

  const nw = latLngBounds.getNorthWest();
  const se = latLngBounds.getSouthEast();

  const pNW = map.project(nw, zoom);
  const pSE = map.project(se, zoom);

  const boundsPixelWidth  = Math.abs(pSE.x - pNW.x);
  const boundsPixelHeight = Math.abs(pSE.y - pNW.y);

  if (!boundsPixelWidth || !boundsPixelHeight) return;

  const container = map.getContainer();
  const containerWidth = container.clientWidth;

  let targetHeight =
    containerWidth * (boundsPixelHeight / boundsPixelWidth);

  targetHeight += padding * 2;

  targetHeight = Math.max(minHeight, Math.min(maxHeight, targetHeight));

  container.style.height = `${Math.round(targetHeight)}px`;
  map.invalidateSize(true);
}


  function renderData(targetMap, data) {
    if (!data) return;

    const localAtc = L.layerGroup().addTo(targetMap);
    const localAirports = L.layerGroup().addTo(targetMap);

    const airports = data.airports || {};
    const wfPath = data.wfPath || [];
    const booking = data.bookingLinks || {};
    const bounds = [];

    // Airports
    wfPath.forEach(icao => {
      const a = airports[icao];
      if (!a) return;

      const ll = [a.lat, a.lon];
      bounds.push(ll);

      L.marker(ll, { icon: airportIcon(icao) })
        .addTo(localAirports)
        .on('click', () => {
          // keep existing behavior
          window.location.href = booking[icao] || '/book';
        })
        .bindTooltip(icao, { direction: 'top', opacity: 0.9 });
    });

    // ATC Routes
    (data.atcPolylines || []).forEach(leg => {
      const pts = (leg.points || [])
        .filter(p => p && p.lat != null && p.lon != null)
        .map(p => [Number(p.lat), Number(p.lon)]);

      splitAtDateline(pts).forEach(seg => {
        L.polyline(seg, {
          weight: 4,
          opacity: 0.95,
          noClip: true
        })
          .addTo(localAtc)
          .bindPopup(
            `<strong>${leg.from} → ${leg.to}</strong><br>
             <div style="margin-top:6px;
               font-family: JetBrains Mono, monospace;
               font-size:12px;
               white-space:pre-wrap;">
               ${(leg.atc_route || '').replace(/</g, '&lt;')}
             </div>`
          );
      });
    });
// Fit
if (bounds.length) {
  targetMap.fitBounds(bounds, {
    padding: [24, 24],
    maxZoom: 5,
    animate: false
  });

  requestAnimationFrame(() => {
  // Only auto-resize inline map, NOT modal
  if (targetMap.getContainer().id !== 'wfMapModalMap') {
    resizeMapToBoundsAspect(targetMap, bounds);
  } else {
    targetMap.invalidateSize(true);
  }
});

}
} // ← REQUIRED: closes renderData()


  /* --------------------------------------------------
     Load + render (main map)
  -------------------------------------------------- */
  async function load() {
    const overlay = ensureOverlay(el);
    setOverlay(overlay, true, 'Requesting route data…');

    const q = window.WF_MAP_QUERY || {};
    const qs = new URLSearchParams(q).toString();

    const cacheKey = wfCacheKey(qs);
    let data = getCachedMapData(cacheKey);

    if (!data) {
      const res = await fetch('/api/wf/world-map' + (qs ? `?${qs}` : ''), {
        credentials: 'same-origin'
      });

      if (!res.ok) {
        setOverlay(overlay, true, `Failed (${res.status})`);
        return;
      }

      const text = await res.text();
      if (text.trim().startsWith('<')) {
        setOverlay(overlay, true, 'Session expired – refresh');
        return;
      }

      data = JSON.parse(text);
      setCachedMapData(cacheKey, data);
    }

    lastData = data;

    // Clear and render on main map using existing layers
    atcLayer.clearLayers();
    airportLayer.clearLayers();

    const airports = data.airports || {};
    const wfPath = data.wfPath || [];
    const booking = data.bookingLinks || {};
    const bounds = [];

    wfPath.forEach(icao => {
      const a = airports[icao];
      if (!a) return;

      const ll = [a.lat, a.lon];
      bounds.push(ll);

      L.marker(ll, { icon: airportIcon(icao) })
        .addTo(airportLayer)
        .on('click', () => (window.location.href = booking[icao] || '/book'))
        .bindTooltip(icao, { direction: 'top', opacity: 0.9 });
    });

    setOverlay(overlay, true, 'Rendering ATC routes…');

    requestAnimationFrame(() => {
      (data.atcPolylines || []).forEach(leg => {
        const pts = (leg.points || [])
          .filter(p => p && p.lat != null && p.lon != null)
          .map(p => [Number(p.lat), Number(p.lon)]);

        splitAtDateline(pts).forEach(seg => {
          L.polyline(seg, {
            weight: 4,
            opacity: 0.95,
            noClip: true
          })
            .addTo(atcLayer)
            .bindPopup(
              `<strong>${leg.from} → ${leg.to}</strong><br>
               <div style="margin-top:6px;
                 font-family: JetBrains Mono, monospace;
                 font-size:12px;
                 white-space:pre-wrap;">
                 ${(leg.atc_route || '').replace(/</g, '&lt;')}
               </div>`
            );
        });
      });

      setOverlay(overlay, false);
    });

    // FIX: boundsPts was undefined; use bounds
    if (bounds.length) {
      map.fitBounds(bounds, {
        padding: [24, 24],
        maxZoom: 5,
        animate: false
      });

      setTimeout(() => {
        map.invalidateSize(true);
      }, 0);
    }
  }

  load().catch(console.error);

  /* --------------------------------------------------
     EXPAND to modal (WF map)
     - Creates modal DOM if missing
     - Only triggers when click comes from within WF map container
  -------------------------------------------------- */
  let modalMap = null;




  function ensureWfModal() {
    let modal = document.getElementById('wfMapModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'wfMapModal';
    // Reuse your existing map-modal styling
    modal.className = 'map-modal hidden';

    modal.innerHTML = `
      <div class="map-modal-backdrop" data-wf-close="1"></div>
      <div class="map-modal-panel">
        <div class="map-modal-header">
          <span>WF Route Map</span>
          <button type="button" aria-label="Close map" data-wf-close="1">✕</button>
        </div>
        <div class="icao-map">
          <div id="wfMapModalMap" style="width:100%;height:100%;min-height:0;"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    return modal;
  }

  function openWfModal() {
    const modal = ensureWfModal();
    modal.classList.remove('hidden');

    setTimeout(() => {
      if (!modalMap) {
        modalMap = L.map('wfMapModalMap', {
          zoomControl: true,
          attributionControl: false
        });

        // Use same base tiles (dark) as main map for now
        const modalBase = L.tileLayer(
          'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
          { subdomains: 'abcd', maxZoom: 19, noWrap: true }
        ).addTo(modalMap);

        modalMap._wfBaseTileLayer = modalBase;
      } else {
        modalMap.invalidateSize(true);
      }

      // Re-render into modal map
      clearLeafletLayers(modalMap);
      renderData(modalMap, lastData);
      modalMap.invalidateSize(true);
    }, 50);
  }

  function closeWfModal() {
    document.getElementById('wfMapModal')?.classList.add('hidden');
  }

  // Close handlers (backdrop + button + ESC)
  document.addEventListener('click', (e) => {
    const close = e.target.closest('[data-wf-close="1"]');
    if (close) closeWfModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeWfModal();
  });

  // Expand button binding (scoped to WF map container)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#wfExpandMapBtn, .wf-expand-map-btn, .map-expand-btn, [data-wf-expand="1"]');
    if (!btn) return;

    // Only respond if button is within the WF map area (avoid ICAO conflicts)
    const wfContainer = el.closest('.card') || el.parentElement;
    if (wfContainer && !wfContainer.contains(btn)) return;

    openWfModal();
  });
});
