import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decimalToDMS, coordPair } from './lib/geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ICAO = process.argv[2] || 'EGLL';
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

// EuroScope colour definitions (RGB as decimal)
const COLOURS = {
  runway: 'smrRunway',
  rwyedge: 'smrRwyEdge',
  taxiway: 'smrTaxiway',
  apron: 'smrApron',
  building: 'smrBuilding',
  grass: 'smrGrass',
  outline: '6579300',   // medium grey for outlines
  twyline: '17219',     // amber for taxiway centerlines
  standlabel: '16777215' // white
};

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 5000;

async function fetchOverpass(query) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`  Querying Overpass API (attempt ${attempt}/${MAX_RETRIES})...`);
    try {
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      if (res.ok) return res.json();
      if (res.status === 429 || res.status === 504 || res.status === 503) {
        console.log(`  Got ${res.status}, retrying in ${RETRY_DELAY_MS / 1000}s...`);
        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw new Error(`Overpass API error: ${res.status}`);
    } catch (err) {
      if (err.message.includes('Overpass API error')) throw err;
      console.log(`  Network error: ${err.message}, retrying in ${RETRY_DELAY_MS / 1000}s...`);
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  throw new Error(`Overpass API failed after ${MAX_RETRIES} attempts`);
}

async function checkIcaoExistsInOSM(icao) {
  const query = `[out:json][timeout:30];(way[icao="${icao}"];relation[icao="${icao}"];node[icao="${icao}"];);out tags;`;
  const data = await fetchOverpass(query);
  return data.elements && data.elements.length > 0;
}

function coordToES(lat, lon) {
  return coordPair(lat, lon);
}

function processWay(element) {
  if (!element.geometry || element.geometry.length < 3) return null;
  return element.geometry.map(n => coordToES(n.lat, n.lon));
}

async function main() {
  console.log(`=== Fetching ground layout for ${ICAO} ===\n`);

  // Check for cached OSM data
  const cacheDir = path.join(__dirname, '..', 'Euroscope_Files', 'WorldFlight', 'cache');
  const cachePath = path.join(cacheDir, `${ICAO}_osm.json`);
  fs.mkdirSync(cacheDir, { recursive: true });

  let data;
  if (fs.existsSync(cachePath) && !process.argv.includes('--fresh')) {
    console.log('  Using cached OSM data (use --fresh to re-fetch)');
    data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } else {
    // Check if airport exists in OSM first
    console.log('  Checking if ICAO exists in OSM...');
    const exists = await checkIcaoExistsInOSM(ICAO);
    if (!exists) {
      console.log(`  ${ICAO} not found in OSM database — skipping ground layout`);
      process.exit(2); // Exit code 2 = ICAO not in OSM (skip, not an error)
    }

    // Query OSM for airport features
    const query = `
[out:json][timeout:120];
area[icao="${ICAO}"]->.airport;
(
  way(area.airport)[aeroway=runway];
  way(area.airport)[aeroway=taxiway];
  way(area.airport)[aeroway=apron];
  way(area.airport)[aeroway=terminal];
  way(area.airport)[building][building!=no](if:t["aeroway"]!="terminal");
  way(area.airport)[landuse=grass];
  way(area.airport)[aeroway=parking_position];
  way(area.airport)[aeroway=gate];
  relation(area.airport)[aeroway=apron];
  relation(area.airport)[building];
);
out body geom;
`;

    data = await fetchOverpass(query);
    fs.writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
    console.log(`  Got ${data.elements.length} elements from OSM (cached)\n`);
  }

  // Categorise elements
  const runways = [];
  const taxiways = [];
  const taxiwayLines = [];
  const aprons = [];
  const buildings = [];
  const grass = [];
  const stands = [];

  for (const el of data.elements) {
    const tags = el.tags || {};
    const aeroway = tags.aeroway || '';
    const building = tags.building || '';
    const landuse = tags.landuse || '';

    if (el.type === 'way') {
      const pts = processWay(el);
      if (!pts) continue;

      if (aeroway === 'runway') {
        // Runways are usually lines, not closed polygons - make them into regions
        // Check if it's a closed way (polygon) or a line
        const isPolygon = el.geometry[0].lat === el.geometry[el.geometry.length - 1].lat &&
                          el.geometry[0].lon === el.geometry[el.geometry.length - 1].lon;
        if (isPolygon) {
          runways.push({ name: tags.ref || 'RWY', pts, id: el.id, rawGeom: el.geometry, width: parseFloat(tags.width) || 45 });
        } else {
          // It's a centerline - we can create a thin polygon from it or just use it as a line
          // For runways, OSM often gives the centerline. We need to widen it.
          const width = parseFloat(tags.width) || 45; // metres
          const widthDeg = width / 111320 / 2; // rough conversion to degrees
          const widened = [];
          for (let i = 0; i < el.geometry.length; i++) {
            const p = el.geometry[i];
            const next = el.geometry[Math.min(i + 1, el.geometry.length - 1)];
            const dx = next.lon - p.lon;
            const dy = next.lat - p.lat;
            const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
            const nx = -dy / len * widthDeg;
            const ny = dx / len * widthDeg;
            widened.push({ lat: p.lat + nx, lon: p.lon + ny });
          }
          for (let i = el.geometry.length - 1; i >= 0; i--) {
            const p = el.geometry[i];
            const next = el.geometry[Math.max(i - 1, 0)];
            const dx = next.lon - p.lon;
            const dy = next.lat - p.lat;
            const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
            const nx = dy / len * widthDeg;
            const ny = -dx / len * widthDeg;
            widened.push({ lat: p.lat + nx, lon: p.lon + ny });
          }
          // Close the polygon
          widened.push({ lat: widened[0].lat, lon: widened[0].lon });
          runways.push({ name: tags.ref || 'RWY', pts: widened.map(p => coordToES(p.lat, p.lon)), id: el.id, rawGeom: el.geometry, width: parseFloat(tags.width) || 45 });
        }
      } else if (aeroway === 'taxiway') {
        // Taxiways - save as lines for centerlines, and try to make polygons
        taxiwayLines.push({ name: tags.ref || '', pts, id: el.id, raw: el.geometry });

        // Also create widened polygon
        const width = parseFloat(tags.width) || 20; // metres
        const widthDeg = width / 111320 / 2;
        const widened = [];
        for (let i = 0; i < el.geometry.length; i++) {
          const p = el.geometry[i];
          const next = el.geometry[Math.min(i + 1, el.geometry.length - 1)];
          const dx = next.lon - p.lon;
          const dy = next.lat - p.lat;
          const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
          const nx = -dy / len * widthDeg;
          const ny = dx / len * widthDeg;
          widened.push({ lat: p.lat + nx, lon: p.lon + ny });
        }
        for (let i = el.geometry.length - 1; i >= 0; i--) {
          const p = el.geometry[i];
          const next = el.geometry[Math.max(i - 1, 0)];
          const dx = next.lon - p.lon;
          const dy = next.lat - p.lat;
          const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
          const nx = dy / len * widthDeg;
          const ny = -dx / len * widthDeg;
          widened.push({ lat: p.lat + nx, lon: p.lon + ny });
        }
        // Close the polygon
        widened.push({ lat: widened[0].lat, lon: widened[0].lon });
        taxiways.push({ name: tags.ref || '', pts: widened.map(p => coordToES(p.lat, p.lon)), id: el.id });
      } else if (aeroway === 'apron' || aeroway === 'terminal') {
        aprons.push({ name: tags.name || '', pts, id: el.id });
      } else if (building && building !== 'no') {
        buildings.push({ name: tags.name || '', pts, id: el.id });
      } else if (landuse === 'grass') {
        grass.push({ name: '', pts, id: el.id });
      } else if (aeroway === 'parking_position' || aeroway === 'gate') {
        if (el.geometry.length > 0) {
          stands.push({ name: tags.ref || tags.name || '', lat: el.geometry[0].lat, lon: el.geometry[0].lon });
        }
      }
    } else if (el.type === 'relation' && el.members) {
      // Handle multipolygon relations (aprons, buildings)
      for (const member of el.members) {
        if (member.type === 'way' && member.geometry && member.geometry.length >= 3) {
          const pts = member.geometry.map(n => coordToES(n.lat, n.lon));
          const tags2 = el.tags || {};
          if (tags2.aeroway === 'apron') aprons.push({ name: tags2.name || '', pts, id: el.id });
          else if (tags2.building) buildings.push({ name: tags2.name || '', pts, id: el.id });
        }
      }
    }
  }

  console.log(`  Runways:     ${runways.length}`);
  console.log(`  Taxiways:    ${taxiways.length} (${taxiwayLines.length} centerlines)`);
  console.log(`  Aprons:      ${aprons.length}`);
  console.log(`  Buildings:   ${buildings.length}`);
  console.log(`  Grass:       ${grass.length}`);
  console.log(`  Stands:      ${stands.length}`);

  // Generate EuroScope output
  const lines = [];
  lines.push(`; ${ICAO} Ground Layout — Generated from OpenStreetMap`);
  lines.push(`; OSM data © OpenStreetMap contributors`);
  lines.push('');

  // REGIONS (filled polygons) — order matters: grass first (background), then aprons, taxiways, runways, buildings on top
  lines.push('; === REGIONS (paste into [REGIONS] section) ===');
  lines.push('');

  // Grass (background - render first)
  for (const g of grass) {
    lines.push(`REGIONNAME ${ICAO}`);
    lines.push(`${COLOURS.grass} ${g.pts[0]}`);
    for (let j = 1; j < g.pts.length; j++) lines.push(` ${g.pts[j]}`);
    lines.push('');
  }

  // Aprons
  for (const a of aprons) {
    lines.push(`REGIONNAME ${ICAO}`);
    lines.push(`${COLOURS.apron} ${a.pts[0]}`);
    for (let j = 1; j < a.pts.length; j++) lines.push(` ${a.pts[j]}`);
    lines.push('');
  }

  // Taxiways
  for (const t of taxiways) {
    lines.push(`REGIONNAME ${ICAO}`);
    lines.push(`${COLOURS.taxiway} ${t.pts[0]}`);
    for (let j = 1; j < t.pts.length; j++) lines.push(` ${t.pts[j]}`);
    lines.push('');
  }

  // Buildings (before runways so runways render on top)
  for (const b of buildings) {
    lines.push(`REGIONNAME ${ICAO}`);
    lines.push(`${COLOURS.building} ${b.pts[0]}`);
    for (let j = 1; j < b.pts.length; j++) lines.push(` ${b.pts[j]}`);
    lines.push('');
  }

  // Runways — surface fill (LAST so they render on top of taxiways)
  for (const r of runways) {
    lines.push(`REGIONNAME ${ICAO}`);
    lines.push(`${COLOURS.runway} ${r.pts[0]}`);
    for (let j = 1; j < r.pts.length; j++) lines.push(` ${r.pts[j]}`);
    lines.push('');
  }

  // Runway edge rectangles — thin white border regions on top
  for (const r of runways) {
    if (r.rawGeom && r.rawGeom.length >= 2) {
      const geom = r.rawGeom;
      const width = r.width || 45;
      const widthDeg = width / 111320 / 2;
      const first = geom[0], last = geom[geom.length - 1];
      const dx = last.lon - first.lon, dy = last.lat - first.lat;
      const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      const nx = -dy / len * widthDeg, ny = dx / len * widthDeg;

      // Outer rectangle
      const o1 = { lat: first.lat + nx, lon: first.lon + ny };
      const o2 = { lat: last.lat + nx, lon: last.lon + ny };
      const o3 = { lat: last.lat - nx, lon: last.lon - ny };
      const o4 = { lat: first.lat - nx, lon: first.lon - ny };

      // Inner rectangle (slightly smaller)
      const border = 0.25; // fraction of width for border thickness
      const inx = nx * (1 - border), iny = ny * (1 - border);
      const i1 = { lat: first.lat + inx, lon: first.lon + iny };
      const i2 = { lat: last.lat + inx, lon: last.lon + iny };
      const i3 = { lat: last.lat - inx, lon: last.lon - iny };
      const i4 = { lat: first.lat - inx, lon: first.lon - iny };

      // Top edge strip
      lines.push(`REGIONNAME ${ICAO}`);
      lines.push(`${COLOURS.rwyedge} ${coordToES(o1.lat, o1.lon)}`);
      lines.push(` ${coordToES(o2.lat, o2.lon)}`);
      lines.push(` ${coordToES(i2.lat, i2.lon)}`);
      lines.push(` ${coordToES(i1.lat, i1.lon)}`);
      lines.push('');

      // Bottom edge strip
      lines.push(`REGIONNAME ${ICAO}`);
      lines.push(`${COLOURS.rwyedge} ${coordToES(o4.lat, o4.lon)}`);
      lines.push(` ${coordToES(o3.lat, o3.lon)}`);
      lines.push(` ${coordToES(i3.lat, i3.lon)}`);
      lines.push(` ${coordToES(i4.lat, i4.lon)}`);
      lines.push('');

      // Left end cap
      lines.push(`REGIONNAME ${ICAO}`);
      lines.push(`${COLOURS.rwyedge} ${coordToES(o1.lat, o1.lon)}`);
      lines.push(` ${coordToES(o4.lat, o4.lon)}`);
      lines.push(` ${coordToES(i4.lat, i4.lon)}`);
      lines.push(` ${coordToES(i1.lat, i1.lon)}`);
      lines.push('');

      // Right end cap
      lines.push(`REGIONNAME ${ICAO}`);
      lines.push(`${COLOURS.rwyedge} ${coordToES(o2.lat, o2.lon)}`);
      lines.push(` ${coordToES(o3.lat, o3.lon)}`);
      lines.push(` ${coordToES(i3.lat, i3.lon)}`);
      lines.push(` ${coordToES(i2.lat, i2.lon)}`);
      lines.push('');
    }
  }

  lines.push('');
  lines.push('; === GEO (paste into [GEO] section) ===');
  lines.push('');

  // Runway outlines — draw a complete rectangle around each runway
  for (const r of runways) {
    if (r.rawGeom && r.rawGeom.length >= 2) {
      const geom = r.rawGeom;
      const width = r.width || 45;
      const widthDeg = width / 111320 / 2;
      const first = geom[0], last = geom[geom.length - 1];
      const dx = last.lon - first.lon, dy = last.lat - first.lat;
      const len = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      const nx = -dy / len * widthDeg, ny = dx / len * widthDeg;

      // Four corners of the runway rectangle
      const c1 = { lat: first.lat + nx, lon: first.lon + ny };
      const c2 = { lat: first.lat - nx, lon: first.lon - ny };
      const c3 = { lat: last.lat - nx, lon: last.lon - ny };
      const c4 = { lat: last.lat + nx, lon: last.lon + ny };

      const corners = [c1, c4, c3, c2, c1]; // closed rectangle
      for (let i = 0; i < corners.length - 1; i++) {
        const p1 = coordToES(corners[i].lat, corners[i].lon);
        const p2 = coordToES(corners[i + 1].lat, corners[i + 1].lon);
        lines.push(`${p1} ${p2} ${COLOURS.rwyedge} ; RWY outline`);
      }

      // Runway centerline
      for (let i = 0; i < geom.length - 1; i++) {
        const p1 = coordToES(geom[i].lat, geom[i].lon);
        const p2 = coordToES(geom[i + 1].lat, geom[i + 1].lon);
        lines.push(`${p1} ${p2} 16777215 ; RWY CL`);
      }

      // Threshold marks (short cross lines at each end)
      const threshLen = widthDeg * 0.8;
      const t1a = coordToES(first.lat + nx * 0.8, first.lon + ny * 0.8);
      const t1b = coordToES(first.lat - nx * 0.8, first.lon - ny * 0.8);
      lines.push(`${t1a} ${t1b} 16777215 ; RWY threshold`);
      const t2a = coordToES(last.lat + nx * 0.8, last.lon + ny * 0.8);
      const t2b = coordToES(last.lat - nx * 0.8, last.lon - ny * 0.8);
      lines.push(`${t2a} ${t2b} 16777215 ; RWY threshold`);
    }
  }

  // Taxiway centerlines
  for (const t of taxiwayLines) {
    for (let i = 0; i < t.raw.length - 1; i++) {
      const p1 = coordToES(t.raw[i].lat, t.raw[i].lon);
      const p2 = coordToES(t.raw[i + 1].lat, t.raw[i + 1].lon);
      lines.push(`${p1} ${p2} ${COLOURS.twyline} ; TWY ${t.name}`);
    }
  }

  lines.push('');
  lines.push('; === LABELS (paste into [LABELS] section) ===');
  lines.push('');

  // Stand labels omitted — too cluttered for EuroScope SMR view

  // Taxiway name labels (at midpoint of each taxiway)
  for (const t of taxiwayLines) {
    if (t.name && t.raw.length >= 2) {
      const mid = Math.floor(t.raw.length / 2);
      lines.push(`"${t.name}" ${coordToES(t.raw[mid].lat, t.raw[mid].lon)} ${COLOURS.standlabel}`);
    }
  }

  // Write output
  const outPath = path.join(__dirname, '..', 'Euroscope_Files', 'WorldFlight', `${ICAO}_ground.txt`);
  fs.writeFileSync(outPath, lines.join('\r\n'), 'utf-8');
  console.log(`\n  Written ${lines.length} lines to ${outPath}`);
  console.log('  Copy the sections into your .sct file [REGIONS], [GEO], and [LABELS] sections');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
