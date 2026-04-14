import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decimalToDMS, coordPair, bearing, projectPoint, haversineNm, midpoint } from './lib/geo.js';
import { parseFixes, parseNavaids, parseAirways, parseCIFP, parseRouteFIRs } from './lib/parsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

const LEG_NUM = process.argv[2] || '01';
const FROM = process.argv[3] || 'EGLL';
const TO = process.argv[4] || 'EHAM';
const ATC_ROUTE = process.argv[5] || '';
const LEG_NAME = `WF26${LEG_NUM.padStart(2, '0')}`;

const RADIUS = 100; // 100nm radius around airports and along route corridor
const COASTLINE_PATH = path.join(__dirname, '..', 'data', 'world_coastline.sct');
const NAVDATA_DIR = path.join(__dirname, '..', 'data', 'navdata');
const CIFP_DIR = path.join(__dirname, '..', 'data', 'XP12', 'CIFP');
const FIR_GEOJSON = path.join(__dirname, '..', 'public', 'fir-boundaries.geojson');
const OUTPUT_DIR = path.join(__dirname, '..', 'Euroscope_Files', 'WorldFlight');

function loadGround(icao) {
  const groundPath = path.join(OUTPUT_DIR, `${icao}_ground.txt`);
  if (!fs.existsSync(groundPath)) return { regions: '', geo: '', labels: '' };
  const ground = fs.readFileSync(groundPath, 'utf-8');
  const regionsStart = ground.indexOf('; === REGIONS');
  const geoStart = ground.indexOf('; === GEO');
  const labelsStart = ground.indexOf('; === LABELS');
  return {
    regions: ground.substring(regionsStart, geoStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n'),
    geo: ground.substring(geoStart, labelsStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n'),
    labels: ground.substring(labelsStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n')
  };
}

function addRunwaysCenterlines(L, airport, icao) {
  for (const rwy of airport.runways) {
    if (!rwy.ident1 || !rwy.lat1) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const recip = (hdg + 180) % 360;
    const ext1 = projectPoint(rwy.lat1, rwy.lon1, recip, 10);
    const ext2 = projectPoint(rwy.lat2, rwy.lon2, hdg, 10);
    L.push(`${icao}-${rwy.ident1} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(ext1.lat, ext1.lon)} centrelinecolour`);
    if (rwy.ident2) L.push(`${icao}-${rwy.ident2} ${coordPair(rwy.lat2, rwy.lon2)} ${coordPair(ext2.lat, ext2.lon)} centrelinecolour`);
  }
}

function addGeoForAirport(L, airport, icao, groundData) {
  L.push(`${icao} Ground              S999.00.00.000 E999.00.00.000 S999.00.00.000 E999.00.00.000`);
  for (const radius of [5, 10]) {
    for (let i = 0; i < 36; i++) {
      const a1 = (360 / 36) * i;
      const a2 = (360 / 36) * (i + 1);
      const p1 = projectPoint(airport.lat, airport.lon, a1, radius);
      const p2 = projectPoint(airport.lat, airport.lon, a2, radius);
      L.push(`${coordPair(p1.lat, p1.lon)} ${coordPair(p2.lat, p2.lon)} rangering`);
    }
  }
  if (groundData.geo) L.push(groundData.geo);
}

function addRegionsForAirport(L, airport, icao, groundData) {
  if (groundData.regions) L.push(groundData.regions);
  for (const rwy of airport.runways) {
    if (!rwy.lat1 || !rwy.lon1 || !rwy.lat2 || !rwy.lon2) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const perpL = (hdg + 90) % 360;
    const perpR = (hdg + 270) % 360;
    const halfWidth = 0.008;
    const c1 = projectPoint(rwy.lat1, rwy.lon1, perpL, halfWidth);
    const c2 = projectPoint(rwy.lat1, rwy.lon1, perpR, halfWidth);
    const c3 = projectPoint(rwy.lat2, rwy.lon2, perpR, halfWidth);
    const c4 = projectPoint(rwy.lat2, rwy.lon2, perpL, halfWidth);
    L.push(`REGIONNAME ${icao}`);
    L.push(`smrRunway ${coordPair(c1.lat, c1.lon)}`);
    L.push(` ${coordPair(c4.lat, c4.lon)}`);
    L.push(` ${coordPair(c3.lat, c3.lon)}`);
    L.push(` ${coordPair(c2.lat, c2.lon)}`);
    L.push(` ${coordPair(c1.lat, c1.lon)}`);
    L.push('');
  }
}

function buildVsmrRunways(airport) {
  const dmsPt = (lat, lon) => [decimalToDMS(lat, true), decimalToDMS(lon, false)];
  const halfWidth = 0.032;
  const runways = [];
  for (const rwy of airport.runways) {
    if (!rwy.lat1 || !rwy.lon1 || !rwy.lat2 || !rwy.lon2) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const perpL = (hdg + 90) % 360;
    const perpR = (hdg + 270) % 360;
    const c1 = projectPoint(rwy.lat1, rwy.lon1, perpL, halfWidth);
    const c2 = projectPoint(rwy.lat2, rwy.lon2, perpL, halfWidth);
    const c3 = projectPoint(rwy.lat2, rwy.lon2, perpR, halfWidth);
    const c4 = projectPoint(rwy.lat1, rwy.lon1, perpR, halfWidth);
    runways.push({
      runway_name: `${rwy.ident1}/${rwy.ident2}`,
      path: [dmsPt(c1.lat, c1.lon), dmsPt(c2.lat, c2.lon), dmsPt(c3.lat, c3.lon), dmsPt(c4.lat, c4.lon)],
      path_lvp: [dmsPt(c1.lat, c1.lon), dmsPt(c2.lat, c2.lon), dmsPt(c3.lat, c3.lon), dmsPt(c4.lat, c4.lon)]
    });
  }
  return runways;
}

function buildSmrAsr(legName, icao, airport, suffix) {
  const boxSize = 0.04;
  const lines = [
    'DisplayTypeName:SMR radar display',
    'DisplayTypeNeedRadarContent:0',
    'DisplayTypeGeoReferenced:1',
    `Geo:${icao} Ground:`,
    `Regions:${icao}:polygon`,
  ];
  for (const rwy of airport.runways) {
    if (rwy.ident1) lines.push(`Runways:${icao}:${rwy.ident1}:centerline`);
    if (rwy.ident2) lines.push(`Runways:${icao}:${rwy.ident2}:centerline`);
  }
  lines.push(`SHOWC:${icao}_TWR:1`);
  lines.push('SHOWSB:0', 'BELOW:0', 'ABOVE:0', 'LEADER:5', 'SHOWLEADER:1');
  lines.push('HISTORY_DOTS:5', 'SIMULATION_MODE:1', 'DISABLEPANNING:0', 'DISABLEZOOMING:0');
  lines.push('DisplayRotation:0.00000', 'TAGFAMILY:Matias (built in)');
  lines.push(`m_Latitude:${airport.lat}`, `m_Longitude:${airport.lon}`);
  lines.push(`WINDOWAREA:${(airport.lat - boxSize).toFixed(6)}:${(airport.lon - boxSize * 1.3).toFixed(6)}:${(airport.lat + boxSize).toFixed(6)}:${(airport.lon + boxSize * 1.3).toFixed(6)}`);
  lines.push(`PLUGIN:vSMR Vatsim UK:ActiveProfile:WorldFlight`);
  lines.push(`PLUGIN:vSMR Vatsim UK:Afterglow:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:Airport:${icao}`);
  lines.push(`PLUGIN:vSMR Vatsim UK:AppTrailsDots:4`);
  lines.push(`PLUGIN:vSMR Vatsim UK:FontSize:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:ShowAircraftType:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:ShowSID:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:ShowWakeTurb:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1Display:1`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1Filter:5500`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1OffsetX:0`, `PLUGIN:vSMR Vatsim UK:SRW1OffsetY:0`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1Rotation:0`, `PLUGIN:vSMR Vatsim UK:SRW1Scale:30`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1TopLeftX:1545`, `PLUGIN:vSMR Vatsim UK:SRW1TopLeftY:629`);
  lines.push(`PLUGIN:vSMR Vatsim UK:SRW1BottomRightX:1920`, `PLUGIN:vSMR Vatsim UK:SRW1BottomRightY:928`);
  return lines;
}

function buildAppAsr(icao, airport) {
  const lines = [
    'DisplayTypeName:Standard ES radar screen',
    'DisplayTypeNeedRadarContent:1',
    'DisplayTypeGeoReferenced:1',
    `Airports:${icao}:symbol`, `Airports:${icao}:name`,
  ];
  for (const rwy of airport.runways) {
    if (rwy.ident1) lines.push(`Runways:${icao}:${rwy.ident1}:centerline`);
    if (rwy.ident2) lines.push(`Runways:${icao}:${rwy.ident2}:centerline`);
    if (rwy.ident1) lines.push(`Sids:${icao}-${rwy.ident1}`);
    if (rwy.ident2) lines.push(`Sids:${icao}-${rwy.ident2}`);
  }
  lines.push(`SHOWC:${icao}_TWR:1`);
  lines.push(`m_Latitude:${airport.lat}`, `m_Longitude:${airport.lon}`);
  lines.push('m_Zoom:7');
  return lines;
}

async function main() {
  console.log(`=== Generating ${LEG_NAME} (${FROM} -> ${TO}) ===\n`);

  const depAirport = await prisma.airport.findUnique({ where: { icao: FROM }, include: { runways: true } });
  const arrAirport = await prisma.airport.findUnique({ where: { icao: TO }, include: { runways: true } });
  if (!depAirport) { console.error(`Departure airport ${FROM} not found`); process.exit(1); }
  if (!arrAirport) { console.error(`Arrival airport ${TO} not found`); process.exit(1); }

  const centers = [
    { icao: FROM, lat: depAirport.lat, lon: depAirport.lon },
    { icao: TO, lat: arrAirport.lat, lon: arrAirport.lon }
  ];
  const dist = haversineNm(depAirport.lat, depAirport.lon, arrAirport.lat, arrAirport.lon);
  const mid = midpoint(depAirport.lat, depAirport.lon, arrAirport.lat, arrAirport.lon);
  console.log(`  Distance: ${dist.toFixed(0)}nm | Midpoint: ${mid.lat.toFixed(2)}, ${mid.lon.toFixed(2)}`);

  // Add route corridor points as additional centers for navdata search
  // Sample every ~150nm along route so 100nm radius gives continuous corridor coverage
  const routeCenters = [...centers];
  const corridorSamples = Math.max(5, Math.ceil(dist / 150));
  for (let i = 1; i < corridorSamples; i++) {
    const frac = i / corridorSamples;
    const lat = depAirport.lat + (arrAirport.lat - depAirport.lat) * frac;
    const lon = depAirport.lon + (arrAirport.lon - depAirport.lon) * frac;
    routeCenters.push({ icao: 'RTE', lat, lon });
  }

  console.log('Parsing navdata...');
  const fixes = await parseFixes(path.join(NAVDATA_DIR, 'earth_fix.dat'), routeCenters, RADIUS);
  const { vors, ndbs } = await parseNavaids(path.join(NAVDATA_DIR, 'earth_nav.dat'), routeCenters, RADIUS);
  const airways = await parseAirways(path.join(NAVDATA_DIR, 'earth_awy.dat'), routeCenters, RADIUS);
  console.log(`  ${fixes.length} fixes, ${vors.length} VORs, ${ndbs.length} NDBs, ${airways.high.length} high/${airways.low.length} low airways`);

  // Parse FIR boundaries along route
  const routeFirs = parseRouteFIRs(FIR_GEOJSON, depAirport.lat, depAirport.lon, arrAirport.lat, arrAirport.lon);
  console.log(`  ${routeFirs.length} FIRs along route`);

  // Load ground layouts
  console.log('Loading ground layouts...');
  const depGround = loadGround(FROM);
  const arrGround = loadGround(TO);

  // ===== BUILD SCT =====
  const L = [];
  L.push(`; ${LEG_NAME} EuroScope Sector File (${FROM} -> ${TO})`);
  L.push(`; Generated from Navigraph AIRAC 2603 + OpenStreetMap`);
  L.push('');
  L.push('#define smrRunway 5263440');
  L.push('#define smrRwyEdge 16777215');
  L.push('#define smrTaxiway 3289650');
  L.push('#define smrApron 6579300');
  L.push('#define smrBuilding 9211020');
  L.push('#define smrGrass 680970');
  L.push('#define centrelinecolour 15790135');
  L.push('#define twyline 17219');
  L.push('#define rangering 4227200');
  L.push('#define Coast 5263440');
  L.push('');

  // INFO centered on departure
  L.push('[INFO]');
  L.push(LEG_NAME);
  L.push(`${FROM}_CTR`);
  L.push(FROM);
  L.push(coordPair(depAirport.lat, depAirport.lon).split(' ')[0]);
  L.push(coordPair(depAirport.lat, depAirport.lon).split(' ')[1]);
  L.push('60');
  L.push('38');
  L.push('0');
  L.push('1.0');
  L.push('');

  // Both airports
  L.push('[AIRPORT]');
  L.push(`${FROM} 118.500 ${coordPair(depAirport.lat, depAirport.lon)} D`);
  L.push(`${TO} 118.500 ${coordPair(arrAirport.lat, arrAirport.lon)} D`);
  L.push('');

  // Runways for both
  L.push('[RUNWAY]');
  for (const rwy of depAirport.runways) {
    if (!rwy.ident1 || !rwy.lat1) continue;
    const hdg1 = Math.round(bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2));
    const hdg2 = (hdg1 + 180) % 360;
    L.push(`${rwy.ident1.padEnd(4)} ${(rwy.ident2 || '').padEnd(4)} ${String(hdg1).padStart(3, '0')} ${String(hdg2).padStart(3, '0')} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(rwy.lat2, rwy.lon2)} ${FROM} ${depAirport.name}`);
  }
  for (const rwy of arrAirport.runways) {
    if (!rwy.ident1 || !rwy.lat1) continue;
    const hdg1 = Math.round(bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2));
    const hdg2 = (hdg1 + 180) % 360;
    L.push(`${rwy.ident1.padEnd(4)} ${(rwy.ident2 || '').padEnd(4)} ${String(hdg1).padStart(3, '0')} ${String(hdg2).padStart(3, '0')} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(rwy.lat2, rwy.lon2)} ${TO} ${arrAirport.name}`);
  }
  L.push('');

  // Navdata
  L.push('[VOR]');
  for (const v of vors) L.push(`${v.ident.padEnd(5)} ${v.freq} ${coordPair(v.lat, v.lon)}`);
  L.push('');
  L.push('[NDB]');
  for (const n of ndbs) L.push(`${n.ident.padEnd(5)} ${n.freq} ${coordPair(n.lat, n.lon)}`);
  L.push('');
  L.push('[FIXES]');
  const fixMap = new Map();
  for (const f of fixes) { const k = `${f.ident}_${f.lat.toFixed(4)}`; if (!fixMap.has(k)) fixMap.set(k, f); }
  for (const f of [...fixMap.values()]) L.push(`${f.ident.padEnd(6)} ${coordPair(f.lat, f.lon)}`);
  L.push('');
  L.push('[HIGH AIRWAY]');
  const awyDedup = new Set();
  for (const s of airways.high) { const k = `${s.name}${s.lat1.toFixed(4)}${s.lon1.toFixed(4)}`; if (!awyDedup.has(k)) { awyDedup.add(k); L.push(`${s.name.padEnd(6)} ${coordPair(s.lat1, s.lon1)} ${coordPair(s.lat2, s.lon2)}`); } }
  L.push('');
  L.push('[LOW AIRWAY]');
  for (const s of airways.low) { const k = `${s.name}${s.lat1.toFixed(4)}${s.lon1.toFixed(4)}`; if (!awyDedup.has(k)) { awyDedup.add(k); L.push(`${s.name.padEnd(6)} ${coordPair(s.lat1, s.lon1)} ${coordPair(s.lat2, s.lon2)}`); } }
  L.push('');

  // Build waypoint lookup for SID/STAR/route drawing
  const wpLookup = new Map();
  for (const f of fixes) { if (!wpLookup.has(f.ident)) wpLookup.set(f.ident, f); }
  for (const v of vors) { if (!wpLookup.has(v.ident)) wpLookup.set(v.ident, v); }
  for (const n of ndbs) { if (!wpLookup.has(n.ident)) wpLookup.set(n.ident, n); }

  // Parse CIFP for both airports to get SID/STAR fix sequences
  const allSidStars = [];
  for (const icao of [FROM, TO]) {
    const cifpPath = path.join(CIFP_DIR, `${icao}.dat`);
    if (fs.existsSync(cifpPath)) {
      const entries = parseCIFP(cifpPath, icao);
      allSidStars.push(...entries);
    }
  }

  // Collect all fix names from SID/STAR entries and resolve missing ones
  const allProcFixes = new Set();
  for (const entry of allSidStars) {
    const fixPart = entry.split(':')[4] || '';
    for (const f of fixPart.split(' ')) if (f) allProcFixes.add(f);
  }
  if (ATC_ROUTE) {
    for (const part of ATC_ROUTE.trim().split(/\s+/)) {
      if (!(/\d/.test(part) && /^[A-Z]{1,2}\d/.test(part)) && !(/\d$/.test(part) && part.length > 4)) {
        allProcFixes.add(part);
      }
    }
  }
  // Scan full fix file for any missing waypoints
  const missingFixes = [...allProcFixes].filter(n => !wpLookup.has(n));
  if (missingFixes.length > 0) {
    const missingSet = new Set(missingFixes);
    const fixFile = fs.readFileSync(path.join(NAVDATA_DIR, 'earth_fix.dat'), 'utf-8');
    for (const line of fixFile.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      if (missingSet.has(parts[2]) && !wpLookup.has(parts[2])) {
        const lat = parseFloat(parts[0]), lon = parseFloat(parts[1]);
        if (!isNaN(lat) && !isNaN(lon)) {
          wpLookup.set(parts[2], { ident: parts[2], lat, lon });
          missingSet.delete(parts[2]);
        }
      }
      if (missingSet.size === 0) break;
    }
  }

  // Draw SID routes
  L.push('[SID]');
  addRunwaysCenterlines(L, depAirport, FROM);
  addRunwaysCenterlines(L, arrAirport, TO);
  for (const entry of allSidStars.filter(e => e.startsWith('SID:'))) {
    const parts = entry.split(':');
    const procName = `${parts[1]}-${parts[3]}`; // EGLL-BPK5K
    const fixNames = (parts[4] || '').split(' ').filter(f => f);
    for (let i = 0; i < fixNames.length - 1; i++) {
      const p1 = wpLookup.get(fixNames[i]);
      const p2 = wpLookup.get(fixNames[i + 1]);
      if (p1 && p2) L.push(`${procName.padEnd(14).substring(0, 14)} ${coordPair(p1.lat, p1.lon)} ${coordPair(p2.lat, p2.lon)}`);
    }
  }

  // Draw ATC route with airway expansion
  if (ATC_ROUTE) {
    // Build airway graph: awyName -> adjacency list of fix pairs
    const awyGraph = {};
    const awyFile = fs.readFileSync(path.join(NAVDATA_DIR, 'earth_awy.dat'), 'utf-8');
    for (const line of awyFile.split('\n')) {
      if (line.startsWith('I') || line.startsWith('9') || !line.trim()) continue;
      const p = line.trim().split(/\s+/);
      if (p.length < 10) continue;
      const fix1 = p[0], lat1 = parseFloat(p[1]), lon1 = parseFloat(p[2]);
      const fix2 = p[3], lat2 = parseFloat(p[4]), lon2 = parseFloat(p[5]);
      const name = p[9];
      if (!awyGraph[name]) awyGraph[name] = {};
      if (!awyGraph[name][fix1]) awyGraph[name][fix1] = [];
      if (!awyGraph[name][fix2]) awyGraph[name][fix2] = [];
      awyGraph[name][fix1].push({ fix: fix2, lat: lat2, lon: lon2 });
      awyGraph[name][fix2].push({ fix: fix1, lat: lat1, lon: lon1 });
      // Also add to wpLookup
      if (!wpLookup.has(fix1)) wpLookup.set(fix1, { ident: fix1, lat: lat1, lon: lon1 });
      if (!wpLookup.has(fix2)) wpLookup.set(fix2, { ident: fix2, lat: lat2, lon: lon2 });
    }

    // Expand airway between two fixes using BFS
    function expandAirway(awyName, fromFix, toFix) {
      const graph = awyGraph[awyName] || awyGraph['U' + awyName] || awyGraph[awyName.replace(/^U/, '')];
      if (!graph || !graph[fromFix]) return [fromFix, toFix]; // fallback: direct
      const visited = new Set([fromFix]);
      const queue = [[fromFix]];
      while (queue.length) {
        const path = queue.shift();
        const current = path[path.length - 1];
        if (current === toFix) return path;
        for (const next of (graph[current] || [])) {
          if (!visited.has(next.fix)) {
            visited.add(next.fix);
            queue.push([...path, next.fix]);
          }
        }
      }
      return [fromFix, toFix]; // fallback
    }

    // Parse route: FIX AWY FIX AWY FIX...
    const routeParts = ATC_ROUTE.trim().split(/\s+/);
    const expandedFixes = [];
    let i = 0;
    while (i < routeParts.length) {
      const current = routeParts[i];
      const isAirway = /\d/.test(current) && /^[A-Z]{1,2}\d/.test(current);
      if (isAirway && i > 0 && i < routeParts.length - 1) {
        // This is an airway — expand between previous fix and next fix
        const prevFix = routeParts[i - 1];
        const nextFix = routeParts[i + 1];
        const expanded = expandAirway(current, prevFix, nextFix);
        // Skip first element (already added) and add the rest
        for (let j = 1; j < expanded.length; j++) expandedFixes.push(expanded[j]);
        i += 2; // skip the airway and the next fix (already added via expansion)
      } else if (!isAirway) {
        expandedFixes.push(current);
        i++;
      } else {
        i++;
      }
    }

    // Build route points from expanded fixes
    const routePoints = [{ lat: depAirport.lat, lon: depAirport.lon, name: FROM }];
    for (const name of expandedFixes) {
      const wp = wpLookup.get(name);
      if (wp) routePoints.push({ lat: wp.lat, lon: wp.lon, name });
    }
    routePoints.push({ lat: arrAirport.lat, lon: arrAirport.lon, name: TO });

    // Deduplicate consecutive
    const deduped = routePoints.filter((p, idx) => idx === 0 || p.name !== routePoints[idx - 1].name);

    L.push(`; ATC Route: ${ATC_ROUTE}`);
    L.push(`; Expanded: ${deduped.map(p => p.name).join(' ')}`);
    for (let i = 0; i < deduped.length - 1; i++) {
      L.push(`${LEG_NAME.padEnd(14)} ${coordPair(deduped[i].lat, deduped[i].lon)} ${coordPair(deduped[i + 1].lat, deduped[i + 1].lon)}`);
    }
    console.log(`  Route: ${deduped.length} waypoints (expanded from "${ATC_ROUTE}")`);
  }
  L.push('');

  // Draw STAR routes
  L.push('[STAR]');
  for (const entry of allSidStars.filter(e => e.startsWith('STAR:'))) {
    const parts = entry.split(':');
    const procName = `${parts[1]}-${parts[3]}`; // EHAM-SUGOL1A
    const fixNames = (parts[4] || '').split(' ').filter(f => f);
    for (let i = 0; i < fixNames.length - 1; i++) {
      const p1 = wpLookup.get(fixNames[i]);
      const p2 = wpLookup.get(fixNames[i + 1]);
      if (p1 && p2) L.push(`${procName.padEnd(14).substring(0, 14)} ${coordPair(p1.lat, p1.lon)} ${coordPair(p2.lat, p2.lon)}`);
    }
  }
  L.push('');
  L.push('[ARTCC]');
  // FIR boundaries from VATSpy data
  for (const fir of routeFirs) {
    for (let i = 0; i < fir.points.length - 1; i++) {
      const p1 = fir.points[i];
      const p2 = fir.points[i + 1];
      L.push(`${fir.icao.padEnd(6)} ${coordPair(p1.lat, p1.lon)} ${coordPair(p2.lat, p2.lon)}`);
    }
    // Close the polygon
    if (fir.points.length > 2) {
      const first = fir.points[0];
      const last = fir.points[fir.points.length - 1];
      L.push(`${fir.icao.padEnd(6)} ${coordPair(last.lat, last.lon)} ${coordPair(first.lat, first.lon)}`);
    }
  }
  L.push('');
  L.push('[ARTCC HIGH]');
  L.push('');
  L.push('[ARTCC LOW]');
  L.push('');

  // GEO for both airports + coastline
  L.push('[GEO]');
  addGeoForAirport(L, depAirport, FROM, depGround);
  L.push('');
  addGeoForAirport(L, arrAirport, TO, arrGround);
  L.push('');

  // Add world coastline clipped to route corridor
  if (fs.existsSync(COASTLINE_PATH)) {
    // Parse DMS coordinate to decimal
    function parseDMS(dms) {
      const m = dms.match(/^([NSEW])(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (!m) return NaN;
      const deg = parseInt(m[2]) + parseInt(m[3]) / 60 + parseFloat(`${m[4]}.${m[5]}`) / 3600;
      return (m[1] === 'S' || m[1] === 'W') ? -deg : deg;
    }

    // Bounding box: route corridor + margin
    const margin = 3; // degrees
    const allLats = routeCenters.map(c => c.lat);
    const allLons = routeCenters.map(c => c.lon);
    const bbMinLat = Math.min(...allLats) - margin;
    const bbMaxLat = Math.max(...allLats) + margin;
    const bbMinLon = Math.min(...allLons) - margin;
    const bbMaxLon = Math.max(...allLons) + margin;

    const coastFile = fs.readFileSync(COASTLINE_PATH, 'utf-8');
    const geoStart = coastFile.indexOf('[GEO]');
    if (geoStart !== -1) {
      const geoLines = coastFile.substring(geoStart + 5).split('\n');
      let coastCount = 0;
      L.push('; World Coastline');
      L.push(`Coastline            S999.00.00.000 E999.00.00.000 S999.00.00.000 E999.00.00.000`);
      for (const line of geoLines) {
        if (line.startsWith('[')) break; // next section
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';')) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 5) continue;
        const lat1 = parseDMS(parts[0]), lon1 = parseDMS(parts[1]);
        const lat2 = parseDMS(parts[2]), lon2 = parseDMS(parts[3]);
        if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) continue;
        // Check if either endpoint is within bounding box
        const in1 = lat1 >= bbMinLat && lat1 <= bbMaxLat && lon1 >= bbMinLon && lon1 <= bbMaxLon;
        const in2 = lat2 >= bbMinLat && lat2 <= bbMaxLat && lon2 >= bbMinLon && lon2 <= bbMaxLon;
        if (in1 || in2) {
          L.push(trimmed);
          coastCount++;
        }
      }
      console.log(`  ${coastCount} coastline segments`);
    }
  }
  L.push('');

  // Labels for both
  L.push('[LABELS]');
  L.push(`"${FROM}" ${coordPair(depAirport.lat, depAirport.lon)} 16777215`);
  if (depGround.labels) L.push(depGround.labels);
  L.push(`"${TO}" ${coordPair(arrAirport.lat, arrAirport.lon)} 16777215`);
  if (arrGround.labels) L.push(arrGround.labels);
  L.push('');

  // Regions for both
  L.push('[REGIONS]');
  addRegionsForAirport(L, depAirport, FROM, depGround);
  addRegionsForAirport(L, arrAirport, TO, arrGround);
  L.push('');

  // Write SCT
  const sctDir = path.join(OUTPUT_DIR, 'Data', 'Sector_Files');
  fs.mkdirSync(sctDir, { recursive: true });
  fs.writeFileSync(path.join(sctDir, `${LEG_NAME}.sct`), L.join('\r\n'), 'utf-8');
  console.log(`Written ${L.length} lines (${(L.join('\r\n').length / 1024).toFixed(0)}KB) to ${LEG_NAME}.sct`);

  // ===== BUILD ESE =====
  const E = [];
  E.push(`; ${LEG_NAME} Extended Sector File (${FROM} -> ${TO})`);
  E.push('');
  E.push('[POSITIONS]');
  for (const [icao, apt] of [[FROM, depAirport], [TO, arrAirport]]) {
    for (const pos of [{s:'OBS',n:'Observer',f:'199.998'},{s:'DEL',n:'Delivery',f:'121.700'},{s:'GND',n:'Ground',f:'121.800'},{s:'TWR',n:'Tower',f:'118.500'},{s:'APP',n:'Approach',f:'119.000'}]) {
      E.push(`${icao}_${pos.s}:${apt.name} ${pos.n}:${pos.f}:${icao}:${pos.s.charAt(0)}:${icao}:${pos.s}:-:-:0100:0177:35:${coordPair(apt.lat, apt.lon)}`);
    }
  }
  E.push('');
  E.push('[SIDSSTARS]');
  let totalSids = 0, totalStars = 0;
  for (const icao of [FROM, TO]) {
    const cifpPath = path.join(CIFP_DIR, `${icao}.dat`);
    if (fs.existsSync(cifpPath)) {
      const sidstars = parseCIFP(cifpPath, icao);
      for (const entry of sidstars) E.push(entry);
      const sids = sidstars.filter(s => s.startsWith('SID:')).length;
      const stars = sidstars.filter(s => s.startsWith('STAR:')).length;
      totalSids += sids; totalStars += stars;
      console.log(`  ${icao}: ${sids} SIDs, ${stars} STARs`);
    }
  }
  E.push('');
  E.push('[AIRSPACE]');

  // Large encompassing sector for the entire leg (GND-FL660)
  // Create a wide box around the route corridor
  const boxMargin = 5; // degrees
  const allCenterLats = routeCenters.map(c => c.lat);
  const allCenterLons = routeCenters.map(c => c.lon);
  const sMinLat = Math.min(...allCenterLats) - boxMargin;
  const sMaxLat = Math.max(...allCenterLats) + boxMargin;
  const sMinLon = Math.min(...allCenterLons) - boxMargin;
  const sMaxLon = Math.max(...allCenterLons) + boxMargin;
  E.push(`SECTORLINE:${LEG_NAME}_BOUNDARY`);
  E.push(`COORD:${coordPair(sMinLat, sMinLon)}`);
  E.push(`COORD:${coordPair(sMaxLat, sMinLon)}`);
  E.push(`COORD:${coordPair(sMaxLat, sMaxLon)}`);
  E.push(`COORD:${coordPair(sMinLat, sMaxLon)}`);
  E.push(`COORD:${coordPair(sMinLat, sMinLon)}`);
  E.push('');
  E.push(`SECTOR:${LEG_NAME}:0:66000`);
  E.push(`OWNER:${FROM}_APP:${TO}_APP:${FROM}_TWR:${TO}_TWR:${FROM}_OBS:${TO}_OBS`);
  E.push(`ALTOWNER:Observer:${FROM}_OBS:${TO}_OBS:${FROM}_APP:${TO}_APP:${FROM}_TWR:${TO}_TWR`);
  E.push(`BORDER:${LEG_NAME}_BOUNDARY`);
  E.push('');

  // Per-airport sectors
  for (const [icao, apt] of [[FROM, depAirport], [TO, arrAirport]]) {
    const pts = [];
    for (let i = 0; i <= 36; i++) { const p = projectPoint(apt.lat, apt.lon, (360/36)*i, 30); pts.push(coordPair(p.lat, p.lon)); }
    E.push(`SECTORLINE:${icao}_BOUNDARY`);
    for (const pt of pts) E.push(`COORD:${pt}`);
    E.push('');
    E.push(`SECTOR:${icao}_TWR:0:24500`);
    E.push(`OWNER:${icao}_TWR:${icao}_APP`);
    E.push(`BORDER:${icao}_BOUNDARY`);
    E.push('');
  }

  fs.writeFileSync(path.join(sctDir, `${LEG_NAME}.ese`), E.join('\r\n'), 'utf-8');

  // ===== BUILD PRF =====
  const prfDir = path.join(OUTPUT_DIR, LEG_NAME);
  fs.mkdirSync(prfDir, { recursive: true });
  const prf = [
    `Settings\tSettingsfileSYMBOLOGY\t\\..\\Data\\Settings\\Symbology_Enroute.txt`,
    `Settings\tSettingsfileTAGS\t\\..\\Data\\Settings\\Tags.txt`,
    `Settings\tSettingsfileSCREEN\t\\..\\Data\\Settings\\Screen.txt`,
    `Settings\tSettingsfile\t\\..\\Data\\Settings\\General.txt`,
    `Settings\tSettingsfilePROFILE\t\\..\\Data\\Settings\\Profiles_${LEG_NAME}.txt`,
    `Settings\tSettingsfileARR\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileDEP\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileFP\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileSEL\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileSIL\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tSettingsfileCONFLICT\t\\..\\Data\\Settings\\Lists.txt`,
    `Settings\tsector\t\\..\\Data\\Sector_Files\\${LEG_NAME}.sct`,
    `Settings\tairlines\t\\..\\Data\\Datafiles\\ICAO_Airlines.txt`,
    `Settings\tairports\t\\..\\Data\\Datafiles\\ICAO_Airports.txt`,
    `Settings\taircraft\t\\..\\Data\\Datafiles\\ICAO_Aircraft.txt`,
    `Settings\tairportcoords\t\\..\\Data\\Datafiles\\icao.txt`,
    `ASRFastKeys\t1\t\\..\\Data\\ASR\\${LEG_NAME}_${FROM}_SMR.asr`,
    `ASRFastKeys\t2\t\\..\\Data\\ASR\\${LEG_NAME}_${FROM}_APP.asr`,
    `ASRFastKeys\t3\t\\..\\Data\\ASR\\${LEG_NAME}_Enroute.asr`,
    `ASRFastKeys\t4\t\\..\\Data\\ASR\\${LEG_NAME}_${TO}_SMR.asr`,
    `ASRFastKeys\t5\t\\..\\Data\\ASR\\${LEG_NAME}_${TO}_APP.asr`,
    `RecentFiles\tRecent1\t\\..\\Data\\ASR\\${LEG_NAME}_${FROM}_SMR.asr`,
    `RecentFiles\tRecent2\t\\..\\Data\\ASR\\${LEG_NAME}_${FROM}_APP.asr`,
    `RecentFiles\tRecent3\t\\..\\Data\\ASR\\${LEG_NAME}_Enroute.asr`,
    `RecentFiles\tRecent4\t\\..\\Data\\ASR\\${LEG_NAME}_${TO}_SMR.asr`,
    `RecentFiles\tRecent5\t\\..\\Data\\ASR\\${LEG_NAME}_${TO}_APP.asr`,
    `Plugins\tPlugin0\t\\..\\Data\\Plugin\\vSMR\\vSMR.dll`,
    `Plugins\tPlugin0Display0\tSMR radar display`,
    // TopSky disabled until rendering issue resolved
    // `Plugins\tPlugin1\t\\..\\Data\\Plugin\\TopSky\\TopSky.dll`,
    // `Plugins\tPlugin1Display0\tStandard ES radar screen`,
    // `Plugins\tPlugin1Display1\tSMR radar display`,
    `LastSession\tserver\tAUTOMATIC`,
    `LastSession\tcallsign\t${FROM}_OBS`,
  ];
  fs.writeFileSync(path.join(prfDir, `${LEG_NAME}.prf`), prf.join('\r\n'), 'utf-8');

  // ===== CONNECTION PROFILES =====
  const profilesDir = path.join(OUTPUT_DIR, 'Data', 'Settings');
  fs.mkdirSync(profilesDir, { recursive: true });
  const profLines = ['PROFILE'];
  for (const [icao] of [[FROM], [TO]]) {
    for (const { s, n, r, f } of [{s:'OBS',n:'Observer',r:100,f:0},{s:'APP',n:'Approach',r:100,f:5},{s:'TWR',n:'Tower',r:30,f:4},{s:'GND',n:'Ground',r:20,f:3},{s:'DEL',n:'Delivery',r:20,f:2}]) {
      profLines.push(`PROFILE:${icao}_${s}:${r}:${f}`);
      profLines.push(`ATIS2:${icao} ${n}`);
      profLines.push(`ATIS3:`);
      profLines.push(`ATIS4:WorldFlight 2026`);
    }
  }
  profLines.push('END');
  fs.writeFileSync(path.join(profilesDir, `Profiles_${LEG_NAME}.txt`), profLines.join('\r\n'), 'utf-8');

  // ===== ASR FILES =====
  const asrDir = path.join(OUTPUT_DIR, 'Data', 'ASR');
  fs.mkdirSync(asrDir, { recursive: true });

  // F1: Departure SMR
  fs.writeFileSync(path.join(asrDir, `${LEG_NAME}_${FROM}_SMR.asr`), buildSmrAsr(LEG_NAME, FROM, depAirport, 'DEP').join('\r\n'), 'utf-8');

  // F2: Departure APP
  fs.writeFileSync(path.join(asrDir, `${LEG_NAME}_${FROM}_APP.asr`), buildAppAsr(FROM, depAirport).join('\r\n'), 'utf-8');

  // F3: Enroute
  const enrZoom = dist < 500 ? 20 : dist < 2000 ? 10 : 5;
  const enroute = [
    'DisplayTypeName:Standard ES radar screen',
    'DisplayTypeNeedRadarContent:1',
    'DisplayTypeGeoReferenced:1',
    `Airports:${FROM}:symbol`, `Airports:${FROM}:name`,
    `Airports:${TO}:symbol`, `Airports:${TO}:name`,
    `SHOWC:${FROM}_TWR:1`, `SHOWC:${TO}_TWR:1`,
    'SHOWC:1',
    'SHOWSB:1',
    'BELOW:66000',
    'ABOVE:0',
    'LEADER:3',
    'SHOWLEADER:1',
    'TURNLEADER:0',
    'HISTORY_DOTS:0',
    'SIMULATION_MODE:1',
    'DISABLEPANNING:0',
    'DISABLEZOOMING:0',
    'DisplayRotation:0.00000',
    'TAGFAMILY:Matias (built in)',
    `m_Latitude:${mid.lat}`, `m_Longitude:${mid.lon}`,
    `m_Zoom:${enrZoom}`,
  ];
  fs.writeFileSync(path.join(asrDir, `${LEG_NAME}_Enroute.asr`), enroute.join('\r\n'), 'utf-8');

  // F4: Arrival SMR
  fs.writeFileSync(path.join(asrDir, `${LEG_NAME}_${TO}_SMR.asr`), buildSmrAsr(LEG_NAME, TO, arrAirport, 'ARR').join('\r\n'), 'utf-8');

  // F5: Arrival APP
  fs.writeFileSync(path.join(asrDir, `${LEG_NAME}_${TO}_APP.asr`), buildAppAsr(TO, arrAirport).join('\r\n'), 'utf-8');

  // ===== vSMR PROFILES =====
  const pluginDir = path.join(OUTPUT_DIR, 'Data', 'Plugin', 'vSMR');
  fs.mkdirSync(pluginDir, { recursive: true });
  const profilesPath = path.join(pluginDir, 'vSMR_Profiles.json');
  let profiles = [];
  if (fs.existsSync(profilesPath)) {
    profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf-8'));
  }
  if (!profiles.find(p => p.name === 'Default')) {
    profiles.unshift({
      name: 'Default',
      font: { font_name: 'EuroScope', weight: 'Regular', sizes: { one: 11, two: 12, three: 13, four: 14, five: 16 } },
      filters: { hide_above_alt: 10000, hide_above_spd: 250, radar_range_nm: 50, night_alpha_setting: 110,
        pro_mode: { enable: false, accept_pilot_squawk: true, do_not_autocorrelate_squawks: [] } },
      labels: { auto_deconfliction: true, leader_line_length: 50, use_aspeed_for_gate: false,
        squawk_error_color: { r: 255, g: 255, b: 0 },
        departure: { definition: [['callsign'], ['actype', 'wake']], background_color: { r: 40, g: 50, b: 200, a: 255 }, background_color_on_runway: { r: 40, g: 50, b: 200, a: 255 }, text_color: { r: 255, g: 255, b: 255 } },
        arrival: { definition: [['callsign'], ['actype']], background_color: { r: 170, g: 50, b: 50, a: 255 }, background_color_on_runway: { r: 170, g: 50, b: 50, a: 255 }, text_color: { r: 255, g: 255, b: 255 } },
        airborne: { use_departure_arrival_coloring: false, definition: [['callsign'], ['flightlevel']], text_color: { r: 255, g: 255, b: 255 }, background_color: { r: 0, g: 0, b: 0, a: 0 }, background_color_on_runway: { r: 0, g: 0, b: 0, a: 0 } },
        uncorrelated: { definition: [['systemid']], text_color: { r: 255, g: 255, b: 255 }, background_color: { r: 150, g: 22, b: 135, a: 255 }, background_color_on_runway: { r: 0, g: 0, b: 0, a: 0 } }
      },
      rimcas: { rimcas_label_only: true, use_red_symbol_for_emergencies: true, timer: [60,45,30,15,0], timer_lvp: [120,90,60,30,0], rimcas_stage_two_speed_threshold: 25,
        background_color_stage_one: { r: 160, g: 90, b: 30, a: 255 }, background_color_stage_two: { r: 150, g: 0, b: 0, a: 255 }, alert_text_color: { r: 255, g: 255, b: 255 } },
      targets: { show_primary_target: true, target_color: { r: 255, g: 242, b: 73, a: 255 }, history_one_color: { r: 0, g: 255, b: 255, a: 255 }, history_two_color: { r: 0, g: 219, b: 219, a: 255 }, history_three_color: { r: 0, g: 183, b: 183, a: 255 } },
      approach_insets: { extended_lines_length: 15, extended_lines_ticks_spacing: 1, extended_lines_color: { r: 255, g: 255, b: 255 }, runway_color: { r: 0, g: 0, b: 0 }, background_color: { r: 127, g: 122, b: 122 } }
    });
  }
  let wfProfile = profiles.find(p => p.name === 'WorldFlight');
  if (!wfProfile) {
    wfProfile = JSON.parse(JSON.stringify(profiles[0]));
    wfProfile.name = 'WorldFlight';
    wfProfile.maps = {};
    profiles.push(wfProfile);
  }
  if (!wfProfile.maps) wfProfile.maps = {};
  wfProfile.maps[FROM] = { runways: buildVsmrRunways(depAirport) };
  wfProfile.maps[TO] = { runways: buildVsmrRunways(arrAirport) };
  wfProfile.approach_insets = { extended_lines_length: 15, extended_lines_ticks_spacing: 1,
    extended_lines_color: { r: 150, g: 150, b: 150 }, runway_color: { r: 255, g: 255, b: 255 }, background_color: { r: 127, g: 122, b: 122 } };
  fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf-8');

  console.log(`\nGenerated ${LEG_NAME}:`);
  console.log(`  SCT: ${LEG_NAME}.sct (${FROM} + ${TO})`);
  console.log(`  ESE: ${LEG_NAME}.ese (${totalSids} SIDs, ${totalStars} STARs)`);
  console.log(`  ASR: DEP_SMR, DEP_APP, Enroute, ARR_SMR, ARR_APP`);
  console.log(`  PRF: ${LEG_NAME}.prf (F1-F5)`);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
