const WF_CACHE_TTL = 1000 * 60 * 30; // 30 minutes

function wfCacheKey(qs) {
  return `wfWorldMap:v3:${qs || 'default'}`;
}

function getSidebarOffset() {
  const body = document.body;

  // Match your actual sidebar widths
  if (body.classList.contains('sidebar-collapsed')) {
    return 72; // collapsed width (px)
  }
  return 260; // expanded width (px)
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
  } catch {}
}

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

  let lastData = null;

  /* --------------------------------------------------
     Loading overlay
  -------------------------------------------------- */
  function ensureOverlay(container) {
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

  function formatUtcDatePretty(dateStr) {
  if (!dateStr) return '';

  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d)) return dateStr;

  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const dayName = days[d.getUTCDay()];
  const dayNum = d.getUTCDate();
  const monthName = months[d.getUTCMonth()];

  const suffix =
    dayNum % 10 === 1 && dayNum !== 11 ? 'st' :
    dayNum % 10 === 2 && dayNum !== 12 ? 'nd' :
    dayNum % 10 === 3 && dayNum !== 13 ? 'rd' : 'th';

  return `${dayName} ${dayNum}${suffix} ${monthName}`;
}


  function setOverlay(o, show, msg) {
    o.style.display = show ? 'flex' : 'none';
    const m = o.querySelector('#wfMapLoadingMsg');
    if (m && msg) m.textContent = msg;
  }

  /* --------------------------------------------------
     Airport icon + hover popup
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

function airportHoverHtml(icao, a) {
  return `
    <div class="wf-airport-popup">
      <div class="wf-airport-popup-header">
        ${icao}
      </div>

      ${a.inbound ? `
        <div class="wf-airport-section inbound">
          <div class="wf-airport-section-title">Inbound</div>
          <div class="wf-airport-leg">
            ${a.inbound.wf} ${a.inbound.from} → ${a.inbound.to}
          </div>
          <div class="wf-airport-meta">
            <span>${formatUtcDatePretty(a.inbound.dateIso)}</span>
            <span class="dot">•</span>
            <span>Arr ${a.inbound.arrWindow}</span>
          </div>
        </div>
      ` : ''}

      ${a.outbound ? `
        <div class="wf-airport-section outbound">
          <div class="wf-airport-section-title">Outbound</div>
          <div class="wf-airport-leg">
            ${a.outbound.wf} ${a.outbound.from} → ${a.outbound.to}
          </div>
          <div class="wf-airport-meta">
            <span>${formatUtcDatePretty(a.outbound.dateIso)}</span>
            <span class="dot">•</span>
            <span>Dep ${a.outbound.depWindow}</span>
          </div>
        </div>
      ` : ''}

      <div class="wf-airport-popup-footer">
        Click for more details
      </div>
    </div>
  `;
}





  /* --------------------------------------------------
     Utilities
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

  function clearLeafletLayers(targetMap) {
    targetMap.eachLayer(layer => {
      if (layer === targetMap._wfBaseTileLayer) return;
      targetMap.removeLayer(layer);
    });
  }

  

  /* --------------------------------------------------
     Render (shared for main + modal)
  -------------------------------------------------- */
  function renderData(targetMap, data) {
    if (!data) return;

    const localAtc = L.layerGroup().addTo(targetMap);
    const localAirports = L.layerGroup().addTo(targetMap);

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
        .addTo(localAirports)
        .bindTooltip(
          airportHoverHtml(icao, a),
          {
            direction: 'top',
            opacity: 0.95,
            sticky: true,
            className: 'wf-airport-hover-tooltip'
          }
        )
        .on('click', () => {
  window.location.href = `/icao/${icao}`;
});
    });

    (data.atcPolylines || []).forEach(leg => {
      const pts = (leg.points || [])
        .filter(p => p?.lat != null && p?.lon != null)
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
             <div style="margin-top:6px;font-family:JetBrains Mono,monospace;font-size:12px;white-space:pre-wrap;">
               ${(leg.atc_route || '').replace(/</g, '&lt;')}
             </div>`
          );
      });
    });

    if (bounds.length) {
  const sidebarWidth = document.body.classList.contains('sidebar-collapsed')
  ? 72
  : 220;

targetMap.fitBounds(bounds, {
  paddingTopLeft: [sidebarWidth + 24, 24],
  paddingBottomRight: [24, 24],
  maxZoom: 5,
  animate: false
});


  requestAnimationFrame(() => {
    if (targetMap.getContainer().id === 'wfWorldMap') {
  targetMap.invalidateSize(true);
} else {
  
}

  });
}

  }

  window.addEventListener('sidebar:toggle', () => {
  if (!map || !lastData) return;

  const bounds = [];
  const airports = lastData.airports || {};

  Object.values(airports).forEach(a => {
    if (a.lat && a.lon) bounds.push([a.lat, a.lon]);
  });

  if (bounds.length) {
  const sidebarOffset =
    targetMap.getContainer().id === 'wfMapModalMap'
      ? 0
      : (document.body.classList.contains('sidebar-collapsed') ? 72 : 240);

  targetMap.fitBounds(bounds, {
    paddingTopLeft: [sidebarOffset + 12, 12],
    paddingBottomRight: [12, 12],
    maxZoom: 4,          // 👈 tighter framing
    animate: false
  });

  requestAnimationFrame(() => {
    targetMap.invalidateSize(true);
  });
}

});


  /* --------------------------------------------------
     Load main map
  -------------------------------------------------- */
  async function load() {
  const overlay = ensureOverlay(el);
  setOverlay(overlay, true, 'Requesting route data…');

  const qs = new URLSearchParams(window.WF_MAP_QUERY || {}).toString();
  const cacheKey = wfCacheKey(qs);

  let data = getCachedMapData(cacheKey);

   if (!data) {
    const res = await fetch(
      '/api/wf/world-map' + (qs ? `?${qs}` : ''),
      { credentials: 'same-origin' }
    );

    if (!res.ok) {
      setOverlay(overlay, true, `Failed (${res.status})`);
      return;
    }

    data = await res.json();
    setCachedMapData(cacheKey, data);
  }

  lastData = data;

  airportLayer.clearLayers();
  atcLayer.clearLayers();

  renderData(map, data);
  setOverlay(overlay, false);
}


  load().catch(console.error);

  /* --------------------------------------------------
     Modal handling (unchanged behavior)
  -------------------------------------------------- */
  let modalMap = null;

  function ensureWfModal() {
    let modal = document.getElementById('wfMapModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'wfMapModal';
    modal.className = 'map-modal hidden';
    modal.innerHTML = `
      <div class="map-modal-backdrop" data-wf-close="1"></div>
      <div class="map-modal-panel">
        <div class="map-modal-header">
          <span>WF Route Map</span>
          <button type="button" data-wf-close="1">✕</button>
        </div>
        <div class="icao-map">
          <div id="wfMapModalMap" style="width:100%;height:100%"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    return modal;
  }

  function openWfModal() {
    const modal = ensureWfModal();
    modal.classList.remove('hidden');

    setTimeout(() => {
      if (!modalMap) {
        modalMap = L.map('wfMapModalMap', { zoomControl: true });
        modalMap._wfBaseTileLayer = L.tileLayer(
          'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
          { subdomains: 'abcd', maxZoom: 19, noWrap: true }
        ).addTo(modalMap);
      }

      clearLeafletLayers(modalMap);
      renderData(modalMap, lastData);
      modalMap.invalidateSize(true);
    }, 50);
  }

  document.addEventListener('click', e => {
    if (e.target.closest('[data-wf-close="1"]')) {
      document.getElementById('wfMapModal')?.classList.add('hidden');
    }
    if (e.target.closest('[data-wf-expand="1"]')) openWfModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.getElementById('wfMapModal')?.classList.add('hidden');
    }
  });
});
