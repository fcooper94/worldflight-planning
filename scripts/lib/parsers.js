import fs from 'fs';
import readline from 'readline';
import { haversineNm } from './geo.js';

export async function parseFixes(filePath, centers, radiusNm = 200) {
  const fixes = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.startsWith('I') || line.startsWith('9') || line.trim() === '' || line.includes('Version')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;

    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    const ident = parts[2];

    if (isNaN(lat) || isNaN(lon) || lat === 0 && lon === 0) continue;

    // Check proximity to any WF airport
    const near = centers.some(c => haversineNm(c.lat, c.lon, lat, lon) <= radiusNm);
    if (near) fixes.push({ ident, lat, lon });
  }

  return fixes;
}

export async function parseNavaids(filePath, centers, radiusNm = 200) {
  const vors = [];
  const ndbs = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.startsWith('I') || line.startsWith('9') || line.trim() === '' || line.includes('Version')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;

    const type = parseInt(parts[0]);
    const lat = parseFloat(parts[1]);
    const lon = parseFloat(parts[2]);
    const freq = parseInt(parts[4]);
    const ident = parts[7];
    const name = parts.slice(8).join(' ');

    if (isNaN(lat) || isNaN(lon)) continue;
    if (type !== 2 && type !== 3) continue; // 2=NDB, 3=VOR

    const near = centers.some(c => haversineNm(c.lat, c.lon, lat, lon) <= radiusNm);
    if (!near) continue;

    if (type === 2) {
      ndbs.push({ ident, lat, lon, freq: freq.toFixed(3).padStart(7, ' '), name });
    } else if (type === 3) {
      // VOR freq is stored as integer * 100, e.g. 11480 = 114.800
      const fmtFreq = (freq / 1000).toFixed(3);
      vors.push({ ident, lat, lon, freq: fmtFreq, name });
    }
  }

  return { vors, ndbs };
}

/**
 * Parse CIFP file for SID/STAR procedures and return EuroScope [SIDSSTARS] lines.
 * CIFP format: TYPE:SEQ,ROUTE_TYPE,PROC_NAME,TRANSITION,FIX,...
 * Route types: 1/2=runway transition, 4=enroute transition, 5=common route, 6=runway transition (STAR)
 * We build: SID:ICAO:RWY:PROC:FIX1 FIX2 FIX3...
 */
export function parseCIFP(filePath, icao) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  // Collect fix sequences per procedure+runway+route_type
  // Key: "SID|STAR:procName:transition:routeType"
  const legs = {};
  for (const line of lines) {
    if (!line.startsWith('SID:') && !line.startsWith('STAR:')) continue;
    const fields = line.split(',');
    if (fields.length < 5) continue;
    const type = fields[0].split(':')[0]; // SID or STAR
    const routeType = parseInt(fields[1]);
    const procName = fields[2];
    const transition = fields[3].trim();
    const fix = fields[4].trim();
    if (!fix || !procName) continue;
    const key = `${type}:${procName}:${transition}:${routeType}`;
    if (!legs[key]) legs[key] = [];
    legs[key].push(fix);
  }

  // Build EuroScope SIDSSTARS entries
  // For SIDs: runway transitions (type 2) give us runway-specific routes
  // For STARs: common route (type 2/5) + runway transitions (type 6)
  const result = [];
  const seen = new Set();

  // Helper to build an entry
  const addEntry = (type, rwy, procName, fixes) => {
    const filtered = fixes.filter(f => f && f !== icao);
    const deduped = filtered.filter((f, i) => i === 0 || f !== filtered[i - 1]);
    if (deduped.length === 0) return;
    if (rwy.endsWith('B')) rwy = rwy.slice(0, -1);
    const entryKey = `${type}:${icao}:${rwy}:${procName}`;
    if (!seen.has(entryKey)) {
      seen.add(entryKey);
      result.push(`${type}:${icao}:${rwy}:${procName}:${deduped.join(' ')}`);
    }
  };

  // Collect common route fixes per procedure
  const commonRoute = {};
  for (const [key, fixes] of Object.entries(legs)) {
    const [type, procName, transition, rt] = key.split(':');
    const routeType = parseInt(rt);
    if (routeType === 5) {
      commonRoute[`${type}:${procName}`] = fixes;
    }
  }

  // Process SIDs: runway transitions are type 1, 2, or 4 with RWxx transition
  for (const [key, fixes] of Object.entries(legs)) {
    const [type, procName, transition, rt] = key.split(':');
    if (type !== 'SID') continue;
    const routeType = parseInt(rt);
    if (![1, 2, 4].includes(routeType)) continue;
    if (!transition.startsWith('RW')) continue;
    const rwy = transition.substring(2);
    const common = commonRoute[`SID:${procName}`] || [];
    addEntry('SID', rwy, procName, [...fixes, ...common]);
  }

  // Process STARs: collect common legs, then add runway-specific entries
  const starCommon = {};
  for (const [key, fixes] of Object.entries(legs)) {
    const [type, procName, transition, rt] = key.split(':');
    if (type !== 'STAR') continue;
    const routeType = parseInt(rt);
    if (routeType === 5 || (routeType === 2 && transition === 'ALL') || routeType === 2) {
      if (!starCommon[procName]) starCommon[procName] = [];
      for (const f of fixes) {
        if (f && !starCommon[procName].includes(f)) starCommon[procName].push(f);
      }
    }
  }

  // STAR runway transitions (type 6) or type 4 with RWxx
  for (const [key, fixes] of Object.entries(legs)) {
    const [type, procName, transition, rt] = key.split(':');
    if (type !== 'STAR') continue;
    const routeType = parseInt(rt);
    if ((routeType === 6 || routeType === 4) && transition.startsWith('RW')) {
      const rwy = transition.substring(2);
      const common = starCommon[procName] || [];
      addEntry('STAR', rwy, procName, [...common, ...fixes]);
    }
  }

  // STARs with only common route (no runway-specific)
  for (const [procName, fixes] of Object.entries(starCommon)) {
    const hasRwyTransition = Object.keys(legs).some(k => {
      const [t, p, tr, r] = k.split(':');
      return t === 'STAR' && p === procName && tr.startsWith('RW') && (r === '6' || r === '4');
    });
    if (!hasRwyTransition && fixes.length > 0) {
      const entryKey = `STAR:${icao}::${procName}`;
      if (!seen.has(entryKey)) {
        seen.add(entryKey);
        result.push(`STAR:${icao}::${procName}:${fixes.join(' ')}`);
      }
    }
  }

  return result.sort();
}

/**
 * Parse GeoJSON FIR boundaries and find FIRs that the route transits.
 * Samples points along the great circle between centers, checks which FIR each point is in.
 * Returns unique FIRs with their polygon boundary points for SCT [ARTCC] output.
 */
export function parseRouteFIRs(geojsonPath, depLat, depLon, arrLat, arrLon) {
  if (!fs.existsSync(geojsonPath)) return [];
  const data = JSON.parse(fs.readFileSync(geojsonPath, 'utf-8'));
  const features = data.features || [];

  function pointInPolygon(lat, lon, coords) {
    let inside = false;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      const xi = coords[i][1], yi = coords[i][0]; // GeoJSON is [lon, lat]
      const xj = coords[j][1], yj = coords[j][0];
      if (((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  const FIR_ALIASES = { 'EGTL': 'EGTT' };
  function baseFirCode(id) {
    if (!id) return null;
    const base = id.split('-')[0];
    return FIR_ALIASES[base] || base;
  }

  function getFirAtPoint(lat, lon) {
    for (const f of features) {
      const geom = f.geometry;
      if (!geom) continue;
      const polys = geom.type === 'MultiPolygon' ? geom.coordinates : geom.type === 'Polygon' ? [geom.coordinates] : [];
      for (const poly of polys) {
        if (poly[0] && pointInPolygon(lat, lon, poly[0])) return baseFirCode(f.properties?.id);
      }
    }
    return null;
  }

  // Sample 100 points along route to find transited top-level FIRs
  const transitTopFirs = new Set();
  for (let i = 0; i <= 100; i++) {
    const frac = i / 100;
    const lat = depLat + (arrLat - depLat) * frac;
    const lon = depLon + (arrLon - depLon) * frac;
    const fir = getFirAtPoint(lat, lon);
    if (fir) transitTopFirs.add(fir);
  }

  // Collect ALL features (including sub-sectors) that belong to transited FIRs
  const result = [];
  const seen = new Set();
  for (const f of features) {
    const rawId = f.properties?.id;
    if (!rawId) continue;
    const topLevel = baseFirCode(rawId);
    if (!transitTopFirs.has(topLevel)) continue;
    // Include this feature (sub-sector or main)
    if (seen.has(rawId)) continue;
    seen.add(rawId);
    const geom = f.geometry;
    if (!geom) continue;
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : geom.type === 'Polygon' ? [geom.coordinates] : [];
    for (const poly of polys) {
      const ring = poly[0];
      if (!ring || ring.length < 3) continue;
      result.push({
        icao: rawId,
        points: ring.map(c => ({ lat: c[1], lon: c[0] }))
      });
    }
  }

  return result;
}

export async function parseAirways(filePath, centers, radiusNm = 200) {
  const high = [];
  const low = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.startsWith('I') || line.startsWith('9') || line.trim() === '' || line.includes('Version')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;

    const ident1 = parts[0];
    const lat1 = parseFloat(parts[1]);
    const lon1 = parseFloat(parts[2]);
    const ident2 = parts[3];
    const lat2 = parseFloat(parts[4]);
    const lon2 = parseFloat(parts[5]);
    const routeType = parseInt(parts[6]);
    const name = parts[9];

    if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) continue;

    const near = centers.some(c =>
      haversineNm(c.lat, c.lon, lat1, lon1) <= radiusNm ||
      haversineNm(c.lat, c.lon, lat2, lon2) <= radiusNm
    );
    if (!near) continue;

    const segment = { name, lat1, lon1, lat2, lon2 };
    if (routeType === 2) high.push(segment);
    else low.push(segment);
  }

  return { high, low };
}

/**
 * Parse VATSpy data to get VATSIM positions and FIR bounding boxes for transited FIRs.
 * Returns { positions: [{callsign, name, firId}], radars: [{name, lat, lon}] }
 */
export function parseVATSpyForFIRs(vatspyPath, firBoundariesPath, transitFirIds) {
  // Get top-level FIR IDs (strip sub-sector suffix for matching)
  const topLevelIds = new Set();
  for (const id of transitFirIds) {
    topLevelIds.add(id.split('-')[0]);
    topLevelIds.add(id); // also keep full id like EGTT-E
  }

  // Parse VATSpy.dat [FIRs] section for positions
  const positions = [];
  const seenCallsigns = new Set();
  const vatspyLines = fs.readFileSync(vatspyPath, 'utf-8').split('\n');
  let inFirs = false;
  for (const line of vatspyLines) {
    if (line.startsWith('[FIRs]')) { inFirs = true; continue; }
    if (line.startsWith('[') && inFirs) break;
    if (!inFirs || line.startsWith(';') || !line.trim()) continue;
    const parts = line.split('|');
    if (parts.length < 4) continue;
    const firId = parts[0].trim();
    const name = parts[1].trim();
    const callsignPrefix = parts[2].trim();
    const boundaryId = parts[3].trim();
    // Check if this FIR is one we transit
    const firBase = firId.split('-')[0].replace(/_/g, '-');
    if (!topLevelIds.has(firBase) && !topLevelIds.has(firId)) continue;
    if (callsignPrefix && !seenCallsigns.has(callsignPrefix)) {
      seenCallsigns.add(callsignPrefix);
      positions.push({ callsign: callsignPrefix, name, firId });
    }
  }

  // Parse FIRBoundaries.dat to get bounding boxes for radar placement
  const firBounds = [];
  const seenFirs = new Set();
  const boundLines = fs.readFileSync(firBoundariesPath, 'utf-8').split('\n');
  for (const line of boundLines) {
    if (!line.includes('|')) continue;
    const parts = line.split('|');
    const icao = parts[0];
    // Only top-level FIRs (no sub-sectors) for radar coverage
    if (icao.includes('-')) continue;
    if (!topLevelIds.has(icao)) continue;
    if (seenFirs.has(icao)) continue;
    seenFirs.add(icao);
    const minLat = parseFloat(parts[4]);
    const minLon = parseFloat(parts[5]);
    const maxLat = parseFloat(parts[6]);
    const maxLon = parseFloat(parts[7]);
    const centerLat = parseFloat(parts[8]);
    const centerLon = parseFloat(parts[9]);
    if (!isNaN(minLat)) firBounds.push({ icao, minLat, minLon, maxLat, maxLon, centerLat, centerLon });
  }

  // Generate radar grid to cover each FIR
  // Place radars every ~4 degrees (approx 240nm) in a grid
  const GRID_STEP = 4;
  const RADAR_RANGE = 300;
  const radars = [];
  let radarIdx = 0;
  for (const fir of firBounds) {
    for (let lat = fir.minLat; lat <= fir.maxLat; lat += GRID_STEP) {
      for (let lon = fir.minLon; lon <= fir.maxLon; lon += GRID_STEP) {
        radars.push({
          name: `WF_R${radarIdx++}`,
          lat, lon
        });
      }
    }
  }

  return { positions, radars, firBounds };
}
