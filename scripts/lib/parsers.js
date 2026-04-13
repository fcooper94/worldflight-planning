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
