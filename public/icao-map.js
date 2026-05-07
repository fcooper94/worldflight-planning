/* =========================================================
   ICAO Airport Map
   ========================================================= */

let modalThemeBound = false;
let modalMap = null;

const TILE_LAYERS = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: { maxZoom: 19 }
  },
  light: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    options: { maxZoom: 19 }
  }
};

function getMapTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

function setMapTheme(theme) {
  localStorage.setItem('icaoMapTheme', theme);
}

/* =========================
   Geometry helpers
========================= */

function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }

function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/* =========================
   Runway labels
========================= */

function addRunwayLabels(map, runways) {
  if (!Array.isArray(runways)) return;
  runways.forEach(rwy => {
    if (!rwy.lat1 || !rwy.lon1 || !rwy.lat2 || !rwy.lon2) return;
    const b12 = bearingDeg(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    addRunwayLabel(map, rwy.lat1, rwy.lon1, rwy.ident1, b12);
    addRunwayLabel(map, rwy.lat2, rwy.lon2, rwy.ident2, (b12 + 180) % 360);
  });
}

function addRunwayLabel(map, lat, lon, text, rotation) {
  L.marker([lat, lon], {
    icon: L.divIcon({
      className: 'runway-label',
      // Two divs: outer centres the label on the lat/lon, inner rotates the
      // text. Combining both transforms on a single element makes the
      // translate happen in the rotated axes, which drifts the label off the
      // runway threshold for any non-cardinal heading.
      html: `<div class="runway-label-wrap"><div class="runway-label-text" style="--rwy-rot:${rotation}deg">${text}</div></div>`,
      iconSize: [0, 0]
    }),
    interactive: false
  }).addTo(map);
}

/* =========================
   DOM Ready
========================= */

document.addEventListener('DOMContentLoaded', () => {

  document.documentElement.dataset.mapTheme = getMapTheme();

  /* ---------- Embedded map ---------- */

  const el = document.getElementById('icaoMap');
  if (!el || typeof L === 'undefined') return;

  const ICAO = el.dataset.icao;

  fetch(`/api/icao/${ICAO}/map`)
    .then(r => r.json())
    .then(({ airport, aircraft }) => {

      window._icaoAirport = airport;
      window._icaoAircraft = aircraft;

      const map = L.map('icaoMap', {
        zoomControl: true,
        attributionControl: false
      });

      wfAddTileLayer(map, TILE_LAYERS[getMapTheme()].options);
      window._icaoMapInstance = map;

      // Recompute tile bounds whenever the map container resizes
      // (e.g. ATIS card appears and stretches the grid row).
      // Debounced to avoid invalidateSize ↔ ResizeObserver feedback loops.
      if (typeof ResizeObserver !== 'undefined') {
        let resizeTimer = null;
        new ResizeObserver(function() {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(function() { map.invalidateSize(); }, 150);
        }).observe(el);
      }

      // Kick off the ground-layout fetch in parallel with rendering aircraft.
      // First load takes 5–30s while OSM is queried; subsequent loads are
      // instant from disk cache.
      loadGround(map, ICAO);

      const bounds = L.latLngBounds([[airport.lat, airport.lon]]);

      aircraft.forEach(ac => {
        if (!ac.lat || !ac.lon) return;
        bounds.extend([ac.lat, ac.lon]);
        L.marker([ac.lat, ac.lon], {
          icon: L.divIcon({
            className: 'ac-marker',
            html: `<div class="ac-icon" style="transform:rotate(${ac.heading || 0}deg)"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg></div>
                   <div class="ac-label">${ac.callsign}</div>`
          }),
          zIndexOffset: 5000
        }).addTo(map);
      });

      addRunwayLabels(map, airport.runways);

      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    });

  /* ---------- Expand button ---------- */

  document
    .getElementById('expandMapBtn')
    ?.addEventListener('click', () => {

      const modal = document.getElementById('mapModal');
      if (!modal) return;

      modal.classList.remove('hidden');

      setTimeout(() => {

        if (!modalMap) {
          modalMap = L.map('mapModalMap', {
            zoomControl: true,
            attributionControl: false
          });

          wfAddTileLayer(modalMap, TILE_LAYERS[getMapTheme()].options);
          window._modalMapInstance = modalMap;
        } else {
          modalMap.eachLayer(l => l instanceof L.Marker && modalMap.removeLayer(l));
        }

        const bounds = L.latLngBounds();

        if (window._icaoAirport) {
          bounds.extend([window._icaoAirport.lat, window._icaoAirport.lon]);
          addRunwayLabels(modalMap, window._icaoAirport.runways);
        }

        (window._icaoAircraft || []).forEach(ac => {
          if (!ac.lat || !ac.lon) return;
          bounds.extend([ac.lat, ac.lon]);
          L.marker([ac.lat, ac.lon], {
            icon: L.divIcon({
              className: 'ac-marker',
              html: `<div class="ac-icon" style="transform:rotate(${ac.heading || 0}deg)"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg></div>
                     <div class="ac-label">${ac.callsign}</div>`
            }),
            zIndexOffset: 5000
          }).addTo(modalMap);
        });

        modalMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
        modalMap.invalidateSize();
      }, 50);
    });
});

/* =========================
   Ground layout (runways, taxiways, aprons, stands, buildings)
========================= */

const GROUND_STYLE_DARK = {
  apron:    { color: '#3a3d45', weight: 0.5, fillColor: '#2a2d35', fillOpacity: 0.55 },
  taxiway:  { color: '#4a4d55', weight: 0.6, fillColor: '#363940', fillOpacity: 0.75 },
  runway:   { color: '#525560', weight: 1.0, fillColor: '#3a3d45', fillOpacity: 0.9 },
  building: { color: '#23252b', weight: 0.4, fillColor: '#1a1c20', fillOpacity: 0.55 },
  stand:    { color: '#5eead4', weight: 1, fillColor: '#5eead4', fillOpacity: 0.18 },
  standOcc: { color: '#ef4444', weight: 1, fillColor: '#ef4444', fillOpacity: 0.32 }
};
const GROUND_STYLE_LIGHT = {
  apron:    { color: '#94a3b8', weight: 0.5, fillColor: '#cbd5e1', fillOpacity: 0.45 },
  taxiway:  { color: '#94a3b8', weight: 0.6, fillColor: '#b0bec5', fillOpacity: 0.55 },
  runway:   { color: '#64748b', weight: 1.0, fillColor: '#94a3b8', fillOpacity: 0.7 },
  building: { color: '#94a3b8', weight: 0.4, fillColor: '#b0bec5', fillOpacity: 0.45 },
  stand:    { color: '#0d9488', weight: 1.5, fillColor: '#0d9488', fillOpacity: 0.15 },
  standOcc: { color: '#dc2626', weight: 1.5, fillColor: '#dc2626', fillOpacity: 0.25 }
};
function getGroundStyle() {
  return document.documentElement.dataset.mapTheme === 'light' ? GROUND_STYLE_LIGHT : GROUND_STYLE_DARK;
}
// Keep backward compat reference
const GROUND_STYLE = GROUND_STYLE_DARK;

function loadGround(map, icao) {
  // Only show the loading pill if the fetch is genuinely slow (cache miss).
  // For airports pre-fetched at server startup the request returns immediately
  // and the indicator never appears.
  let indicator = null;
  const showAfter = setTimeout(() => { indicator = makeGroundIndicator(map); }, 400);

  fetch('/api/icao/' + icao + '/ground')
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(geo => {
      clearTimeout(showAfter);
      if (indicator) indicator.remove();
      renderGround(map, geo);
      pollStandOccupancy(map, icao);
    })
    .catch(err => {
      clearTimeout(showAfter);
      if (!indicator) indicator = makeGroundIndicator(map);
      indicator.fail(err && err.message ? err.message : 'failed');
    });
}

function makeGroundIndicator(map) {
  const el = L.DomUtil.create('div', 'ground-indicator', map.getContainer());
  el.textContent = 'Loading ground layout…';
  return {
    remove: () => el.remove(),
    fail: (msg) => {
      el.textContent = 'Ground layout unavailable (' + msg + ')';
      el.classList.add('ground-indicator-fail');
      setTimeout(() => el.remove(), 6000);
    }
  };
}

function renderGround(map, geo) {
  if (!geo || !Array.isArray(geo.features)) return;

  const gs = getGroundStyle();

  // Runways and buildings only — aprons and taxiways are already visible on the
  // base tile layer and rendering hundreds of widened OSM polygons for them
  // tanks performance on integrated GPUs.
  const layers = {};
  ['runway', 'building'].forEach(kind => {
    const features = geo.features.filter(f => f.properties && f.properties.kind === kind);
    if (!features.length) return;
    layers[kind] = L.geoJSON({ type: 'FeatureCollection', features }, {
      style: gs[kind],
      interactive: false,
      pane: 'overlayPane'
    }).addTo(map);
  });

  // Stands — render polygons (where available) and a label per stand.
  const standLayer = L.layerGroup().addTo(map);
  window._icaoStandLookup = {};

  geo.features.filter(f => f.properties && f.properties.kind === 'stand').forEach(f => {
    const props = f.properties;
    const id = String(props.osm_id);
    const name = props.ref || props.name || '';
    let center = null;
    let polygon = null;

    if (f.geometry.type === 'Polygon') {
      const ring = f.geometry.coordinates[0];
      polygon = L.polygon(ring.map(c => [c[1], c[0]]), getGroundStyle().stand).addTo(standLayer);
      let lat = 0, lon = 0;
      ring.forEach(c => { lon += c[0]; lat += c[1]; });
      center = [lat / ring.length, lon / ring.length];
    } else if (f.geometry.type === 'Point') {
      center = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
    }

    if (center && name) {
      const label = L.marker(center, {
        icon: L.divIcon({
          className: 'stand-label',
          html: '<div class="stand-label-box" data-stand-id="' + id + '">' + escapeText(name) + '</div>',
          iconSize: [0, 0]
        }),
        zIndexOffset: 100
      }).addTo(standLayer);
      window._icaoStandLookup[id] = { name, polygon, label };
    } else if (polygon) {
      window._icaoStandLookup[id] = { name, polygon, label: null };
    }
  });

  window._icaoGroundLayers = layers;
  window._icaoStandLayer = standLayer;
}

function escapeText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

/* =========================
   Stand occupancy
========================= */

let _occupancyTimer = null;

function pollStandOccupancy(map, icao) {
  if (_occupancyTimer) clearInterval(_occupancyTimer);
  refreshStandOccupancy(icao);
  _occupancyTimer = setInterval(() => refreshStandOccupancy(icao), 60_000);
}

async function refreshStandOccupancy(icao) {
  try {
    const res = await fetch('/api/icao/' + icao + '/stand-occupancy');
    if (!res.ok) return;
    const data = await res.json();
    const occ = data.occupancy || {};
    const lookup = window._icaoStandLookup || {};

    Object.keys(lookup).forEach(id => {
      const s = lookup[id];
      const isOccupied = !!occ[id];
      const gs = getGroundStyle();
      if (s.polygon) s.polygon.setStyle(isOccupied ? gs.standOcc : gs.stand);
      if (s.label) {
        const box = s.label.getElement()?.querySelector('.stand-label-box');
        if (box) {
          box.classList.toggle('stand-occupied', isOccupied);
          box.title = isOccupied ? occ[id].callsign : '';
        }
      }
    });
  } catch (err) {
    // Silent — we'll try again on the next interval.
  }
}

/* =========================
   Theme toggle
========================= */

function toggleMapTheme() {
  const theme = getMapTheme() === 'dark' ? 'light' : 'dark';
  setMapTheme(theme);
  document.documentElement.dataset.mapTheme = theme;

  [window._icaoMapInstance, window._modalMapInstance].forEach(map => {
    if (!map?._baseTileLayer) return;
    map.removeLayer(map._baseTileLayer);
    map._baseTileLayer = L.tileLayer(
      TILE_LAYERS[theme].url,
      TILE_LAYERS[theme].options
    ).addTo(map);
  });
}

/* =========================
   Modal close
========================= */

document.addEventListener('click', e => {
  if (e.target.id === 'closeMapModal' ||
      e.target.classList.contains('map-modal-backdrop')) {
    document.getElementById('mapModal')?.classList.add('hidden');
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('mapModal')?.classList.add('hidden');
  }
});
