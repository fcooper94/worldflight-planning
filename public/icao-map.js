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
      html: `<div style="--rwy-rot:${rotation}deg">${text}</div>`,
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
        attributionControl: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false
      });

      wfAddTileLayer(map, TILE_LAYERS[getMapTheme()].options);
      window._icaoMapInstance = map;

      // Recompute tile bounds whenever the map container resizes
      // (e.g. ATIS card appears and stretches the grid row).
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(function() { map.invalidateSize(); }).observe(el);
      }

      const bounds = L.latLngBounds([[airport.lat, airport.lon]]);

      aircraft.forEach(ac => {
        if (!ac.lat || !ac.lon) return;
        bounds.extend([ac.lat, ac.lon]);
        L.marker([ac.lat, ac.lon], {
          icon: L.divIcon({
            className: 'ac-marker',
            html: `<div class="ac-icon" style="transform:rotate(${ac.heading || 0}deg)"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg></div>
                   <div class="ac-label">${ac.callsign}</div>`
          })
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
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
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
            })
          }).addTo(modalMap);
        });

        modalMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
        modalMap.invalidateSize();
      }, 50);
    });
});

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
