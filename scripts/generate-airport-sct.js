import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { coordPair, bearing, projectPoint } from './lib/geo.js';
import { parseFixes, parseNavaids, parseAirways } from './lib/parsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

const ICAO = process.argv[2] || 'EGLL';
const RADIUS = 50; // 50nm radius for a single airport
const NAVDATA_DIR = path.join(__dirname, '..', 'data', 'navdata');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'euroscope');

async function main() {
  console.log(`=== Generating ${ICAO} sector file ===\n`);

  const airport = await prisma.airport.findUnique({
    where: { icao: ICAO },
    include: { runways: true }
  });
  if (!airport) { console.error('Airport not found'); process.exit(1); }

  const centers = [{ icao: ICAO, lat: airport.lat, lon: airport.lon }];

  console.log('Parsing nearby fixes...');
  const fixes = await parseFixes(path.join(NAVDATA_DIR, 'earth_fix.dat'), centers, RADIUS);
  console.log(`  ${fixes.length} fixes`);

  console.log('Parsing nearby navaids...');
  const { vors, ndbs } = await parseNavaids(path.join(NAVDATA_DIR, 'earth_nav.dat'), centers, RADIUS);
  console.log(`  ${vors.length} VORs, ${ndbs.length} NDBs`);

  console.log('Parsing nearby airways...');
  const airways = await parseAirways(path.join(NAVDATA_DIR, 'earth_awy.dat'), centers, RADIUS);
  console.log(`  ${airways.high.length} high, ${airways.low.length} low`);

  // Read ground layout if exists
  const groundPath = path.join(OUTPUT_DIR, `${ICAO}_ground.txt`);
  let groundData = { regions: '', geo: '', labels: '' };
  if (fs.existsSync(groundPath)) {
    console.log('Loading ground layout...');
    const ground = fs.readFileSync(groundPath, 'utf-8');
    const regionsStart = ground.indexOf('; === REGIONS');
    const geoStart = ground.indexOf('; === GEO');
    const labelsStart = ground.indexOf('; === LABELS');
    groundData.regions = ground.substring(regionsStart, geoStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n');
    groundData.geo = ground.substring(geoStart, labelsStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n');
    groundData.labels = ground.substring(labelsStart).split('\n').filter(l => !l.startsWith(';') && l.trim()).join('\r\n');
    console.log('  Ground layout loaded');
  }

  // Build SCT
  const L = [];
  L.push(`; ${ICAO} EuroScope Sector File`);
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
  L.push('');

  L.push('[INFO]');
  L.push(ICAO);
  L.push(`${ICAO}_CTR`);
  L.push(ICAO);
  L.push(coordPair(airport.lat, airport.lon).split(' ')[0]);
  L.push(coordPair(airport.lat, airport.lon).split(' ')[1]);
  L.push('60');
  L.push('38');
  L.push('0');
  L.push('1.0');
  L.push('');

  L.push('[AIRPORT]');
  L.push(`${ICAO} 118.500 ${coordPair(airport.lat, airport.lon)} D`);
  L.push('');

  L.push('[RUNWAY]');
  for (const rwy of airport.runways) {
    if (!rwy.ident1 || !rwy.lat1) continue;
    const hdg1 = Math.round(bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2));
    const hdg2 = (hdg1 + 180) % 360;
    L.push(`${rwy.ident1.padEnd(4)} ${(rwy.ident2 || '').padEnd(4)} ${String(hdg1).padStart(3, '0')} ${String(hdg2).padStart(3, '0')} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(rwy.lat2, rwy.lon2)}`);
  }
  L.push('');

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
  for (const s of airways.high) L.push(`${s.name.padEnd(6)} ${coordPair(s.lat1, s.lon1)} ${coordPair(s.lat2, s.lon2)}`);
  L.push('');

  L.push('[LOW AIRWAY]');
  for (const s of airways.low) L.push(`${s.name.padEnd(6)} ${coordPair(s.lat1, s.lon1)} ${coordPair(s.lat2, s.lon2)}`);
  L.push('');

  // Extended centerlines
  L.push('[SID]');
  for (const rwy of airport.runways) {
    if (!rwy.ident1 || !rwy.lat1) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const recip = (hdg + 180) % 360;
    const ext1 = projectPoint(rwy.lat1, rwy.lon1, recip, 10);
    const ext2 = projectPoint(rwy.lat2, rwy.lon2, hdg, 10);
    L.push(`${ICAO}-${rwy.ident1} ${coordPair(rwy.lat1, rwy.lon1)} ${coordPair(ext1.lat, ext1.lon)} centrelinecolour`);
    if (rwy.ident2) L.push(`${ICAO}-${rwy.ident2} ${coordPair(rwy.lat2, rwy.lon2)} ${coordPair(ext2.lat, ext2.lon)} centrelinecolour`);
  }
  L.push('');

  L.push('[STAR]');
  L.push('');
  L.push('[ARTCC]');
  L.push('');
  L.push('[ARTCC HIGH]');
  L.push('');
  L.push('[ARTCC LOW]');
  L.push('');

  L.push('[GEO]');
  // GEO group header for ground layout
  L.push(`${ICAO} Ground              S999.00.00.000 E999.00.00.000 S999.00.00.000 E999.00.00.000`);
  // Range rings
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
  L.push('');

  L.push('[LABELS]');
  L.push(`"${ICAO}" ${coordPair(airport.lat, airport.lon)} 16777215`);
  if (groundData.labels) L.push(groundData.labels);
  L.push('');

  L.push('[REGIONS]');
  if (groundData.regions) L.push(groundData.regions);

  // Add runway rectangles from DB runway data (45m wide, on top of everything)
  for (const rwy of airport.runways) {
    if (!rwy.lat1 || !rwy.lon1 || !rwy.lat2 || !rwy.lon2) continue;
    const hdg = bearing(rwy.lat1, rwy.lon1, rwy.lat2, rwy.lon2);
    const perpL = (hdg + 90) % 360;
    const perpR = (hdg + 270) % 360;
    const halfWidth = 0.008; // ~15m in nm, gives ~30m total

    const c1 = projectPoint(rwy.lat1, rwy.lon1, perpL, halfWidth);
    const c2 = projectPoint(rwy.lat1, rwy.lon1, perpR, halfWidth);
    const c3 = projectPoint(rwy.lat2, rwy.lon2, perpR, halfWidth);
    const c4 = projectPoint(rwy.lat2, rwy.lon2, perpL, halfWidth);

    // Runway surface
    L.push(`REGIONNAME ${ICAO}`);
    L.push(`smrRunway ${coordPair(c1.lat, c1.lon)}`);
    L.push(` ${coordPair(c4.lat, c4.lon)}`);
    L.push(` ${coordPair(c3.lat, c3.lon)}`);
    L.push(` ${coordPair(c2.lat, c2.lon)}`);
    L.push(` ${coordPair(c1.lat, c1.lon)}`);
    L.push('');

  }
  L.push('');

  // Write
  const sctDir = path.join(OUTPUT_DIR, 'Data', 'Sector_Files');
  fs.mkdirSync(sctDir, { recursive: true });
  const sctPath = path.join(sctDir, `${ICAO}.sct`);
  fs.writeFileSync(sctPath, L.join('\r\n'), 'utf-8');
  console.log(`\nWritten ${L.length} lines (${(L.join('\r\n').length / 1024).toFixed(0)}KB) to ${sctPath}`);

  // Generate ESE
  const E = [];
  E.push(`; ${ICAO} Extended Sector File`);
  E.push('');
  E.push('[POSITIONS]');
  for (const pos of [{s:'DEL',n:'Delivery',f:'121.700'},{s:'GND',n:'Ground',f:'121.800'},{s:'TWR',n:'Tower',f:'118.500'},{s:'APP',n:'Approach',f:'119.000'}]) {
    E.push(`${ICAO}_${pos.s}:${airport.name} ${pos.n}:${pos.f}:${ICAO}:${pos.s.charAt(0)}:${ICAO}:${pos.s}:-:-:0100:0177:35:${coordPair(airport.lat, airport.lon)}`);
  }
  E.push('');
  E.push('[SIDSSTARS]');
  E.push('');
  E.push('[AIRSPACE]');
  const pts = [];
  for (let i = 0; i <= 36; i++) { const p = projectPoint(airport.lat, airport.lon, (360/36)*i, 30); pts.push(coordPair(p.lat, p.lon)); }
  E.push(`SECTORLINE:${ICAO}_BOUNDARY`);
  for (const pt of pts) E.push(`COORD:${pt}`);
  E.push('');
  E.push(`SECTOR:${ICAO}_TWR:0:24500`);
  E.push(`OWNER:${ICAO}_TWR:${ICAO}_APP`);
  E.push(`BORDER:${ICAO}_BOUNDARY`);
  E.push('');

  const esePath = path.join(sctDir, `${ICAO}.ese`);
  fs.writeFileSync(esePath, E.join('\r\n'), 'utf-8');

  // Generate PRF
  const prf = [
    `Settings\tSettingsfileSYMBOLOGY\tData\\Settings\\Symbology.txt`,
    `Settings\tSettingsfileTAGS\tData\\Settings\\Tags.txt`,
    `Settings\tSettingsfileSCREEN\tData\\Settings\\Screen.txt`,
    `Settings\tSettingsfile\tData\\Settings\\General.txt`,
    `Settings\tsector\tData\\Sector_Files\\${ICAO}.sct`,
    `ASRFastKeys\t1\tData\\ASR\\${ICAO}.asr`,
    `RecentFiles\tRecent1\tData\\ASR\\${ICAO}.asr`,
    `LastSession\tserver\tAUTOMATIC`,
  ];
  fs.writeFileSync(path.join(OUTPUT_DIR, `${ICAO}.prf`), prf.join('\r\n'), 'utf-8');

  // Generate ASR
  const asrDir = path.join(OUTPUT_DIR, 'Data', 'ASR');
  fs.mkdirSync(asrDir, { recursive: true });
  const asr = [
    'DisplayTypeName:Standard ES radar screen',
    'DisplayTypeNeedRadarContent:1',
    'DisplayTypeGeoReferenced:1',
    `Airports:${ICAO}:symbol`,
    `Airports:${ICAO}:name`,
  ];
  for (const rwy of airport.runways) {
    if (rwy.ident1) asr.push(`Runways:${ICAO}:${rwy.ident1}:centerline`);
    if (rwy.ident2) asr.push(`Runways:${ICAO}:${rwy.ident2}:centerline`);
    if (rwy.ident1) asr.push(`Sids:${ICAO}-${rwy.ident1}`);
    if (rwy.ident2) asr.push(`Sids:${ICAO}-${rwy.ident2}`);
  }
  asr.push(`SHOWC:${ICAO}_TWR:1`);
  asr.push(`m_Latitude:${airport.lat}`);
  asr.push(`m_Longitude:${airport.lon}`);
  asr.push('m_Zoom:7');
  fs.writeFileSync(path.join(asrDir, `${ICAO}.asr`), asr.join('\r\n'), 'utf-8');

  console.log(`Generated ${ICAO}.prf, ${ICAO}.asr, ${ICAO}.sct, ${ICAO}.ese`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
