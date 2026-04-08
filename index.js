import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import path from 'path';

const prisma = new PrismaClient();

/* ===== NAVDATA: WAYPOINT LOOKUP ===== */
const navFixes = new Map(); // name -> [{ lat, lon }, { lat, lon }, ...]

/* ===== FIR DATA ===== */
let firFeatures = [];

function loadFirData() {
  const firFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'fir-boundaries.geojson');
  if (!fs.existsSync(firFile)) { console.log('[FIR] fir-boundaries.geojson not found'); return; }
  const data = JSON.parse(fs.readFileSync(firFile, 'utf-8'));
  firFeatures = data.features || [];
  console.log('[FIR] Loaded ' + firFeatures.length + ' FIR boundaries');
}

function pointInPolygon(lat, lon, coords) {
  // Ray-casting algorithm for a single ring
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const xi = coords[i][1], yi = coords[i][0]; // GeoJSON is [lon, lat]
    const xj = coords[j][1], yj = coords[j][0];
    if (((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

const FIR_ALIASES = {
  'EGTL': 'EGTT',  // London Terminal → London Area
};

function baseFirCode(id) {
  if (!id) return 'Unknown';
  const base = id.split('-')[0];
  return FIR_ALIASES[base] || base;
}

function getFirsForPoint(lat, lon) {
  const results = [];
  const seen = new Set();
  for (const f of firFeatures) {
    const geom = f.geometry;
    if (!geom) continue;
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : geom.type === 'Polygon' ? [geom.coordinates] : [];
    for (const poly of polys) {
      if (poly[0] && pointInPolygon(lat, lon, poly[0])) {
        const base = baseFirCode(f.properties?.id);
        if (!seen.has(base)) { seen.add(base); results.push(base); }
        break;
      }
    }
  }
  return results;
}

function loadNavFixes() {
  const fixFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'navdata', 'earth_fix.dat');
  if (!fs.existsSync(fixFile)) { console.log('[NAV] earth_fix.dat not found'); return; }
  const lines = fs.readFileSync(fixFile, 'utf-8').split('\n');
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('I') || trimmed.startsWith('9') || trimmed.indexOf('Version') !== -1) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 3) {
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      const name = parts[2];
      if (name && !isNaN(lat) && !isNaN(lon)) {
        if (!navFixes.has(name)) navFixes.set(name, []);
        navFixes.get(name).push({ lat, lon });
        count++;
      }
    }
  }
  console.log('[NAV] Loaded ' + count + ' fixes (' + navFixes.size + ' unique names) from earth_fix.dat');

  // Load navaids (VOR, NDB, DME) from earth_nav.dat
  const navFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'navdata', 'earth_nav.dat');
  if (fs.existsSync(navFile)) {
    const navLines = fs.readFileSync(navFile, 'utf-8').split('\n');
    let navCount = 0;
    for (const line of navLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('I') || trimmed.startsWith('9') || trimmed.indexOf('Version') !== -1) continue;
      const parts = trimmed.split(/\s+/);
      // Format: type lat lon elev freq range ? ident ...
      // Types: 2=NDB, 3=VOR, 12=DME, 13=VORDME
      if (parts.length >= 8) {
        const type = parseInt(parts[0]);
        if (type === 2 || type === 3 || type === 12 || type === 13) {
          const lat = parseFloat(parts[1]);
          const lon = parseFloat(parts[2]);
          const name = parts[7];
          if (name && !isNaN(lat) && !isNaN(lon)) {
            if (!navFixes.has(name)) navFixes.set(name, []);
            const existing = navFixes.get(name);
            const isDupe = existing.some(e => Math.abs(e.lat - lat) < 0.01 && Math.abs(e.lon - lon) < 0.01);
            if (!isDupe) { existing.push({ lat, lon }); navCount++; }
          }
        }
      }
    }
    console.log('[NAV] Loaded ' + navCount + ' navaids from earth_nav.dat (' + navFixes.size + ' total unique names)');
  }

  // Also load waypoints from earth_awy.dat if XP700 format (has inline coordinates)
  const awyFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'navdata', 'earth_awy.dat');
  if (fs.existsSync(awyFile)) {
    const header = fs.readFileSync(awyFile, 'utf-8').slice(0, 200);
    if (header.includes('XP700') || header.includes('640')) {
      const awyLines = fs.readFileSync(awyFile, 'utf-8').split('\n');
      let awyCount = 0;
      for (const line of awyLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('I') || trimmed.startsWith('9') || trimmed.indexOf('Version') !== -1) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 6) {
          const pairs = [
            { name: parts[0], lat: parseFloat(parts[1]), lon: parseFloat(parts[2]) },
            { name: parts[3], lat: parseFloat(parts[4]), lon: parseFloat(parts[5]) }
          ];
          for (const p of pairs) {
            if (p.name && !isNaN(p.lat) && !isNaN(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180) {
              if (!navFixes.has(p.name)) navFixes.set(p.name, []);
              const existing = navFixes.get(p.name);
              const isDupe = existing.some(e => Math.abs(e.lat - p.lat) < 0.01 && Math.abs(e.lon - p.lon) < 0.01);
              if (!isDupe) { existing.push({ lat: p.lat, lon: p.lon }); awyCount++; }
            }
          }
        }
      }
      console.log('[NAV] Loaded ' + awyCount + ' additional fixes from earth_awy.dat (XP700)');
    }
  }

  console.log('[NAV] Total: ' + navFixes.size + ' unique waypoint/navaid names');
}

function closestFix(name, refLat, refLon) {
  const fixes = navFixes.get(name);
  if (!fixes || !fixes.length) return null;
  if (fixes.length === 1) return fixes[0];

  let best = null;
  let bestDist = Infinity;
  const toRad = Math.PI / 180;

  for (const f of fixes) {
    const dLat = (f.lat - refLat) * toRad;
    const dLon = (f.lon - refLon) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(refLat * toRad) * Math.cos(f.lat * toRad) * Math.sin(dLon / 2) ** 2;
    const d = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (d < bestDist) { bestDist = d; best = f; }
  }
  return best;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const icao = req.params.icao.toUpperCase();
    const dir = path.join(__dirname, 'Uploads', icao);

    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },

  filename: (req, file, cb) => {
  if (!file || !file.originalname) {
    return cb(new Error('No file received'));
  }

  const base =
    typeof req.body.filename === 'string' && req.body.filename.trim()
      ? req.body.filename
      : path.parse(file.originalname).name;

  const safeBase = base
     .toUpperCase()
  .replace(/[_\-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

  const ext = path.extname(file.originalname).toUpperCase();

  cb(null, safeBase + ext);
}

});

const upload = multer({ storage });

// ---- ATC route geometry cache (in-memory) ----
// Cache values can be: { value, ts } OR an in-flight Promise
const ATC_CACHE = new Map();
const ATC_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours; adjust as needed

function cacheGet(key) {
  const entry = ATC_CACHE.get(key);
  if (!entry) return null;

  // In-flight promise
  if (entry && typeof entry.then === 'function') return entry;

  // Expired
  if (Date.now() - entry.ts > ATC_CACHE_TTL_MS) {
    ATC_CACHE.delete(key);
    return null;
  }

  return entry.value;
}

function cacheSet(key, value) {
  ATC_CACHE.set(key, { value, ts: Date.now() });
}

// Simple concurrency limiter (no dependencies)
function createLimiter(maxConcurrent = 8) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= maxConcurrent) return;
    const item = queue.shift();
    if (!item) return;

    active++;
    const { fn, resolve, reject } = item;

    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        runNext();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
}

const limitAtc = createLimiter(10); // tune: 6–12 depending on DB capacity


/* ===========================
   OFFICIAL TEAM CALLSIGN RULES
   =========================== */

async function isReservedTeamCallsign(callsign, cid) {
  const normalized = callsign.trim().toUpperCase();

  const team = await prisma.officialTeam.findFirst({
    where: {
      callsign: normalized,
      participatingWf26: true
    }
  });

  if (!team) {
    return { reserved: false };
  }

  if (Number(team.mainCid) !== Number(cid)) {
    return {
      reserved: true,
      allowed: false,
      teamName: team.teamName
    };
  }

  return {
    reserved: true,
    allowed: true
  };
}



import { fileURLToPath } from 'url';

import 'dotenv/config';
import session from 'express-session';
import axios from 'axios';
import vatsimLogin from './auth/login.js';
import vatsimCallback from './auth/callback.js';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import _renderLayout from './layout.js';
function renderLayout(opts) {
  return _renderLayout({ ...opts, pageVisibility, siteBanner });
}

import { createServer } from 'http';
import { Server } from 'socket.io';







const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const allTobtSlots = {}; // slotKey -> { from, to, dateUtc, depTimeUtc, tobt }



let cachedPilots = [];

async function refreshPilots() {
  try {
    const res = await axios.get(
      'https://data.vatsim.net/v3/vatsim-data.json'
    );
    cachedPilots = res.data.pilots || [];
    console.log('[VATSIM] Pilots refreshed:', cachedPilots.length);
  } catch (err) {
    console.error('[VATSIM] Failed to refresh pilots:', err.message);
    cachedPilots = [];
  }
}

async function loadTobtBookingsFromDb() {
  const bookings = await prisma.tobtBooking.findMany();

  bookings.forEach(b => {
  // cid MUST exist for pilot bookings (your rule)
  if (b.cid === null) return;

  const bookingKey = `${b.cid}:${b.slotKey}`;

  tobtBookingsByKey[bookingKey] = {
    bookingKey,
    slotKey: b.slotKey,
    cid: b.cid,
    callsign: b.callsign,
    from: b.from,
    to: b.to,
    dateUtc: b.dateUtc,
    depTimeUtc: b.depTimeUtc,
    tobtTimeUtc: b.tobtTimeUtc,
    createdAtISO: b.createdAt.toISOString()
  };

  if (!tobtBookingsByCid[b.cid]) {
    tobtBookingsByCid[b.cid] = new Set();
  }
  tobtBookingsByCid[b.cid].add(bookingKey);
});

  console.log(`[TOBT] Loaded ${bookings.length} bookings from DB`);
}





/* ===== EXPRESS + HTTP SERVER ===== */
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));


const httpServer = createServer(app);
const io = new Server(httpServer);

/* ================= ICAO-SCOPED EMIT HELPER ================= */

function emitToIcao(icao, event, payload) {
  if (!icao) return;
  io.to(`icao:${icao.toUpperCase()}`).emit(event, payload);
}


io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});



/* ===== PAGE VISIBILITY (GLOBAL) ===== */
const PAGE_KEYS = ['schedule', 'world-map', 'my-slots', 'atc', 'suggest-airport', 'arrival-info', 'departure-info', 'book-slot', 'airspace'];
const pageVisibility = {};     // key -> boolean (true = enabled)

async function loadPageVisibility() {
  const rows = await prisma.pageVisibility.findMany();
  const found = new Set();
  for (const r of rows) {
    pageVisibility[r.key] = r.enabled;
    found.add(r.key);
  }
  // default missing keys to true
  for (const k of PAGE_KEYS) {
    if (!found.has(k)) pageVisibility[k] = true;
  }
  console.log('[PAGE VIS] Loaded page visibility:', pageVisibility);
}

function isPageEnabled(key) {
  return pageVisibility[key] !== false;
}

// ===== SITE BANNER =====
const siteBanner = { enabled: false, text: '' };

async function loadSiteBanner() {
  const enabledRow = await prisma.siteSetting.findUnique({ where: { key: 'banner-enabled' } });
  const textRow = await prisma.siteSetting.findUnique({ where: { key: 'banner-text' } });
  siteBanner.enabled = enabledRow?.value === 'true';
  siteBanner.text = textRow?.value || '';
  console.log('[BANNER] Loaded:', siteBanner);
}

function requirePageEnabled(pageKey) {
  return (req, res, next) => {
    const cid = req.session?.user?.data?.cid;
    const isAdmin = cid && ADMIN_CIDS.includes(Number(cid));
    if (isAdmin || isPageEnabled(pageKey)) return next();
    return res.status(403).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Page Unavailable</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body class="login-page no-layout">
  <div class="login-overlay"></div>
  <div class="login-container">
    <img src="/logo.png" alt="WorldFlight" class="login-logo" />
    <h1>Page Unavailable</h1>
    <h2>Temporarily Disabled</h2>
    <p class="login-subtitle">This page has been disabled by an administrator.</p>
    <a href="/" class="login-btn">Back to Homepage</a>
  </div>
</body>
</html>`);
  };
}

/* ===== SHARED STATE (GLOBAL) ===== */
const sharedToggles = {};      // { callsign: { clearance: bool, start: bool, sector?: "EGCC-EGLL" } }
const sharedDepFlows = {};     // sector -> rate (number)
const sharedFlowTypes = {};    // sector -> 'NONE' | 'SLOTTED' | 'BOOKING_ONLY'

const connectedUsers = {};     // { socketId: { cid, position } }

/* ===== DEP FLOW PERSISTENCE ===== */
async function loadDepFlowsFromDb() {
  // Migrate orphan rows (eventId=0) to the active event
  if (activeEventId) {
    await prisma.depFlow.updateMany({
      where: { eventId: 0 },
      data: { eventId: activeEventId }
    });
  }

  const flows = await prisma.depFlow.findMany({
    where: { eventId: activeEventId || 0 }
  });

  // Clear existing
  Object.keys(sharedDepFlows).forEach(k => delete sharedDepFlows[k]);
  Object.keys(sharedFlowTypes).forEach(k => delete sharedFlowTypes[k]);

  flows.forEach(f => {
    sharedDepFlows[f.sector] = Number(f.rate) || 0;

    const ft = (f.flowtype || 'NONE').toString().toUpperCase();
    sharedFlowTypes[f.sector] =
      ft === 'SLOTTED' || ft === 'BOOKING_ONLY' || ft === 'NONE'
        ? ft
        : 'NONE';
  });

  console.log(`[DEP FLOW] Loaded ${flows.length} flow rates/types for event ${activeEventId}`);
}


// MODEL 2 (per-user bookings)
// bookingKey = `${cid}:${slotKey}`
const tobtBookingsByKey = {};  // bookingKey -> booking
const tobtBookingsByCid = {};  // cid -> Set(bookingKey)


/**
 * sharedTSAT is the authoritative TSAT store:
 * {
 *   "BAW123": { tsat: "14:32", icao?: "EGCC" }
 * }
 */
const sharedTSAT = {};

/**
 * recentlyStarted:
 * {
 *   "BAW123": { tsat: "14:32", icao: "EGCC", startedAt: "14:35" }
 * }
 */
let recentlyStarted = {};

const startedAircraft = {}; // { "BAW123": true }

/**
 * TSAT queues per sector:
 * {
 *   "EGCC-EGLL": [
 *     { callsign: "BAW123", tsat: Date },
 *     { callsign: "EZY45",  tsat: Date }
 *   ]
 * }
 */


const tsatQueues = {};

function getTobtBookingForCallsign(callsign, icao) {
  const cs = callsign.trim().toUpperCase();

  for (const booking of Object.values(tobtBookingsByKey)) {
    if (
      booking.callsign === cs &&
      booking.from === icao
    ) {
      return booking; // includes tobtTimeUtc
    }
  }
  return null;
}

function hhmmColonToHHMM(time) {
  if (!time) return '';
  return time.replace(':', '');
}

function formatDatePretty(dateUtc) {
  const d = new Date(dateUtc + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
}


const PHONETIC_TO_LETTER = {
  ALFA: 'A',
  BRAVO: 'B',
  CHARLIE: 'C',
  DELTA: 'D',
  ECHO: 'E',
  FOXTROT: 'F',
  GOLF: 'G',
  HOTEL: 'H',
  INDIA: 'I',
  JULIET: 'J',
  KILO: 'K',
  LIMA: 'L',
  MIKE: 'M',
  NOVEMBER: 'N',
  OSCAR: 'O',
  PAPA: 'P',
  QUEBEC: 'Q',
  ROMEO: 'R',
  SIERRA: 'S',
  TANGO: 'T',
  UNIFORM: 'U',
  VICTOR: 'V',
  WHISKEY: 'W',
  XRAY: 'X',
  YANKEE: 'Y',
  ZULU: 'Z'
};

function extractAtisLetter(lines = []) {
  for (const line of lines) {
    const upper = line.toUpperCase();

    // 0. ATIS EDDC Q  / ATIS EGLL A
    let m = upper.match(/\bATIS\s+[A-Z]{4}\s+([A-Z])\b/);
    if (m) return m[1];

    // 1. INFORMATION ROMEO / INFORMATION R
    m = upper.match(/\bINFORMATION\s+([A-Z]+)\b/);
    if (m) return phoneticOrLetter(m[1]);

    // 2. ATIS Q
    m = upper.match(/\bATIS\s+([A-Z])\b/);
    if (m) return m[1];

    // 3. RECEIVING INFO GOLF / INFO CHARLIE
    m = upper.match(/\bINFO\s+([A-Z]+)\b/);
    if (m) return phoneticOrLetter(m[1]);
  }

  return '';
}

function getUtcMinutesNow() {
  const now = new Date();
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

function parseTsatToMinutes(tsat) {
  if (!tsat || tsat === '—') return null;

  const clean = tsat.replace(':', '');
  const hh = Number(clean.slice(0, 2));
  const mm = Number(clean.slice(2, 4));

  return hh * 60 + mm;
}


function phoneticOrLetter(token) {
  if (token.length === 1) return token;

  const map = {
    ALFA: 'A', BRAVO: 'B', CHARLIE: 'C', DELTA: 'D',
    ECHO: 'E', FOXTROT: 'F', GOLF: 'G', HOTEL: 'H',
    INDIA: 'I', JULIET: 'J', KILO: 'K', LIMA: 'L',
    MIKE: 'M', NOVEMBER: 'N', OSCAR: 'O', PAPA: 'P',
    QUEBEC: 'Q', ROMEO: 'R', SIERRA: 'S', TANGO: 'T',
    UNIFORM: 'U', VICTOR: 'V', WHISKEY: 'W',
    XRAY: 'X', YANKEE: 'Y', ZULU: 'Z'
  };

  return map[token] || '';
}


/* ===== SESSION ===== */
const sessionMiddleware = session({
  name: 'worldflight.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
});

app.use(sessionMiddleware);


function getNextAvailableTobts(from, to, limit = 5) {
  return Object.entries(allTobtSlots)
    .filter(([slotKey, slot]) =>
      slot.from === from &&
      slot.to === to &&
      !tobtBookingsByKey[slotKey]
    )
    .map(([slotKey, slot]) => ({
      slotKey,
      tobt: slot.tobt
    }))
    .sort((a, b) => a.tobt.localeCompare(b.tobt))
    .slice(0, limit);
}

function requireLogin(req, res, next) {
  if (req.session && req.session.user && req.session.user.data) {
    return next();
  }

  if (req.session) {
    req.session.returnTo = req.originalUrl;
  }

  return res.redirect('/');
}





function isAirportController(cs, icao) {
  if (!cs || !icao) return false;

  // 1️⃣ Preserve the original callsign if you need it later
  const rawCallsign = cs.toUpperCase().trim();

  // 2️⃣ Normalise relief markers: EGCC_N__TWR → EGCC_N_TWR
  const callsign = rawCallsign.replace(/__+/g, '_');

  const airport = icao.toUpperCase();
  const prefixes = [];

  // 🇦🇺 Australia: YSSY → SY
  if (airport.startsWith('Y') && airport.length === 4) {
    prefixes.push(airport.slice(2));
  }

  // 🇺🇸 USA: KJFK → JFK
  if (airport.startsWith('K') && airport.length === 4) {
    prefixes.push(airport.slice(1));
  }

  // ICAO fallback
  prefixes.push(airport);

  const roles = ['ATIS', 'DEL', 'GND', 'TWR', 'APP', 'DEP'];

  return prefixes.some(prefix =>
    roles.some(role =>
      new RegExp(
        `^${prefix}(?:_[A-Z0-9]+)?_${role}$`
      ).test(callsign)
    )
  );
}

function isUsIcao(icao) {
  return typeof icao === 'string'
    && icao.length === 4
    && icao.startsWith('K');
}

const US_ENROUTE_PREFIX_BY_ICAO = {
  KJFK: ['NY', 'ZNY'],
  KLGA: ['NY', 'ZNY'],
  KEWR: ['NY', 'ZNY'],

  KLAX: ['LA', 'ZLA', 'LAX'],
  KLAS: ['LA', 'ZLA', 'LAX'],
  KSFO: ['SF', 'ZOA'],

  KPIT: ['ZOB', 'CLE'],
  KDTW: ['ZOB', 'CLE'],

  

  KORD: ['CHI', 'ZAU'],
  KATL: ['ATL', 'ZTL'],
  KDFW: ['DFW', 'ZFW'],
  KDEN: ['DEN', 'ZDV'],
  KMIA: ['MIA', 'ZMA'],
  KSEA: ['SEA', 'ZSE'],
  KPDX: ['SEA', 'ZSE'],
  KMFR: ['SEA', 'ZSE'],
  KBFI: ['SEA', 'ZSE'],
  KBOS: ['BOS', 'ZBW'],
  KIAD: ['DC', 'ZDC'],
  KDCA: ['DC', 'ZDC'],
  KBWI: ['DC', 'ZDC'],
  KPHX: ['PHX', 'ABQ'],
  KABQ: ['ABQ'],
  KMSP: ['MSP', 'ZMP'],
  KIAD: ['DC','ZDC'],
  KDCA: ['DC','ZDC'],
  KPHL: ['PHL', 'ZNY'],
  KSAN: ['SAN', 'ZLA'],
};

const US_APP_COVERAGE_BY_ICAO = {
  KIAD: ['PCT'],
  KDCA: ['PCT'],
  KBWI: ['PCT'],

  KLAX: ['SCT'],
  KSAN: ['SCT'],
  KBUR: ['SCT'],
  KLGB: ['SCT'],

  KJFK: ['N90'],
  KLGA: ['N90'],
  KEWR: ['N90'],
};

function isUsApp(callsign) {
  return /^[A-Z0-9]{2,4}(?:_[A-Z0-9]+)?_(APP|DEP)$/.test(
    callsign.toUpperCase()
  );
}

function isCoveringUsApp(callsign, icao) {
  if (!icao?.startsWith('K')) return false;

  const cs = callsign.toUpperCase();
  if (!isUsApp(cs)) return false;

  const prefix = cs.split('_')[0]; // PCT, SCT, N90
  const allowed = US_APP_COVERAGE_BY_ICAO[icao];

  return Array.isArray(allowed) && allowed.includes(prefix);
}


function isUkCtr(callsign) {
  return /^(LON|EGTT|EGVV|SCO|LTC)(?:_[A-Z0-9]+)?_CTR$/.test(
    callsign.toUpperCase()
  );
}


function isCoveringSouthAmericaCtr(callsign, icao) {
  const cs = callsign.toUpperCase();
  const icaoUpper = icao.toUpperCase();

  // Only FIR-style CTRs like SCEZ_CTR / SCEZ_N_CTR
  if (!/^[A-Z]{4}(?:_[A-Z0-9]+)?_CTR$/.test(cs)) return false;

  const prefix = cs.split('_')[0];

  /* =========================
     CHILE – SANTIAGO FIR
     ========================= */
  if (icaoUpper === 'SCEL') {
    return prefix === 'SCEZ';
  }

  return false;
}

function computeArrivalDateUtc(dateUtc, depTimeUtc, blockTime) {
  if (!dateUtc || !depTimeUtc || !blockTime) return dateUtc || '';

  const dep = parseUtcDateTime(dateUtc, depTimeUtc);

  const [bh, bm] = blockTime.split(':').map(Number);
  const arr = new Date(dep.getTime() + (bh * 60 + bm) * 60000);

  return arr.toISOString().slice(0, 10); // YYYY-MM-DD
}


function isCoveringUkCtr(callsign, icao) {
  const cs = callsign.toUpperCase();
  const icaoUpper = icao.toUpperCase();

  if (!isUkCtr(cs)) return false;

  const prefix = cs.split('_')[0];

  /* =========================
     SCOTLAND & N. IRELAND
     ========================= */
  if (
    icaoUpper.startsWith('EGP') || // Scotland
    icaoUpper === 'EGAA' ||
    icaoUpper === 'EGAC' ||
    icaoUpper === 'EGNS'

  ) {
    return prefix === 'SCO';
  }

  /* =========================
     ENGLAND & WALES
     ========================= */
  if (icaoUpper.startsWith('EG')) {
  return ['LON', 'EGTT', 'EGVV', 'LTC'].includes(prefix);
}

  return false;
}



function isUsCtr(callsign) {
  return /^[A-Z]{2,3}(?:_\d{1,2})?_CTR$/.test(
    callsign.toUpperCase()
  );
}

function isCoveringUsCtr(callsign, icao) {
  if (!icao?.startsWith('K')) return false;

  const cs = callsign.toUpperCase();
  if (!isUsCtr(cs)) return false;

  const prefix = cs.split('_')[0]; // NY, DC, ZNY
  const allowed = US_ENROUTE_PREFIX_BY_ICAO[icao];


  return Array.isArray(allowed) && allowed.includes(prefix);

  
}

function isCoveringIndiaCtr(callsign, icao) {
  const cs = callsign.toUpperCase();
  const icaoUpper = icao.toUpperCase();

  // Only Indian airports
  if (!icaoUpper.startsWith('VA') && !icaoUpper.startsWith('VO') && !icaoUpper.startsWith('VI')) {
    return false;
  }

  // Must be CTR
  if (!/^[A-Z]{4}(?:_[A-Z0-9]+)?_CTR$/.test(cs)) return false;

  const parts = cs.split('_');
  const prefix = parts[0];      // VABB, VOMF, VIDF
  const level  = parts[1];      // LC, UC, UAC (or undefined)

  // 1️⃣ FIR / ACC CTR: airport must match FIR
  if (!level || level === 'LC' || level === 'UC') {
    return prefix === icaoUpper;
  }

  // 2️⃣ UAC CTR: covers ALL India
  if (level === 'UAC') {
    return prefix.startsWith('VO') || prefix.startsWith('VI');
  }

  return false;
}

function isCoveringGenericIcaoCtr(callsign, icao) {
  if (!callsign || !icao) return false;

  const cs = callsign.toUpperCase();
  const ap = icao.toUpperCase();

  // Must be CTR
  if (!/^[A-Z]{2,4}(?:_[A-Z0-9]+)*_CTR$/.test(cs)) return false;

  const prefix = cs.split('_')[0];

  // 1️⃣ Exact ICAO match (VABB_CTR, WSSS_CTR)
  if (prefix === ap) return true;

  // 2️⃣ Regional ICAO match (VO*, WS*, SC*)
  if (prefix.startsWith(ap.slice(0, 2))) return true;

  // 3️⃣ FIR / city aliases (Asia-Pacific reality)
  const FIR_ALIAS_BY_ICAO = {
    VHHH: ['HKG'],
    RCTP: ['TPE'],
    WSSS: ['SIN'],
    VTBS: ['BKK'],
    RJTT: ['TYO'],
    RKSI: ['SEL'],
    ZBAA: ['PEK'],
  };

  return FIR_ALIAS_BY_ICAO[ap]?.includes(prefix) ?? false;
}



function isCoveringCtr(callsign, icao) {
  return (
    isCoveringUsCtr(callsign, icao) ||
    isCoveringUsApp(callsign, icao) ||
    isCoveringUkCtr(callsign, icao) ||
    isCoveringIndiaCtr(callsign, icao) ||
    isCoveringSouthAmericaCtr(callsign, icao) ||
    isCoveringGenericIcaoCtr(callsign, icao) // ← fallback
  );
}




function canEditIcao(user, pageIcao) {
  if (!user) return false;
  if (ADMIN_CIDS.includes(Number(user.cid))) return true;

  const cs = user.callsign || '';
  return cs.startsWith(pageIcao + '_') && !cs.endsWith('_OBS');
}

// Basic HTML escaping for any user/admin-provided text rendered into server-side templates
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function canEditDocumentation(cid, icao) {
  const cidInt = Number(cid);
  if (!Number.isFinite(cidInt)) return false;

  const rules = await prisma.documentationPermission.findMany({
    where: { cid: cidInt }
  });

  return rules.some(r =>
    matchesIcaoPattern(r.pattern.toUpperCase(), icao.toUpperCase())
  );
}


function matchesIcaoPattern(pattern, icao) {
  if (pattern.length !== 4 || icao.length !== 4) return false;

  for (let i = 0; i < 4; i++) {
    if (pattern[i] === '*') continue;
    if (pattern[i] !== icao[i]) return false;
  }

  return true;
}



app.post(
  '/icao/:icao/upload',
  requireLogin,
  async (req, res, next) => {
    try {
      const { icao } = req.params;
      const user = req.session.user?.data;

      const allowed = await canEditDocumentation(user.cid, icao);
      if (!allowed) return res.status(403).send('Not allowed');

      next();
    } catch (err) {
      console.error('[UPLOAD PERM]', err);
      return res.status(500).send('Server error');
    }
  },
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      await prisma.airportDocument.create({
        data: {
          icao: req.params.icao.toUpperCase(),
          filename: req.file.filename,
          uploadedBy: Number(req.session.user.data.cid)
        }
      });

      return res.json({ success: true });
    } catch (err) {
      console.error('[UPLOAD SAVE]', err);
      return res.status(500).json({ error: 'Failed to save document' });
    }
  }
);




function rebuildAllTobtSlots() {
  // Clear existing slots
  Object.keys(allTobtSlots).forEach(k => delete allTobtSlots[k]);

  for (const row of adminSheetCache) {
    const { from, to, date_utc, dep_time_utc } = row;

    // Only generate TOBTs if a dep flow exists
    const slots = generateTobtSlots({
      from,
      to,
      dateUtc: date_utc,
      depTimeUtc: dep_time_utc
    });

    if (!slots) continue; // no flow defined → no TOBTs

    for (const tobt of slots) {
      const slotKey = makeTobtSlotKey({
        from,
        to,
        dateUtc: date_utc,
        depTimeUtc: dep_time_utc,
        tobtTimeUtc: tobt
      });

      allTobtSlots[slotKey] = {
        from,
        to,
        dateUtc: date_utc,
        depTimeUtc: dep_time_utc,
        tobt
      };
    }
  }

  console.log(
    `[TOBT] Rebuilt allTobtSlots: ${Object.keys(allTobtSlots).length} slots`
  );
}



/* ===== RECENTLY STARTED HELPER ===== */
function buildRecentlyStartedForICAO(icao) {
  return Object.entries(recentlyStarted)
    .filter(([cs, e]) => e.icao === icao)
    .map(([callsign, entry]) => ({
      callsign,
      startedAt: entry.startedAt
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/* ===== UPCOMING TSAT HELPER ===== */
function buildUpcomingTSATsForICAO(icao, vatsimPilots = []) {
  const list = [];

  for (const [callsign, tsatObj] of Object.entries(sharedTSAT)) {
    if (startedAircraft[callsign]) continue;

    if (tsatObj.icao !== icao) continue;

    let dest = '----';
    const pilot = vatsimPilots.find(p => p.callsign === callsign);
    if (pilot?.flight_plan) {
      dest = pilot.flight_plan.arrival || dest;
    }

    list.push({
      callsign,
      dest,
      tsat: tsatObj.tsat
    });
  }

 const nowUtcMinutes = getUtcMinutesNow();


  return list
  .sort((a, b) => {
    const ta = parseTsatToMinutes(a.tsat);
    const tb = parseTsatToMinutes(b.tsat);

    if (ta === null && tb === null) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;

    return ta - tb;
  })
  .slice(0, 5);

}


function buildUnassignedTobtsForICAO(icao) {
  if (!icao) return [];

  const normalizedIcao = icao.toUpperCase();

  return Object.entries(allTobtSlots)
    .filter(([key, slot]) => {
      return (
        slot.from === normalizedIcao &&
        !tobtBookingsByKey[key]   // ✅ NOT BOOKED
      );
    })
    .map(([key, slot]) => ({
      tobt: slot.tobt,
      to: slot.to
    }))
    .sort((a, b) => a.tobt.localeCompare(b.tobt));
}

function hasOutboundFlow(icao) {
  const upper = icao.toUpperCase();
  return Object.keys(sharedDepFlows).some(
    key => key.startsWith(upper + '-')
  );
}


/* ===== ADMIN CID WHITELIST ===== */
const ADMIN_CIDS = [10000010, 1303570, 10000005];

/* ===== GOOGLE SHEET (MULTI-EVENT) ===== */
const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRG6DbmhAQpFmOophiGjjSh_UUGdTo-LA_sNNexrMpkkH2ECHl8eDsdxM24iY8Itw06pUZZXWtvmUNg/pub?output=csv';

let adminSheetCache = [];          // active event's rows (backward compat)
const eventSheetCaches = {};       // eventId -> rows[]
let wfEvents = [];                 // all events from DB
let activeEventId = null;          // currently active event ID
let lastDepartureSnapshot = new Set();

const port = process.env.PORT || 8080;

/* ================= TSAT HELPERS (SERVER) ================= */

/**
 * Normalise sector key as FROM-TO, e.g. "EGCC-EGLL"
 */
function normalizeSectorKey(sectorRaw) {
  if (!sectorRaw) return 'UNKNOWN-UNKNOWN';
  return sectorRaw.trim().toUpperCase();
}

/**
 * Assign a TSAT for a callsign within a sector queue with these rules:
 * - Earliest = now + 1 minute
 * - If flow <= 31: min spacing = 2 minutes
 * - If flow > 31: spacing = floor(60 / flow), >= 1 minute
 * - At most `flow` TSATs in any rolling 60-minute window
 * - Uses the earliest available valid slot, so it can backfill gaps
 *   if the hour is not yet "full".
 */
function assignTSAT(sectorKey, callsign) {
  const sector = normalizeSectorKey(sectorKey);

  const flowPerHourRaw = sharedDepFlows[sector];
  const flowPerHour = flowPerHourRaw ? Number(flowPerHourRaw) : 60; // default 60/h

  const now = new Date();
  now.setSeconds(0, 0);

    // 🔒 TOBT lower bound (if exists)
  let tobtLowerBound = null;

  // Determine FROM ICAO from sector (FROM-TO)
  const fromIcao = sector.split('-')[0];

  // Look up TOBT for this aircraft
  const tobtBooking = getTobtBookingForCallsign(callsign, fromIcao);

  if (tobtBooking?.tobtTimeUtc) {
    const [hh, mm] = tobtBooking.tobtTimeUtc.split(':').map(Number);

    const tobtDate = new Date(now);
tobtDate.setUTCHours(hh, mm, 0, 0);

// 🔁 If TOBT time is earlier than now, assume NEXT UTC DAY
if (tobtDate <= now) {
  tobtDate.setUTCDate(tobtDate.getUTCDate() + 1);
}

tobtLowerBound = tobtDate;

  }


    let earliest = new Date(now.getTime() + 1 * 60000);

  // 🔒 Enforce TSAT ≥ TOBT
  if (tobtLowerBound && tobtLowerBound > earliest) {
    earliest = tobtLowerBound;
  }


  if (!tsatQueues[sector]) tsatQueues[sector] = [];
  let queue = tsatQueues[sector];

  // Remove existing entry for this callsign and prune old entries (older than 60 min in the past)
  const cutoffPast = new Date(now.getTime() - 60 * 60000);
  queue = queue.filter(
    entry =>
      entry.callsign !== callsign &&
      entry.tsat >= cutoffPast
  );

  tsatQueues[sector] = queue;

  // Minimum spacing rule
  const minIntervalMinutes =
    flowPerHour <= 31
      ? 2
      : Math.max(1, Math.floor(60 / flowPerHour));

  const maxPerHour = flowPerHour; // hard cap per 60-min window

  // Start searching from the earliest allowed time
  let candidate = new Date(earliest);

  while (true) {
    const windowStart = new Date(candidate.getTime() - 60 * 60000);

    const inWindow = queue.filter(
      entry => entry.tsat >= windowStart && entry.tsat <= candidate
    );

    // Enforce flow capacity per rolling hour
    if (inWindow.length >= maxPerHour) {
      candidate = new Date(candidate.getTime() + 1 * 60000);
      continue;
    }

    // Enforce minimum spacing from any existing TSAT in the window
    const tooClose = inWindow.some(entry => {
      return Math.abs(entry.tsat - candidate) < minIntervalMinutes * 60 * 1000;
    });

    if (!tooClose) break; // found a valid slot

    candidate = new Date(candidate.getTime() + 1 * 60000);
  }

  // Save into queue
  queue.push({ callsign, tsat: candidate });
  queue.sort((a, b) => a.tsat - b.tsat);
  tsatQueues[sector] = queue;

  const tsatStr =
    candidate.getHours().toString().padStart(2, '0') +
    ':' +
    candidate.getMinutes().toString().padStart(2, '0');

  // Store TSAT as an object
  sharedTSAT[callsign] = {
  tsat: tsatStr,
  icao: sector.split('-')[0]
};


  return tsatStr;
}

/**
 * Clear TSAT for a given callsign in a sector.
 */
function clearTSAT(sectorKey, callsign) {
  const sector = normalizeSectorKey(sectorKey);

  if (tsatQueues[sector]) {
    tsatQueues[sector] = tsatQueues[sector].filter(
      entry => entry.callsign !== callsign
    );
    if (tsatQueues[sector].length === 0) {
      delete tsatQueues[sector];
    }
  }
  delete sharedTSAT[callsign];
}

async function bootstrap() {
  loadNavFixes();
  loadFirData();
  await refreshPilots();
  await loadPageVisibility();
  await loadSiteBanner();

  await refreshAdminSheet();   // 🔑 sets activeEventId + loads schedule rows
  await loadDepFlowsFromDb();  // needs activeEventId
  await loadTobtBookingsFromDb();
  wfWorldMapCache.clear();

// Warm default map cache once per server start (no overrides)
await (async () => {
  const key = wfWorldMapKey({ a: '', b: '', c: '' });
  if (!wfWorldMapCache.has(key)) {
    const payload = await buildWfWorldMapPayload({ a: '', b: '', c: '' });
    wfWorldMapCache.set(key, { builtAt: Date.now(), payload });
  }
})();


  rebuildAllTobtSlots();       // 🔑 NOW WORKS

  // Pre-warm FIR analysis cache in background
  buildFirAnalysis().then(() => console.log('[AIRSPACE] FIR analysis cache warmed')).catch(() => {});

  setInterval(refreshPilots, 60000);
}


/* ===== ADMIN: VISITED AIRPORTS ===== */
app.get('/admin/visited-airports', requireAdmin, async (req, res) => {
  const user = req.session.user.data;
  const isAdmin = true;

  const visits = await prisma.wfVisitedAirport.findMany({
    orderBy: [{ year: 'desc' }, { icao: 'asc' }]
  });

  const rows = visits.map(v => `
    <tr>
      <td><strong>${v.icao}</strong></td>
      <td>${v.year}</td>
      <td>
        <button class="action-btn btn-delete-visit" data-id="${v.id}" style="font-size:12px;">Delete</button>
      </td>
    </tr>
  `).join('');

  const content = `
    <section class="card card-full">
      <h2>Visited Airports</h2>

      <form id="addVisitForm" style="display:flex;gap:8px;align-items:flex-end;margin-bottom:20px;flex-wrap:wrap;">
        <label style="font-size:13px;">
          ICAO
          <input type="text" id="visitIcao" placeholder="EGLL" maxlength="4" required
            style="width:100px;padding:6px 8px;background:#0f172a;border:1px solid #1e293b;border-radius:6px;color:#e5e7eb;text-transform:uppercase;font-family:monospace;" />
        </label>
        <label style="font-size:13px;">
          Year
          <input type="number" id="visitYear" placeholder="2025" min="2000" max="2099" required
            style="width:90px;padding:6px 8px;background:#0f172a;border:1px solid #1e293b;border-radius:6px;color:#e5e7eb;" />
        </label>
        <button type="submit" class="action-btn primary" style="padding:7px 16px;">Add</button>
        <span id="visitMsg" style="font-size:13px;margin-left:8px;" class="hidden"></span>
      </form>

      <div class="table-scroll">
        <table class="departures-table" id="visitedTable">
          <thead>
            <tr>
              <th>ICAO</th>
              <th>Year</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="3" class="empty">No visited airports yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <script>
    document.getElementById('addVisitForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      var icao = document.getElementById('visitIcao').value.trim().toUpperCase();
      var year = Number(document.getElementById('visitYear').value);
      var msg = document.getElementById('visitMsg');

      if (!/^[A-Z]{4}$/.test(icao)) { alert('Invalid ICAO'); return; }

      var res = await fetch('/admin/api/visited-airports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ icao: icao, year: year })
      });

      if (res.ok) {
        window.location.reload();
      } else {
        var data = await res.json().catch(function() { return {}; });
        msg.textContent = data.error || 'Failed to add';
        msg.style.color = 'var(--danger)';
        msg.classList.remove('hidden');
      }
    });

    document.getElementById('visitedTable').addEventListener('click', async function(e) {
      var btn = e.target.closest('.btn-delete-visit');
      if (!btn) return;
      if (!confirm('Delete this entry?')) return;

      var res = await fetch('/admin/api/visited-airports/' + btn.dataset.id, { method: 'DELETE' });
      if (res.ok) window.location.reload();
    });
    </script>
  `;

  res.send(renderLayout({ title: 'Visited Airports', user, isAdmin, content, layoutClass: 'dashboard-full' }));
});

app.post('/admin/api/visited-airports', requireAdmin, async (req, res) => {
  const { icao, year } = req.body;
  const normalized = icao?.toUpperCase?.().trim();

  if (!normalized || !/^[A-Z]{4}$/.test(normalized)) {
    return res.status(400).json({ error: 'Invalid ICAO' });
  }
  if (!year || year < 2000 || year > 2099) {
    return res.status(400).json({ error: 'Invalid year' });
  }

  const existing = await prisma.wfVisitedAirport.findFirst({
    where: { icao: normalized, year }
  });
  if (existing) {
    return res.status(409).json({ error: normalized + ' ' + year + ' already exists' });
  }

  await prisma.wfVisitedAirport.create({
    data: { icao: normalized, year, eventName: 'WorldFlight' }
  });

  res.json({ success: true });
});

app.delete('/admin/api/visited-airports/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await prisma.wfVisitedAirport.delete({ where: { id } });
  } catch (err) {
    if (err.code === 'P2025') return res.json({ ok: true });
    throw err;
  }
  res.json({ ok: true });
});

/* ===== ADMIN: SUGGESTIONS ===== */
app.get('/admin/suggestions', requireAdmin, async (req, res) => {
  const user = req.session.user.data;
  const isAdmin = true;

  const [suggestions, allVisited] = await Promise.all([
    prisma.airportSuggestion.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.wfVisitedAirport.findMany({ orderBy: { year: 'desc' } })
  ]);

  // Build visit history per ICAO
  const visitHistory = {}; // icao -> [year, year, ...]
  for (const v of allVisited) {
    if (!visitHistory[v.icao]) visitHistory[v.icao] = [];
    visitHistory[v.icao].push(v.year);
  }

  const currentYear = new Date().getFullYear();
  const fiveYearsAgo = currentYear - 5;

  // Color coding: red = >2 in last 5yr, amber = 1 in last 5yr, green = 0 in last 5yr
  function getVisitColor(icao) {
    if (/\*/.test(icao)) return 'neutral';
    const years = visitHistory[icao] || [];
    const recent = years.filter(y => y >= fiveYearsAgo).length;
    if (recent > 2) return 'red';
    if (recent >= 1) return 'amber';
    return 'green';
  }

  const visits = suggestions.filter(s => s.type !== 'avoid');
  const avoids = suggestions.filter(s => s.type === 'avoid');

  // Top 20 suggested (aggregated by ICAO)
  const visitCounts = {};
  for (const s of visits) { visitCounts[s.icao] = (visitCounts[s.icao] || 0) + 1; }
  const top20Visit = Object.entries(visitCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);

  const avoidCounts = {};
  for (const s of avoids) { avoidCounts[s.icao] = (avoidCounts[s.icao] || 0) + 1; }
  const top20Avoid = Object.entries(avoidCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);

  // Top 20 green only (not visited in past 5 years)
  const top20Green = Object.entries(visitCounts)
    .filter(([icao]) => getVisitColor(icao) === 'green')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  // Top 20 suggested by staff (Director or Staff roles)
  const staffVisits = visits.filter(s =>
    /director/i.test(s.association) || /staff/i.test(s.association)
  );
  const staffCounts = {};
  for (const s of staffVisits) { staffCounts[s.icao] = (staffCounts[s.icao] || 0) + 1; }
  const top20Staff = Object.entries(staffCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);

  // Unique ICAOs from visit suggestions that we've never been to (exclude wildcards)
  const neverVisitedMap = {};
  for (const s of visits) {
    if (/\*/.test(s.icao)) continue;
    if (visitHistory[s.icao]?.length) continue;
    if (!neverVisitedMap[s.icao]) neverVisitedMap[s.icao] = 0;
    neverVisitedMap[s.icao]++;
  }
  const neverVisited = Object.entries(neverVisitedMap)
    .sort((a, b) => b[1] - a[1])
    .map(([icao, count]) => ({ icao, count }));

  function getTooltip(icao) {
    if (/\*/.test(icao)) return 'Wildcard pattern';
    const years = visitHistory[icao] || [];
    const recent = years.filter(y => y >= fiveYearsAgo);
    if (years.length === 0) return 'Never visited';
    if (recent.length === 0) return 'Not visited in past 5 years. Last: ' + years[0];
    return 'Visited ' + recent.length + 'x in past 5 years (' + recent.join(', ') + ')';
  }

  function buildRows(list) {
    if (!list.length) return '<tr><td colspan="8" class="empty">None yet</td></tr>';
    return list.map(s => {
      const date = new Date(s.createdAt).toISOString().replace('T', ' ').slice(0, 16);
      const color = getVisitColor(s.icao);
      const tooltipText = getTooltip(s.icao);
      return `
        <tr data-icao="${s.icao}" data-name="${s.firstName} ${s.lastName}" data-assoc="${s.association}" data-date="${s.createdAt}">
          <td><span class="icao-tag icao-${color}" data-tooltip="${tooltipText}"><strong>${s.icao}</strong></span></td>
          <td>${s.firstName} ${s.lastName}</td>
          <td>${s.association}</td>
          <td style="max-width:300px;font-size:12px;">
            <div class="reason-cell">${s.reason}</div>
            ${s.reason.length > 100 ? '<button class="reason-expand">Show more</button>' : ''}
          </td>
          <td style="font-size:12px;">${s.contact}</td>
          <td style="text-align:center;"><input type="checkbox" ${s.notify ? 'checked' : ''} disabled style="accent-color:var(--accent);" /></td>
          <td style="font-size:12px;">${date}</td>
          <td>
            <button class="action-btn btn-delete-suggestion" data-id="${s.id}" style="font-size:12px;">Delete</button>
          </td>
        </tr>`;
    }).join('');
  }

  function buildTable(id, rows) {
    return `
      <div class="table-scroll">
        <table class="departures-table sortable-table" id="${id}">
          <thead>
            <tr>
              <th class="sortable" data-sort="icao">ICAO <span class="sort-arrow"></span></th>
              <th class="sortable" data-sort="name">Name <span class="sort-arrow"></span></th>
              <th class="sortable" data-sort="assoc">Association <span class="sort-arrow"></span></th>
              <th>Reason</th>
              <th>Contact</th>
              <th>Notify</th>
              <th class="sortable" data-sort="date">Date <span class="sort-arrow"></span></th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>`;
  }

  const content = `
    <div style="margin-bottom:24px;">
      <button id="deleteAllSuggestionsBtn" class="action-btn" style="background:var(--danger);color:#fff;">Delete All Suggestions</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:24px;">
      <section class="card">
        <h2 style="color:#4ade80;">Top 20 Suggested to Visit</h2>
        <div class="top-list">
          ${top20Visit.length ? top20Visit.map(([icao, count], i) => {
            const color = getVisitColor(icao);
            const tooltip = getTooltip(icao);
            const max = top20Visit[0][1];
            const pct = Math.round((count / max) * 100);
            return `<div class="top-row">
              <span class="top-pos">#${i + 1}</span>
              <span class="icao-tag icao-${color}" data-tooltip="${tooltip}"><strong>${icao}</strong></span>
              <div class="top-bar-wrap"><div class="top-bar visit" style="width:${pct}%"></div></div>
              <span class="top-count">${count}</span>
            </div>`;
          }).join('') : '<p style="color:var(--muted);font-size:13px;">No suggestions yet</p>'}
        </div>
      </section>

      <section class="card">
        <h2 style="color:#fbbf24;">Top 20 — Staff Suggestions</h2>
        <p style="color:var(--muted);font-size:12px;margin-bottom:12px;">Suggested by Division/vACC Directors &amp; Staff</p>
        <div class="top-list">
          ${top20Staff.length ? top20Staff.map(([icao, count], i) => {
            const color = getVisitColor(icao);
            const tooltip = getTooltip(icao);
            const max = top20Staff[0][1];
            const pct = Math.round((count / max) * 100);
            return `<div class="top-row">
              <span class="top-pos">#${i + 1}</span>
              <span class="icao-tag icao-${color}" data-tooltip="${tooltip}"><strong>${icao}</strong></span>
              <div class="top-bar-wrap"><div class="top-bar" style="width:${pct}%;background:#fbbf24;"></div></div>
              <span class="top-count">${count}</span>
            </div>`;
          }).join('') : '<p style="color:var(--muted);font-size:13px;">No staff suggestions yet</p>'}
        </div>
      </section>

      <section class="card">
        <h2 style="color:#4ade80;">Top 20 — Not Visited Recently</h2>
        <p style="color:var(--muted);font-size:12px;margin-bottom:12px;">Suggested airports not visited in the past 5 years</p>
        <div class="top-list">
          ${top20Green.length ? top20Green.map(([icao, count], i) => {
            const tooltip = getTooltip(icao);
            const max = top20Green[0][1];
            const pct = Math.round((count / max) * 100);
            return `<div class="top-row">
              <span class="top-pos">#${i + 1}</span>
              <span class="icao-tag icao-green" data-tooltip="${tooltip}"><strong>${icao}</strong></span>
              <div class="top-bar-wrap"><div class="top-bar visit" style="width:${pct}%"></div></div>
              <span class="top-count">${count}</span>
            </div>`;
          }).join('') : '<p style="color:var(--muted);font-size:13px;">No green suggestions yet</p>'}
        </div>
      </section>

      <section class="card">
        <h2 style="color:#f87171;">Top 20 Suggested to Avoid</h2>
        <div class="top-list">
          ${top20Avoid.length ? top20Avoid.map(([icao, count], i) => {
            const color = getVisitColor(icao);
            const tooltip = getTooltip(icao);
            const max = top20Avoid[0][1];
            const pct = Math.round((count / max) * 100);
            return `<div class="top-row">
              <span class="top-pos">#${i + 1}</span>
              <span class="icao-tag icao-${color}" data-tooltip="${tooltip}"><strong>${icao}</strong></span>
              <div class="top-bar-wrap"><div class="top-bar avoid" style="width:${pct}%"></div></div>
              <span class="top-count">${count}</span>
            </div>`;
          }).join('') : '<p style="color:var(--muted);font-size:13px;">No suggestions yet</p>'}
        </div>
      </section>
    </div>

    <section class="card card-full">
      <h2 style="color:var(--accent);">Never Visited — Suggested Airports</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">
        ${neverVisited.length} airport${neverVisited.length !== 1 ? 's' : ''} suggested that we have never visited
      </p>
      ${neverVisited.length ? `
      <div class="suggestion-chips">
        ${neverVisited.map(n => `
          <div class="suggestion-chip">
            <span class="chip-icao">${n.icao}</span>
            <span class="chip-count">${n.count} vote${n.count !== 1 ? 's' : ''}</span>
          </div>
        `).join('')}
      </div>` : '<p style="color:var(--muted);font-size:13px;">All suggested airports have been visited before.</p>'}
    </section>

    <section class="card card-full" style="margin-top:24px;">
      <h2 style="color:#4ade80;">All Suggestions</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">${visits.length} suggestion${visits.length !== 1 ? 's' : ''} to visit</p>
      <div class="admin-table-scroll">
        ${buildTable('visitTable', buildRows(visits))}
      </div>
    </section>

    <section class="card card-full" style="margin-top:24px;">
      <h2 style="color:#f87171;">All Avoids</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">${avoids.length} suggestion${avoids.length !== 1 ? 's' : ''} to avoid</p>
      <div class="admin-table-scroll">
        ${buildTable('avoidTable', buildRows(avoids))}
      </div>
    </section>

    <style>
      .admin-table-scroll {
        max-height: 640px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.08) transparent;
      }
      .admin-table-scroll::-webkit-scrollbar { width: 4px; }
      .admin-table-scroll::-webkit-scrollbar-track { background: transparent; }
      .admin-table-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
      .admin-table-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }

      .admin-table-scroll thead th { position: sticky; top: 0; background: var(--panel); z-index: 1; }

      .suggestion-chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .suggestion-chip {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 14px; border-radius: 8px;
        background: rgba(56,189,248,0.06); border: 1px solid rgba(56,189,248,0.15);
      }
      .chip-icao { font-family: monospace; font-weight: 700; font-size: 15px; color: var(--accent); }
      .chip-count { font-size: 12px; color: var(--muted); }

      .reason-cell {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        white-space: normal;
        line-height: 1.5;
      }
      .reason-cell.expanded {
        -webkit-line-clamp: unset;
        display: block;
      }
      .reason-expand {
        background: none; border: none; color: var(--accent);
        font-size: 11px; cursor: pointer; padding: 2px 0 0; font-weight: 600;
      }
      .reason-expand:hover { text-decoration: underline; }

      /* Color coded ICAO tags */
      .icao-tag {
        position: relative;
        display: inline-block;
        padding: 2px 8px;
        border-radius: 4px;
        font-family: monospace;
        font-size: 13px;
        cursor: default;
      }
      .icao-green { background: rgba(34,197,94,0.15); color: #4ade80; }
      .icao-amber { background: rgba(245,158,11,0.15); color: #fbbf24; }
      .icao-red { background: rgba(239,68,68,0.15); color: #f87171; }
      .icao-neutral { background: rgba(148,163,184,0.1); color: var(--muted); }

      /* Tooltip on hover */
      .icao-tooltip {
        display: none;
        position: fixed;
        padding: 5px 10px;
        background: #1e293b;
        color: #e5e7eb;
        font-size: 11px;
        font-family: monospace;
        white-space: nowrap;
        border-radius: 6px;
        border: 1px solid #334155;
        pointer-events: none;
        z-index: 9999;
      }

      /* Top 20 lists */
      .top-list { display: flex; flex-direction: column; gap: 4px; max-height: 380px; overflow-y: auto;
        scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.08) transparent; }
      .top-list::-webkit-scrollbar { width: 4px; }
      .top-list::-webkit-scrollbar-track { background: transparent; }
      .top-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
      .top-row {
        display: flex; align-items: center; gap: 10px;
        padding: 6px 10px; border-radius: 6px;
        background: rgba(255,255,255,0.02);
        border: 1px solid var(--border);
      }
      .top-row:hover { background: rgba(255,255,255,0.04); }
      .top-pos { font-size: 13px; font-weight: 700; color: var(--muted2); min-width: 30px; }
      .top-bar-wrap { flex: 1; height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden; }
      .top-bar { height: 100%; border-radius: 3px; }
      .top-bar.visit { background: #4ade80; }
      .top-bar.avoid { background: #f87171; }
      .top-count { font-size: 13px; font-weight: 600; color: var(--text); min-width: 30px; text-align: right; }

      @media (max-width: 1000px) {
        div[style*="grid-template-columns:1fr 1fr"] { grid-template-columns: 1fr !important; }
      }

      .sortable { cursor: pointer; user-select: none; }
      .sortable:hover { color: var(--accent); }
      .sort-arrow { font-size: 10px; margin-left: 4px; }
      .sort-arrow.asc::after { content: '▲'; }
      .sort-arrow.desc::after { content: '▼'; }
    </style>

    <div class="icao-tooltip" id="icaoTooltip"></div>

    <script>
    (function() {
      var tooltip = document.getElementById('icaoTooltip');

      document.addEventListener('mouseover', function(e) {
        var tag = e.target.closest('.icao-tag[data-tooltip]');
        if (!tag) { tooltip.style.display = 'none'; return; }
        var rect = tag.getBoundingClientRect();
        tooltip.textContent = tag.dataset.tooltip;
        tooltip.style.display = 'block';
        tooltip.style.left = rect.left + 'px';
        tooltip.style.top = (rect.bottom + 6) + 'px';
      });

      document.addEventListener('mouseout', function(e) {
        if (e.target.closest('.icao-tag[data-tooltip]')) {
          tooltip.style.display = 'none';
        }
      });

      document.querySelectorAll('.sortable-table').forEach(function(table) {
        var currentSort = { key: null, dir: 'asc' };

        table.querySelector('thead').addEventListener('click', function(e) {
          var th = e.target.closest('.sortable');
          if (!th) return;

          var key = th.dataset.sort;
          if (currentSort.key === key) {
            currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
          } else {
            currentSort.key = key;
            currentSort.dir = 'asc';
          }

          // Update arrows
          table.querySelectorAll('.sort-arrow').forEach(function(a) { a.className = 'sort-arrow'; });
          th.querySelector('.sort-arrow').className = 'sort-arrow ' + currentSort.dir;

          // Sort rows
          var tbody = table.querySelector('tbody');
          var rows = Array.from(tbody.querySelectorAll('tr[data-icao]'));

          rows.sort(function(a, b) {
            var va = (a.dataset[key] || '').toLowerCase();
            var vb = (b.dataset[key] || '').toLowerCase();
            if (key === 'date') { va = a.dataset.date; vb = b.dataset.date; }
            var cmp = va < vb ? -1 : va > vb ? 1 : 0;
            return currentSort.dir === 'desc' ? -cmp : cmp;
          });

          rows.forEach(function(r) { tbody.appendChild(r); });
        });
      });

      document.getElementById('deleteAllSuggestionsBtn').addEventListener('click', function() {
        openConfirmModal({
          title: 'Delete All Suggestions',
          message: 'This will permanently delete all suggestions. This cannot be undone.'
        }).then(async function(ok) {
          if (!ok) return;
          var res = await fetch('/admin/api/suggestions/all', { method: 'DELETE' });
          if (res.ok) window.location.reload();
        });
      });

      document.addEventListener('click', async function(e) {
        var expandBtn = e.target.closest('.reason-expand');
        if (expandBtn) {
          var cell = expandBtn.previousElementSibling;
          var expanded = cell.classList.toggle('expanded');
          expandBtn.textContent = expanded ? 'Show less' : 'Show more';
          return;
        }

        var btn = e.target.closest('.btn-delete-suggestion');
        if (!btn) return;
        if (!confirm('Delete this suggestion?')) return;

        var res = await fetch('/admin/api/suggestions/' + btn.dataset.id, { method: 'DELETE' });
        if (res.ok) window.location.reload();
      });
    })();
    </script>
  `;

  res.send(renderLayout({ title: 'Airport Suggestions', user, isAdmin, content, layoutClass: 'dashboard-full' }));
});

app.delete('/admin/api/suggestions/all', requireAdmin, async (req, res) => {
  await prisma.airportSuggestion.deleteMany({});
  res.json({ ok: true });
});

app.delete('/admin/api/suggestions/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await prisma.airportSuggestion.delete({ where: { id } });
  } catch (err) {
    if (err.code === 'P2025') return res.json({ ok: true });
    throw err;
  }
  res.json({ ok: true });
});

/* ===== SUGGEST AIRPORT PAGE ===== */
app.get('/suggest-airport', requirePageEnabled('suggest-airport'), (req, res) => {
  const user = req.session?.user?.data || null;
  const cid = Number(user?.cid) || null;
  const isAdmin = cid && ADMIN_CIDS.includes(cid);

  const firstName = user?.personal?.name_first || '';
  const lastName = user?.personal?.name_last || '';
  const userEmail = user?.personal?.email || '';

  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  const captchaAnswer = a + b;

  const content = `
  <div class="suggest-layout">

    <section class="card suggest-info">
      <img src="/logo.png" alt="WorldFlight" class="suggest-logo" />
      <h2 class="suggest-heading">WorldFlight 2026</h2>
      <p class="suggest-dates">October 31st &mdash; November 7th</p>

      <div class="suggest-body">
        <p>
          We invite you to submit an airport suggestion for WorldFlight 2026.
          Whether you'd like us to visit or avoid a specific airport, region, or division,
          your input plays a vital role in shaping the route.
        </p>

        <p class="suggest-contact">
          <a href="mailto:contact@worldflight.center">contact@worldflight.center</a>
        </p>

        <p>
          WorldFlight is an annual circumnavigation of the globe completed over seven days on the
          VATSIM network. Since its inception, the event has raised millions of dollars for charities
          worldwide, and regularly sees upwards of 70 aircraft participating in each leg.
        </p>

        <p>
          An event of this scale requires careful coordination. If you would like to support
          WorldFlight, please submit your suggestion using the form and our planning team will
          be in touch during the route development phase.
        </p>

        <p>
          While it is not always possible to schedule every arrival at a convenient local time,
          we make every effort to accommodate all regions. Should your airport fall outside peak hours
          this year, we will endeavour to revisit it at a more suitable time in a future event.
        </p>

        <p class="suggest-signoff">Happy flying &mdash; and thank you for your continued support.</p>
      </div>

      <a href="/previous-destinations" class="prev-dest-banner">
        <span>📍</span>
        <span>View all previous WorldFlight destinations &rarr;</span>
      </a>
    </section>

    <div>
    <section class="card" style="margin-bottom:16px;">
      <h2>Recent Suggestions</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:12px;">Latest airports the community wants WorldFlight to visit</p>
      <div id="recentVisitList" class="suggestion-list suggestion-scroll">
        <div class="empty" style="padding:20px;text-align:center;color:var(--muted);">Loading...</div>
      </div>
    </section>

    <section class="card suggest-form-card">
      <h2>Suggest an Airport</h2>

      <form id="suggestForm">
        <label>
          First Name
          <input type="text" id="suggestFirst" value="${firstName}" required ${firstName ? 'readonly' : ''} />
        </label>

        <label>
          Last Name
          <input type="text" id="suggestLast" value="${lastName}" required ${lastName ? 'readonly' : ''} />
        </label>

        <label>
          Email Address${userEmail ? '' : ' (optional)'}
          <input type="email" id="suggestEmail" value="${userEmail}" placeholder="${userEmail ? 'you@example.com' : 'Optional — you@example.com'}" />
        </label>

        <label class="suggest-checkbox">
          <input type="checkbox" id="suggestNotify" />
          <span>Notify me when the WorldFlight route is announced</span>
        </label>

        <label>
          I would like WorldFlight to...
          <select id="suggestType" required>
            <option value="visit">Visit this airport</option>
            <option value="avoid">Avoid this airport</option>
          </select>
        </label>

        <label>
          Airport ICAO
          <input type="text" id="suggestIcao" placeholder="e.g. EGLL, LAX, EG**, K***" maxlength="4" required autocomplete="off" style="text-transform:uppercase;font-family:monospace;" />
        </label>
        <div id="icaoVisitInfo" class="icao-visit-info hidden"></div>

        <label>
          What is your VATSIM association with this airport?
          <select id="suggestAssociation" required>
            <option value="">Select...</option>
            <option value="Division Director">Division Director</option>
            <option value="Division Staff">Division Staff</option>
            <option value="vACC Director">vACC Director</option>
            <option value="vACC Staff">vACC Staff</option>
            <option value="Controller">Controller</option>
            <option value="Pilot">Pilot</option>
            <option value="Other">Other</option>
          </select>
        </label>

        <label>
          Reason for your suggestion
          <textarea id="suggestReason" rows="4" required placeholder="Tell us why we should visit (or avoid) this airport..."></textarea>
        </label>

        <label>
          Anti-bot check: What is ${a} + ${b}?
          <input type="text" id="suggestCaptcha" inputmode="numeric" required placeholder="Your answer" autocomplete="off" />
        </label>
        <input type="hidden" id="captchaAnswer" value="${captchaAnswer}" />

        <div id="suggestMsg" class="modal-message hidden" style="margin-top:8px;"></div>

        <div class="modal-actions" style="margin-top:16px;">
          <button type="submit" class="modal-btn modal-btn-submit" id="suggestSubmitBtn">Submit Suggestion</button>
        </div>
      </form>
    </section>
    </div>

  </div>

  <style>
    .suggest-layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      align-items: stretch;
    }
    .suggest-layout > .card {
      display: flex;
      flex-direction: column;
    }
    @media (max-width: 900px) {
      .suggest-layout { grid-template-columns: 1fr; }
    }

    .suggest-info { text-align: center; }
    .suggest-logo { width: 80px; height: 80px; border-radius: 50%; margin-bottom: 16px; }
    .suggest-heading { color: var(--accent); font-size: 24px; margin-bottom: 4px; }
    .suggest-dates { color: var(--text); font-size: 16px; font-weight: 600; margin-bottom: 24px; }
    .suggest-body { text-align: left; }
    .suggest-body p { color: var(--muted); font-size: 14px; line-height: 1.7; margin-bottom: 14px; }
    .suggest-contact { text-align: center; }
    .suggest-contact a { color: var(--accent); text-decoration: none; font-weight: 600; }
    .suggest-contact a:hover { text-decoration: underline; }
    .suggest-signoff { color: var(--text) !important; font-weight: 600; font-style: italic; text-align: center; margin-top: 20px; }
    .prev-dest-banner {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      margin-top: 20px; padding: 12px 16px;
      background: rgba(56,189,248,0.06); border: 1px solid rgba(56,189,248,0.15);
      border-radius: 8px; text-decoration: none;
      color: var(--accent); font-size: 13px; font-weight: 600;
      transition: background .15s, border-color .15s;
    }
    .prev-dest-banner:hover { background: rgba(56,189,248,0.12); border-color: rgba(56,189,248,0.3); }

    .suggest-form-card label { display: block; font-size: 13px; margin-top: 12px; font-weight: 600; }
    .suggest-form-card input,
    .suggest-form-card select,
    .suggest-form-card textarea {
      width: 100%; margin-top: 4px; padding: 8px;
      background: #0f172a; border: 1px solid #1e293b; border-radius: 6px;
      color: #e5e7eb; font-family: inherit; font-size: 13px;
    }
    .suggest-form-card input[readonly] {
      color: #4a5568; background: #080d17; cursor: not-allowed;
    }
    .suggest-form-card textarea { resize: vertical; }
    .suggest-checkbox {
      display: flex; align-items: center; gap: 8px;
      margin-top: 14px; font-size: 13px; font-weight: 400; cursor: pointer;
    }
    .suggest-checkbox input[type="checkbox"] {
      width: auto; margin: 0; accent-color: var(--accent);
    }

    .suggest-checkbox {
      display: flex !important;
      flex-direction: row !important;
      align-items: center;
      gap: 8px;
      margin-top: 16px !important;
      cursor: pointer;
    }
    .suggest-checkbox input[type="checkbox"] {
      width: auto;
      margin: 0;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .suggest-checkbox span {
      font-size: 13px;
      color: var(--muted);
    }

    .icao-visit-info {
      margin-top: 6px;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.5;
      border: 1px solid var(--border);
    }
    .icao-visit-info.visited {
      background: rgba(56,189,248,0.08);
      border-color: rgba(56,189,248,0.25);
      color: var(--text);
    }
    .icao-visit-info.not-visited {
      background: rgba(34,197,94,0.08);
      border-color: rgba(34,197,94,0.25);
      color: var(--success);
    }
    .icao-visit-info.icao-invalid {
      background: rgba(239,68,68,0.08);
      border-color: rgba(239,68,68,0.25);
      color: #f87171;
    }
    .icao-visit-info .visit-count {
      font-weight: 700;
      color: var(--accent);
    }
    .icao-visit-info .visit-years {
      color: var(--muted);
      font-size: 12px;
      margin-top: 4px;
    }
  </style>

  <script>
  (function() {
    var emailInput = document.getElementById('suggestEmail');
    var notifyBox = document.getElementById('suggestNotify');

    function updateNotifyState() {
      if (!emailInput || !notifyBox) return;
      var hasEmail = emailInput.value.trim().length > 0;
      if (!hasEmail) {
        notifyBox.checked = false;
        notifyBox.disabled = true;
      } else {
        notifyBox.disabled = false;
      }
    }
    if (emailInput) {
      emailInput.addEventListener('input', updateNotifyState);
      updateNotifyState();
    }

  })();
  </script>

  <script>
  (function() {
    var icaoInput = document.getElementById('suggestIcao');
    var visitInfo = document.getElementById('icaoVisitInfo');
    var debounceTimer = null;

    var submitBtn = document.getElementById('suggestSubmitBtn');

    if (!icaoInput || !visitInfo) return;

    function iataToIcao(code) {
      if (code.length === 3 && /^[A-Z]{3}$/.test(code)) {
        return code.charAt(0) === 'Y' ? 'C' + code : 'K' + code;
      }
      return code;
    }

    window._icaoValid = false;
    var icaoValid = false;

    icaoInput.addEventListener('input', function() {
      clearTimeout(debounceTimer);
      icaoValid = false; window._icaoValid = false;
      if (submitBtn) submitBtn.disabled = true;
      var val = icaoInput.value.trim().toUpperCase();

      // Wildcards skip airport check
      if (/[*]/.test(val) && /^[A-Z*]{2,4}$/.test(val) && /[A-Z]/.test(val)) {
        icaoValid = true; window._icaoValid = true;
        if (submitBtn) submitBtn.disabled = false;
        visitInfo.innerHTML = 'Wildcard pattern — applies to a region.';
        visitInfo.className = 'icao-visit-info visited';
        return;
      }

      if (!/^[A-Z]{3,4}$/.test(val)) {
        if (val.length >= 3) {
          icaoValid = false; window._icaoValid = false;
          visitInfo.innerHTML = '<strong>' + val + '</strong> is not a valid ICAO code. ICAO codes are 4 letters (e.g. EGLL, KLAX).';
          visitInfo.className = 'icao-visit-info icao-invalid';
        } else {
          visitInfo.classList.add('hidden');
        }
        return;
      }

      debounceTimer = setTimeout(async function() {
        try {
          var lookup = iataToIcao(val);
          var sugType = document.getElementById('suggestType')?.value || 'visit';
          var res = await fetch('/api/airport-visits/' + lookup + '?type=' + sugType);
          if (!res.ok) { visitInfo.classList.add('hidden'); return; }
          var data = await res.json();

          if (!data.exists) {
            icaoValid = false;
            var name = data.airportName ? ' (' + data.airportName + ')' : '';
            visitInfo.innerHTML = '<strong>' + data.icao + '</strong> is not a recognised airport in our database. Please check the ICAO code.';
            visitInfo.className = 'icao-visit-info icao-invalid';
            return;
          }

          icaoValid = true; window._icaoValid = true;
          var nameLabel = data.airportName ? ' — ' + data.airportName : '';
          var visitText;

          if (data.icao === 'YSSY') {
            visitText = 'We start and finish at <span class="visit-count">YSSY</span>' + nameLabel + ' every year!';
            visitInfo.className = 'icao-visit-info visited';
          } else if (data.totalVisits > 0) {
            visitText = data.totalVisits === 1
              ? '<span class="visit-count">' + data.icao + '</span>' + nameLabel + ' — visited once before. Last visit was <span class="visit-count">' + data.lastVisit + '</span>.'
              : '<span class="visit-count">' + data.icao + '</span>' + nameLabel + ' — visited <span class="visit-count">' + data.totalVisits + '</span> times. Last visit was <span class="visit-count">' + data.lastVisit + '</span>.';
            visitInfo.className = 'icao-visit-info visited';
          } else {
            visitText = '<span class="visit-count">' + data.icao + '</span>' + nameLabel + ' — never visited before. Great suggestion!';
            visitInfo.className = 'icao-visit-info not-visited';
          }

          // Check for duplicate suggestion (logged-in users only)
          if (data.alreadySuggested) {
            icaoValid = false; window._icaoValid = false;
            if (submitBtn) submitBtn.disabled = true;
            visitInfo.innerHTML = visitText + '<div style="margin-top:8px;color:#f87171;font-weight:600;">You have already submitted a suggestion for ' + data.icao + '.</div>';
            visitInfo.className = 'icao-visit-info icao-invalid';
          } else {
            if (submitBtn) submitBtn.disabled = false;
            visitInfo.innerHTML = visitText;
          }
        } catch(err) {
          visitInfo.classList.add('hidden');
        }
      }, 300);
    });

    // Re-check when type changes (visit/avoid)
    var typeSelect = document.getElementById('suggestType');
    if (typeSelect) {
      typeSelect.addEventListener('change', function() {
        icaoInput.dispatchEvent(new Event('input'));
      });
    }
  })();
  </script>

  <script>
  (function() {
    function iataToIcaoSubmit(code) {
      if (code.length === 3 && /^[A-Z]{3}$/.test(code)) {
        return code.charAt(0) === 'Y' ? 'C' + code : 'K' + code;
      }
      return code;
    }

    document.getElementById('suggestForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      var btn = document.getElementById('suggestSubmitBtn');
      var msg = document.getElementById('suggestMsg');

      var captchaVal = Number(document.getElementById('suggestCaptcha').value.trim());
      var captchaExpected = Number(document.getElementById('captchaAnswer').value);
      if (captchaVal !== captchaExpected) {
        msg.textContent = 'Incorrect answer. Please try again.';
        msg.style.color = 'var(--danger)';
        msg.classList.remove('hidden');
        return;
      }

      var icao = iataToIcaoSubmit(document.getElementById('suggestIcao').value.trim().toUpperCase());
    if (!/^[A-Z*]{2,4}$/.test(icao) || !/[A-Z]/.test(icao)) {
      msg.textContent = 'Please enter a valid ICAO code or pattern (e.g. EGLL, EG**, K***).';
      msg.style.color = 'var(--danger)';
      msg.classList.remove('hidden');
      return;
    }

    if (!window._icaoValid) {
      msg.textContent = 'This airport is not recognised. Please check the ICAO code.';
      msg.style.color = 'var(--danger)';
      msg.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Submitting...';
    msg.classList.add('hidden');

    try {
      var res = await fetch('/api/suggest-airport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: document.getElementById('suggestFirst').value.trim(),
          lastName: document.getElementById('suggestLast').value.trim(),
          icao: icao,
          type: document.getElementById('suggestType').value,
          association: document.getElementById('suggestAssociation').value,
          reason: document.getElementById('suggestReason').value.trim(),
          contact: document.getElementById('suggestEmail').value.trim(),
          email: document.getElementById('suggestEmail').value.trim(),
          notifyRoute: document.getElementById('suggestNotify').checked
        })
      });

      if (!res.ok) {
        var data = await res.json().catch(function() { return {}; });
        throw new Error(data.error || 'Failed to submit');
      }

      msg.textContent = 'Thank you! Your suggestion has been submitted.';
      msg.style.color = 'var(--success)';
      msg.classList.remove('hidden');
      btn.textContent = 'Submitted';

      // Reset form fields (except name)
      document.getElementById('suggestIcao').value = '';
      document.getElementById('suggestType').value = 'visit';
      document.getElementById('suggestAssociation').value = '';
      document.getElementById('suggestReason').value = '';

      setTimeout(function() { btn.disabled = false; btn.textContent = 'Submit Suggestion'; }, 3000);
    } catch(err) {
      msg.textContent = err.message || 'Something went wrong. Please try again.';
      msg.style.color = 'var(--danger)';
      msg.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Submit Suggestion';
    }
  });
  })();
  </script>


  <style>
    .suggestions-view {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      align-items: stretch;
    }
    .suggestions-view > .card {
      display: flex;
      flex-direction: column;
    }
    .suggestions-view .suggestion-list { flex: 1; }
    .suggestion-scroll {
      max-height: 138px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.08) transparent;
    }
    .suggestion-scroll::-webkit-scrollbar { width: 4px; }
    .suggestion-scroll::-webkit-scrollbar-track { background: transparent; }
    .suggestion-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
    @media (max-width: 900px) {
      .suggestions-view { grid-template-columns: 1fr; }
    }
    .suggestion-list { display: flex; flex-direction: column; gap: 4px; }
    .suggestion-rank {
      display: flex; align-items: center; padding: 12px 16px;
      border-radius: 8px; background: rgba(255,255,255,0.02);
      border: 1px solid var(--border); transition: background .15s;
    }
    .suggestion-rank:hover { background: rgba(255,255,255,0.04); }
    .rank-icao { font-family: monospace; font-size: 15px; font-weight: 700; color: var(--accent); min-width: 56px; }
    .rank-name { flex: 1; font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-left: 8px; }
    .rank-time { text-align: right; flex-shrink: 0; margin-left: 12px; font-size: 12px; color: var(--muted2); white-space: nowrap; }
  </style>

  <script>
  (async function() {
    var res = await fetch('/api/suggestion-stats');
    var data = await res.json();

    function timeAgo(dateStr) {
      var diff = Date.now() - new Date(dateStr).getTime();
      var mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      var days = Math.floor(hrs / 24);
      if (days < 30) return days + 'd ago';
      return Math.floor(days / 30) + 'mo ago';
    }

    function renderList(containerId, items) {
      var el = document.getElementById(containerId);
      if (!items || !items.length) {
        el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;">No suggestions yet.</div>';
        return;
      }
      el.innerHTML = items.map(function(item) {
        return '<div class="suggestion-rank">'
          + '<span class="rank-icao">' + item.icao + '</span>'
          + (item.name ? '<span class="rank-name">' + item.name + '</span>' : '')
          + '<span class="rank-time">' + timeAgo(item.createdAt) + '</span>'
          + '</div>';
      }).join('');
    }

    renderList('recentVisitList', data.recentVisit);
    renderList('recentAvoidList', data.recentAvoid);
  })();
  </script>
  `;

  res.send(renderLayout({
    title: 'Suggest an Airport',
    user,
    isAdmin,
    content,
    layoutClass: 'dashboard-full'
  }));
});

app.get('/api/previous-destinations', async (req, res) => {
  try {
    const visited = await prisma.wfVisitedAirport.findMany({
      orderBy: [{ icao: 'asc' }, { year: 'desc' }]
    });

    // Group visits by ICAO
    const byIcao = {};
    for (const v of visited) {
      if (!byIcao[v.icao]) byIcao[v.icao] = [];
      byIcao[v.icao].push({ year: v.year, eventName: v.eventName });
    }

    // Look up airport coordinates and names
    const icaos = Object.keys(byIcao);
    let airports;
    try {
      airports = await prisma.airport.findMany({
        where: { icao: { in: icaos } },
        select: { icao: true, name: true, lat: true, lon: true }
      });
    } catch {
      airports = await prisma.airport.findMany({
        where: { icao: { in: icaos } },
        select: { icao: true, lat: true, lon: true }
      });
    }

    const result = {};
    for (const ap of airports) {
      result[ap.icao] = {
        icao: ap.icao,
        name: ap.name || null,
        lat: ap.lat,
        lon: ap.lon,
        visits: byIcao[ap.icao] || []
      };
    }

    res.json({ airports: result });
  } catch (err) {
    console.error('previous-destinations API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/airport-visits/:icao', async (req, res) => {
  const icao = req.params.icao?.toUpperCase();
  if (!icao || !/^[A-Z]{4}$/.test(icao)) {
    return res.status(400).json({ error: 'Invalid ICAO' });
  }

  const cid = Number(req.session?.user?.data?.cid) || null;
  const sugType = req.query.type === 'avoid' ? 'avoid' : 'visit';

  const queries = [
    prisma.airport.findUnique({ where: { icao }, select: { icao: true, name: true } }),
    prisma.wfVisitedAirport.findMany({ where: { icao }, orderBy: { year: 'desc' } })
  ];

  // Check for existing suggestion if logged in
  if (cid) {
    queries.push(prisma.airportSuggestion.findFirst({
      where: { cid, icao, type: sugType }
    }));
  }

  const [airport, visits, existingSuggestion] = await Promise.all(queries);

  res.json({
    icao,
    exists: !!airport,
    airportName: airport?.name || null,
    totalVisits: visits.length,
    lastVisit: visits.length > 0 ? visits[0].year : null,
    visits: visits.map(v => ({ year: v.year, eventName: v.eventName })),
    alreadySuggested: !!existingSuggestion
  });
});

app.post('/api/suggest-airport', async (req, res) => {
  const { firstName, lastName, icao, type, association, reason, contact, email, notifyRoute } = req.body;

  if (!firstName || !lastName || !icao || !association || !reason) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const upperIcao = icao.toUpperCase().trim();
  if (!/^[A-Z*]{2,4}$/.test(upperIcao) || !/[A-Z]/.test(upperIcao)) {
    return res.status(400).json({ error: 'Invalid ICAO code' });
  }

  // Validate non-wildcard ICAOs exist in our database
  if (!/\*/.test(upperIcao) && upperIcao.length === 4) {
    const airport = await prisma.airport.findUnique({ where: { icao: upperIcao }, select: { icao: true } });
    if (!airport) {
      return res.status(400).json({ error: upperIcao + ' is not a recognised airport' });
    }
  }

  const suggestionType = type === 'avoid' ? 'avoid' : 'visit';
  const cid = Number(req.session?.user?.data?.cid) || null;

  // Prevent duplicate suggestions per airport for logged-in users
  if (cid) {
    const existing = await prisma.airportSuggestion.findFirst({
      where: { cid, icao: upperIcao, type: suggestionType }
    });
    if (existing) {
      return res.status(409).json({ error: 'You have already submitted a suggestion for ' + upperIcao });
    }
  }

  await prisma.airportSuggestion.create({
    data: {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      icao: icao.toUpperCase(),
      type: suggestionType,
      association,
      reason: reason.trim(),
      contact: (contact || '').trim(),
      notify: !!notifyRoute,
      cid
    }
  });

  // Subscribe to mailing list if opted in
  if (notifyRoute && email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    try {
      await prisma.mailingListSubscriber.upsert({
        where: { email: email.trim().toLowerCase() },
        update: { firstName: firstName.trim(), lastName: lastName.trim(), cid },
        create: {
          email: email.trim().toLowerCase(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          cid
        }
      });
    } catch (err) {
      console.error('Mailing list subscribe error:', err.message);
    }
  }

  res.json({ success: true });
});

/* ===== VIEW SUGGESTIONS PAGE ===== */
app.get('/api/suggestion-stats', async (req, res) => {
  const [recentVisit, recentAvoid] = await Promise.all([
    prisma.airportSuggestion.findMany({
      where: { type: { not: 'avoid' } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { icao: true, createdAt: true }
    }),
    prisma.airportSuggestion.findMany({
      where: { type: 'avoid' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { icao: true, createdAt: true }
    })
  ]);

  // Look up airport names
  const allIcaos = [...new Set([...recentVisit, ...recentAvoid].map(s => s.icao))];
  let airports;
  try {
    airports = await prisma.airport.findMany({
      where: { icao: { in: allIcaos } },
      select: { icao: true, name: true }
    });
  } catch {
    airports = await prisma.airport.findMany({
      where: { icao: { in: allIcaos } },
      select: { icao: true }
    });
  }
  const nameMap = Object.fromEntries(airports.map(a => [a.icao, a.name || null]));

  const addName = s => ({ ...s, name: nameMap[s.icao] || null });

  res.json({
    recentVisit: recentVisit.map(addName),
    recentAvoid: recentAvoid.map(addName)
  });
});

// Redirect old view-suggestions URL to suggest-airport
app.get('/view-suggestions', (req, res) => {
  res.redirect(301, '/suggest-airport');
});

bootstrap().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});

function getWfAirportsSet() {
  const s = new Set();
  for (const row of adminSheetCache) {
    if (row.from) s.add(String(row.from).toUpperCase());
    if (row.to)   s.add(String(row.to).toUpperCase());
  }
  return s;
}

const SCENERY_FILE = path.join(__dirname, 'data', 'scenery-links.json');


function extractTSATMap() {
  return Object.fromEntries(
    Object.entries(sharedTSAT).map(([cs, obj]) => [cs, obj.tsat])
  );
}
function rebuildTSATStateForICAO(icao) {
  Object.entries(sharedToggles).forEach(([callsign, toggles]) => {
    if (!toggles.start) return;
    if (!toggles.sector) return;

    const fromIcao = toggles.sector.split('-')[0];
    if (fromIcao !== icao) return;

    // If START is already true but TSAT does not exist, rebuild it
    if (!sharedTSAT[callsign]) {
      assignTSAT(toggles.sector, callsign);
    }
  });
}


/* ================= SOCKET.IO ================= */
io.on('connection', async socket => {

  console.log('Client connected:', socket.id);

  const user = socket.request.session?.user?.data || null;
const icaoFromQuery = socket.handshake.query?.icao || null;
if (icaoFromQuery) {
  const room = `icao:${icaoFromQuery.toUpperCase()}`;
  socket.join(room);
}


// ✅ Rebuild TSATs for late joiners (keep this)
if (icaoFromQuery) rebuildTSATStateForICAO(icaoFromQuery);

// ✅ These can stay as-is
socket.emit('syncState', sharedToggles);
socket.emit('syncDepFlows', sharedDepFlows);
socket.emit('syncFlowTypes', sharedFlowTypes);

socket.emit(
  'unassignedTobtUpdate',
  buildUnassignedTobtsForICAO(icaoFromQuery)
);



// ✅ IMPORTANT: emit a string map, not objects (fixes [object Object])
socket.emit('syncTSAT', extractTSATMap());

socket.emit('tsatStartedUpdated', startedAircraft);

if (icaoFromQuery) {
  socket.emit('upcomingTSATUpdate', buildUpcomingTSATsForICAO(icaoFromQuery, cachedPilots));
  socket.emit('recentlyStartedUpdate', buildRecentlyStartedForICAO(icaoFromQuery));
}


  socket.on('requestInitialTSATState', ({ icao }) => {
    if (!icao) return;
    socket.emit(
  'upcomingTSATUpdate',
  buildUpcomingTSATsForICAO(icao, cachedPilots)
);


    socket.emit('recentlyStartedUpdate', buildRecentlyStartedForICAO(icao));
  });

  socket.on('requestToggleStateSync', () => {
    socket.emit('syncState', sharedToggles);
  });

  socket.on('requestTSATSync', () => {
    socket.emit(
      'syncTSAT',
      Object.fromEntries(
        Object.entries(sharedTSAT).map(([cs, obj]) => [cs, obj.tsat])
      )
    );
  });
  socket.on('requestSyncAllState', ({ icao }) => {
  if (!icao) return;

  rebuildTSATStateForICAO(icao);

  socket.emit('upcomingTSATUpdate', buildUpcomingTSATsForICAO(icao, cachedPilots));
  socket.emit('recentlyStartedUpdate', buildRecentlyStartedForICAO(icao));

  socket.emit('unassignedTobtUpdate', buildUnassignedTobtsForICAO(icao));

  socket.emit('syncState', sharedToggles);
  socket.emit('syncDepFlows', sharedDepFlows);
  socket.emit('syncTSAT', extractTSATMap());
  socket.emit('tsatStartedUpdated', startedAircraft);
});



  socket.on('requestStartedStateSync', () => {
    socket.emit('tsatStartedUpdated', startedAircraft);
  });

  /* =========================================================
     PERMISSION HELPER
     ========================================================= */

  function canEditSector(sector) {
    if (!user || !sector) return false;
    const pageIcao = sector.split('-')[0];
    return ADMIN_CIDS.includes(Number(user.cid)) || canEditIcao(user, pageIcao);
  }

  /* =========================================================
     TOGGLES (CLR / START)
     ========================================================= */

  socket.on('updateToggle', ({ callsign, type, value, sector }) => {
  if (!callsign || type !== 'start') return;

    if (!canEditSector(sector)) return;

    if (!sharedToggles[callsign]) sharedToggles[callsign] = {};
    sharedToggles[callsign].start = value;

    if (sector) {
      sharedToggles[callsign].sector = normalizeSectorKey(sector);
    }

    const activeSector = sector || sharedToggles[callsign].sector;
    const icao = activeSector?.split('-')[0];

    if (type === 'start' && value === true && activeSector) {
      const tsat = assignTSAT(activeSector, callsign);
      io.emit('tsatUpdated', { callsign, tsat });
      io.to(`icao:${icao}`).emit(
  'upcomingTSATUpdate',
  buildUpcomingTSATsForICAO(icao, cachedPilots)
);

    }

    if (type === 'start' && value === false && activeSector) {
      clearTSAT(activeSector, callsign);
      io.emit('tsatUpdated', { callsign, tsat: '' });
      io.to(`icao:${icao}`).emit(
  'upcomingTSATUpdate',
  buildUpcomingTSATsForICAO(icao, cachedPilots)
);

    }

    io.emit('toggleUpdated', { callsign, type, value });
  });

  /* =========================================================
     TSAT MANIPULATION
     ========================================================= */

  socket.on('requestTSAT', async ({ callsign, sector }) => {
    if (!canEditSector(sector)) return;
    const tsat = assignTSAT(sector, callsign);
    io.emit('tsatUpdated', { callsign, tsat });
    io.emit(
      'upcomingTSATUpdate',
      buildUpcomingTSATsForICAO(sector.split('-')[0])
    );
  });

  socket.on('recalculateTSAT', ({ callsign, sector }) => {
    if (!canEditSector(sector)) return;
    const tsat = assignTSAT(sector, callsign);
    io.emit('tsatUpdated', { callsign, tsat });
  });

  socket.on('cancelTSAT', ({ callsign, sector }) => {
    if (!canEditSector(sector)) return;
    clearTSAT(sector, callsign);
    io.emit('tsatUpdated', { callsign, tsat: '' });
    io.emit(
      'upcomingTSATUpdate',
      buildUpcomingTSATsForICAO(sector.split('-')[0])
    );
  });

  socket.on('updateTSAT', ({ callsign, tsat }) => {
    if (!callsign) return;
    sharedTSAT[callsign] = { tsat };
    io.emit('tsatUpdated', { callsign, tsat });
  });

  /* =========================================================
     STARTED / RECENTLY STARTED
     ========================================================= */

  socket.on('markTSATStarted', ({ callsign }) => {
    const sector = sharedToggles[callsign]?.sector;
    if (!canEditSector(sector)) return;

    const icao = sector.split('-')[0];
    const entry = sharedTSAT[callsign];
    if (!entry) return;

    startedAircraft[callsign] = true;
    recentlyStarted[callsign] = {
      tsat: entry.tsat,
      icao,
      startedAt: new Date().toISOString().slice(11, 16)
    };

    io.emit('tsatStartedUpdated', startedAircraft);
    io.to(`icao:${icao}`).emit(
  'upcomingTSATUpdate',
  buildUpcomingTSATsForICAO(icao, cachedPilots)
);

    io.emit(
  'recentlyStartedUpdate',
  buildRecentlyStartedForICAO(icao)
);

  });

  socket.on('sendBackToUpcoming', ({ callsign }) => {
  const entry = recentlyStarted[callsign];
  if (!entry) return;
  if (!canEditIcao(user, entry.icao)) return;

  if (entry.tsat) {
    sharedTSAT[callsign] = {
      tsat: entry.tsat,
      icao: entry.icao   // 🔑 REQUIRED
    };
  }

  delete recentlyStarted[callsign];
  delete startedAircraft[callsign];

  io.emit('tsatStartedUpdated', startedAircraft);
  io.emit(
    'upcomingTSATUpdate',
    buildUpcomingTSATsForICAO(entry.icao, cachedPilots)
  );
  io.emit(
    'recentlyStartedUpdate',
    buildRecentlyStartedForICAO(entry.icao)
  );
});


  socket.on('deleteStartedEntry', ({ callsign }) => {
    const entry = recentlyStarted[callsign];
    if (!entry) return;
    if (!canEditIcao(user, entry.icao)) return;

    delete recentlyStarted[callsign];
    delete startedAircraft[callsign];

    io.emit(
      'recentlyStartedUpdate',
      buildRecentlyStartedForICAO(entry.icao)
    );
  });

  /* =========================================================
     DEP FLOWS
     ========================================================= */

// Request flows for a specific event (admin schedule page)
socket.on('requestEventFlows', async ({ eventId: reqEventId }) => {
  if (!reqEventId) return;
  const flows = await prisma.depFlow.findMany({ where: { eventId: reqEventId } });
  const rates = {};
  const types = {};
  for (const f of flows) {
    rates[f.sector] = Number(f.rate) || 0;
    const ft = (f.flowtype || 'NONE').toString().toUpperCase();
    types[f.sector] = (ft === 'SLOTTED' || ft === 'BOOKING_ONLY' || ft === 'NONE') ? ft : 'NONE';
  }
  socket.emit('syncDepFlows', rates);
  socket.emit('syncFlowTypes', types);
});

socket.on('updateDepFlow', async ({ sector, value, eventId: clientEventId }) => {
  const key = normalizeSectorKey(sector);
  const rate = Number(value);
  const evtId = clientEventId || activeEventId || 0;
  const isActiveEvent = evtId === activeEventId;

  // treat blank / 0 / invalid as "remove rate"
  if (!Number.isFinite(rate) || rate <= 0) {
    if (isActiveEvent) delete sharedDepFlows[key];

    await prisma.depFlow.deleteMany({ where: { eventId: evtId, sector: key } });

    io.emit('depFlowUpdated', { sector: key, value: 0, eventId: evtId });
    if (isActiveEvent) {
      rebuildAllTobtSlots();
      const fromIcao = key.split('-')[0];
      io.to(`icao:${fromIcao}`).emit(
        'unassignedTobtUpdate',
        buildUnassignedTobtsForICAO(fromIcao)
      );
    }

    return;
  }

  if (isActiveEvent) sharedDepFlows[key] = rate;

  await prisma.depFlow.upsert({
    where: { eventId_sector: { eventId: evtId, sector: key } },
    update: { rate },
    create: {
      eventId: evtId,
      sector: key,
      rate,
      flowtype: (isActiveEvent ? sharedFlowTypes[key] : null) || 'NONE'
    }
  });

  io.emit('depFlowUpdated', { sector: key, value: rate, eventId: evtId });
  if (isActiveEvent) {
    rebuildAllTobtSlots();
    const fromIcao = key.split('-')[0];
    io.to(`icao:${fromIcao}`).emit(
      'unassignedTobtUpdate',
      buildUnassignedTobtsForICAO(fromIcao)
    );
  }
});

socket.on('updateDepFlowType', async ({ sector, flowtype, eventId: clientEventId }) => {
  const key = normalizeSectorKey(sector);
  const evtId = clientEventId || activeEventId || 0;
  const isActiveEvent = evtId === activeEventId;

  const ft = (flowtype || 'NONE').toString().toUpperCase();
  const normalized =
    ft === 'SLOTTED' || ft === 'BOOKING_ONLY' || ft === 'NONE'
      ? ft
      : 'NONE';

  if (isActiveEvent) sharedFlowTypes[key] = normalized;

  await prisma.depFlow.upsert({
    where: { eventId_sector: { eventId: evtId, sector: key } },
    update: { flowtype: normalized },
    create: {
      eventId: evtId,
      sector: key,
      rate: (isActiveEvent ? sharedDepFlows[key] : null) || 0,
      flowtype: normalized
    }
  });

  io.emit('depFlowTypeUpdated', { sector: key, flowtype: normalized, eventId: evtId });
});

socket.on('createBookingOnly', async ({ sector, callsign: enteredCid }) => {

  console.log('[BOOKING ONLY]', sector, enteredCid);

  if (!sector || !enteredCid) return;
  if (!user || !user.cid) return;

  // Verify CID matches logged-in user
  if (String(enteredCid).trim() !== String(user.cid)) {
    socket.emit('bookingError', { error: 'CID does not match your logged-in account.' });
    return;
  }

  const [leg, dateUtc, depTimeUtc] = sector.split('|');
  if (!leg || !dateUtc || !depTimeUtc) return;

  const [from, to] = leg.split('-');

  const row = adminSheetCache.find(
    r =>
      r.from === from &&
      r.to === to &&
      r.date_utc === dateUtc &&
      r.dep_time_utc === depTimeUtc
  );
  if (!row) return;

  const slotKey =
    `${from}-${to}|${row.date_utc}|${row.dep_time_utc}|BOOKING_ONLY`;

  // Prevent duplicates
  if (tobtBookingsByKey[slotKey]) return;

  await prisma.tobtBooking.create({
    data: {
      slotKey,
      cid: Number(user.cid),
      callsign: String(user.cid),
      from,
      to,
      dateUtc: row.date_utc,
      depTimeUtc: row.dep_time_utc,
      tobtTimeUtc: null
    }
  });

  tobtBookingsByKey[slotKey] = {
    slotKey,
    cid: Number(user.cid),
    callsign: String(user.cid),
    from,
    to,
    dateUtc: row.date_utc,
    depTimeUtc: row.dep_time_utc,
    tobtTimeUtc: null,
    createdAtISO: new Date().toISOString()
  };

  if (!tobtBookingsByCid[user.cid]) {
    tobtBookingsByCid[user.cid] = new Set();
  }
  tobtBookingsByCid[user.cid].add(slotKey);

  io.emit('bookingCreated', { slotKey });
});



  /* =========================================================
     CONNECTED USERS
     ========================================================= */

  socket.on('registerUser', ({ cid, name }) => {
    connectedUsers[socket.id] = { cid, name };
    io.emit('connectedUsersUpdate', Object.values(connectedUsers));
  });

  socket.on('disconnect', () => {
    delete connectedUsers[socket.id];
    io.emit('connectedUsersUpdate', Object.values(connectedUsers));
    console.log('Client disconnected:', socket.id);
  });
});




/* ===== ADMIN SHEET REFRESH ===== */
function parseSheetCsv(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());

  const idx = {
    number: headers.indexOf('Number'),
    from: headers.indexOf('From'),
    to: headers.indexOf('To'),
    date_utc: headers.indexOf('Date_UTC'),
    dep_time_utc: headers.indexOf('Dep_Time_UTC'),
    arr_time_utc: headers.indexOf('Arr_Time_UTC'),
    block_time: headers.indexOf('Block_Time'),
    atc_route: headers.indexOf('ATC_Route')
  };

  return lines.slice(1).map(line => {
    const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
    return {
      number: cols[idx.number] || '',
      from: cols[idx.from] || '',
      to: cols[idx.to] || '',
      date_utc: cols[idx.date_utc] || '',
      dep_time_utc: cols[idx.dep_time_utc] || '',
      arr_time_utc: cols[idx.arr_time_utc] || '',
      block_time: cols[idx.block_time] || '',
      atc_route: cols[idx.atc_route] || ''
    };
  });
}

async function refreshSheetForEvent(event) {
  // Scratch events don't have a sheet — just load from DB
  if (event.mode === 'scratch' || !event.sheetUrl) {
    return await loadScheduleFromDb(event.id);
  }

  try {
    const res = await axios.get(event.sheetUrl);
    const rows = parseSheetCsv(res.data);

    // Sync rows to DB
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.number) continue;
      await prisma.wfScheduleRow.upsert({
        where: { eventId_number: { eventId: event.id, number: r.number } },
        update: {
          sortOrder: i,
          from: r.from,
          to: r.to,
          dateUtc: r.date_utc,
          depTimeUtc: r.dep_time_utc,
          arrTimeUtc: r.arr_time_utc,
          blockTime: r.block_time,
          atcRoute: r.atc_route
        },
        create: {
          eventId: event.id,
          sortOrder: i,
          number: r.number,
          from: r.from,
          to: r.to,
          dateUtc: r.date_utc,
          depTimeUtc: r.dep_time_utc,
          arrTimeUtc: r.arr_time_utc,
          blockTime: r.block_time,
          atcRoute: r.atc_route
        }
      });
    }

    console.log(`✅ Sheet synced to DB for ${event.name}: ${rows.length} rows`);
  } catch (err) {
    console.error(`⚠️ Sheet fetch failed for ${event.name}: ${err.message} — loading from DB`);
  }

  // Always load from DB (includes any manual edits, or as fallback when sheet fetch fails)
  return await loadScheduleFromDb(event.id);
}

async function loadScheduleFromDb(eventId) {
  const dbRows = await prisma.wfScheduleRow.findMany({
    where: { eventId },
    orderBy: { sortOrder: 'asc' }
  });

  const rows = dbRows.map(r => ({
    number: r.number,
    from: r.from,
    to: r.to,
    date_utc: r.dateUtc,
    dep_time_utc: r.depTimeUtc,
    arr_time_utc: r.arrTimeUtc,
    block_time: r.blockTime,
    atc_route: r.atcRoute
  }));

  eventSheetCaches[eventId] = rows;
  if (eventId === activeEventId) {
    adminSheetCache = rows;
  }
  return rows;
}

async function loadWfEvents() {
  wfEvents = await prisma.wfEvent.findMany({ orderBy: { year: 'desc' } });
  const active = wfEvents.find(e => e.isActive);

  // If no events exist, create a default one from the hardcoded URL
  if (wfEvents.length === 0) {
    const defaultEvent = await prisma.wfEvent.create({
      data: {
        name: 'WorldFlight 2025',
        year: 2025,
        sheetUrl: DEFAULT_SHEET_URL,
        isActive: true
      }
    });
    wfEvents = [defaultEvent];
    activeEventId = defaultEvent.id;
  } else {
    activeEventId = active?.id || wfEvents[0].id;
  }
}

async function refreshAdminSheet() {
  await loadWfEvents();

  // Refresh all event sheets
  for (const event of wfEvents) {
    await refreshSheetForEvent(event);
  }

  // Set adminSheetCache to the active event for backward compatibility
  adminSheetCache = eventSheetCaches[activeEventId] || [];
  console.log(`✅ Active schedule: ${wfEvents.find(e => e.id === activeEventId)?.name || 'none'} (${adminSheetCache.length} rows)`);
}

cron.schedule('0 0 * * *', refreshAdminSheet);





// HOME: logged in → dashboard, logged out → login page


app.get('/dashboard', requirePageEnabled('schedule'), (req, res) => {
  return res.redirect(301, '/schedule');
});



/* ===== ADMIN AUTH ===== */
function requireAdmin(req, res, next) {
  const cid = req.session?.user?.data?.cid;
  if (!cid || !ADMIN_CIDS.includes(Number(cid))) {
    return res.status(403).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Access Denied</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body class="login-page no-layout">
  <div class="login-overlay"></div>
  <div class="login-container">
    <img src="/logo.png" alt="WorldFlight" class="login-logo" />
    <h1>Access Denied</h1>
    <h2>Administrators Only</h2>
    <p class="login-subtitle">You do not have permission to view this page.</p>
    <a href="/" class="login-btn">Back to Homepage</a>
  </div>
</body>
</html>`);
  }
  next();
}

function findFirstRouteMismatch(filedRoute, wfRoute) {
  const filed = normalizeRoute(filedRoute, wfRoute);
  const wf = normalizeRoute(wfRoute);

  const len = Math.min(filed.length, wf.length);

  for (let i = 0; i < len; i++) {
    if (filed[i] !== wf[i]) {
      return filed[i]; // first mismatching token
    }
  }

  // If all common tokens match but length differs
  if (filed.length !== wf.length) {
    return filed[len];
  }

  return null;
}


function normalizeRoute(route, adminRoute = null) {
  if (!route) return [];

  let tokens = route
  .toUpperCase()
  .replace(/\/\d+[A-Z]?/g, '')      // remove runway suffixes (/27R)
  .replace(/\bN\d+F\d+\b/g, '')     // remove speed/level (N0456F350)
  .replace(/\bDCT\b/g, '')          // 🔑 REMOVE rogue DCTs
  .split(/\s+/)
  .filter(Boolean);


  // Remove trailing STAR(s) and destination ICAO
  while (
    tokens.length &&
    (
      /^[A-Z]{4}$/.test(tokens[tokens.length - 1]) || // destination ICAO
      /\d[A-Z]$/.test(tokens[tokens.length - 1])      // STAR like IMCO1A
    )
  ) {
    tokens.pop();
  }

  // If adminRoute provided, align from first matching fix
  if (adminRoute) {
    const adminTokens = adminRoute
      .toUpperCase()
      .split(/\s+/)
      .filter(Boolean);

    const firstFix = adminTokens[0];
    const idx = tokens.indexOf(firstFix);

    if (idx !== -1) {
      tokens = tokens.slice(idx);
    }
  }

  return tokens;
}

function decorateRouteForDisplay(route, mismatchToken = null, options = {}) {
  const { muteProcedural = true } = options;

  const LATLON_REGEX = /^\d{2,4}[NS]\d{3,5}[EW]$/;


  if (!route) return '';

  const tokens = route
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);

  return tokens
    .map(t => {
      // 🔴 mismatch always wins
      if (mismatchToken && t === mismatchToken) {
        return `<span class="route-error">${t}</span>`;
      }

      if (muteProcedural && /\/\d+[A-Z]?$/.test(t)) {
        return `<span class="route-muted">${t}</span>`;
      }

      if (muteProcedural && /\d[A-Z]$/.test(t) && !LATLON_REGEX.test(t)) {
  return `<span class="route-muted">${t}</span>`;
}


      if (muteProcedural && /^[A-Z]{4}$/.test(t) && !LATLON_REGEX.test(t)) {
  return `<span class="route-muted">${t}</span>`;
}


      if (muteProcedural && t === 'DCT') {
        return `<span class="route-muted">DCT</span>`;
      }

      return t;
    })
    .join(' ');
}






/* ===== WF STATUS ===== */
function getWorldFlightStatus(pilot) {
  if (!pilot.flight_plan) return { isWF: false, routeMatch: false };

  const from = pilot.flight_plan.departure;
  const to = pilot.flight_plan.arrival;
  const route = pilot.flight_plan.route || '';

  const match = adminSheetCache.find(
    wf => wf.from === from && wf.to === to
  );
  if (!match) return { isWF: false, routeMatch: false };

  const adminTokens = normalizeRoute(match.atc_route);
  const liveTokens = normalizeRoute(route, match.atc_route);

  return {
    isWF: true,
    routeMatch:
      adminTokens.join(' ') === liveTokens.join(' '),
    routeMismatch:
      adminTokens.join(' ') !== liveTokens.join(' ')
  };
}

function resolveWfStatusForPilot(pilot) {
  if (!pilot?.flight_plan) {
    return { status: 'NON-EVENT' };
  }

  const wf = getWorldFlightStatus(pilot);

  if (!wf.isWF) {
    return { status: 'NON-EVENT' };
  }

  const dep = pilot.flight_plan.departure;
  const dest = pilot.flight_plan.arrival;

  const adminLeg = adminSheetCache.find(
    r => r.from === dep && r.to === dest
  );

  // No WF leg = WF but not booked
  if (!adminLeg?.atc_route) {
    return { status: 'WF – NOT BOOKED' };
  }

  // ✅ USE EXISTING ROUTE MISMATCH FLAG
  if (wf.routeMismatch === true) {
    return {
      status: 'WF – ROUTE',
      filedRoute: pilot.flight_plan.route || '',
      wfRoute: adminLeg.atc_route || ''
    };
  }

  const booking = getTobtBookingForCallsign(
    pilot.callsign,
    dep
  );

  return {
    status: booking ? 'WF – BOOKED' : 'WF – NOT BOOKED'
  };
}

function formatCruiseLevel(alt) {
  if (!alt) return '—';

  const n = Number(alt);
  if (!Number.isFinite(n)) return '—';

  // Convert feet to flight level
  return 'FL' + Math.round(n / 100);
}

function extractRegistration(pilot) {
  const fp = pilot?.flight_plan;
  if (!fp) return '—';

  const remarks = (fp.remarks || '').toUpperCase();

  // Match: REG/G-BNLL  REG G-BNLL  REG:G-BNLL  REG=G-BNLL
  // Allow hyphenated registrations and digits.
  const m = remarks.match(/\bREG\s*[\/:= ]\s*([A-Z0-9]+(?:-[A-Z0-9]+)?)\b/);

  return m ? m[1] : '—';
}

function parseAircraftTypeAndWake(acft) {
  if (!acft || typeof acft !== 'string') return { type: '—', wake: '—' };

  // Take left side before dash: "A20N/M"
  const left = acft.split('-')[0] || '';
  const parts = left.split('/');

  const type = (parts[0] || '—').toUpperCase();
  const wake = (parts[1] || '—').toUpperCase();

  return { type, wake };
}



app.get('/api/atc/flight/:callsign', (req, res) => {
  const callsign = req.params.callsign.toUpperCase();

  const pilot = cachedPilots.find(p => p.callsign === callsign);

  if (!pilot || !pilot.flight_plan) {
    return res.status(404).json({ error: 'Flight not found' });
  }

  const dep = pilot.flight_plan.departure || '—';
  const dest = pilot.flight_plan.arrival || '—';

  // Admin ATC route (authoritative)
  const adminLeg = adminSheetCache.find(
    r => r.from === dep && r.to === dest
  );

  const route =
    adminLeg?.atc_route ||
    pilot.flight_plan.route ||
    '—';

  const booking = getTobtBookingForCallsign(callsign, dep);

  const wfResult = resolveWfStatusForPilot(pilot);
  let mismatchToken = null;

if (wfResult.status === 'WF – ROUTE') {
  mismatchToken = findFirstRouteMismatch(
    wfResult.filedRoute,
    wfResult.wfRoute
  );
}

  const acft = parseAircraftTypeAndWake(pilot.flight_plan.aircraft);

res.json({
  callsign,
  wfStatus: wfResult.status,
  routeMismatch: wfResult.status === 'WF – ROUTE',
filedRoute: wfResult.filedRoute || '',
wfRoute: wfResult.wfRoute || '',


  dep,
  dest,

  flightRules: pilot.flight_plan.flight_rules || '—',
  registration: extractRegistration(pilot),

  aircraftType: acft.type,
  wake: acft.wake,

  cruiseLevel: formatCruiseLevel(pilot.flight_plan.altitude),

 filedTas: pilot.flight_plan.true_airspeed || null,


  pilotName: pilot.name
  ? pilot.name.toUpperCase()
  : '—',

  pilotCid: pilot.cid || '—',

  tobt: booking?.tobtTimeUtc || '—',
  tsat: sharedTSAT[callsign]?.tsat || '—',
filedTas: pilot.flight_plan.true_airspeed || null,
  route: pilot.flight_plan.route || '—',

  filedRoute: wfResult?.filedRoute
  ? decorateRouteForDisplay(
      wfResult.filedRoute,
      mismatchToken,
      { muteProcedural: true }   // FILED: context muted
    )
  : '',

wfRoute: wfResult?.wfRoute
  ? decorateRouteForDisplay(
      wfResult.wfRoute,
      null,
      { muteProcedural: false }  // WF: everything is relevant
    )
  : '',



});



});


app.get('/api/icao/:icao/scenery-links', async (req, res) => {
  const icao = req.params.icao.toUpperCase();

  // Optional: WF-only guard (keep if you want)
  

  const rows = await prisma.airportScenery.findMany({
    where: {
      icao,
      approved: true
    },
    orderBy: [
      { sim: 'asc' },
      { name: 'asc' }
    ]
  });

  // Group by simulator for existing frontend
  const result = {
    msfs: [],
    xplane: [],
    p3d: []
  };

  for (const r of rows) {
    if (r.sim === 'MSFS') result.msfs.push(r);
    if (r.sim === 'XPLANE') result.xplane.push(r);
    if (r.sim === 'P3D') result.p3d.push(r);
  }

  res.json(result);
});


app.post('/admin/scenery/refresh-links', requireAdmin, (req, res) => {
  const result = refreshSceneryLinksFile();
  res.json({ success: true, ...result });
});


app.get('/api/icao/:icao/map', async (req, res) => {
  const icao = req.params.icao.toUpperCase();

  const airport = await prisma.airport.findUnique({
  where: { icao },
  include: { runways: true }
});


  if (!airport) {
    return res.status(404).json({ error: 'Airport not found' });
  }

  function distanceNm(lat1, lon1, lat2, lon2) {
  const R = 3440;
  const toRad = d => d * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

const aircraft = cachedPilots
  // must have a flight plan
  .filter(p => p.flight_plan)

  // ✅ departures only
  .filter(p => p.flight_plan.departure === icao)

  // must have position
  .filter(p => p.latitude && p.longitude)
.filter(p => {
  const d = distanceNm(
    airport.lat,
    airport.lon,
    p.latitude,
    p.longitude
  );

  const altMSL = Number(p.altitude ?? 0);
  const airportElev = Number(airport.elev ?? 0);
  const altAGL = altMSL - airportElev;

  return (
    d <= 8 &&                 // spatial clamp
    altAGL >= -50 &&          // allow slight negatives
    altAGL <= 200             // surface / flare / rollout
  );
})


  .map(p => ({
    callsign: p.callsign,
    lat: p.latitude,
    lon: p.longitude,
    heading: p.heading,
    groundspeed: p.groundspeed,
    altitude: p.altitude
  }));





  res.json({ airport, aircraft });
});



app.use(express.static('public', { index: false }));
function parseUtcDateTime(dateUtc, timeUtc) {
  let year = new Date().getUTCFullYear();

  // Handle ISO format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) {
    const [y, m, d] = dateUtc.split('-').map(Number);
    const [hh, mm] = timeUtc.split(':').map(Number);
    return new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  }

  // Handle "Sat 1st Nov", "Mon 22nd Jan", etc.
  // 1️⃣ Remove weekday
  let cleaned = dateUtc.replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+/i, '');

  // 2️⃣ Remove ordinal suffixes (st, nd, rd, th)
  cleaned = cleaned.replace(/(\d+)(st|nd|rd|th)/i, '$1');

  // cleaned now looks like "1 Nov"
  const parsed = Date.parse(`${cleaned} ${year} UTC`);
  if (isNaN(parsed)) {
    throw new Error('Invalid date format: ' + dateUtc);
  }

  const date = new Date(parsed);

  const [hh, mm] = timeUtc.split(':').map(Number);
  date.setUTCHours(hh, mm, 0, 0);

  return date;
}

function hhmmToNextUtcDate(hhmm, nowUtc = new Date()) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;

  const [hh, mm] = hhmm.split(':').map(Number);

  const d = new Date(nowUtc);
  d.setUTCSeconds(0, 0);
  d.setUTCHours(hh, mm, 0, 0);

  // If the time is not in the future, treat it as next day
  if (d <= nowUtc) {
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return d;
}

function buildTimeWindow(hhmm) {
  if (!hhmm) return '';
  return `${subtractMinutes(hhmm, 60)}–${addMinutes(hhmm, 60)}`;
}

function addMinutes(timeStr, minutes) {
  const [hh, mm] = timeStr.split(':').map(Number);
  const d = new Date(Date.UTC(2000, 0, 1, hh, mm));
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().substring(11, 16);
}


function hhmmToOperationalUtcDate(hhmm, nowUtc = new Date()) {
  if (!hhmm || !/^\d{2}:\d{2}$/.test(hhmm)) return null;

  const [hh, mm] = hhmm.split(':').map(Number);

  const d = new Date(nowUtc);
  d.setUTCSeconds(0, 0);
  d.setUTCHours(hh, mm, 0, 0);

  const diffMs = nowUtc - d;
  const diffHours = diffMs / (1000 * 60 * 60);

  // If TSAT is more than 4 hours in the past, assume next day
  if (diffHours > 4) {
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return d;
}


function formatUtcHHMM(date) {
  return date.toISOString().substring(11, 16);
}

function subtractMinutes(timeStr, minutes) {
  const [hh, mm] = timeStr.split(':').map(Number);
  const date = new Date(Date.UTC(2000, 0, 1, hh, mm));
  date.setUTCMinutes(date.getUTCMinutes() - minutes);
  return date.toISOString().substring(11, 16);
}


function generateTobtSlots({ from, to, dateUtc, depTimeUtc }) {
  const dep = parseUtcDateTime(dateUtc, depTimeUtc);

  // Inclusive window
  const windowStart = new Date(dep.getTime() - 60 * 60 * 1000);
  const windowEnd   = new Date(dep.getTime() + 60 * 60 * 1000);

  const flowKey = `${from}-${to}`;
  const flow = Number(sharedDepFlows[flowKey]);

if (!flow || flow <= 0) {
  return null; // Explicitly signal "no flow defined"
}

  const intervalMinutes = Math.max(1, Math.floor(60 / flow));

  const slots = [];

  // Use a fresh cursor and NEVER mutate windowStart
  let cursor = new Date(windowStart);

  while (cursor <= windowEnd) {
    slots.push(formatUtcHHMM(cursor));
    cursor = new Date(cursor.getTime() + intervalMinutes * 60000);
  }

  return slots;
}


function makeTobtSlotKey({ from, to, dateUtc, depTimeUtc, tobtTimeUtc }) {
  return `${from}-${to}|${dateUtc}|${depTimeUtc}|${tobtTimeUtc}`;
}
app.get('/', (req, res) => {
  const user = req.session?.user?.data || null;
  const cid = user ? Number(user.cid) : null;
  const isAdmin = cid ? ADMIN_CIDS.includes(cid) : false;

  const allPages = [
    { title: '2026 Schedule',      desc: 'View the full WorldFlight 2026 event schedule with departure flows and times.', icon: '🗓️', href: '/schedule',           public: true,  visKey: 'schedule' },
    { title: 'Route Map',          desc: 'Interactive map showing all WorldFlight routes and airports.',                   icon: '🗺️', href: '/wf/world-map',        public: false, visKey: 'world-map' },
    { title: 'Airport Portal',     desc: 'Look up airport information, charts, scenery, and documentation.',              icon: '🛫', href: '/airport-portal',      public: true },
    { title: 'Suggest Airport',    desc: 'Submit your airport suggestions for upcoming WorldFlight events.',              icon: '💡', href: '/suggest-airport',     public: true,  visKey: 'suggest-airport' },
    { title: 'Previous Destinations', desc: 'Explore every airport WorldFlight has visited over the years.',                icon: '📍', href: '/previous-destinations', public: true },
    { title: 'Airspace Management', desc: 'View FIR staffing requirements and timelines for the active schedule.',        icon: '🌐', href: '/airspace',             public: true, visKey: 'airspace' },
    { title: 'My Slots / Bookings',desc: 'Manage your booked departure and arrival slots.',                               icon: '✈️', href: '/my-slots',            public: false, visKey: 'my-slots' },
    { title: 'WF Slot Management', desc: 'Controller tools for managing WorldFlight ATC slots.',                          icon: '🎧', href: '/atc',                 public: false, visKey: 'atc' },
    { title: 'Admin Panel',        desc: 'Manage settings, page visibility, and site configuration.',                    icon: '🛠️', href: '/admin/control-panel', public: false, adminOnly: true },
  ];

  const pages = allPages.filter(p => {
    if (p.adminOnly) return isAdmin;
    return !p.visKey || isAdmin || isPageEnabled(p.visKey);
  });

  const cards = pages.map(p => {
    const needsLogin = !p.public && !user;
    const href = needsLogin ? '/auth/login' : p.href;
    const lockClass = needsLogin ? ' dash-card--locked' : '';

    return `
      <a href="${href}" class="dash-card${lockClass}">
        <div class="dash-card-icon">${p.icon}</div>
        <div class="dash-card-title">${p.title}</div>
        <div class="dash-card-desc">${p.desc}</div>
        ${needsLogin
          ? `<div class="dash-card-badge">Login →</div>`
          : ''}
      </a>`;
  }).join('');

  const content = `
    <section class="dash-wrapper">
      <section class="dash-grid">
        ${cards}
      </section>
    </section>

    <style>
      .dashboard.dashboard-home {
        display: block;
        max-width: none;
        padding: 0;
      }
      .dash-wrapper {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 32px 40px;
      }

      .header-brand {
        display: flex;
        align-items: center;
        gap: 12px;
        padding-left: 20px;
        position: absolute;
        left: 0;
        text-decoration: none;
        color: inherit;
      }
      .header-brand-logo {
        width: 40px;
        height: 40px;
        border-radius: 50%;
      }
      .header-brand-text {
        display: flex;
        flex-direction: column;
        line-height: 1.2;
      }
      .header-brand-name {
        font-size: 16px;
        font-weight: 700;
        color: var(--text, #e2e8f0);
      }
      .header-brand-sub {
        font-size: 11px;
        color: var(--muted, #94a3b8);
      }

      .dash-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 16px;
        max-width: 1400px;
        width: 100%;
      }

      .dash-card {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        text-align: center;
        gap: 12px;
        padding: 28px 24px;
        border-radius: 14px;
        border: 1px solid rgba(255,255,255,0.07);
        background: rgba(255,255,255,0.03);
        text-decoration: none;
        color: inherit;
        transition: background .15s, border-color .15s, transform .15s;
        cursor: pointer;
      }
      .dash-card:hover {
        background: rgba(255,255,255,0.06);
        border-color: var(--accent, #3b82f6);
        transform: translateY(-2px);
      }

      .dash-card--locked {
        opacity: 0.45;
      }
      .dash-card--locked:hover {
        opacity: 0.8;
        border-color: var(--accent, #3b82f6);
      }

      .dash-card-icon {
        font-size: 30px;
        width: 52px;
        height: 52px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 14px;
        background: rgba(255,255,255,0.05);
      }
      .dash-card-title {
        font-weight: 700;
        font-size: 16px;
        color: var(--text, #e2e8f0);
      }
      .dash-card-desc {
        font-size: 13px;
        color: var(--muted, #94a3b8);
        line-height: 1.5;
        max-width: 260px;
      }
      .dash-card-badge {
        font-size: 12px;
        font-weight: 600;
        color: var(--accent, #3b82f6);
        margin-top: 4px;
      }

      @media (max-width: 1000px) {
        .dash-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      @media (max-width: 900px) {
        .header-brand {
          display: none;
        }
        .dash-wrapper {
          padding: 16px;
        }
      }
      @media (max-width: 600px) {
        .dash-grid {
          grid-template-columns: 1fr;
        }
        .dash-card {
          aspect-ratio: auto;
          padding: 24px 20px;
        }
      }
    </style>`;

  return res.send(renderLayout({
    title: 'WorldFlight Planning',
    user,
    isAdmin,
    content,
    hideSidebar: true,
    layoutClass: 'dashboard-home'
  }));
});


// ===============================
// WF WORLD MAP ROUTE API
// ===============================

function parseLatLonFix(token) {
  // Supports: 52N020W, 5230N02000W, 52N020E, 52S020W
  // Returns { lat, lon } or null
  const t = token.toUpperCase().trim();

  // 52N020W
  let m = t.match(/^(\d{2})(N|S)(\d{3})(E|W)$/);
  if (m) {
    const lat = Number(m[1]) * (m[2] === 'S' ? -1 : 1);
    const lon = Number(m[3]) * (m[4] === 'W' ? -1 : 1);
    return { lat, lon };
  }

  // 5230N02000W (ddmm + dddmm)
  m = t.match(/^(\d{2})(\d{2})(N|S)(\d{3})(\d{2})(E|W)$/);
  if (m) {
    const latDeg = Number(m[1]);
    const latMin = Number(m[2]);
    const lonDeg = Number(m[4]);
    const lonMin = Number(m[5]);

    const lat = (latDeg + latMin / 60) * (m[3] === 'S' ? -1 : 1);
    const lon = (lonDeg + lonMin / 60) * (m[6] === 'W' ? -1 : 1);
    return { lat, lon };
  }

  return null;
}

function tokenizeRoute(atcRouteRaw) {
  if (!atcRouteRaw) return [];
  // Split on whitespace, remove common separators
  return atcRouteRaw
    .replace(/[\r\n]+/g, ' ')
    .replace(/[.,;]+/g, ' ')
    .split(/\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

async function resolveAtcRoutePoints({ fromIcao, toIcao, atcRoute }, prisma) {
  const points = [];

  // Always start with departure airport if present
  const fromAp = await prisma.airport.findUnique({ where: { icao: fromIcao } });
  if (fromAp?.lat && fromAp?.lon) points.push({ lat: fromAp.lat, lon: fromAp.lon, name: fromIcao });

  const tokens = tokenizeRoute(atcRoute);

  // Resolve intermediate points:
  // - lat/lon fixes (52N020W etc)
  // - any ICAO tokens that exist in prisma.airport (helps when route includes alternates or intermediate ICAOs)
  for (const tok of tokens) {
    const fix = parseLatLonFix(tok);
    if (fix) {
      points.push({ ...fix, name: tok });
      continue;
    }

    if (/^[A-Z]{4}$/.test(tok)) {
      const ap = await prisma.airport.findUnique({ where: { icao: tok } });
      if (ap?.lat && ap?.lon) points.push({ lat: ap.lat, lon: ap.lon, name: tok });
    }
  }

  // Always end with arrival airport if present
  const toAp = await prisma.airport.findUnique({ where: { icao: toIcao } });
  if (toAp?.lat && toAp?.lon) points.push({ lat: toAp.lat, lon: toAp.lon, name: toIcao });

  // De-dupe consecutive identical points
  const cleaned = [];
  for (const p of points) {
    const prev = cleaned[cleaned.length - 1];
    if (!prev || prev.lat !== p.lat || prev.lon !== p.lon) cleaned.push(p);
  }

  return cleaned;
}

// ===============================
// WF ROUTE HELPERS
// ===============================

function buildFullRouteChain(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Index legs by FROM
  const byFrom = new Map();
  const byTo = new Map();

  for (const r of rows) {
    if (!r?.from || !r?.to) continue;
    const from = String(r.from).toUpperCase();
    const to = String(r.to).toUpperCase();

    byFrom.set(from, r);
    byTo.set(to, r);
  }

  // Find starting leg (FROM that is never a TO)
  let start = null;
  for (const r of rows) {
    const from = String(r.from).toUpperCase();
    if (!byTo.has(from)) {
      start = r;
      break;
    }
  }

  // Fallback if perfectly circular
  if (!start) start = rows[0];

  // Walk the chain
  const chain = [];
  let current = start;

  while (current) {
    chain.push(current);
    const nextFrom = String(current.to).toUpperCase();
    current = byFrom.get(nextFrom) || null;
  }

  return chain;
}

function computeWindowDateIso(baseDateIso, timeUtc) {
  if (!baseDateIso || !timeUtc) return baseDateIso;

  const base = new Date(`${baseDateIso}T00:00:00Z`);
  const [hh] = timeUtc.split(':').map(Number);

  // If time is after midnight but schedule is previous evening
  if (hh < 6) {
    base.setUTCDate(base.getUTCDate() + 1);
  }

  return base.toISOString().slice(0, 10);
}

function normalizeDateToIso(dateUtc) {
  if (!dateUtc) return '';

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateUtc)) {
    return dateUtc;
  }

  // "Sat 2nd Nov"
  const cleaned = dateUtc
    .replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+/i, '')
    .replace(/(\d+)(st|nd|rd|th)/i, '$1');

  const year = new Date().getUTCFullYear();
  const d = new Date(`${cleaned} ${year} UTC`);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

async function buildWfWorldMapPayload({ a = '', b = '', c = '' } = {}) {
  a = String(a).trim().toUpperCase();
  b = String(b).trim().toUpperCase();
  c = String(c).trim().toUpperCase();



  let legs = [];

  /* --------------------------------------------------
     Explicit A → B → C override (URL-driven)
  -------------------------------------------------- */
  if (a && b && c) {
    const ab = adminSheetCache.find(r => r.from === a && r.to === b);
    const bc = adminSheetCache.find(r => r.from === b && r.to === c);
    if (ab) legs.push(ab);
    if (bc) legs.push(bc);
  }

  /* --------------------------------------------------
     Default: FULL WF schedule (ordered)
  -------------------------------------------------- */
  if (!legs.length) {
    legs = adminSheetCache
      .filter(r => r?.from && r?.to && r.number != null)
      .slice()
      .sort((x, y) => Number(x.number) - Number(y.number));
  }

  /* --------------------------------------------------
     Build WF path: [A, B, C, D...]
  -------------------------------------------------- */
  const wfPath = [];
  for (let i = 0; i < legs.length; i++) {
    if (i === 0) wfPath.push(legs[i].from);
    wfPath.push(legs[i].to);
  }

  /* --------------------------------------------------
     Airports (INBOUND / OUTBOUND SECTORS)
  -------------------------------------------------- */
  const airports = {};

  function ensureAirport(icao, ap) {
    airports[icao] ??= {
      icao,
      name: ap.name || icao,
      lat: ap.lat,
      lon: ap.lon,
      inbound: null,
      outbound: null
    };
  }

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const depIcao = leg.from;
    const arrIcao = leg.to;

    /* ---- Outbound sector (this leg) */
    const apDep = await prisma.airport.findUnique({ where: { icao: depIcao } });
    if (apDep) {
      ensureAirport(depIcao, apDep);

      airports[depIcao].outbound = {
  wf: leg.wf || leg.number || null,
  from: leg.from,
  to: leg.to,
  dateIso: normalizeDateToIso(leg.date_utc),
  depWindow: leg.dep_time_utc
    ? `${subtractMinutes(leg.dep_time_utc, 60)}–${addMinutes(leg.dep_time_utc, 60)}`
    : ''
};



    }

    /* ---- Inbound sector (this leg) */
    const apArr = await prisma.airport.findUnique({ where: { icao: arrIcao } });
    if (apArr) {
      ensureAirport(arrIcao, apArr);

      const arrDateIso = computeWindowDateIso(
  leg.date_iso,
  leg.arr_time_utc || leg.dep_time_utc
);

airports[arrIcao].inbound = {
  wf: leg.wf || leg.number || null,
  from: leg.from,
  to: leg.to,
  dateIso: computeArrivalDateUtc(
    normalizeDateToIso(leg.date_utc),
    leg.dep_time_utc,
    leg.block_time
  ),
  arrWindow: leg.arr_time_utc
    ? `${subtractMinutes(leg.arr_time_utc, 60)}–${addMinutes(leg.arr_time_utc, 60)}`
    : ''
};




    }
  }

  /* --------------------------------------------------
     ATC polylines (unchanged)
  -------------------------------------------------- */
  const atcPolylines = await Promise.all(
    legs.map((leg) =>
      limitAtc(async () => {
        const cacheKey = `${leg.from}-${leg.to}-${leg.atc_route || ''}`;
        const cached = cacheGet(cacheKey);
        if (cached) {
          return {
            from: leg.from,
            to: leg.to,
            atc_route: leg.atc_route || '',
            dep_time_utc: leg.dep_time_utc || '',
            points: await Promise.resolve(cached)
          };
        }

        const inflight = resolveAtcRoutePoints(
          { fromIcao: leg.from, toIcao: leg.to, atcRoute: leg.atc_route },
          prisma
        );

        ATC_CACHE.set(cacheKey, inflight);

        try {
          const points = await inflight;
          cacheSet(cacheKey, points);
          return {
            from: leg.from,
            to: leg.to,
            atc_route: leg.atc_route || '',
            dep_time_utc: leg.dep_time_utc || '',
            points
          };
        } catch (err) {
          ATC_CACHE.delete(cacheKey);
          throw err;
        }
      })
    )
  );

  /* --------------------------------------------------
     Booking links (optional legacy)
  -------------------------------------------------- */
  const bookingLinks = {};
  for (const leg of legs) {
    if (leg?.from && leg?.to && leg?.dep_time_utc) {
      bookingLinks[leg.from] =
        `/book?from=${encodeURIComponent(leg.from)}&to=${encodeURIComponent(leg.to)}&depTimeUtc=${encodeURIComponent(leg.dep_time_utc)}`;
    }
  }

  const last = wfPath[wfPath.length - 1];
  if (last && !bookingLinks[last]) bookingLinks[last] = '/book';

  /* --------------------------------------------------
     Response
  -------------------------------------------------- */
  return {
  airports,
  wfPath,
  atcPolylines,
  bookingLinks
};

}


const atcRouteCache = new Map();

// ===== WF WORLD MAP CACHE (SERVER-SIDE) =====
const wfWorldMapCache = new Map(); // key -> { builtAt, payload }
const wfWorldMapInFlight = new Map(); // key -> Promise<{ builtAt, payload }>

function wfWorldMapKey(params = {}) {
  const a = params.a || '';
  const b = params.b || '';
  const c = params.c || '';

  return `a=${a}&b=${b}&c=${c}`;
}



app.get('/api/wf/world-map/version', (req, res) => {
  const qs = new URLSearchParams({ a: req.query.a || '', b: req.query.b || '', c: req.query.c || '' }).toString();
  const key = wfWorldMapKey({
    a: (req.query.a || '').toString().trim().toUpperCase(),
    b: (req.query.b || '').toString().trim().toUpperCase(),
    c: (req.query.c || '').toString().trim().toUpperCase()
  });
  const cached = wfWorldMapCache.get(key);
  res.json({ builtAt: cached?.builtAt ?? null, eventId: activeEventId });
});

app.get('/api/wf/world-map', async (req, res) => {
  const a = (req.query.a || '').toString().trim().toUpperCase();
  const b = (req.query.b || '').toString().trim().toUpperCase();
  const c = (req.query.c || '').toString().trim().toUpperCase();

  const key = wfWorldMapKey({
  a: (req.query.a || '').toString().trim().toUpperCase(),
  b: (req.query.b || '').toString().trim().toUpperCase(),
  c: (req.query.c || '').toString().trim().toUpperCase()
});


  // 1) Serve from cache instantly
  const cached = wfWorldMapCache.get(key);
  if (cached) {
    return res.json({ builtAt: cached.builtAt, eventId: activeEventId, ...cached.payload });
  }

  // 2) De-dupe concurrent builds (first request builds, others await)
  let p = wfWorldMapInFlight.get(key);
  if (!p) {
    p = (async () => {
      const payload = await buildWfWorldMapPayload({ a, b, c });
      const builtAt = Date.now();
      const entry = { builtAt, payload };
      wfWorldMapCache.set(key, entry);
      return entry;
    })().finally(() => {
      wfWorldMapInFlight.delete(key);
    });

    wfWorldMapInFlight.set(key, p);
  }

  try {
    const built = await p;
    return res.json({ builtAt: built.builtAt, eventId: activeEventId, ...built.payload });
  } catch (err) {
    console.error('[WF MAP] Build failed', err);
    return res.status(500).json({ error: 'Failed to build world map' });
  }
});






app.get('/wf/world-map', requireLogin, requirePageEnabled('world-map'), (req, res) => {
  const user = req.session.user?.data || null;
  const isAdmin = ADMIN_CIDS.includes(Number(user?.cid));

  const content = `
    <div class="wf-map-page">
      <div id="wfWorldMap"></div>

      <!-- Optional overlay title -->

    </div>

    <script>
      window.WF_MAP_QUERY = {
        a: new URLSearchParams(location.search).get('a') || '',
        b: new URLSearchParams(location.search).get('b') || '',
        c: new URLSearchParams(location.search).get('c') || ''
      };
    </script>

    <script src="/wf-world-map.js"></script>
  `;

  res.send(renderLayout({
    title: 'WF World Map',
    user,
    isAdmin,
    content,
    layoutClass: 'dashboard-full map-layout' // important
  }));
});

app.get('/previous-destinations', (req, res) => {
  const user = req.session.user?.data || null;
  const isAdmin = ADMIN_CIDS.includes(Number(user?.cid));

  const content = `
    <div class="wf-map-page">
      <div id="prevDestMap"></div>
    </div>

    <script src="/previous-destinations.js"></script>
  `;

  res.send(renderLayout({
    title: 'Previous Destinations',
    user,
    isAdmin,
    content,
    layoutClass: 'dashboard-full map-layout'
  }));
});



// ===== DEV LOGIN (only when DEV_MODE=true) =====
if (process.env.DEV_MODE === 'true') {
  app.get('/dev-login', (req, res) => {
    req.session.user = {
      data: {
        cid: 1303570,
        personal: {
          name_first: 'Dev',
          name_last: 'Admin',
          name_full: 'Dev Admin'
        },
        vatsim: {
          rating: { id: 1, short: 'OBS', long: 'Observer' },
          pilotrating: { id: 0, short: 'NEW', long: 'Basic Member' },
          division: { id: 'GBR', name: 'United Kingdom' },
          region: { id: 'EMEA', name: 'Europe, Middle East and Africa' }
        },
        oauth: { token_valid: true }
      }
    };
    req.session.save(() => {
      res.redirect(req.query.next || '/');
    });
  });
  console.log('[DEV] Dev login available at /dev-login');
}

app.get('/auth/login', (req, res, next) => {
  // In dev mode, skip VATSIM and use dev login
  if (process.env.DEV_MODE === 'true') {
    return res.redirect('/dev-login');
  }

  if (!req.session.returnTo) {
    const referer = req.headers.referer || '';
    try {
      const url = new URL(referer);
      if (url.pathname && url.pathname !== '/' && url.pathname !== '/auth/login') {
        req.session.returnTo = url.pathname;
      }
    } catch (e) {}
  }
  next();
}, vatsimLogin);
app.get('/auth/callback', vatsimCallback);
app.get('/schedule', requirePageEnabled('schedule'), (req, res) => {
  const cid = Number(req.session?.user?.data?.cid);
  const isAdmin = ADMIN_CIDS.includes(cid);
  const isLoggedIn = !!cid;
  const myBookings = cid ? tobtBookingsByCid[cid] : null;
  const showBookSlot = isAdmin || isPageEnabled('book-slot');

  const content = `
  <section class="card card-full">
    <h2>WorldFlight Event Schedule</h2>

    <div class="table-scroll">
      <table class="departures-table">
        <thead>
          <tr>
            <th class="col-wf-sector">WF</th>
            <th class="col-from">Dep</th>
            <th class="col-to">Arr</th>
            <th class="col-date">Date</th>
            <th class="col-window">Dep Window</th>
            <th class="col-block">Block</th>
            <th class="col-route">ATC Route</th>
            ${showBookSlot ? '<th class="col-book">Book</th>' : ''}
            <th class="col-plan">Plan</th>
          </tr>
        </thead>

        <tbody>
          ${adminSheetCache.map(r => {
            // ✅ FLOW TYPE — must live INSIDE map
            const flowSectorKey = `${r.from}-${r.to}`;
            const sectorInstanceKey = `${r.from}-${r.to}|${r.date_utc}|${r.dep_time_utc}`;
            const flowtype = sharedFlowTypes[flowSectorKey] || 'NONE';
            const flowtypeLabel =
              flowtype === 'SLOTTED' ? 'Slotted' :
              flowtype === 'BOOKING_ONLY' ? 'Booking Only' :
              'None';

            return `
            <tr>
              <td class="col-wf-sector">${r.number}</td>

              <td class="col-from">
                <a href="/icao/${r.from}">${r.from}</a>
              </td>

              <td class="col-to">
                <a href="/icao/${r.to}">${r.to}</a>
              </td>

              <td class="col-date">${r.date_utc}</td>
              <td class="col-window">${buildTimeWindow(r.dep_time_utc)}</td>
              <td class="col-block">${r.block_time}</td>

              <td class="col-route">
                <div class="route-collapsible">
                  <span class="route-text collapsed">
                    ${escapeHtml(r.atc_route)}
                  </span>
                  <button type="button" class="route-toggle" aria-expanded="false">
                    Expand
                  </button>
                </div>
              </td>

              <!-- ✅ BOOK (combined booking type + action) -->
              ${showBookSlot ? (() => {
                const sk = r.from + '-' + r.to + '|' + r.date_utc + '|' + r.dep_time_utc;

                if (flowtype === 'NONE') {
                  return '<td class="col-book"><span class="flowtype-pill flowtype-none">No Restrictions</span></td>';
                }

                /* Already booked — show CID pill, hover to cancel */
                if (isLoggedIn && myBookings) {
                  const prefixWithCid = cid + ':' + sk + '|';
                  const prefixNoCid = sk + '|';
                  const mySlotKey = [...myBookings].find(k =>
                    (k.startsWith(prefixWithCid) || k.startsWith(prefixNoCid)) && tobtBookingsByKey[k]
                  );
                  if (mySlotKey) {
                    const booking = tobtBookingsByKey[mySlotKey];
                    const bookedCid = booking?.cid || 'Booked';
                    const tobt = booking?.tobtTimeUtc || '';
                    const pillLabel = tobt ? bookedCid + ' (' + tobt.slice(0, 5) + ')' : String(bookedCid);
                    const rawSlotKey = booking?.slotKey || mySlotKey;
                    return '<td class="col-book">'
                      + '<button class="book-pill book-pill-booked" data-slot-key="' + rawSlotKey + '">'
                      + '<span class="book-pill-label">' + escapeHtml(pillLabel) + '</span>'
                      + '<span class="book-pill-hover">Cancel Booking</span>'
                      + '</button></td>';
                  }
                }

                /* Bookable — hover pill */
                const pillClass = flowtype === 'BOOKING_ONLY' ? 'flowtype-booking_only' : 'flowtype-slotted';
                const label = flowtype === 'BOOKING_ONLY' ? 'Booking Required' : 'Time Slot Required';
                const hoverLabel = isLoggedIn ? 'Click to Book' : 'Login to Book';

                if (!isLoggedIn) {
                  return '<td class="col-book">'
                    + '<a class="book-pill ' + pillClass + '" href="/auth/login">'
                    + '<span class="book-pill-label">' + label + '</span>'
                    + '<span class="book-pill-hover">' + hoverLabel + '</span>'
                    + '</a></td>';
                }

                if (flowtype === 'BOOKING_ONLY') {
                  return '<td class="col-book">'
                    + '<button class="book-pill booking-only ' + pillClass + '" data-sector="' + sk + '">'
                    + '<span class="book-pill-label">' + label + '</span>'
                    + '<span class="book-pill-hover">' + hoverLabel + '</span>'
                    + '</button></td>';
                }

                return '<td class="col-book">'
                  + '<a class="book-pill ' + pillClass + '" href="/book?from=' + r.from + '&to=' + r.to + '&dateUtc=' + encodeURIComponent(r.date_utc) + '&depTimeUtc=' + r.dep_time_utc + '">'
                  + '<span class="book-pill-label">' + label + '</span>'
                  + '<span class="book-pill-hover">' + hoverLabel + '</span>'
                  + '</a></td>';
              })() : ''}


              <!-- ✅ SIMBRIEF PLAN -->
              <td class="col-plan">
  ${
    (() => {
      let url =
        `https://dispatch.simbrief.com/options/custom` +
        `?orig=${r.from}` +
        `&dest=${r.to}` +
        `&route=${encodeURIComponent(r.atc_route)}`;

      // 🔑 Optionally enrich with TOBT if user has one
      if (myBookings) {
        const sectorKey = `${r.from}-${r.to}|${r.date_utc}|${r.dep_time_utc}`;
        const mySlotKey = [...myBookings].find(k =>
          k.startsWith(sectorKey + '|')
        );

        if (mySlotKey) {
          const booking = tobtBookingsByKey[mySlotKey];

          if (booking?.tobtTimeUtc) {
            const [h, m] = booking.tobtTimeUtc.split(':').map(Number);
            const hh = String(h).padStart(2, '0');
            const mm = String(m).padStart(2, '0');

            url +=
              `&callsign=${encodeURIComponent(booking.callsign)}` +
              `&deph=${hh}` +
              `&depm=${mm}` +
              `&manualrmk=${encodeURIComponent(
                `WF TOBT [SLOT] ${hh}:${mm} UTC - Route validated from www.worldflight.center`
              )}`;
          }
        }
      }

      // Default remark (always present)
      url += `&manualrmk=${encodeURIComponent(
        'Route validated from www.worldflight.center'
      )}`;

      return `
        <a class="simbrief-btn" href="${url}" target="_blank" rel="noopener">
          <span class="simbrief-logo">SB</span>
          <span class="simbrief-text">Plan with SimBrief</span>
        </a>
      `;
    })()
  }
</td>
            </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
    </section>

<script>
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.booking-only');
  if (!btn) return;

  const sector = btn.dataset.sector;
  if (!sector) return;

  openCidModal(function(enteredCid) {
    socket.emit('createBookingOnly', {
      sector,
      callsign: enteredCid
    });
  });
});

function openCidModal(onSubmit) {
  const modal = document.getElementById('callsignModal');
  const input = document.getElementById('callsignModalInput');
  const confirmBtn = document.getElementById('callsignConfirm');
  const cancelBtn = document.getElementById('callsignCancel');
  const errorEl = document.getElementById('modalError');

  modal.classList.remove('hidden');
  input.value = '';
  input.focus();
  errorEl.classList.add('hidden');
  errorEl.textContent = '';

  // Store reference so socket errors can reach it
  window._cidModalErrorEl = errorEl;
  window._cidModalOpen = true;

  function cleanup() {
    confirmBtn.removeEventListener('click', onConfirm);
    cancelBtn.removeEventListener('click', onCancel);
    input.removeEventListener('keydown', onKey);
    window._cidModalOpen = false;
    window._cidModalErrorEl = null;
  }

  function closeModal() {
    modal.classList.add('hidden');
    errorEl.classList.add('hidden');
    cleanup();
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    input.focus();
  }

  function onConfirm() {
    const value = input.value.trim();
    if (!value) return;
    if (!/^[0-9]+$/.test(value)) {
      showError('Please enter a valid numeric CID.');
      return;
    }
    // Don't close — wait for server response
    onSubmit(value);
  }

  function onCancel() { closeModal(); }

  function onKey(e) {
    if (e.key === 'Enter') onConfirm();
    if (e.key === 'Escape') onCancel();
  }

  confirmBtn.addEventListener('click', onConfirm);
  cancelBtn.addEventListener('click', onCancel);
  input.addEventListener('keydown', onKey);
}

</script>
<script>
let bookingOnlySector = null;
const socket = io();
socket.on('bookingError', ({ error }) => {
  if (window._cidModalOpen && window._cidModalErrorEl) {
    window._cidModalErrorEl.textContent = error;
    window._cidModalErrorEl.classList.remove('hidden');
  } else {
    alert(error);
  }
});
socket.on('bookingCreated', () => { location.reload(); });

function showCallsignModal(sector) {
  bookingOnlySector = sector;

  const modal = document.getElementById('callsignModal');
  if (!modal) return;

  modal.classList.add('open');

  const input = modal.querySelector('#callsignInput');
  input.value = '';
  input.focus();
}

document.addEventListener('DOMContentLoaded', () => {
  const confirmBtn = document.getElementById('callsignConfirm');
  const cancelBtn  = document.getElementById('callsignCancel');
  const input      = document.getElementById('callsignInput');

  if (!confirmBtn || !input) return;

  confirmBtn.addEventListener('click', () => {
    const callsign = input.value.trim().toUpperCase();
    if (!callsign || !bookingOnlySector) return;

    console.log('[CLIENT] booking-only submit', bookingOnlySector, callsign);

    socket.emit('createBookingOnly', {
      sector: bookingOnlySector,
      callsign
    });

    document.getElementById('callsignModal').classList.remove('open');
    bookingOnlySector = null;
  });

  cancelBtn?.addEventListener('click', () => {
    bookingOnlySector = null;
    document.getElementById('callsignModal').classList.remove('open');
  });
});
</script>




  
  <script>

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.route-toggle');
  if (!btn) return;

  const wrapper = btn.closest('.route-collapsible');
  const text = wrapper.querySelector('.route-text');

  const expanded = btn.getAttribute('aria-expanded') === 'true';

  btn.setAttribute('aria-expanded', String(!expanded));
  btn.textContent = expanded ? 'Expand' : 'Collapse';

  text.classList.toggle('collapsed', expanded);
});

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.route-collapsible').forEach(wrapper => {
    const text = wrapper.querySelector('.route-text');
    const btn = wrapper.querySelector('.route-toggle');
    if (!text || !btn) return;
    // Hide button first so it doesn't affect text width, then check overflow
    btn.style.display = 'none';
    if (text.scrollWidth > text.clientWidth) {
      btn.style.display = '';
    }
  });
});
</script>
<script>
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.tobt-btn.cancel, .book-pill-booked');
  if (!btn) return;

  const slotKey = btn.dataset.slotKey;
  if (!slotKey) return;

  const ok = await openConfirmModal({
    title: 'Cancel TOBT Slot',
    message: 'Are you sure you want to cancel this booking?'
  });

  if (!ok) return;

  const res = await fetch('/api/tobt/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ slotKey })
  });

  if (!res.ok) {
    alert('Failed to cancel booking');
    return;
  }

  location.reload();
});

</script>

<script>
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.flowtype-select').forEach(sel => {
    sel.dataset.flowtype = sel.value;
    sel.addEventListener('change', () => {
      sel.dataset.flowtype = sel.value;
    });
  });
});
</script>

  `;

  res.send(renderLayout({
    title: 'WorldFlight Schedule',
    user: req.session.user?.data || null,
    isAdmin,
    content,
    layoutClass: 'dashboard-full schedule-page'
  }));
});


app.get('/api/icao/:icao/departures', (req, res) => {
  const icao = req.params.icao.toUpperCase();
  const list = buildUpcomingTSATsForICAO(icao, cachedPilots);
  res.json(list);
});

app.post('/admin/api/scenery/:id/approve', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  await prisma.airportScenery.update({
    where: { id },
    data: {
      approved: true,
      approvedBy: req.session.user.data.name || 'Admin',
      approvedAt: new Date()
    }
  });

  res.json({ success: true });
});

app.post('/admin/api/scenery/:id/reject', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  await prisma.airportScenery.delete({
    where: { id }
  });

  res.json({ success: true });
});

app.get('/admin/documentation-access', requireAdmin, (req, res) => {
  const content = `
<section class="card card-narrow">
  <h2>Manage User Access</h2>

  <form id="docAccessSearch">
    <label>
      VATSIM CID
      <input id="docAccessCid" required>
    </label>

    <button class="action-btn">Load Permissions</button>
  </form>
</section>

<section class="card hidden" id="docAccessPanel">
  <h3>Permissions for CID <span id="currentCid"></span></h3>

  <table class="admin-table">
    <thead>
      <tr>
        <th>Pattern</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="docAccessTable"></tbody>
  </table>

  <form id="addDocAccess">
    <input id="newPattern" placeholder="EGLL or EG**" required>
    <button class="action-btn">Add Permission</button>
  </form>
</section>

<section class="card card-narrow doc-access-requests">
  <h2>Documentation Upload Access Requests</h2>

  <table class="admin-table">
    <thead>
      <tr>
        <th>CID</th>
        <th>Name</th>
        <th>Email</th>
        <th>Role</th>
        <th>Pattern</th>
        <th>Requested</th>
        <th>Status</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="docAccessRequestsTable">
      <tr><td colspan="8" class="empty">Loading...</td></tr>
    </tbody>
  </table>
</section>

<!-- APPROVAL MODAL -->
<div id="approvalModal" class="modal hidden">
  <div class="modal-backdrop"></div>
  <div class="modal-dialog" style="width:560px;">
    <h3 id="approvalModalTitle">Review Access Request</h3>

    <div class="approval-info">
      <div class="approval-info-row">
        <span class="approval-label">Name</span>
        <span id="approvalName">—</span>
      </div>
      <div class="approval-info-row">
        <span class="approval-label">Email</span>
        <span id="approvalEmail">—</span>
      </div>
      <div class="approval-info-row">
        <span class="approval-label">Role</span>
        <span id="approvalRole">—</span>
      </div>
      <div class="approval-info-row">
        <span class="approval-label">CID</span>
        <span id="approvalCid">—</span>
      </div>
      <div class="approval-info-row">
        <span class="approval-label">Requested</span>
        <span id="approvalPattern">—</span>
      </div>
    </div>

    <div style="margin-top:16px;">
      <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;">
        Permissions
        <span style="font-weight:400;color:var(--muted);"> — add or remove ICAO patterns (e.g. EGLL, EG**, K***)</span>
      </label>
      <div id="approvalPermissions" class="approval-perms"></div>
      <div class="approval-add-perm">
        <input type="text" id="approvalNewPerm" placeholder="e.g. EGLL or EG**" maxlength="4" style="flex:1;" />
        <button type="button" id="approvalAddPermBtn" class="action-btn" style="flex-shrink:0;">Add</button>
      </div>
    </div>

    <label style="display:block;margin-top:16px;font-size:13px;font-weight:600;">
      Message <span style="font-weight:400;color:var(--muted);"> — included in the email to the user</span>
    </label>
    <textarea id="approvalMessage" rows="3" placeholder="Optional message to include in the email..." style="width:100%;margin-top:4px;padding:8px;background:#0f172a;border:1px solid #1e293b;border-radius:6px;color:#e5e7eb;resize:vertical;font-family:inherit;font-size:13px;"></textarea>

    <div id="approvalModalMsg" class="modal-message hidden" style="margin-top:12px;"></div>

    <div class="modal-actions" style="margin-top:16px;gap:8px;flex-wrap:wrap;">
      <button type="button" id="approvalCancelBtn" class="modal-btn modal-btn-cancel">Cancel</button>
      <button type="button" id="approvalDenyBtn" class="modal-btn" style="background:var(--danger);color:#fff;">Deny & Send Email</button>
      <button type="button" id="approvalSaveBtn" class="modal-btn" style="background:var(--muted2);color:#fff;">Save Changes</button>
      <button type="button" id="approvalApproveBtn" class="modal-btn modal-btn-submit">Approve & Send Email</button>
    </div>
  </div>
</div>

<style>
  .approval-info { margin-top:12px; display:flex; flex-direction:column; gap:6px; }
  .approval-info-row { display:flex; gap:12px; font-size:13px; }
  .approval-label { color:var(--muted); min-width:80px; font-weight:600; }
  .approval-perms { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; min-height:32px; }
  .approval-perm-tag {
    display:inline-flex; align-items:center; gap:6px;
    background:#1e293b; color:#e5e7eb; padding:4px 10px;
    border-radius:6px; font-size:13px; font-family:monospace; font-weight:600;
  }
  .approval-perm-tag .remove-perm {
    cursor:pointer; color:var(--danger); font-size:15px; line-height:1;
  }
  .approval-perm-tag .remove-perm:hover { color:#f87171; }
  .approval-perm-tag.perm-new { border:1px dashed var(--accent); background:rgba(56,189,248,0.08); }
  .approval-add-perm { display:flex; gap:6px; }
  .approval-add-perm input {
    padding:6px 8px; background:#0f172a; border:1px solid #1e293b;
    border-radius:6px; color:#e5e7eb; text-transform:uppercase; font-family:monospace;
  }
</style>

<script>
document.addEventListener('DOMContentLoaded', function () {

  var searchForm = document.getElementById('docAccessSearch');
  var cidInput = document.getElementById('docAccessCid');
  var panel = document.getElementById('docAccessPanel');
  var table = document.getElementById('docAccessTable');
  var currentCidSpan = document.getElementById('currentCid');
  var addForm = document.getElementById('addDocAccess');
  var patternInput = document.getElementById('newPattern');
  var requestsTable = document.getElementById('docAccessRequestsTable');

  var currentCid = null;

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  /* ===============================
     EXISTING PERMISSION MANAGEMENT
     =============================== */

  searchForm.addEventListener('submit', function (e) {
    e.preventDefault();
    currentCid = cidInput.value.trim();

    if (!/^[0-9]+$/.test(currentCid)) {
      alert('Invalid CID');
      return;
    }

    fetch('/admin/api/documentation/' + currentCid)
      .then(r => r.json())
      .then(rows => {
        panel.classList.remove('hidden');
        currentCidSpan.textContent = currentCid;

        table.innerHTML = rows.length
          ? rows.map(function (r) {
              return (
                '<tr>' +
                  '<td>' + escapeHtml(r.pattern) + '</td>' +
                  '<td><button data-id="' + r.id + '" class="btn-reject">Remove</button></td>' +
                '</tr>'
              );
            }).join('')
          : '<tr><td colspan="2" class="empty">No permissions</td></tr>';
      });
  });

  addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!currentCid) return;

    var pattern = patternInput.value.trim().toUpperCase();

    fetch('/admin/api/documentation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid: currentCid, pattern })
    }).then(function () {
      searchForm.dispatchEvent(new Event('submit'));
    });
  });

  table.addEventListener('click', function (e) {
    var btn = e.target.closest('.btn-reject');
    if (!btn) return;

    fetch('/admin/api/documentation/' + btn.dataset.id, {
      method: 'DELETE'
    }).then(function () {
      searchForm.dispatchEvent(new Event('submit'));
    });
  });

  /* ===============================
     ACCESS REQUEST MANAGEMENT
     =============================== */

 function loadRequests() {
  fetch('/admin/api/documentation-access-requests')
    .then(r => r.json())
    .then(rows => {
      requestsTable.innerHTML = rows.length
        ? rows.map(function (r) {
            var requested = r.requestedAt
              ? new Date(r.requestedAt).toISOString().replace('T',' ').slice(0,19)
              : '';

            var statusLabel =
              r.status === 'DENIED'
                ? '<span class="badge badge-denied">Denied</span>'
                : '<span class="badge badge-pending">Pending</span>';

            // ✅ Decide actions FIRST
            var actionsHtml;
            if (r.status === 'DENIED') {
              actionsHtml =
                '<button class="action-btn btn-delete" data-id="' + r.id + '">Delete</button>';
            } else {
              actionsHtml =
                '<button class="action-btn btn-approve" data-id="' + r.id + '">Approve</button> ' +
                '<button class="action-btn btn-deny" data-id="' + r.id + '">Deny</button>';
            }

            var roleLabel = r.role === 'director' ? 'Director' : r.role === 'staff' ? 'Staff Member' : r.role || '—';

            // ✅ Then render row
            return (
              '<tr data-status="' + r.status + '">' +
                '<td>' + escapeHtml(r.cid) + '</td>' +
                '<td>' + escapeHtml(r.name || '—') + '</td>' +
                '<td>' + escapeHtml(r.email || '—') + '</td>' +
                '<td>' + escapeHtml(roleLabel) + '</td>' +
                '<td><strong>' + escapeHtml(r.pattern) + '</strong></td>' +
                '<td>' + requested + '</td>' +
                '<td>' + statusLabel + '</td>' +
                '<td>' + actionsHtml + '</td>' +
              '</tr>'
            );
          }).join('')
        : '<tr><td colspan="8" class="empty">No requests</td></tr>';
    })
    .catch(function () {
      requestsTable.innerHTML =
        '<tr><td colspan="8" class="empty">Failed to load requests</td></tr>';
    });
}



  /* ===============================
     APPROVAL MODAL LOGIC
     =============================== */

  var approvalModal = document.getElementById('approvalModal');
  var approvalPerms = document.getElementById('approvalPermissions');
  var approvalNewPerm = document.getElementById('approvalNewPerm');
  var approvalMsg = document.getElementById('approvalModalMsg');
  var currentRequestData = null;
  var permissionsList = []; // { pattern, isExisting, id? }

  function openApprovalModal(requestRow) {
    currentRequestData = requestRow;

    document.getElementById('approvalName').textContent = requestRow.name || '—';
    document.getElementById('approvalEmail').textContent = requestRow.email || '—';
    var roleLabel = requestRow.role === 'director' ? 'Director' : requestRow.role === 'staff' ? 'Staff Member' : requestRow.role || '—';
    document.getElementById('approvalRole').textContent = roleLabel;
    document.getElementById('approvalCid').textContent = requestRow.cid;
    document.getElementById('approvalPattern').textContent = requestRow.pattern;
    document.getElementById('approvalMessage').value = '';
    approvalMsg.classList.add('hidden');

    // Load existing permissions for this user
    permissionsList = [];
    fetch('/admin/api/documentation/' + requestRow.cid)
      .then(function(r) { return r.json(); })
      .then(function(rows) {
        rows.forEach(function(r) {
          permissionsList.push({ pattern: r.pattern, isExisting: true, id: r.id });
        });
        // Add the requested pattern if not already present
        if (!permissionsList.some(function(p) { return p.pattern === requestRow.pattern; })) {
          permissionsList.push({ pattern: requestRow.pattern, isExisting: false });
        }
        renderPermissions();
      });

    approvalModal.classList.remove('hidden');
  }

  function closeApprovalModal() {
    approvalModal.classList.add('hidden');
    currentRequestData = null;
  }

  function renderPermissions() {
    approvalPerms.innerHTML = permissionsList.map(function(p, i) {
      var cls = p.isExisting ? 'approval-perm-tag' : 'approval-perm-tag perm-new';
      return '<span class="' + cls + '">' +
        escapeHtml(p.pattern) +
        ' <span class="remove-perm" data-idx="' + i + '">&times;</span>' +
      '</span>';
    }).join('');
  }

  approvalPerms.addEventListener('click', function(e) {
    var rm = e.target.closest('.remove-perm');
    if (!rm) return;
    var idx = Number(rm.dataset.idx);
    permissionsList.splice(idx, 1);
    renderPermissions();
  });

  document.getElementById('approvalAddPermBtn').addEventListener('click', function() {
    var val = approvalNewPerm.value.trim().toUpperCase();
    if (!/^[A-Z*]{4}$/.test(val)) { alert('Enter a valid 4-character ICAO pattern (e.g. EGLL, EG**, K***)'); return; }
    if (permissionsList.some(function(p) { return p.pattern === val; })) { approvalNewPerm.value = ''; return; }
    permissionsList.push({ pattern: val, isExisting: false });
    renderPermissions();
    approvalNewPerm.value = '';
  });

  approvalNewPerm.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('approvalAddPermBtn').click(); }
  });

  document.getElementById('approvalCancelBtn').addEventListener('click', closeApprovalModal);
  approvalModal.querySelector('.modal-backdrop').addEventListener('click', closeApprovalModal);

  function showApprovalMsg(text, color) {
    approvalMsg.textContent = text;
    approvalMsg.style.color = color || 'var(--text)';
    approvalMsg.classList.remove('hidden');
  }

  function setApprovalButtonsDisabled(disabled) {
    ['approvalApproveBtn','approvalDenyBtn','approvalSaveBtn','approvalCancelBtn'].forEach(function(id) {
      document.getElementById(id).disabled = disabled;
    });
  }

  // APPROVE & SEND EMAIL
  document.getElementById('approvalApproveBtn').addEventListener('click', async function() {
    if (!currentRequestData) return;
    setApprovalButtonsDisabled(true);
    showApprovalMsg('Approving and sending email...', 'var(--accent)');

    try {
      var res = await fetch('/admin/api/documentation-access-requests/' + currentRequestData.id + '/approve-full', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          permissions: permissionsList.map(function(p) { return p.pattern; }),
          message: document.getElementById('approvalMessage').value.trim(),
          sendEmail: true
        })
      });
      if (!res.ok) throw new Error('Failed');
      showApprovalMsg('Approved and email sent!', 'var(--success)');
      setTimeout(function() { closeApprovalModal(); loadRequests(); }, 1500);
    } catch(err) {
      showApprovalMsg('Failed to approve. Please try again.', 'var(--danger)');
      setApprovalButtonsDisabled(false);
    }
  });

  // DENY
  document.getElementById('approvalDenyBtn').addEventListener('click', async function() {
    if (!currentRequestData) return;
    setApprovalButtonsDisabled(true);
    showApprovalMsg('Denying request...', 'var(--accent)');

    try {
      var res = await fetch('/admin/api/documentation-access-requests/' + currentRequestData.id + '/approve-full', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'deny',
          message: document.getElementById('approvalMessage').value.trim(),
          sendEmail: !!currentRequestData.email
        })
      });
      if (!res.ok) throw new Error('Failed');
      showApprovalMsg('Request denied.', 'var(--danger)');
      setTimeout(function() { closeApprovalModal(); loadRequests(); }, 1500);
    } catch(err) {
      showApprovalMsg('Failed to deny. Please try again.', 'var(--danger)');
      setApprovalButtonsDisabled(false);
    }
  });

  // SAVE CHANGES (permissions only, no email, no status change)
  document.getElementById('approvalSaveBtn').addEventListener('click', async function() {
    if (!currentRequestData) return;
    setApprovalButtonsDisabled(true);
    showApprovalMsg('Saving permissions...', 'var(--accent)');

    try {
      var res = await fetch('/admin/api/documentation-access-requests/' + currentRequestData.id + '/approve-full', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          permissions: permissionsList.map(function(p) { return p.pattern; })
        })
      });
      if (!res.ok) throw new Error('Failed');
      showApprovalMsg('Permissions saved.', 'var(--success)');
      setTimeout(function() { closeApprovalModal(); loadRequests(); }, 1500);
    } catch(err) {
      showApprovalMsg('Failed to save. Please try again.', 'var(--danger)');
      setApprovalButtonsDisabled(false);
    }
  });

  /* ===============================
     REQUEST TABLE CLICK HANDLERS
     =============================== */

  // Store loaded request data for modal use
  var loadedRequests = [];

  var _origLoadRequests = loadRequests;
  loadRequests = function() {
    fetch('/admin/api/documentation-access-requests')
      .then(function(r) { return r.json(); })
      .then(function(rows) {
        loadedRequests = rows;

        requestsTable.innerHTML = rows.length
          ? rows.map(function (r) {
              var requested = r.requestedAt
                ? new Date(r.requestedAt).toISOString().replace('T',' ').slice(0,19)
                : '';

              var statusLabel =
                r.status === 'DENIED'
                  ? '<span class="badge badge-denied">Denied</span>'
                  : '<span class="badge badge-pending">Pending</span>';

              var roleLabel = r.role === 'director' ? 'Director' : r.role === 'staff' ? 'Staff Member' : r.role || '\u2014';

              var actionsHtml;
              if (r.status === 'DENIED') {
                actionsHtml =
                  '<button class="action-btn btn-review" data-id="' + r.id + '">Review</button> ' +
                  '<button class="action-btn btn-delete" data-id="' + r.id + '">Delete</button>';
              } else {
                actionsHtml =
                  '<button class="action-btn btn-review" data-id="' + r.id + '">Review</button>';
              }

              return (
                '<tr data-status="' + r.status + '">' +
                  '<td>' + escapeHtml(r.cid) + '</td>' +
                  '<td>' + escapeHtml(r.name || '\u2014') + '</td>' +
                  '<td>' + escapeHtml(r.email || '\u2014') + '</td>' +
                  '<td>' + escapeHtml(roleLabel) + '</td>' +
                  '<td><strong>' + escapeHtml(r.pattern) + '</strong></td>' +
                  '<td>' + requested + '</td>' +
                  '<td>' + statusLabel + '</td>' +
                  '<td>' + actionsHtml + '</td>' +
                '</tr>'
              );
            }).join('')
          : '<tr><td colspan="8" class="empty">No requests</td></tr>';
      })
      .catch(function () {
        requestsTable.innerHTML =
          '<tr><td colspan="8" class="empty">Failed to load requests</td></tr>';
      });
  };

  requestsTable.addEventListener('click', function (e) {
    var reviewBtn = e.target.closest('.btn-review');
    var deleteBtn = e.target.closest('.btn-delete');

    if (reviewBtn) {
      var rid = Number(reviewBtn.dataset.id);
      var row = loadedRequests.find(function(r) { return r.id === rid; });
      if (row) openApprovalModal(row);
      return;
    }

    if (deleteBtn) {
      var did = deleteBtn.dataset.id;
      openConfirmModal({
        title: 'Delete Request',
        message: 'This will permanently remove the request. This cannot be undone.'
      }).then(function(ok) {
        if (!ok) return;
        fetch('/admin/api/documentation-access-requests/' + did, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' }
        })
        .then(function(r) { if (!r.ok) throw new Error('Failed'); return r.json(); })
        .then(function() { loadRequests(); })
        .catch(function(err) { alert(err.message || 'Failed'); });
      });
    }
  });

  // initial load
  loadRequests();

});
</script>
`;

  res.send(renderLayout({
    title: 'Documentation Access',
    user: req.session.user?.data,
    isAdmin: true,
    content,
    layoutClass: 'dashboard-full'
  }));
});

app.get(
  '/admin/api/documentation-access-requests/pending-count',
  requireAdmin,
  async (req, res) => {
    const count = await prisma.documentationAccessRequest.count({
      where: { status: 'PENDING' }
    });

    res.json({ count });
  }
);


app.get('/admin/api/documentation/:cid', requireAdmin, async (req, res) => {
  const cid = Number(req.params.cid);

  const rows = await prisma.documentationPermission.findMany({
    where: { cid }
  });

  res.json(rows);
});

app.delete(
  '/admin/api/documentation-access-requests/:id',
  requireAdmin,
  async (req, res) => {
    const id = Number(req.params.id);

    try {
      await prisma.documentationAccessRequest.delete({
        where: { id }
      });
    } catch (err) {
      if (err.code === 'P2025') {
        return res.json({ ok: true }); // already deleted
      }
      throw err;
    }

    res.json({ ok: true });
  }
);



app.post('/admin/api/documentation', requireAdmin, async (req, res) => {
  const { cid, pattern } = req.body;

  if (!cid || !pattern) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const normalized = pattern.toUpperCase().trim();

  // 1️⃣ Validate pattern format
  if (!/^[A-Z*]{4}$/.test(normalized)) {
    return res.status(400).json({ error: 'Invalid ICAO pattern' });
  }

  // 2️⃣ Restrict global wildcard ****
  if (
    normalized === '****' &&
    !ADMIN_CIDS.includes(Number(req.session.user.data.cid))
  ) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  // 3️⃣ Create permission
  await prisma.documentationPermission.create({
    data: {
      cid: Number(cid),
      pattern: normalized
    }
  });

  res.json({ success: true });
});


app.delete('/admin/api/documentation/:id', requireAdmin, async (req, res) => {
  await prisma.documentationPermission.delete({
    where: { id: Number(req.params.id) }
  });

  res.json({ success: true });
});

app.get('/admin/api/documentation-access-requests', requireAdmin, async (req, res) => {
  const rows = await prisma.documentationAccessRequest.findMany({
  where: {
    status: { in: ['PENDING', 'DENIED'] }
  },
  orderBy: { createdAt: 'asc' }
});

  res.json(rows);
});

app.post('/admin/api/documentation-access-requests/:id/approve', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const adminCid = Number(req.session.user?.data?.cid);

  const request = await prisma.documentationAccessRequest.findUnique({ where: { id } });
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (request.status !== 'PENDING') return res.status(400).json({ error: 'Not pending' });

  await prisma.$transaction(async (tx) => {
    // recommended de-dupe
    const exists = await tx.documentationPermission.findFirst({
      where: { cid: request.cid, pattern: request.pattern }
    });

    if (!exists) {
      await tx.documentationPermission.create({
        data: { cid: request.cid, pattern: request.pattern }
      });
    }

    await tx.documentationAccessRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        reviewedBy: adminCid,
        reviewedAt: new Date()
      }
    });
  });

  res.json({ success: true });
});

app.post('/admin/api/documentation-access-requests/:id/deny', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const adminCid = Number(req.session.user?.data?.cid);

  const request = await prisma.documentationAccessRequest.findUnique({ where: { id } });
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (request.status !== 'PENDING') return res.status(400).json({ error: 'Not pending' });

  await prisma.documentationAccessRequest.update({
  where: { id },
  data: {
    status: 'DENIED',
    reviewedBy: adminCid,
    reviewedAt: new Date()
  }
});


  res.json({ success: true });
});

/* ===== FULL APPROVAL ENDPOINT (approve/deny/save + email) ===== */
app.post('/admin/api/documentation-access-requests/:id/approve-full', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

  const adminCid = Number(req.session.user?.data?.cid);
  const adminName = req.session.user?.data?.personal?.name_full || 'WorldFlight Admin';
  const { action, permissions, message, sendEmail } = req.body;

  const request = await prisma.documentationAccessRequest.findUnique({ where: { id } });
  if (!request) return res.status(404).json({ error: 'Not found' });

  const isDeny = action === 'deny';
  const isSave = action === 'save';

  await prisma.$transaction(async (tx) => {
    // Update permissions if provided (for approve or save)
    if (Array.isArray(permissions) && !isDeny) {
      // Delete all existing permissions for this user
      await tx.documentationPermission.deleteMany({ where: { cid: request.cid } });
      // Re-create with the new set
      for (const pattern of permissions) {
        const normalized = pattern.toUpperCase().trim();
        if (/^[A-Z*]{4}$/.test(normalized)) {
          await tx.documentationPermission.create({
            data: { cid: request.cid, pattern: normalized }
          });
        }
      }
    }

    // Update request status (unless just saving)
    if (!isSave) {
      await tx.documentationAccessRequest.update({
        where: { id },
        data: {
          status: isDeny ? 'DENIED' : 'APPROVED',
          reviewedBy: adminCid,
          reviewedAt: new Date()
        }
      });
    }
  });

  // Send email if requested and user has an email
  if (sendEmail && request.email) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

      const permList = Array.isArray(permissions)
        ? permissions.map(p => p.toUpperCase()).join(', ')
        : request.pattern;

      const userName = request.name || 'there';

      // For denials, fetch existing permissions to remind user
      let existingPerms = [];
      if (isDeny) {
        const rows = await prisma.documentationPermission.findMany({ where: { cid: request.cid } });
        existingPerms = rows.map(r => r.pattern.toUpperCase());
      }

      const htmlEmail = buildAccessEmail({
        userName,
        isDeny,
        permissions: Array.isArray(permissions) ? permissions.map(p => p.toUpperCase()) : [request.pattern],
        deniedPattern: request.pattern,
        existingPerms,
        message: message || '',
        adminName
      });

      await transporter.sendMail({
        from: process.env.SMTP_FROM || '"WorldFlight" <noreply@worldflight.center>',
        to: request.email,
        subject: isDeny
          ? 'WorldFlight — Documentation Access Request Denied'
          : 'WorldFlight — Documentation Access Granted',
        html: htmlEmail
      });
    } catch (emailErr) {
      console.error('[EMAIL] Failed to send:', emailErr.message);
      // Don't fail the whole request over email
    }
  }

  res.json({ success: true });
});

function buildAccessEmail({ userName, isDeny, permissions, deniedPattern, existingPerms, message, adminName }) {
  function permTable(perms) {
    return `<table cellpadding="0" cellspacing="0" style="margin:20px auto;border-collapse:collapse;">
      ${perms.map(p => `
        <tr>
          <td style="padding:6px 24px;font-family:monospace;font-size:18px;font-weight:700;color:#38bdf8;background:#0f172a;border:1px solid #1e293b;border-radius:4px;text-align:center;letter-spacing:2px;">
            ${p}
          </td>
        </tr>
      `).join('')}
    </table>`;
  }

  const messageHtml = message
    ? `<div style="background:#0f172a;border-left:3px solid #38bdf8;padding:12px 16px;margin:20px 0;border-radius:0 6px 6px 0;color:#cbd5e1;font-size:14px;line-height:1.6;">
        ${message.replace(/\n/g, '<br>')}
       </div>`
    : '';

  let bodyText;
  if (isDeny) {
    bodyText = `<p style="color:#e5e7eb;font-size:15px;line-height:1.6;">
        Unfortunately, your request to upload documentation for <strong style="color:#f87171;">${deniedPattern || ''}</strong> has been denied.
       </p>`;

    if (messageHtml) {
      bodyText += messageHtml;
    }

    if (existingPerms && existingPerms.length > 0) {
      bodyText += `<p style="color:#e5e7eb;font-size:15px;line-height:1.6;margin-top:20px;">
        As a reminder, you still have permission to upload documentation for the following:
       </p>
       ${permTable(existingPerms)}`;
    }
  } else {
    bodyText = `<p style="color:#e5e7eb;font-size:15px;line-height:1.6;">
        You have been granted permission to upload documentation for the following:
       </p>
       ${permTable(permissions)}
       ${messageHtml}`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#020617;padding:40px 20px;">
    <tr>
      <td align="center">
        <table cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#0b1220;border:1px solid #1e293b;border-radius:16px;overflow:hidden;">

          <!-- HEADER -->
          <tr>
            <td style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:32px;text-align:center;">
              <img src="https://planning.worldflight.center/logo.png" width="64" height="64" style="border-radius:50%;" alt="WorldFlight" />
              <h1 style="color:#38bdf8;font-size:22px;margin:16px 0 0;">WorldFlight</h1>
              <p style="color:#94a3b8;font-size:13px;margin:4px 0 0;">Documentation Access</p>
            </td>
          </tr>

          <!-- BODY -->
          <tr>
            <td style="padding:32px;">
              <p style="color:#e5e7eb;font-size:15px;line-height:1.6;margin:0 0 16px;">
                Hello ${userName},
              </p>

              ${bodyText}

              ${!isDeny ? `<div style="text-align:center;margin:28px 0 8px;">
                <a href="https://planning.worldflight.center/icao/${permissions[0] && !/\\*/.test(permissions[0]) ? permissions[0] : ''}" style="display:inline-block;padding:12px 32px;background:#38bdf8;color:#020617;font-weight:600;font-size:14px;text-decoration:none;border-radius:8px;">
                  Open Airport Portal
                </a>
              </div>` : ''}

              <hr style="border:none;border-top:1px solid #1e293b;margin:24px 0;" />

              <p style="color:#94a3b8;font-size:13px;margin:0;">
                Kind Regards,
              </p>
              <p style="color:#e5e7eb;font-size:14px;font-weight:600;margin:4px 0 0;">
                WorldFlight Organizers
              </p>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background:#080d17;padding:16px 32px;text-align:center;">
              <p style="color:#475569;font-size:11px;margin:0;">
                This is an automated message from the WorldFlight Planning system.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}


app.get('/admin/scenery', requireAdmin, (req, res) => {
  const user = req.session.user?.data || null;

  const content = `
    <section class="card card-narrow">
  <h2>Pending Scenery Submissions</h2>

  <div class="table-wrap">
    <table class="admin-table admin-scenery-table">
        <thead>
          <tr>
            <th>ICAO</th>
            <th>Sim</th>
            <th>Product</th>
            <th>Developer</th>
            <th>Store</th>
            <th>Type</th>
            <th>Submitted by</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody id="sceneryAdminTable">
          <tr>
            <td colspan="8" class="empty">Loading...</td>
          </tr>
        </tbody>
      </table>
  </div>
</section>

    <script>
      async function loadPendingScenery() {
        const tbody = document.getElementById('sceneryAdminTable');

        const res = await fetch('/admin/api/scenery/pending');

if (!res.ok) {
  console.error('Failed to load pending scenery', res.status);
  tbody.innerHTML =
    '<tr><td colspan="8" class="empty">Failed to load submissions</td></tr>';
  return;
}

const rows = await res.json();


        if (!rows.length) {
          tbody.innerHTML =
            '<tr><td colspan="8" class="empty">No pending submissions</td></tr>';
          return;
        }

       tbody.innerHTML = rows.map(r =>
  '<tr>' +
    '<td>' + r.icao + '</td>' +
    '<td><span class="sim-badge">' + r.sim + '</span></td>' +
    '<td><a href="' + r.url + '" target="_blank" rel="noopener">' + r.name + '</a></td>' +
    '<td>' + (r.developer || '-') + '</td>' +
    '<td>' + (r.store || '-') + '</td>' +
    '<td>' + r.type + '</td>' +
    '<td>' + (r.submittedBy || '-') + '</td>' +
    '<td class="actions">' +
      '<div class="action-group">' +
        '<button class="btn-approve" onclick="approveScenery(' + r.id + ')">Approve</button>' +
        '<button class="btn-reject" onclick="rejectScenery(' + r.id + ')">Reject</button>' +
      '</div>' +
    '</td>' +
  '</tr>'
).join('');

      }

      async function approveScenery(id) {
        const ok = confirm('Approve this scenery submission?');
        if (!ok) return;
        await fetch('/admin/api/scenery/' + id + '/approve', { method: 'POST' });
        loadPendingScenery();
      }

      async function rejectScenery(id) {
        const ok = confirm('Reject this scenery submission?');
        if (!ok) return;
        await fetch('/admin/api/scenery/' + id + '/reject', { method: 'POST' });
        loadPendingScenery();
      }

      document.addEventListener('DOMContentLoaded', loadPendingScenery);
    </script>
  `;

  res.send(renderLayout({
    title: 'Scenery Submissions',
    user,
    isAdmin: true,
    content,
    layoutClass: 'dashboard-full'
  }));
});

function normalizeAtisText(lines) {
  return lines
    .join(' ')                 // flatten radio line breaks
    .replace(/\s*\.\s*/g, '. ') // normalize dot spacing
    .replace(/\s{2,}/g, ' ')    // collapse extra spaces
    .trim();
}
async function fetchFaaAtis(icao) {
  if (!isUsIcao(icao)) {
    return { available: false };
  }

  try {
    const r = await axios.get(
      'https://atis.info/api/' + icao,
      { timeout: 8000 }
    );

    const data = r.data;

    // 🔑 atis.info returns an ARRAY
    if (!Array.isArray(data) || !data.length) {
      return { available: false };
    }

    const atis = data[0];

    if (!atis.datis) {
      return { available: false };
    }

    return {
      available: true,
      source: 'faa',
      letter: atis.code || '',
      text: atis.datis,
      time: atis.time,
      updatedAt: atis.updatedAt
    };
  } catch (err) {
    console.warn('[FAA ATIS]', icao, err.message);
    return { available: false };
  }
}




app.get('/api/icao/:icao/atis-all', async (req, res) => {
  const icao = req.params.icao.toUpperCase();

  const vatsim = await fetchVatsimAtisForIcao(icao);
  const faa = await fetchFaaAtis(icao);

  res.json({
    vatsim,
    faa
  });
});

async function fetchVatsimAtisForIcao(icao) {
  try {
    const short = icao.startsWith('K') ? icao.slice(1) : null;

    const r = await axios.get(
      'https://data.vatsim.net/v3/vatsim-data.json'
    );

    const atisList = r.data.atis || [];

    return atisList
      .filter(a => {
        const cs = a.callsign?.toUpperCase();
        if (!cs || !cs.endsWith('_ATIS')) return false;

        return (
          cs.startsWith(icao + '_') ||
          (short && cs.startsWith(short + '_'))
        );
      })
      .map(a => {
        const cs = a.callsign.toUpperCase();

        let atisType = 'General';
        if (cs.includes('_D_ATIS')) atisType = 'Departure';
        else if (cs.includes('_A_ATIS')) atisType = 'Arrival';

        const lines = Array.isArray(a.text_atis)
          ? a.text_atis
          : String(a.text_atis || '').split('\n');

        return {
          source: 'vatsim',
          callsign: a.callsign,
          frequency: a.frequency,
          atisType,
          letter: extractAtisLetter(lines),
          text: normalizeAtisText(lines)
        };
      });
  } catch (err) {
    console.error('[VATSIM ATIS]', err.message);
    return [];
  }
}

app.get('/api/icao/:icao/atis', async (req, res) => {
  const icao = req.params.icao.toUpperCase();
  const short = icao.startsWith('K') ? icao.slice(1) : null;

  try {
    const r = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');
    const atisList = r.data.atis || [];

    const matches = atisList.filter(a => {
      const cs = a.callsign?.toUpperCase().trim();
      if (!cs) return false;
      if (!cs.endsWith('_ATIS')) return false;

      return (
        cs.startsWith(icao + '_') ||
        (short && cs.startsWith(short + '_'))
      );
    });

    if (!matches.length) {
      return res.json([]);
    }

    const result = matches.map(a => {
      const cs = a.callsign.toUpperCase();

      let atisType = 'general';
      if (cs.includes('_D_ATIS')) atisType = 'departure';
      else if (cs.includes('_A_ATIS')) atisType = 'arrival';

      const lines = Array.isArray(a.text_atis)
        ? a.text_atis
        : typeof a.text_atis === 'string'
          ? a.text_atis.split('\n')
          : [];

      return {
        callsign: a.callsign,
        frequency: a.frequency,
        atisType,                       // 🔑
        letter: extractAtisLetter(lines),
        text: normalizeAtisText(lines)
      };
    });

    res.json(result);

  } catch (err) {
    console.error('[ATIS]', err.message);
    res.json([]);
  }
});



app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.get('/admin/api/scenery/pending', requireAdmin, async (req, res) => {
  const rows = await prisma.airportScenery.findMany({
    where: { approved: false },
    orderBy: { submittedAt: 'asc' }
  });

  res.json(rows);
});

function getWorldFlightLegForAirport(icao) {
  const leg = adminSheetCache.find(r => r.from === icao);
  if (!leg) return null;

  return {
    from: leg.from,
    to: leg.to,
    dateUtc: leg.date_utc,
    depTimeUtc: leg.dep_time_utc,          // ✅ SOURCE OF TRUTH
    depWindow: buildTimeWindow(leg.dep_time_utc),
    blockTime: leg.block_time || '—'
  };
}





app.use('/uploads', express.static(path.join(__dirname, 'Uploads')));

app.get('/icao/:icao', async (req, res) => {
  const icao = req.params.icao.toUpperCase();
  const isWorldFlight = hasOutboundFlow(icao);
  const wfLeg = getWorldFlightLegForAirport(icao); // whatever function you already use

  
  const isLoggedIn = Boolean(req.session?.user?.data);

  const documents = await prisma.airportDocument.findMany({
    where: { icao },
    orderBy: { uploadedAt: 'desc' }
  });
  const content = `
  <div class="portal-header portal-width" id="slotBannerHeader">
  <div id="slotBanners" class="slot-banners"></div>
</div>


  <section class="card">

  <div class="icao-top-row two-cols">

    <!-- DEPARTURES TABLE (commented out)
    <div class="icao-deps">
  <div class="deps-scroll">
    <table class="departures-table departures-table--compact">
      <thead>
        <tr>
          <th class="col-sts">STS</th>
          <th>Callsign</th>
          <th>A/C</th>
          <th>Dest</th>
          <th>ATC Route</th>
        </tr>
      </thead>
      <tbody id="upcomingDepartures"></tbody>
    </table>
  </div>
</div>
    -->

    <!-- LEFT: Online Controllers -->
    <div class="controllers-card">
    <h3 class="controllers-heading">Online Controllers <span class="controllers-src">(VATSIM)</span></h3>
    <div class="controllers-scroll">
    <ul id="onlineControllers" class="atc-list">
  <li class="atc-empty">Loading ATC...</li>
</ul>
</div>
</div>


    <!-- RIGHT: Map -->
    <div class="icao-map">
  <div id="icaoMap" data-icao="${icao}"></div>

  <div class="map-overlay-controls">
    <button
      id="expandMapBtn"
      class="map-overlay-btn"
      title="Expand map"
      aria-label="Expand map"
    >
      ⤢
    </button>

    <button
      id="toggleMapThemeBtn"
      class="map-overlay-btn"
      title="Toggle map theme"
      aria-label="Toggle map theme"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" class="theme-icon">
  <!-- Sun -->
  <g class="sun">
    <circle cx="12" cy="12" r="4" />
    <line x1="12" y1="2"  x2="12" y2="5" />
    <line x1="12" y1="19" x2="12" y2="22" />
    <line x1="2"  y1="12" x2="5"  y2="12" />
    <line x1="19" y1="12" x2="22" y2="12" />
    <line x1="4.5" y1="4.5" x2="6.5" y2="6.5" />
    <line x1="17.5" y1="17.5" x2="19.5" y2="19.5" />
    <line x1="17.5" y1="6.5" x2="19.5" y2="4.5" />
    <line x1="4.5" y1="19.5" x2="6.5" y2="17.5" />
  </g>

  <!-- Moon -->
  <path
    class="moon"
    d="M21 12.79A9 9 0 1111.21 3
       7 7 0 0021 12.79z"
  />
</svg>



    </button>
  </div>
</div>


  </div>

</section>
<section class="card hidden" id="airportAtisCard">
  <div class="atis-container">
    <div class="atis-letter" id="atisLetter">?</div>


    <div class="atis-body">
      <div class="atis-header">
        <span class="atis-source" id="atisSource"></span>
      </div>

      <pre class="atis-text" id="atisText"></pre>
    </div>
  </div>
</section>

<section class="card">
  <h2>Airport Documentation</h2>

  <table class="docs-table">
    <thead>
      <tr>
        <th>File Name</th>
        <th>Type</th>
        <th class="hide-mobile">Last Updated</th>
        <th>Submitted By</th>
      </tr>
    </thead>
    <tbody id="airportDocs"></tbody>
  </table>
<button
  class="action-btn hidden"
  id="openUploadDoc"
  data-icao="${icao}"
>
  ➕ Upload Document
</button>
<script>
  window.IS_LOGGED_IN = ${req.session?.user?.data ? 'true' : 'false'};
  window.IS_WORLD_FLIGHT = ${isWorldFlight ? 'true' : 'false'};
  window.ICAO = "${icao}";
  window.WF_LEG = ${wfLeg ? JSON.stringify(wfLeg) : 'null'};
</script>
<script>
(function waitForIo() {
  if (typeof io === 'undefined') {
    setTimeout(waitForIo, 50);
    return;
  }

  // Create ICAO-scoped socket for this page
  window.socket = io({
    query: { icao: window.ICAO }
  });
})();
</script>

<button
  class="action-btn hidden"
  id="requestDocAccess"
  data-icao="${icao}"
>
  🔐 Request access to upload documents
</button>





</section>

<script>
  window.IS_LOGGED_IN = ${req.session?.user?.data ? 'true' : 'false'};
  window.VATSIM_USER = ${req.session?.user?.data ? JSON.stringify({
    cid: req.session.user.data.cid,
    nameFirst: req.session.user.data.personal?.name_first || '',
    nameLast: req.session.user.data.personal?.name_last || '',
    email: req.session.user.data.personal?.email || ''
  }) : 'null'};
</script>

<section class="card">
  <h2>Available Scenery</h2>
  <div id="availableScenery"></div>
  <button id="openSceneryModal" class="action-btn">
  ➕ Submit scenery for this airport
</button>
<div id="sceneryLoginHint" class="login-hint hidden">
  Log in to submit scenery for this airport
</div>
</section>

<div id="sceneryModal" class="modal hidden">
  <div class="modal-backdrop"></div>

  <div class="modal-dialog">
    <h3>Submit scenery for <span id="sceneryIcao"></span></h3>

    <form id="sceneryForm">
      <input type="hidden" name="icao" id="sceneryIcaoInput">

      <label>
        Simulator
        <select name="sim" required>
          <option value="">Select…</option>
          <option value="MSFS">MSFS</option>
          <option value="XPLANE">X-Plane</option>
          <option value="P3D">Prepar3D</option>
        </select>
      </label>

      <label>
        Product name
        <input name="name" required>
      </label>

      <label>
        Developer
        <input name="developer">
      </label>

      <label>
        Store
        <input name="store" placeholder="Orbx, SimMarket, flightsim.to">
      </label>

      <label>
        URL
        <input name="url" type="url" required>
      </label>

      <label>
        Type
        <select name="type" required>
          <option value="Freeware">Freeware</option>
          <option value="Payware">Payware</option>
        </select>
      </label>

      <div id="sceneryFormMessage" class="modal-message hidden"></div>

      <div class="modal-actions">
        <button
          type="button"
          class="modal-btn modal-btn-cancel"
          id="closeSceneryModal">
          Cancel
        </button>

        <button
          type="submit"
          class="modal-btn modal-btn-submit"
          id="submitSceneryBtn">
          Submit scenery
        </button>
        

      </div>
    </form>
  </div>
</div>


<script>
document.addEventListener('DOMContentLoaded', function () {
  var map = document.getElementById('icaoMap');
  if (!map) return;

  var icao = map.dataset.icao;
  if (!icao) return;

  /* ---------- INITIAL LOAD ---------- */
  loadDepartures(icao);
  loadControllers(icao);
  loadAtis(icao);
  loadAirportDocs(icao);

  /* ---------- REFRESH EVERY 60s ---------- */
  setInterval(function () {
    loadDepartures(icao);
    loadControllers(icao);
    loadAtis(icao);
  }, 60000);

  /* ---------- ROUTE EXPAND / COLLAPSE ---------- */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.route-toggle');
    if (!btn) return;

    var wrapper = btn.closest('.route-collapsible');
    var text = wrapper.querySelector('.route-text');

    var expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!expanded));
    btn.textContent = expanded ? 'Expand' : 'Collapse';
    text.classList.toggle('collapsed', expanded);
  });

  /* ---------- SCENERY MODAL ---------- */
  var openBtn  = document.getElementById('openSceneryModal');
  var modal    = document.getElementById('sceneryModal');
  var closeBtn = document.getElementById('closeSceneryModal');
  var form     = document.getElementById('sceneryForm');
  var submitBtn = document.getElementById('submitSceneryBtn');
  var msg       = document.getElementById('sceneryFormMessage');

 if (openBtn && modal && form) {
  openBtn.addEventListener('click', function () {
    if (!window.IS_LOGGED_IN) {
      window.location.href =
  '/auth/login?redirect=' + encodeURIComponent(window.location.pathname);

      return;
    }

    document.getElementById('sceneryIcao').textContent = icao;
    document.getElementById('sceneryIcaoInput').value = icao;
    modal.classList.remove('hidden');
  });

  function closeModal() {
    modal.classList.add('hidden');
    form.reset();
    msg.classList.add('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit scenery';
  }

  if (openBtn && !window.IS_LOGGED_IN) {
  openBtn.disabled = true;
  openBtn.classList.add('btn-disabled-login');
  openBtn.setAttribute(
    'title',
    'You must be logged in to submit scenery'
  );
}


  if (closeBtn) closeBtn.addEventListener('click', closeModal);

  var backdrop = modal.querySelector('.modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeModal);

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting';
    msg.classList.add('hidden');
    msg.textContent = '';

    fetch('/api/scenery/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        Object.fromEntries(new FormData(form).entries())
      )
    })
    .then(function (res) {
      if (!res.ok) throw new Error();
      msg.textContent = 'Scenery submitted for approval';
      msg.className = 'modal-message success';
      setTimeout(closeModal, 1500);
    })
    .catch(function () {
      msg.textContent = 'Failed to submit scenery. Please try again.';
      msg.className = 'modal-message error';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit scenery';
    });
  });
}

});

/* ================= FUNCTIONS ================= */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}






function loadAtis(icao) {
  fetch('/api/icao/' + icao + '/atis-all')
    .then(res => res.json())
    .then(data => {
      const container = document.getElementById('airportAtisCard');
      if (!container) return;

      container.innerHTML = '';

      const vatsimList = Array.isArray(data.vatsim) ? data.vatsim : [];
const faa = data.faa;

// Hide section only if neither exists
container.innerHTML = '';

if (!vatsimList.length && (!faa || !faa.available)) {
  container.classList.add('hidden');
  return;
}

container.classList.remove('hidden');

// VATSIM ATIS (PRIMARY)
vatsimList.forEach(function (atis) {
  const card = document.createElement('section');
  card.className = 'atis-entry vatsim-atis';

        card.innerHTML =
          '<div class="atis-container">' +
            '<div class="atis-letter vatsim">' +
              (atis.letter || '—') +
            '</div>' +
            '<div class="atis-body">' +
              '<div class="atis-title">' +
                'VATSIM ATIS (' + atis.atisType + ')' +
              '</div>' +
              '<div class="atis-meta">' +
                atis.callsign +
                (atis.frequency ? ' • ' + atis.frequency : '') +
              '</div>' +
              '<div class="atis-text">' +
                escapeHtml(atis.text) +
              '</div>' +
              '<button class="atis-expand-btn" onclick="this.previousElementSibling.classList.toggle(&quot;atis-expanded&quot;);this.textContent=this.previousElementSibling.classList.contains(&quot;atis-expanded&quot;)?&quot;Hide ATIS ▲&quot;:&quot;Show full ATIS ▼&quot;">Show full ATIS ▼</button>' +
            '</div>' +
          '</div>';

        container.appendChild(card);
      });

      /* =========================
         2) FAA ATIS
         ========================= */

      if (faa && faa.available) {
  const card = document.createElement('section');
  card.className = 'atis-entry faa-atis';


        card.innerHTML =
          '<div class="atis-container">' +
            '<div class="atis-letter faa">' +
              (faa.letter || '—') +
            '</div>' +
            '<div class="atis-body">' +
             '<div class="atis-title faa">' +
  'FAA ATIS' +
  '<span class="atis-badge">REFERENCE</span>' +
'</div>' +

              '<div class="atis-disclaimer">' +
                'Not valid for VATSIM operations. Always follow VATSIM ATC.' +
              '</div>' +
              '<div class="atis-text">' +
                escapeHtml(faa.text) +
              '</div>' +
              '<button class="atis-expand-btn" onclick="this.previousElementSibling.classList.toggle(&quot;atis-expanded&quot;);this.textContent=this.previousElementSibling.classList.contains(&quot;atis-expanded&quot;)?&quot;Hide ATIS ▲&quot;:&quot;Show full ATIS ▼&quot;">Show full ATIS ▼</button>' +
            '</div>' +
          '</div>';

        container.appendChild(card);
      }
    })
    .catch(err => {
      console.error('[ATIS]', err);
    });
}


function loadControllers(icao) {
  fetch('/api/icao/' + icao + '/controllers')
    .then(res => res.json())
    .then(data => {
      const ul = document.getElementById('onlineControllers');
      if (!ul) return;

      ul.innerHTML = data.length
        ? data.map(c =>
            '<li class="atc-item">' +
              '<span class="atc-callsign">' + c.callsign + '</span>' +
              '<span class="atc-freq">' + c.frequency + '</span>' +
            '</li>'
          ).join('')
        : '<li class="atc-empty">No ATC online</li>';
    });
}

function loadDepartures(icao) {
  fetch('/api/icao/' + icao + '/departures/live')
    .then(res => res.json())
    .then(data => {
      const tbody = document.getElementById('upcomingDepartures');
      if (!tbody) return;

      tbody.innerHTML = data.map(d =>
        '<tr>' +

          // STATUS ICON
          '<td class="col-sts">' +
            '<span class="sts-icon ' +
              (d.status === 'Taxiing' ? 'sts-taxi' : 'sts-gate') +
            '" title="' + d.status + '">' +
              (d.status === 'Taxiing' ? '➜' : '⎍') +
            '</span>' +
          '</td>' +

          '<td>' + d.callsign + '</td>' +
          '<td>' + d.aircraft + '</td>' +
          '<td>' + d.destination + '</td>' +

          // ROUTE (collapsible)
          '<td>' +
            '<div class="route-collapsible">' +
              '<span class="route-text collapsed">' + d.route + '</span>' +
              '<button type="button" class="route-toggle" aria-expanded="false">' +
                'Expand' +
              '</button>' +
            '</div>' +
          '</td>' +

        '</tr>'
      ).join('');
    });
}


function loadAirportDocs(icao) {
  fetch('/api/icao/' + icao + '/docs')
    .then(res => res.json())
    .then(data => {
      const tbody = document.getElementById('airportDocs');
      const uploadBtn = document.getElementById('openUploadDoc');
      const requestBtn = document.getElementById('requestDocAccess');

      if (!tbody) return;

      // 🔒 Always reset both buttons
      uploadBtn?.classList.add('hidden');
      requestBtn?.classList.add('hidden');

      // ✅ Mutually exclusive logic
      if (data.canUpload) {
        uploadBtn?.classList.remove('hidden');
      } else if (window.IS_LOGGED_IN) {
        requestBtn?.classList.remove('hidden');
      }

      const docs = data.docs;

      tbody.innerHTML = docs.length
        ? docs.map(d =>
            '<tr>' +
              '<td><a href="' + d.url + '" target="_blank">' + d.filename + '</a></td>' +
              '<td>' + d.type + '</td>' +
              '<td class="hide-mobile">' + new Date(d.updated).toLocaleDateString('en-GB') + '</td>' +
              '<td>' + d.submittedBy + '</td>' +
            '</tr>'
          ).join('')
        : '<tr><td colspan="4" class="empty">No documentation available</td></tr>';
    });
}



</script>
<script>
  window.WF_LEG = ${wfLeg ? JSON.stringify(wfLeg) : 'null'};
</script>


<script>
document.addEventListener('DOMContentLoaded', () => {
  if (!window.IS_LOGGED_IN) return;

  const btn = document.getElementById('requestDocAccess');
  if (btn) {
    btn.classList.remove('hidden');
  }
});
</script>
<script>
document.addEventListener('DOMContentLoaded', async () => {
  if (!/\\/icao\\/[A-Z]{4}$/i.test(window.location.pathname)) return;

  const pathParts = window.location.pathname.split('/');
  const icao = pathParts[pathParts.length - 1].toUpperCase();

  try {
    const res = await fetch('/api/icao/' + icao + '/wf-slots');
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const data = await res.json();
    if (window.loadSlotBanners) {
      window.loadSlotBanners(data);
    }
  } catch (err) {
    console.error('[WF SLOT LOAD FAILED]', err);
  }
});
</script>



<div id="docAccessModal" class="modal hidden">
  <div class="modal-backdrop"></div>
  <div class="modal-dialog">
    <h3>Request Documentation Access</h3>

    <form id="docAccessForm">
      <label>
        First Name
        <input type="text" id="docAccessFirst" readonly />
      </label>

      <label>
        Last Name
        <input type="text" id="docAccessLast" readonly />
      </label>

      <label>
        Email Address
        <input type="email" id="docAccessEmail" required />
      </label>

      <label>
        Staff Role
        <select id="docAccessRole" required>
          <option value="">Select...</option>
          <option value="staff">Staff Member</option>
          <option value="director">Director</option>
          <option value="none">No staff role</option>
        </select>
      </label>

      <div id="docAccessRoleError" class="modal-message hidden" style="color:var(--danger);margin-top:8px;font-size:13px;">
        Only Division/vACC Staff can request access to upload documentation.
      </div>

      <div id="docAccessFormMessage" class="modal-message hidden"></div>

      <div class="modal-actions">
        <button type="button" class="modal-btn modal-btn-cancel" id="closeDocAccessModal">Cancel</button>
        <button type="submit" class="modal-btn modal-btn-submit" id="submitDocAccessBtn">Submit Request</button>
      </div>
    </form>
  </div>
</div>

<script>
(function() {
  const btn = document.getElementById('requestDocAccess');
  const modal = document.getElementById('docAccessModal');
  const form = document.getElementById('docAccessForm');
  const closeBtn = document.getElementById('closeDocAccessModal');
  const backdrop = modal?.querySelector('.modal-backdrop');
  const roleSelect = document.getElementById('docAccessRole');
  const roleError = document.getElementById('docAccessRoleError');
  const submitBtn = document.getElementById('submitDocAccessBtn');
  const msgEl = document.getElementById('docAccessFormMessage');

  if (!btn || !modal) return;

  function openModal() {
    const u = window.VATSIM_USER;
    if (!u) return;

    document.getElementById('docAccessFirst').value = u.nameFirst;
    document.getElementById('docAccessLast').value = u.nameLast;
    document.getElementById('docAccessEmail').value = u.email;
    roleSelect.value = '';
    roleError.classList.add('hidden');
    submitBtn.disabled = false;
    msgEl.classList.add('hidden');
    modal.classList.remove('hidden');
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  btn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  if (backdrop) backdrop.addEventListener('click', closeModal);

  roleSelect.addEventListener('change', () => {
    if (roleSelect.value === 'none') {
      roleError.classList.remove('hidden');
      submitBtn.disabled = true;
    } else {
      roleError.classList.add('hidden');
      submitBtn.disabled = false;
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (roleSelect.value === 'none' || !roleSelect.value) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    const icao = btn.dataset.icao;
    const email = document.getElementById('docAccessEmail').value.trim();
    const role = roleSelect.value;

    try {
      const res = await fetch('/api/documentation-access/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ icao, email, role })
      });

      if (!res.ok) throw new Error('Request failed');

      msgEl.textContent = 'Your request has been sent to an administrator for review.';
      msgEl.style.color = 'var(--success)';
      msgEl.classList.remove('hidden');
      submitBtn.textContent = 'Sent';
      btn.classList.add('hidden');

      setTimeout(closeModal, 2000);
    } catch (err) {
      msgEl.textContent = 'Unable to submit request. Please try again.';
      msgEl.style.color = 'var(--danger)';
      msgEl.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Request';
    }
  });
})();
</script>
<script>
(function () {
  var wfBanner = document.getElementById('wfSlotBanner');
  var wfLink   = document.getElementById('wfSlotLink');

  if (!wfBanner || !wfLink) return;

  function attach() {
    if (typeof socket === 'undefined') {
      setTimeout(attach, 100);
      return;
    }

    socket.on('unassignedTobtUpdate', function (slots) {
  if (!Array.isArray(slots) || slots.length === 0) {
    wfBanner.classList.add('hidden');
    return;
  }

  const slot = slots[0];
  const leg  = window.WF_LEG;

  if (!leg) {
    wfBanner.classList.add('hidden');
    return;
  }

  // ---- Display ----
  document.getElementById('wfDep').textContent    = leg.from;
  document.getElementById('wfDest').textContent   = leg.to;
  document.getElementById('wfDate').textContent   = leg.dateUtc;
  document.getElementById('wfWindow').textContent = leg.depWindow;
  document.getElementById('wfBlock').textContent  = leg.blockTime;

  // ---- Booking URL (SCHEDULE TIME ONLY) ----
  wfLink.href =
    '/book?' +
    'from=' + encodeURIComponent(leg.from) +
    '&to=' + encodeURIComponent(leg.to) +
    '&dateUtc=' + encodeURIComponent(leg.dateUtc) +
    '&depTimeUtc=' + encodeURIComponent(leg.depTimeUtc); // ✅ FIX

  wfBanner.classList.remove('hidden');
});



    // Request initial state so we don't miss first emit
    socket.emit('requestSyncAllState', { icao: window.ICAO });
  }

  attach();
})();
</script>





<script>
document.addEventListener('DOMContentLoaded', function () {
  const uploadModal = document.getElementById('uploadDocModal');
  const openUploadBtn = document.getElementById('openUploadDoc');
  const cancelUploadBtn = document.getElementById('uploadDocCancel');
  const uploadForm = document.getElementById('uploadDocForm');
  const uploadIcaoInput = document.getElementById('uploadDocIcao');

  if (!uploadModal || !uploadForm) return;

  if (openUploadBtn) {
    openUploadBtn.addEventListener('click', function () {
      uploadIcaoInput.value = openUploadBtn.dataset.icao;
      uploadModal.classList.remove('hidden');
    });
  }

  if (cancelUploadBtn) {
    cancelUploadBtn.addEventListener('click', function () {
      uploadModal.classList.add('hidden');
    });
  }

  uploadForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    const icao = uploadIcaoInput.value;
    const formData = new FormData(uploadForm);

    const res = await fetch('/icao/' + icao + '/upload', {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      alert('Upload failed');
      return;
    }

    uploadModal.classList.add('hidden');
    location.reload();
  });
});
</script>


<script>
const hint = document.getElementById('sceneryLoginHint');
if (!window.IS_LOGGED_IN && hint) {
  hint.classList.remove('hidden');
}
</script>
<script>
(function () {
  const icao = "${icao}";
  const container = document.getElementById('availableScenery');

  if (!container) return;

  fetch('/api/icao/' + icao + '/scenery-links')
    .then(res => res.json())
    .then(data => {
      const rows = []
        .concat((data.msfs || []).map(r => Object.assign({}, r, { sim: 'MSFS' })))
        .concat((data.xplane || []).map(r => Object.assign({}, r, { sim: 'X-Plane' })))
        .concat((data.p3d || []).map(r => Object.assign({}, r, { sim: 'P3D' })));

      if (!rows.length) {
        container.innerHTML =
          '<div class="empty">No scenery available</div>';
        return;
      }

      container.innerHTML =
        '<table class="admin-table scenery-table">' +
          '<thead>' +
            '<tr>' +
              '<th>Sim</th>' +
              '<th>Name</th>' +
              '<th class="hide-mobile">Developer</th>' +
              '<th class="hide-mobile">Store</th>' +
              '<th>Type</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' +
            rows.map(r =>
  '<tr>' +
    '<td><span class="sim-pill">' + r.sim + '</span></td>' +
    '<td><a href="' + r.url + '" target="_blank" rel="noopener">' +
      r.name +
    '</a></td>' +
    '<td class="hide-mobile">' + (r.developer || '-') + '</td>' +
    '<td class="hide-mobile">' + (r.store || '-') + '</td>' +
    '<td>' +
      '<span class="type-pill ' + r.type.toLowerCase() + '">' +
        r.type +
      '</span>' +
    '</td>' +
  '</tr>'
).join('')
 +
          '</tbody>' +
        '</table>';
    })
    .catch(() => {
      container.innerHTML =
        '<div class="empty">Failed to load scenery</div>';
    });
})();
</script>












`;

  


  res.send(renderLayout({
    title: `${icao} <span class="hide-mobile">Airport </span>Portal`,
    user: req.session?.user?.data,
    isAdmin: ADMIN_CIDS.includes(Number(req.session?.user?.data?.cid)),
    content,
    layoutClass: 'dashboard-full'
  }));
});

app.get('/api/icao/:icao/departures/live', (req, res) => {
  const icao = req.params.icao.toUpperCase();

  const departures = cachedPilots
    .filter(p => p.flight_plan?.departure === icao)
    .map(p => {
      let status = 'Airborne';

      if (p.groundspeed < 5 && p.altitude < 500) {
        status = 'At Gate';
      } else if (p.groundspeed >= 5 && p.altitude < 500) {
        status = 'Taxiing';
      } else if (p.altitude >= 500 && p.altitude < 3000) {
        status = 'Departed';
      }

      return {
        status,
        callsign: p.callsign,
        aircraft: p.flight_plan.aircraft_short || p.flight_plan.aircraft || '-',
        destination: p.flight_plan.arrival || '-',
        route: p.flight_plan.route || ''
      };
    })
    // ✅ KEEP ONLY RELEVANT STATES
    .filter(d =>
      d.status === 'At Gate' ||
      d.status === 'Taxiing'
    )
    // optional: stable order
    .sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'At Gate' ? -1 : 1;
      }
      return a.callsign.localeCompare(b.callsign);
    });

  res.json(departures);
});

app.post(
  '/api/documentation-access/request',
  requireLogin,
  async (req, res) => {
    const cid = Number(req.session.user.data.cid);
    const { icao, email, role } = req.body;

    if (!icao || !/^[A-Z]{4}$/.test(icao)) {
      return res.status(400).json({ error: 'Invalid ICAO' });
    }

    // Prevent duplicate pending requests
    const existing = await prisma.documentationAccessRequest.findFirst({
      where: {
        cid,
        pattern: icao.toUpperCase(),
        status: 'PENDING'
      }
    });

    if (existing) {
      return res.status(409).json({ error: 'Request already pending' });
    }

    const personal = req.session.user.data.personal || {};
    const fullName = [personal.name_first, personal.name_last].filter(Boolean).join(' ') || null;

    await prisma.documentationAccessRequest.create({
      data: {
        cid,
        pattern: icao.toUpperCase(),
        name: fullName,
        email: typeof email === 'string' ? email.trim() : (personal.email || null),
        role: typeof role === 'string' ? role : null,
        status: 'PENDING'
      }
    });

    res.json({ success: true });
  }
);


app.post('/api/scenery/submit', requireLogin, async (req, res) => {
  try {
    const {
      icao,
      sim,
      name,
      developer,
      store,
      url,
      type
    } = req.body;

    if (!icao || !sim || !name || !url || !type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await prisma.airportScenery.create({
      data: {
        icao: icao.toUpperCase(),
        sim,
        name,
        developer: developer || null,
        store: store || null,
        url,
        type,
        submittedBy: req.session.user.data.name || req.session.user.data.cid,
        approved: false
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[SCENERY SUBMIT]', err);
    res.status(500).json({ error: 'Failed to submit scenery' });
  }
});

app.get('/api/icao/:icao/wf-slots', (req, res) => {
  const icao = req.params.icao.toUpperCase();
  const userCid = req.session?.user?.data?.cid ?? null;

  const arrivalLeg   = adminSheetCache.find(r => r.to === icao);
  const departureLeg = adminSheetCache.find(r => r.from === icao);

  /* ================= ARRIVAL ================= */

  let arrivalHasSlots = false;
  let arrivalFullyBooked = false;
  let arrivalIHaveSlot = false;

 

  if (arrivalLeg && arrivalLeg.dep_time_utc) {
  const prefix =
    `${arrivalLeg.from}-${arrivalLeg.to}|${arrivalLeg.date_utc}|${arrivalLeg.dep_time_utc}|`;

    const allSlots = Object.keys(allTobtSlots)
      .filter(k => k.startsWith(prefix));

    const bookedSlots = Object.keys(tobtBookingsByKey)
      .filter(k => k.startsWith(prefix));

    arrivalHasSlots = allSlots.length > 0;
    arrivalFullyBooked =
      arrivalHasSlots && bookedSlots.length === allSlots.length;

    if (userCid && tobtBookingsByCid[userCid]) {
      arrivalIHaveSlot = [...tobtBookingsByCid[userCid]]
        .some(k => k.startsWith(prefix));
    }
  }

  /* ================= DEPARTURE ================= */

  let departureHasSlots = false;
  let departureFullyBooked = false;
  let departureIHaveSlot = false;

  if (departureLeg) {
    const prefix =
      `${departureLeg.from}-${departureLeg.to}|${departureLeg.date_utc}|${departureLeg.dep_time_utc}|`;

    const allSlots = Object.keys(allTobtSlots)
      .filter(k => k.startsWith(prefix));

    const bookedSlots = Object.keys(tobtBookingsByKey)
      .filter(k => k.startsWith(prefix));

    departureHasSlots = allSlots.length > 0;
    departureFullyBooked =
      departureHasSlots && bookedSlots.length === allSlots.length;

    if (userCid && tobtBookingsByCid[userCid]) {
      departureIHaveSlot = [...tobtBookingsByCid[userCid]]
        .some(k => k.startsWith(prefix));
    }
  }

  /* ================= WINDOWS ================= */

  const arrivalWindow = arrivalLeg?.arr_time_utc
    ? `${subtractMinutes(arrivalLeg.arr_time_utc, 60)}–${addMinutes(arrivalLeg.arr_time_utc, 60)}`
    : null;

  const departureWindow = departureLeg?.dep_time_utc
    ? `${subtractMinutes(departureLeg.dep_time_utc, 60)}–${addMinutes(departureLeg.dep_time_utc, 60)}`
    : null;

  /* ================= RESPONSE ================= */

  const cid = req.session?.user?.data?.cid;
  const isAdminUser = cid && ADMIN_CIDS.includes(Number(cid));
  const showArrival = isAdminUser || isPageEnabled('arrival-info');
  const showDeparture = isAdminUser || isPageEnabled('departure-info');

  res.json({
    arrival: (showArrival && arrivalLeg) ? {
      from: arrivalLeg.from,
      to: arrivalLeg.to,
      dateUtc: arrivalLeg.date_utc,
      dep_time_utc: arrivalLeg.dep_time_utc,
      arr_time_utc: arrivalLeg.arr_time_utc,
      window: arrivalWindow,
      atcRoute: arrivalLeg.atc_route,

      hasSlots: arrivalHasSlots,
      fullyBooked: arrivalFullyBooked,
      iHaveSlot: arrivalIHaveSlot
    } : null,

    departure: (showDeparture && departureLeg) ? {
      from: departureLeg.from,
      to: departureLeg.to,
      dateUtc: departureLeg.date_utc,
      dep_time_utc: departureLeg.dep_time_utc,
      window: departureWindow,
      atcRoute: departureLeg.atc_route,

      hasSlots: departureHasSlots,
      fullyBooked: departureFullyBooked,
      iHaveSlot: departureIHaveSlot
    } : null
  });
});



app.get('/api/icao/:icao/controllers', async (req, res) => {
  const icao = req.params.icao.toUpperCase();

  try {
    const r = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');

    const controllers = r.data.controllers || [];
    const atis = r.data.atis || [];

    /* =====================
       CTR (TOP LEVEL)
       ===================== */
    const ctrControllers = controllers
      .filter(c => isCoveringCtr(c.callsign, icao))
      .map(c => ({
        callsign: c.callsign,
        frequency: c.frequency || '—',
        isCtr: true
      }));

    /* =====================
       AIRPORT CONTROLLERS
       ===================== */
    const airportControllers = controllers
      .filter(c => isAirportController(c.callsign, icao))
      .map(c => ({
        callsign: c.callsign,
        frequency: c.frequency || '—',
        isAtis: false
      }));

    /* =====================
       ATIS (BOTTOM)
       ===================== */
    const airportAtis = atis
      .filter(a => {
        const cs = a.callsign?.toUpperCase();
        return cs &&
          cs.includes('_ATIS') &&
          (
            cs.startsWith(icao + '_') ||
            (icao.startsWith('K') && cs.startsWith(icao.slice(1) + '_'))
          );
      })
      .map(a => {
        const cs = a.callsign.toUpperCase();

        let atisType = 'general';
        if (cs.includes('_D_ATIS')) atisType = 'departure';
        else if (cs.includes('_A_ATIS')) atisType = 'arrival';

        return {
          callsign: a.callsign,
          frequency: a.frequency || '—',
          isAtis: true,
          atisType
        };
      });

    /* =====================
       FINAL ORDERED OUTPUT
       ===================== */
    res.json([
      ...ctrControllers,
      ...airportControllers,
      ...airportAtis
    ]);

  } catch (err) {
    console.error('[CONTROLLERS]', err.message);
    res.json([]);
  }
});

function getFileType(filename) {
  const ext = filename.split('.').pop().toUpperCase();

  if (['PDF'].includes(ext)) return 'PDF';
  if (['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP'].includes(ext)) return 'IMAGE';
  if (['DOC', 'DOCX'].includes(ext)) return 'WORD';
  if (['XLS', 'XLSX'].includes(ext)) return 'EXCEL';

  return ext; // fallback
}


app.get('/api/icao/:icao/docs', async (req, res) => {
  try {
    const icao = req.params.icao.toUpperCase();
    const user = req.session?.user?.data || null;

    const docs = await prisma.airportDocument.findMany({
      where: { icao },
      orderBy: { uploadedAt: 'desc' }
    });

    const users = await prisma.user.findMany({
      where: {
        cid: { in: docs.map(d => d.uploadedBy) }
      }
    });

    const userMap = Object.fromEntries(
      users.map(u => [u.cid, u.name])
    );

    const canUpload = user
      ? await canEditDocumentation(user.cid, icao)
      : false;

    res.json({
  canUpload,
  docs: docs.map(d => ({
    filename: d.filename.replace(/\.[^/.]+$/, ''), // ❌ extension removed
    url: `/uploads/${icao}/${encodeURIComponent(d.filename)}`,
    type: getFileType(d.filename),                  // ✅ real type
    updated: d.uploadedAt,
    submittedBy: userMap[d.uploadedBy]
      ? `${userMap[d.uploadedBy]} (${d.uploadedBy})`
      : String(d.uploadedBy)
  }))
});

  } catch (err) {
    console.error('[DOCS API]', err);
    res.status(500).json({ canUpload: false, docs: [] });
  }
});




app.get('/api/tobt/slots', (req, res) => {
  const cid = Number(req.session?.user?.data?.cid);

  const { from, to, dateUtc, depTimeUtc } = req.query;

  if (!from || !to || !dateUtc || !depTimeUtc) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const slots = generateTobtSlots({ from, to, dateUtc, depTimeUtc });

  // No flow defined
  if (slots === null) {
    return res.json({
      noFlow: true,
      message: 'No flow rate has been defined for this sector.'
    });
  }

  const results = [];

  // 🔑 detect BOOKING-ONLY made by *this user* for this sector
  const myBookingOnly = Object.values(tobtBookingsByKey).find(b =>
    b.cid === cid &&
    b.from === from &&
    b.to === to &&
    b.dateUtc === dateUtc &&
    b.depTimeUtc === depTimeUtc &&
    b.tobtTimeUtc === null
  );

  slots.forEach(tobt => {
    const slotKey = makeTobtSlotKey({
      from,
      to,
      dateUtc,
      depTimeUtc,
      tobtTimeUtc: tobt
    });

    const myBookingKey = `${cid}:${slotKey}`;
    const myBooking = tobtBookingsByKey[myBookingKey];

    results.push({
      tobt,
      slotKey,
      booked: !!myBooking, // booked-by-me only
      byMe: !!myBooking,
      callsign: myBooking?.callsign || null
    });
  });

  // 🔑 Anchor booking-only so Cancel appears
  if (myBookingOnly && results.length) {
    results[0].byMe = true;
    results[0].booked = true;
    results[0].callsign = myBookingOnly.callsign || null;
  }

  res.json(results);
});




/* ===== ADMIN MANUAL REFRESH ===== */
app.post('/wf-schedule/refresh-schedule', requireAdmin, async (req, res) => {
  await refreshAdminSheet();
  rebuildAllTobtSlots();
  res.json({ success: true });
});

app.post('/api/tobt/cancel', requireLogin, async (req, res) => {
  try {
    const { slotKey } = req.body;
    if (!slotKey) {
      return res.status(400).json({ error: 'Missing slotKey' });
    }

    const cid = Number(req.session.user.data.cid);
    const bookingKey = `${cid}:${slotKey}`;

    const booking = tobtBookingsByKey[bookingKey];
    if (!booking) {
      return res.status(404).json({
        error: 'Booking not found or already cancelled.'
      });
    }

    // 🔥 Delete from DB (MODEL 2: cid + slotKey)
    await prisma.tobtBooking.deleteMany({
      where: {
        cid,
        slotKey
      }
    });

    // 🔥 Delete from memory
    delete tobtBookingsByKey[bookingKey];

    if (tobtBookingsByCid[cid]) {
      tobtBookingsByCid[cid].delete(bookingKey);
      if (tobtBookingsByCid[cid].size === 0) {
        delete tobtBookingsByCid[cid];
      }
    }

    // 🔔 Notify clients
    emitToIcao(booking.from, 'departures:update');
    emitToIcao(
      booking.from,
      'unassignedTobtUpdate',
      buildUnassignedTobtsForICAO(booking.from)
    );

    return res.json({ success: true });

  } catch (err) {
    console.error('[TOBT] Cancel failed:', err);
    return res.status(500).json({ error: 'Failed to cancel booking' });
  }
});


app.get('/admin/api/documentation-requests', requireAdmin, async (req, res) => {
  const requests = await prisma.documentationAccessRequest.findMany({
    where: {
    status: { in: ['PENDING', 'DENIED'] }
  },
    orderBy: { requestedAt: 'asc' }
  });

  res.json(requests);
});

app.post('/admin/api/documentation-requests/:id/deny', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const adminCid = Number(req.session.user.data.cid);

 await prisma.documentationAccessRequest.update({
  where: { id },
  data: {
    status: 'DENIED',
    reviewedBy: adminCid,
    reviewedAt: new Date()
  }
});


  res.json({ success: true });
});


app.post(
  '/admin/api/documentation-requests/:id/approve',
  requireAdmin,
  async (req, res) => {
    const id = Number(req.params.id);
    const adminCid = Number(req.session.user.data.cid);

    const request = await prisma.documentationAccessRequest.findUnique({
      where: { id }
    });

    if (!request || request.status !== 'PENDING') {
      return res.status(400).json({ error: 'Invalid request' });
    }

    // 1️⃣ Grant permission
    await prisma.documentationPermission.create({
      data: {
        cid: request.cid,
        pattern: request.pattern
      }
    });

    // 2️⃣ Mark request approved
    await prisma.documentationAccessRequest.update({
  where: { id },
  data: {
    status: 'APPROVED'
  }
});


    res.json({ success: true });
  }
);


app.post('/api/docs/request-access', requireLogin, async (req, res) => {
  const cid = Number(req.session.user.data.cid);
  const icao = req.body.icao?.toUpperCase();

  if (!icao || icao.length !== 4) {
    return res.status(400).json({ error: 'Invalid ICAO' });
  }

  // Prevent duplicates
  const existing = await prisma.documentationAccessRequest.findFirst({
    where: {
  cid,
  pattern: icao.toUpperCase(),
  status: 'PENDING'
}

  });

  if (existing) {
    return res.status(409).json({ error: 'Request already pending' });
  }

  await prisma.documentationAccessRequest.create({
  data: {
    cid,
    pattern: icao.toUpperCase()
  }
});


  res.json({ success: true });
});


app.post('/api/tobt/book', requireLogin, async (req, res) => {
  try {
    // 1️⃣ Validate input
    const { slotKey, callsign: enteredCid, manual } = req.body;
    if (!slotKey || !enteredCid) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    // 2️⃣ Extract user basics
    const userData = req.session.user.data;
    const cid = Number(userData.cid);

    // Verify CID matches logged-in user
    if (String(enteredCid).trim() !== String(cid)) {
      return res.status(403).json({ error: 'CID does not match your logged-in account.' });
    }

    // 3️⃣ Parse slotKey: FROM-TO|Date|DepTime|TOBT
    // 3️⃣ Parse slotKey
// 3️⃣ Parse slotKey
const parts = slotKey.split('|');

let from, to, dateUtc, depTimeUtc, tobtTimeUtc;

// BOOKING-ONLY
if (parts.length === 3) {
  const [sectorPart, dateUtcRaw, depTimeUtcRaw] = parts;
  [from, to] = sectorPart.split('-');
  dateUtc = dateUtcRaw;
  depTimeUtc = depTimeUtcRaw;
  tobtTimeUtc = null;

// NORMAL SLOT
} else if (parts.length === 4) {
  const [sectorPart, dateUtcRaw, depTimeUtcRaw, tobtRaw] = parts;
  [from, to] = sectorPart.split('-');
  dateUtc = dateUtcRaw;
  depTimeUtc = depTimeUtcRaw;
  tobtTimeUtc = tobtRaw;

} else {
  return res.status(400).json({ error: 'Invalid slot key format' });
}

if (!from || !to) {
  return res.status(400).json({ error: 'Invalid sector format' });
}

const fromIcao = from.toUpperCase();

// ✅ MISSING LINE (THIS FIXES EVERYTHING)
const isBookingOnly = tobtTimeUtc === null;

// 4️⃣ Decide assignment mode
// Booking-only is ALWAYS a pilot booking
const wantsManual = !isBookingOnly && manual === true;



    // Permission to do a manual assignment
    const canManualAssign = wantsManual && canEditIcao(userData, fromIcao);

    // Pilot booking must have a CID
    if (!canManualAssign && !cid) {
      return res.status(400).json({ error: 'Invalid pilot booking' });
    }

    // 5️⃣ Prevent double booking
    if (tobtBookingsByKey[slotKey]) {
      return res.status(409).json({ error: 'Slot already booked' });
    }

    // 6️⃣ Use CID as identifier
    const normalizedCallsign = String(cid);

    // 8️⃣ Prevent duplicate sector + callsign
    const sectorKey = parts.slice(0, 3).join('|');

    // block duplicates per-user per-sector (MODEL 2)
for (const existing of Object.values(tobtBookingsByKey)) {
  if (existing.cid !== cid) continue;

  const existingSectorKey = `${existing.from}-${existing.to}|${existing.dateUtc}|${existing.depTimeUtc}`;
  if (existingSectorKey === sectorKey) {
    return res.status(409).json({
      error: 'You already have a booking for this sector.'
    });
  }
}


    // 9️⃣ Persist to DB
    // Manual assignment => cid NULL
    // Pilot booking     => cid user's CID
    const storedCid = wantsManual && canEditIcao(userData, fromIcao)
  ? null
  : cid;


    await prisma.tobtBooking.create({
      data: {
        slotKey,
        cid: storedCid,
        callsign: normalizedCallsign,
        from: fromIcao,
        to: to.toUpperCase(),
        dateUtc,
        depTimeUtc,
        tobtTimeUtc
      }
    });

    // 🔟 Update in-memory cache
    tobtBookingsByKey[slotKey] = {
      slotKey,
      cid: storedCid,
      callsign: normalizedCallsign,
      from: fromIcao,
      to: to.toUpperCase(),
      dateUtc,
      depTimeUtc,
      tobtTimeUtc
    };

    const bookingKey = `${storedCid}:${slotKey}`;

tobtBookingsByKey[bookingKey] = {
  bookingKey,
  slotKey,
  cid: storedCid,
  callsign: normalizedCallsign,
  from: fromIcao,
  to: to.toUpperCase(),
  dateUtc,
  depTimeUtc,
  tobtTimeUtc
};

if (!tobtBookingsByCid[storedCid]) {
  tobtBookingsByCid[storedCid] = new Set();
}
tobtBookingsByCid[storedCid].add(bookingKey);


    // 1️⃣2️⃣ Notify clients
    emitToIcao(fromIcao, 'departures:update');
    emitToIcao(fromIcao, 'unassignedTobtUpdate', buildUnassignedTobtsForICAO(fromIcao));

    return res.json({ success: true });

  } catch (err) {
    console.error('[TOBT] Booking failed:', err);
    return res.status(500).json({ error: 'Failed to book TOBT slot' });
  }
});








app.post('/api/tobt/update-callsign', requireLogin, async (req, res) => {
  try {
    const { slotKey, callsign } = req.body;
    if (!slotKey || !callsign) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    const cid = Number(req.session.user.data.cid);
    const bookingKey = `${cid}:${slotKey}`;

    const booking = tobtBookingsByKey[bookingKey];
    if (!booking) {
      return res.status(403).json({
        error: 'Not your booking'
      });
    }

    const normalizedCallsign = callsign.trim().toUpperCase();

    // Reserved team callsign enforcement
    const teamCheck = await isReservedTeamCallsign(normalizedCallsign, cid);
    if (teamCheck.reserved && !teamCheck.allowed) {
      return res.status(403).json({
        error: `Callsign ${normalizedCallsign} is reserved for an official team.`
      });
    }

    // Update DB (Model 2: cid + slotKey)
    await prisma.tobtBooking.updateMany({
      where: {
        cid,
        slotKey
      },
      data: {
        callsign: normalizedCallsign
      }
    });

    // Update in-memory cache
    booking.callsign = normalizedCallsign;

    return res.json({ success: true });

  } catch (err) {
    console.error('[TOBT] Update callsign failed:', err);
    return res.status(500).json({ error: 'Failed to update callsign' });
  }
});


// 🔒 Reserved Official Team callsign enforcement (UPDATE)



app.get('/admin', (req, res) => {
  res.redirect(301, '/admin/control-panel');
});

app.get('/admin/control-panel', requireAdmin, async (req, res) => {
  const user = req.session.user.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

  let sceneryCount = 0;
  let docAccessCount = 0;
  try {
    sceneryCount = await prisma.airportScenery.count({ where: { approved: false } });
  } catch (e) {}
  try {
    docAccessCount = await prisma.documentationAccessRequest.count({ where: { status: 'PENDING' } });
  } catch (e) {}

  const sections = [
    {
      title: 'WF Schedule / Flow',
      desc: 'Manage the WorldFlight schedule, departure flows, flow types, dates, and ATC routes.',
      icon: '🛠️',
      href: '/wf-schedule',
      badge: null
    },
    {
      title: 'Official Teams',
      desc: 'Manage official teams and WF affiliates with active participation toggles.',
      icon: '👥',
      href: '/official-teams',
      badge: null
    },
    {
      title: 'Scenery Submissions',
      desc: 'Review and approve or reject pending scenery submissions from the community.',
      icon: '🗺️',
      href: '/admin/scenery',
      badge: sceneryCount > 0 ? sceneryCount : null
    },
    {
      title: 'Doc Upload Permissions',
      desc: 'Manage user access permissions for uploading airport documentation.',
      icon: '📄',
      href: '/admin/documentation-access',
      badge: docAccessCount > 0 ? docAccessCount : null
    },
    {
      title: 'Visited Airports',
      desc: 'Manage which airports have been visited by year and ICAO code.',
      icon: '🌍',
      href: '/admin/visited-airports',
      badge: null
    },
    {
      title: 'Suggestions',
      desc: 'View and manage community airport suggestions.',
      icon: '💡',
      href: '/admin/suggestions',
      badge: null
    },
    {
      title: 'Mailing List',
      desc: 'Send route announcement emails to subscribers.',
      icon: '📧',
      href: '/admin/mailing-list',
      badge: null
    },
    {
      title: 'Page Visibility',
      desc: 'Control page visibility for pilots and controllers.',
      icon: '⚙️',
      href: '/admin/settings',
      badge: null
    },
    {
      title: 'AIRAC Data',
      desc: 'Upload and manage navigation data (waypoints, airways) for route planning.',
      icon: '🧭',
      href: '/admin/airac',
      badge: null
    }
  ];

  const sectionCards = sections.map(s => `
    <a href="${s.href}" class="cp-card">
      <div class="cp-card-icon">${s.icon}</div>
      <div class="cp-card-body">
        <div class="cp-card-title">
          ${s.title}
          ${s.badge ? `<span class="cp-badge">${s.badge}</span>` : ''}
        </div>
        <div class="cp-card-desc">${s.desc}</div>
      </div>
      <div class="cp-card-arrow">→</div>
    </a>
  `).join('');

  const content = `
    <section class="card card-full">
      <h2>Admin Panel</h2>
      <p class="cp-subtitle">Admin tools and management pages.</p>
      <div class="cp-grid">
        ${sectionCards}
      </div>
    </section>

    <style>
      .cp-subtitle {
        color: var(--muted);
        font-size: 13px;
        margin-bottom: 24px;
      }
      .cp-grid {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .cp-card {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 20px 24px;
        border-radius: 10px;
        background: rgba(255,255,255,0.02);
        border: 1px solid var(--border);
        text-decoration: none;
        color: inherit;
        transition: background .15s, border-color .15s;
        cursor: pointer;
      }
      .cp-card:hover {
        background: rgba(255,255,255,0.06);
        border-color: var(--accent, #3b82f6);
      }
      .cp-card-icon {
        font-size: 28px;
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 10px;
        background: rgba(255,255,255,0.04);
        flex-shrink: 0;
      }
      .cp-card-body {
        flex: 1;
        min-width: 0;
      }
      .cp-card-title {
        font-weight: 600;
        font-size: 15px;
        color: var(--text);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .cp-card-desc {
        font-size: 13px;
        color: var(--muted);
        margin-top: 4px;
      }
      .cp-badge {
        background: #ef4444;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        padding: 2px 7px;
        border-radius: 10px;
        line-height: 1.4;
      }
      .cp-card-arrow {
        font-size: 18px;
        color: var(--muted);
        flex-shrink: 0;
        transition: color .15s;
      }
      .cp-card:hover .cp-card-arrow {
        color: var(--accent, #3b82f6);
      }
    </style>
  `;

  res.send(renderLayout({ title: 'Admin Panel', user, isAdmin, content, layoutClass: 'dashboard-full' }));
});

/* ===========================
   OFFICIAL TEAMS / AFFILIATES
   =========================== */

app.get('/official-teams', requireAdmin, async (req, res) => {
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/');
  }

  const user = req.session.user.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

  if (!isAdmin) {
    return res.status(403).send('You do not have Admin access');
  }

  const [teams, affiliates] = await Promise.all([
    prisma.officialTeam.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.affiliate.findMany({ orderBy: { createdAt: 'desc' } })
  ]);

  const content = `
  <section class="card card-full">
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
      <h2 style="margin:0;">Official Teams / WF Affiliates</h2>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="action-btn primary" id="addTeamBtn">Add Official Team</button>
        <button class="action-btn" id="addAffiliateBtn">Add WF Affiliate</button>
      </div>
    </div>
<div class="sub-card">
     <h3 class="section-title">Official Teams</h3>
    <div class="table-scroll">
      <table class="departures-table official-teams">
        <thead>
          <tr>
            <th>Team Name</th>
            <th>Callsign</th>
            <th>Main CID</th>
            <th>A/C Type</th>
            <th>Country</th>
            <th class="col-wf26 col-center">Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${teams.map(t => `
            <tr data-team-id="${t.id}">
              <td>${escapeHtml(t.teamName)}</td>
              <td>${escapeHtml(t.callsign)}</td>
              <td>${t.mainCid}</td>
              <td>${escapeHtml(t.aircraftType)}</td>
              <td>${escapeHtml(t.country)}</td>
              <td class="col-wf26 col-center">
  <input
    type="checkbox"
    class="wf26-toggle wf-check"
    data-entity="team"
    data-id="${t.id}"
    ${t.participatingWf26 ? 'checked' : ''}
  />
</td>
              <td style="text-align:right;">
                <button class="tobt-btn cancel" data-action="delete-team" data-id="${t.id}">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
</div>
    <div class="sub-card">
  <h3 class="section-title">WF Affiliates</h3>
    <div class="table-scroll">
    <table class="departures-table affiliates">
  <thead>
    <tr>
      <th class="col-callsign">Callsign</th>
      <th class="col-simtype">Full Sim / Home Cockpit</th>
      <th class="col-cid col-right">CID</th>
      <th class="col-wf26 col-center">Active</th>
      <th class="col-actions"></th>
    </tr>
  </thead>
  <tbody>
    ${affiliates.map(a => `
      <tr data-affiliate-id="${a.id}">
        <td class="col-callsign">${escapeHtml(a.callsign)}</td>
        <td class="col-simtype">
  ${escapeHtml(a.simType)}
</td>


        <td class="col-cid col-right">${a.cid}</td>
        <td class="col-wf26 col-center">
          <input
            type="checkbox"
            class="wf26-toggle wf-check"
            data-entity="affiliate"
            data-id="${a.id}"
            ${a.participatingWf26 ? 'checked' : ''}
          />
        </td>
        <td class="col-actions col-right">
          <button
            class="tobt-btn cancel"
            data-action="delete-affiliate"
            data-id="${a.id}">
            Delete
          </button>
        </td>
      </tr>
    `).join('')}
  </tbody>
</table>

    </div>
    </div>
  </section>

  <!-- ===== Add Entry Modal ===== -->
  <div id="adminEntryModal" class="modal hidden">
    <div class="modal-backdrop"></div>

    <div class="modal-card card" style="max-width:520px; text-align:left;">
      <h3 id="adminEntryModalTitle" style="text-align:center;">Add Entry</h3>
      <p id="adminEntryModalHelp" class="modal-help" style="text-align:center;">Fill in the details below.</p>

      <form id="adminEntryForm">
  <input type="hidden" id="adminEntryType" name="type" value="team" />

  <!-- ================= TEAM FIELDS ================= -->
  <div id="teamFields">
    <label style="display:block; margin:10px 0 6px;">Team Name</label>
    <input name="teamName" type="text" placeholder="e.g. Virtual Airline XYZ" required />

    <label style="display:block; margin:10px 0 6px;">Callsign</label>
    <input name="callsign" type="text" placeholder="e.g. BAW" maxlength="10" required />

    <label style="display:block; margin:10px 0 6px;">Main CID</label>
    <input name="mainCid" type="number" inputmode="numeric" placeholder="e.g. 1303570" required />

    <label style="display:block; margin:10px 0 6px;">A/C Type</label>
    <input name="aircraftType" type="text" placeholder="e.g. B738" required />

    <label style="display:block; margin:10px 0 6px;">Country</label>
    <input name="country" type="text" placeholder="e.g. UK" required />
  </div>

  <!-- ================= AFFILIATE FIELDS ================= -->
  
  <!-- ================= AFFILIATE FIELDS ================= -->
<div id="affiliateFields" class="hidden">

  <label style="display:block; margin:10px 0 6px;">Callsign</label>
  <input
    name="affiliateCallsign"
    type="text"
    placeholder="e.g. TOM1VB"
    maxlength="10"
    style="text-transform:uppercase;"
  />

  <label style="display:block; margin:10px 0 6px;">Full Sim / Home Cockpit</label>
  <select name="simType">
    <option value="" disabled selected>SELECT SIM TYPE</option>
    <option value="FULL SIM">FULL SIM</option>
    <option value="HOME COCKPIT">HOME COCKPIT</option>
  </select>

  <label style="display:block; margin:10px 0 6px;">CID</label>
  <input
    name="cid"
    type="number"
    inputmode="numeric"
    placeholder="E.G. 1303570"
  />

</div>



  <!-- ================= WF26 ================= -->
  <label style="display:flex; align-items:center; gap:10px; margin:14px 0 0; user-select:none;">
    <input type="checkbox" name="participatingWf26" />
    Participating in Active Event
  </label>

  <div class="modal-actions" style="margin-top:16px;">
    <button type="button" class="action-btn" id="adminEntryCancel">Cancel</button>
    <button type="submit" class="action-btn primary" id="adminEntrySave">Save</button>
  </div>
</form>

    </div>
  </div>

  <script>
  document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('adminEntryModal');
    const form = document.getElementById('adminEntryForm');
    const typeInput = document.getElementById('adminEntryType');

    const teamFields = document.getElementById('teamFields');
    const affiliateFields = document.getElementById('affiliateFields');

    const titleEl = document.getElementById('adminEntryModalTitle');
    const cancelBtn = document.getElementById('adminEntryCancel');
    const addTeamBtn = document.getElementById('addTeamBtn');
    const addAffiliateBtn = document.getElementById('addAffiliateBtn');

    if (!modal || !form || !typeInput || !teamFields || !affiliateFields || !titleEl || !cancelBtn || !addTeamBtn || !addAffiliateBtn) {
      console.error('[Admin modal] Missing required DOM elements:', {
        modal, form, typeInput, teamFields, affiliateFields, titleEl, cancelBtn, addTeamBtn, addAffiliateBtn
      });
      return;
    }

    function setSectionEnabled(container, enabled) {
      // Disable inputs in the hidden section to prevent validation blocking and unwanted FormData values
      container.querySelectorAll('input, select, textarea, button').forEach(el => {
        el.disabled = !enabled;
      });
    }

    function openEntryModal(type) {
      typeInput.value = type;
      form.reset();

      if (type === 'team') {
        titleEl.textContent = 'Add Official Team';

        teamFields.classList.remove('hidden');
        affiliateFields.classList.add('hidden');

        setSectionEnabled(teamFields, true);
        setSectionEnabled(affiliateFields, false);

        // Required only for TEAM
        form.querySelector('input[name="teamName"]').required = true;
        form.querySelector('input[name="callsign"]').required = true;
        form.querySelector('input[name="mainCid"]').required = true;
        form.querySelector('input[name="aircraftType"]').required = true;
        form.querySelector('input[name="country"]').required = true;

        // Optional / not required for TEAM
        const affiliateCallsign = form.querySelector('input[name="affiliateCallsign"]');
        const simType = form.querySelector('select[name="simType"], input[name="simType"]');
        const cid = form.querySelector('input[name="cid"]');

        if (affiliateCallsign) affiliateCallsign.required = false;
        if (simType) simType.required = false;
        if (cid) cid.required = false;

      } else {
        titleEl.textContent = 'Add WF Affiliate';

        teamFields.classList.add('hidden');
        affiliateFields.classList.remove('hidden');

        setSectionEnabled(teamFields, false);
        setSectionEnabled(affiliateFields, true);

        // Required for AFFILIATE
        const affiliateCallsign = form.querySelector('input[name="affiliateCallsign"]');
        const simType = form.querySelector('select[name="simType"], input[name="simType"]');
        const cid = form.querySelector('input[name="cid"]');

        if (affiliateCallsign) affiliateCallsign.required = true;
        if (simType) simType.required = true;
        if (cid) cid.required = true;

        // Not required for AFFILIATE
        form.querySelector('input[name="teamName"]').required = false;
        form.querySelector('input[name="callsign"]').required = false;
        form.querySelector('input[name="mainCid"]').required = false;
        form.querySelector('input[name="aircraftType"]').required = false;
        form.querySelector('input[name="country"]').required = false;
      }

      modal.classList.remove('hidden');

      // Focus first enabled input/select (not hidden/disabled)
      const firstFocusable = modal.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)');
      if (firstFocusable) firstFocusable.focus();
    }

    function closeEntryModal() {
      modal.classList.add('hidden');
    }

    addTeamBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openEntryModal('team');
    });

    addAffiliateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openEntryModal('affiliate');
    });

    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeEntryModal();
    });

    const backdrop = modal.querySelector('.modal-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeEntryModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeEntryModal();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const type = typeInput.value;
      const fd = new FormData(form);
      const payload = {};

      payload.participatingWf26 = fd.get('participatingWf26') === 'on';

      if (type === 'team') {
        payload.teamName = (fd.get('teamName') || '').toString().trim();
        payload.callsign = (fd.get('callsign') || '').toString().trim().toUpperCase();
        payload.mainCid = Number(fd.get('mainCid'));
        payload.aircraftType = (fd.get('aircraftType') || '').toString().trim().toUpperCase();
        payload.country = (fd.get('country') || '').toString().trim();
      } else {
        payload.callsign = (fd.get('affiliateCallsign') || '').toString().trim().toUpperCase();
        payload.simType = (fd.get('simType') || '').toString().trim().toUpperCase();
        payload.cid = Number(fd.get('cid'));
      }

      const url = type === 'team' ? '/api/admin/official-teams' : '/api/admin/affiliates';

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to save');
        return;
      }

      closeEntryModal();
      location.reload();
    });

    // Delete handlers (event delegation)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;

      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (!action || !id) return;

      if (action === 'delete-team') {
        const ok = await openConfirmModal({
          title: 'Delete Official Team',
          message: 'Are you sure you want to delete this team?'
        });
        if (!ok) return;

        const res = await fetch('/api/admin/official-teams/' + id, {
          method: 'DELETE',
          credentials: 'same-origin'
        });

        if (!res.ok) alert('Failed to delete');
        else location.reload();
      }

      if (action === 'delete-affiliate') {
        const ok = await openConfirmModal({
          title: 'Delete WF Affiliate',
          message: 'Are you sure you want to delete this affiliate?'
        });
        if (!ok) return;

        const res = await fetch('/api/admin/affiliates/' + id, {
          method: 'DELETE',
          credentials: 'same-origin'
        });

        if (!res.ok) alert('Failed to delete');
        else location.reload();
      }
    });

    // WF26 toggle persistence
    document.querySelectorAll('.wf26-toggle').forEach(cb => {
      cb.addEventListener('change', async () => {
        const entity = cb.dataset.entity;
        const id = cb.dataset.id;
        const participatingWf26 = cb.checked;

        const url = entity === 'team'
          ? '/api/admin/official-teams/' + id
          : '/api/admin/affiliates/' + id;

        const res = await fetch(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ participatingWf26 })
        });

        if (!res.ok) {
          cb.checked = !participatingWf26;
          alert('Failed to update active flag');
        }
      });
    });

    // Affiliate sim type dropdown persistence
    
    
  });
</script>

 

  `;

  return res.send(renderLayout({
    title: 'Official Teams / Affiliates',
    user,
    isAdmin,
    content,
    layoutClass: 'dashboard-full'
  }));
});

app.get('/api/admin/scenery/pending-count', requireAdmin, async (req, res) => {
  const count = await prisma.airportScenery.count({
    where: { approved: false }
  });

  res.json({ count });
});


// Create Official Team
app.post('/api/admin/official-teams', requireAdmin, async (req, res) => {
  const { teamName, callsign, mainCid, aircraftType, country, participatingWf26 } = req.body || {};

  if (!teamName || !callsign || !mainCid || !aircraftType || !country) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const created = await prisma.officialTeam.create({
    data: {
      teamName: String(teamName).trim(),
      callsign: String(callsign).trim().toUpperCase(),
      mainCid: Number(mainCid),
      aircraftType: String(aircraftType).trim().toUpperCase(),
      country: String(country).trim(),
      participatingWf26: Boolean(participatingWf26)
    }
  });

  return res.json({ success: true, id: created.id });
});

// Create Affiliate
app.post('/api/admin/affiliates', requireAdmin, async (req, res) => {
  const { callsign, simType, cid, participatingWf26 } = req.body || {};

  if (!callsign || !simType || !cid) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const created = await prisma.affiliate.create({
    data: {
      callsign: String(callsign).trim().toUpperCase(),
      simType: String(simType).trim(),
      cid: Number(cid),
      participatingWf26: Boolean(participatingWf26)
    }
  });

  return res.json({ success: true, id: created.id });
});

// Delete Official Team
app.delete('/api/admin/official-teams/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  await prisma.officialTeam.delete({ where: { id } }).catch(() => null);
  return res.json({ success: true });
});

// Delete Affiliate
app.delete('/api/admin/affiliates/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  await prisma.affiliate.delete({ where: { id } }).catch(() => null);
  return res.json({ success: true });
});

// Patch Official Team (WF26 toggle)
app.patch('/api/admin/official-teams/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { participatingWf26 } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  await prisma.officialTeam.update({
    where: { id },
    data: { participatingWf26: Boolean(participatingWf26) }
  });

  return res.json({ success: true });
});

// Patch Affiliate (WF26 toggle)
app.patch('/api/admin/affiliates/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { participatingWf26 } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  await prisma.affiliate.update({
    where: { id },
    data: { participatingWf26: Boolean(participatingWf26) }
  });

  return res.json({ success: true });
});


/* ===== CHANGE CHECK ===== */
app.get('/departures/check-changes', async (req, res) => {
  const icao = req.query.icao?.toUpperCase();
  if (!icao) return res.json({ changed: false });

  const response = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');

  const currentSet = new Set(
    response.data.pilots
      .filter(p => p.flight_plan && p.flight_plan.departure === icao && p.groundspeed < 5)
      .map(p => `${p.callsign}-${p.flight_plan.arrival}`)
  );

  const changed = currentSet.size !== lastDepartureSnapshot.size;
  lastDepartureSnapshot = currentSet;

  res.json({ changed });
});

/* ===== ADMIN PAGE ===== */
/* ===== WF EVENT MANAGEMENT (SUBMENU) ===== */
app.get('/wf-schedule', requireAdmin, async (req, res) => {
  const user = req.session.user.data;
  const isAdmin = true;

  const events = await prisma.wfEvent.findMany({ orderBy: { year: 'asc' } });

  const eventCards = events.map(e => {
    const rowCount = eventSheetCaches[e.id]?.length || 0;
    return `
      <div class="event-card ${e.isActive ? 'event-active' : ''}">
        <div class="event-card-header">
          <h3>${e.name}</h3>
          ${e.isActive ? '<span class="badge" style="background:rgba(34,197,94,0.15);color:#4ade80;font-size:11px;padding:2px 8px;border-radius:8px;">Active</span>' : ''}
        </div>
        <p class="event-card-meta">${rowCount} legs &middot; ${e.mode === 'scratch' ? 'Editable' : 'CSV'}</p>
        <div class="event-card-actions">
          <a href="/wf-schedule/${e.id}" class="action-btn primary" style="text-decoration:none;">Open Schedule</a>
          ${!e.isActive ? '<button class="action-btn btn-set-active" data-id="' + e.id + '">Set as Active</button>' : ''}
          ${!e.isActive ? '<button class="action-btn btn-delete-event" data-id="' + e.id + '" style="color:var(--danger);">Delete</button>' : ''}
        </div>
      </div>`;
  }).join('');

  const content = `
    <section class="card card-full">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
        <div>
          <h2>WorldFlight Schedules</h2>
          <p style="color:var(--muted);font-size:13px;">Manage event schedules. The active schedule is shown to the public.</p>
        </div>
        <button id="createEventBtn" class="action-btn primary">+ Create New Event</button>
      </div>

      <div class="event-grid">
        ${eventCards || '<p style="color:var(--muted);">No events yet. Create one to get started.</p>'}
      </div>
    </section>

    <!-- CREATE EVENT MODAL -->
    <div id="createEventModal" class="modal hidden">
      <div class="modal-backdrop"></div>
      <div class="modal-dialog">
        <h3>Create New Event</h3>
        <form id="createEventForm">
          <label>
            Schedule Mode
            <select id="eventMode">
              <option value="scratch">From Scratch — fully editable</option>
              <option value="csv">From CSV — linked to Google Sheet</option>
            </select>
          </label>
          <label>
            Event Name
            <input type="text" id="eventName" placeholder="e.g. WorldFlight 2026" required />
          </label>
          <label>
            Year
            <input type="number" id="eventYear" placeholder="2026" min="2020" max="2099" required />
          </label>
          <div id="csvFields">
            <label>
              Google Sheet CSV URL
              <input type="url" id="eventSheetUrl" placeholder="https://docs.google.com/spreadsheets/d/e/.../pub?output=csv" />
            </label>
          </div>
          <label>
            Import Dep Flow rates from
            <select id="eventImportFrom">
              <option value="">None — start fresh</option>
              ${events.map(e => `<option value="${e.id}">${e.name} (${(eventSheetCaches[e.id] || []).length} legs)</option>`).join('')}
            </select>
          </label>
          <p style="color:var(--muted);font-size:11px;margin-top:4px;">Flow rates will be imported but Flow Types will be reset to NONE.</p>
          <div id="createEventMsg" class="modal-message hidden" style="margin-top:8px;"></div>
          <div class="modal-actions">
            <button type="button" class="modal-btn modal-btn-cancel" id="closeCreateEvent">Cancel</button>
            <button type="submit" class="modal-btn modal-btn-submit">Create</button>
          </div>
        </form>
      </div>
    </div>

    <style>
      .event-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
      .event-card {
        padding: 20px; border-radius: 12px;
        background: rgba(255,255,255,0.02); border: 1px solid var(--border);
        transition: background .15s;
      }
      .event-card:hover { background: rgba(255,255,255,0.04); }
      .event-card.event-active { border-color: rgba(34,197,94,0.3); }
      .event-card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
      .event-card-header h3 { margin: 0; font-size: 16px; color: var(--text); }
      .event-card-meta { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
      .event-card-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    </style>

    <script>
    (function() {
      var modal = document.getElementById('createEventModal');
      var form = document.getElementById('createEventForm');
      var msg = document.getElementById('createEventMsg');
      var modeSelect = document.getElementById('eventMode');
      var csvFields = document.getElementById('csvFields');

      // Toggle CSV fields based on mode
      function updateModeFields() {
        if (modeSelect.value === 'csv') {
          csvFields.style.display = '';
        } else {
          csvFields.style.display = 'none';
        }
      }
      modeSelect.addEventListener('change', updateModeFields);
      updateModeFields();

      document.getElementById('createEventBtn').addEventListener('click', function() {
        modal.classList.remove('hidden');
      });
      document.getElementById('closeCreateEvent').addEventListener('click', function() {
        modal.classList.add('hidden');
      });
      modal.querySelector('.modal-backdrop').addEventListener('click', function() {
        modal.classList.add('hidden');
      });

      form.addEventListener('submit', async function(e) {
        e.preventDefault();
        msg.classList.add('hidden');

        var mode = modeSelect.value;
        var sheetUrl = mode === 'csv' ? document.getElementById('eventSheetUrl').value.trim() : '';

        if (mode === 'csv' && !sheetUrl) {
          msg.textContent = 'Google Sheet URL is required for CSV mode.';
          msg.style.color = 'var(--danger)';
          msg.classList.remove('hidden');
          return;
        }

        var res = await fetch('/admin/api/wf-events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: document.getElementById('eventName').value.trim(),
            year: Number(document.getElementById('eventYear').value),
            mode: mode,
            sheetUrl: sheetUrl,
            importFromEventId: Number(document.getElementById('eventImportFrom').value) || null
          })
        });

        if (res.ok) {
          window.location.reload();
        } else {
          var data = await res.json().catch(function() { return {}; });
          msg.textContent = data.error || 'Failed to create event';
          msg.style.color = 'var(--danger)';
          msg.classList.remove('hidden');
        }
      });

      // Set active
      document.addEventListener('click', async function(e) {
        var setBtn = e.target.closest('.btn-set-active');
        if (setBtn) {
          var evtId = setBtn.dataset.id;
          var evtName = setBtn.closest('.event-card').querySelector('h3').textContent;

          // Check current bookings and target backups
          var backupRes = await fetch('/admin/api/wf-events/' + evtId + '/backup-count');
          var backupData = await backupRes.json();
          var hasBackups = backupData.count > 0;

          // Step 1: Confirm switching (warns about current bookings being backed up)
          var proceed = await openConfirmModal({
            title: 'Switch to ' + evtName + '?',
            message: 'All current bookings and slots will be backed up and cancelled. You can restore them later if you switch back.'
          });
          if (!proceed) return;

          // Step 2: If the target event has backups, ask about restoring
          var restoreBookings = false;
          if (hasBackups) {
            restoreBookings = await openConfirmModal({
              title: 'Restore Previous Bookings?',
              message: evtName + ' has ' + backupData.count + ' booking(s) from a previous session. Would you like to restore them?'
            });
          }

          // Show switching overlay
          var overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:rgba(2,6,23,0.9);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;';
          overlay.innerHTML = '<div style="text-align:center;">' +
            '<div style="width:36px;height:36px;border:3px solid rgba(255,255,255,0.1);border-top-color:var(--accent,#38bdf8);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px;"></div>' +
            '<h2 style="color:var(--text,#e5e7eb);font-size:18px;margin:0 0 6px;">Switching Schedule...</h2>' +
            '<p style="color:var(--muted,#94a3b8);font-size:13px;">Backing up bookings and loading ' + evtName + '</p>' +
            '</div>' +
            '<style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
          document.body.appendChild(overlay);

          var res = await fetch('/admin/api/wf-events/' + evtId + '/activate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ restoreBookings: restoreBookings })
          });
          if (res.ok) window.location.reload();
          else { overlay.remove(); alert('Failed to switch schedule'); }
          return;
        }

        var delBtn = e.target.closest('.btn-delete-event');
        if (delBtn) {
          openConfirmModal({
            title: 'Delete Event',
            message: 'This will permanently delete this event and its schedule data. This cannot be undone.'
          }).then(async function(ok) {
            if (!ok) return;
            var res = await fetch('/admin/api/wf-events/' + delBtn.dataset.id, { method: 'DELETE' });
            if (res.ok) window.location.reload();
          });
        }
      });
    })();
    </script>
  `;

  res.send(renderLayout({ title: 'WF Schedules', user, isAdmin, content, layoutClass: 'dashboard-full' }));
});

/* ===== WF EVENT SCHEDULE (PER-EVENT) ===== */
app.get('/wf-schedule/:eventId', requireAdmin, async (req, res) => {
const eventId = Number(req.params.eventId);
const event = wfEvents.find(e => e.id === eventId);
if (!event) return res.redirect('/wf-schedule');

const eventRows = eventSheetCaches[eventId] || [];

if (!req.session.user || !req.session.user.data) {
  return res.redirect('/');
}

const user = req.session.user.data;
const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

if (!isAdmin) {
  return res.status(403).send('You do not have Admin access');
}

// Load suggestions + visit history for the map
const [allSuggestions, allVisited] = await Promise.all([
  prisma.airportSuggestion.findMany({ where: { type: 'visit' }, select: { icao: true } }),
  prisma.wfVisitedAirport.findMany({ orderBy: { year: 'desc' } })
]);

// Aggregate suggestion votes per ICAO and look up coordinates
const voteCounts = {};
for (const s of allSuggestions) {
  voteCounts[s.icao] = (voteCounts[s.icao] || 0) + 1;
}
const suggestedIcaos = Object.keys(voteCounts).filter(i => !/[*]/.test(i));
const airportCoords = suggestedIcaos.length > 0
  ? await prisma.airport.findMany({
      where: { icao: { in: suggestedIcaos } },
      select: { icao: true, lat: true, lon: true, name: true }
    })
  : [];
const suggestedAirports = airportCoords
  .filter(a => a.lat != null && a.lon != null)
  .map(a => ({ icao: a.icao, lat: a.lat, lon: a.lon, name: a.name, votes: voteCounts[a.icao] || 0 }))
  .sort((a, b) => b.votes - a.votes);

const visitHistoryMap = {};
for (const v of allVisited) {
  if (!visitHistoryMap[v.icao]) visitHistoryMap[v.icao] = [];
  visitHistoryMap[v.icao].push(v.year);
}

const currentYear = new Date().getFullYear();
const fiveYearsAgo = currentYear - 5;

const isScratch = event.mode === 'scratch';

const mapAirports = suggestedAirports.map(a => {
  const years = visitHistoryMap[a.icao] || [];
  const recent = years.filter(y => y >= fiveYearsAgo).length;
  const color = recent > 2 ? 'red' : recent >= 1 ? 'amber' : 'green';
  const tooltip = years.length === 0 ? 'Never visited'
    : recent === 0 ? 'Not visited in past 5 years. Last: ' + years[0]
    : 'Visited ' + recent + 'x in past 5 years (' + years.filter(y => y >= fiveYearsAgo).join(', ') + ')';
  return { icao: a.icao, lat: a.lat, lon: a.lon, name: a.name, votes: a.votes, color, tooltip };
});

const content = `
 <script>window.WF_EVENT_ID = ${eventId};</script>
 <div style="margin-bottom:16px;">
   <a href="/wf-schedule" style="color:var(--accent);text-decoration:none;font-size:13px;">&larr; Back to all schedules</a>
   <span style="color:var(--muted);font-size:13px;margin-left:12px;">${event.name}${event.isActive ? ' (Active)' : ''}</span>
 </div>
 <main class="dashboard-full">
<section class="card dashboard-full">

<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
  <h2 style="margin:0;">WorldFlight Admin Schedule</h2>
  <div style="display:flex;gap:8px;align-items:center;">
    ${isScratch ? `
    <div style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;padding:4px 12px;">
      <a href="https://www.simbrief.com/system/profile.php#settings" target="_blank" style="font-size:11px;color:var(--muted);text-decoration:none;" title="Find your Pilot ID in SimBrief Account Settings">SB Pilot ID:</a>
      <input type="text" id="simbriefPilotId" value="" placeholder="e.g. 546033" style="width:80px;padding:2px 6px;background:#0f172a;border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;text-align:center;" />
    </div>
    <div class="turnaround-setting" style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;padding:4px 12px;">
      <span style="font-size:12px;color:var(--muted);">Turnaround:</span>
      <span id="turnaroundDisplay" style="font-size:13px;color:var(--text);font-weight:600;">${event.turnaroundMins || 45} min</span>
      <button type="button" id="editTurnaroundBtn" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:11px;padding:2px 4px;">&#9998;</button>
      <input type="hidden" id="turnaroundInput" value="${event.turnaroundMins || 45}" />
    </div>
    <button id="addRowBtn" class="action-btn" style="background:var(--success);color:#020617;font-weight:600;">+ Add Leg</button>
    ` : `
    <button id="unlinkCsvBtn" class="action-btn" style="background:var(--warning);color:#020617;font-weight:600;">Unlink CSV</button>
    <button id="refreshScheduleBtn" class="action-btn" style="background:var(--accent);color:#020617;font-weight:600;">Force Refresh from Sheet</button>
    `}
  </div>
</div>

<div class="table-scroll">
<table class="departures-table" id="mainDeparturesTable">

<thead>
<tr>
  ${isScratch ? '<th></th>' : ''}
  <th>WF</th>
  <th>From</th>
  <th>To</th>
  <th>Dep Flow</th>
  <th>Flow Type</th>
  <th>Date</th>
  <th>Dep</th>
  <th>Arr</th>
  <th>Block</th>
  <th class="col-route">ATC Route</th>
</tr>
</thead>
<tbody>
${eventRows.map((r, idx) => {
  const sectorKey = `${r.from}-${r.to}`;
  const isFirst = idx === 0;
  return `
<tr data-wf="${r.number}" data-idx="${idx}">
  ${isScratch ? '<td class="col-del" style="white-space:nowrap;">'
    + '<button class="btn-delete-row" data-wf="' + r.number + '" title="Delete leg">&#x2715;</button>'
    + (r.from && r.to ? '<a class="row-icon simbrief-launch" data-from="' + r.from + '" data-to="' + r.to + '" data-wf="' + r.number + '" href="#" title="Generate SimBrief plan">SB</a>' : '')
    + (r.from && r.to ? '<button class="row-icon sb-fetch" data-wf="' + r.number + '" data-from="' + r.from + '" data-to="' + r.to + '" title="Fetch block time from SimBrief">&#x2913;</button>' : '')
    + '</td>' : ''}
  <td><a href="#" class="sector-link" data-wf="${r.number}" data-from="${r.from}" data-to="${r.to}" data-date="${r.date_utc}" data-dep="${r.dep_time_utc}" data-arr="${r.arr_time_utc}" data-block="${r.block_time}" data-route="${r.atc_route}">${r.number}</a></td>
  ${isScratch
    ? '<td><input class="sched-edit" data-field="from" value="' + r.from + '" style="width:60px;text-transform:uppercase;" /></td>'
    : '<td>' + r.from + '</td>'}
  ${isScratch
    ? '<td><input class="sched-edit" data-field="to" value="' + r.to + '" style="width:60px;text-transform:uppercase;" /></td>'
    : '<td>' + r.to + '</td>'}
  <td>
    <input
      class="dep-flow-input"
      type="number"
      data-sector="${sectorKey}"
      placeholder="Rate"
      style="width:70px;"
    />
  </td>
  <td class="col-flowtype">
  <select class="flowtype-select" data-sector="${sectorKey}">
  <option value="NONE">None</option>
  <option value="SLOTTED">Slotted</option>
  <option value="BOOKING_ONLY">Booking Only</option>
</select>
</td>

  ${isScratch
    ? (isFirst
      ? '<td><input class="sched-edit" data-field="dateUtc" value="' + r.date_utc + '" style="width:100px;" /></td>'
      : '<td class="calc-cell" data-field="date">' + r.date_utc + '</td>')
    : '<td>' + r.date_utc + '</td>'}
  ${isScratch
    ? (isFirst
      ? '<td><input class="sched-edit" data-field="depTimeUtc" value="' + r.dep_time_utc + '" style="width:60px;" /></td>'
      : '<td class="calc-cell" data-field="dep">' + r.dep_time_utc + '</td>')
    : '<td>' + r.dep_time_utc + '</td>'}
  ${isScratch && !r.block_time && r.from && r.to
    ? '<td></td><td></td>'
      + '<td><div class="sched-edit sched-route" data-field="atcRoute" contenteditable="true" style="min-width:200px;">' + (r.atc_route || '') + '</div></td>'
    : '<td class="calc-cell" data-field="arr">' + r.arr_time_utc + '</td>'
      + (isScratch
        ? '<td><input class="sched-edit" data-field="blockTime" value="' + r.block_time + '" style="width:60px;" /></td>'
        : '<td>' + r.block_time + '</td>')
      + (isScratch
        ? '<td><input class="sched-edit sched-route" data-field="atcRoute" value="' + r.atc_route + '" style="width:100%;min-width:200px;" /></td>'
        : '<td style="font-size:12px;font-family:monospace;white-space:pre-wrap;word-break:break-all;">' + r.atc_route + '</td>')}
</tr>`;
}).join('')}
</tbody>
</table>
</div>

</section>
</main> 

<footer>
  </section>

<!-- ADD LEG MODAL -->
<div id="addLegModal" class="modal hidden">
  <div class="modal-backdrop"></div>
  <div id="addLegDialog" class="modal-dialog" style="width:95vw;max-width:1400px;padding:0;overflow:hidden;">
    <form id="addLegForm">
    <div style="display:flex;height:75vh;max-height:700px;">

      <!-- LEFT: FORM SECTIONS -->
      <div style="flex:0 0 480px;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:20px;">

        <h3 style="margin:0 0 4px;">Add New Leg</h3>

        <!-- SECTION 1: OVERVIEW -->
        <div class="leg-section">
          <div class="leg-section-title">Overview</div>

          <label>
            Previous Leg
            <select id="addLegPrev" required>
              <option value="START">Start (first leg)</option>
              ${eventRows.map(r => '<option value="' + r.number + '" data-to="' + r.to + '" data-arr="' + r.arr_time_utc + '" data-date="' + r.date_utc + '">' + r.number + ' — ' + r.from + ' to ' + r.to + '</option>').join('')}
            </select>
          </label>

          <table class="leg-fields" style="width:100%;border-collapse:separate;border-spacing:6px 0;">
            <tr>
              <td style="width:50%;"><label>From<input type="text" id="addLegFrom" readonly style="text-transform:uppercase;font-family:monospace;" /></label></td>
              <td style="width:50%;"><label>To<input type="text" id="addLegTo" required placeholder="ICAO" maxlength="4" style="text-transform:uppercase;font-family:monospace;" /></label></td>
              <td style="width:36px;vertical-align:bottom;"><button type="button" id="openMapBtn" class="action-btn" style="padding:7px 8px;" title="Browse suggested airports">🌍</button></td>
            </tr>
            <tr>
              <td><label>Dep Time<input type="text" id="addLegDepTime" readonly style="font-family:monospace;" /></label></td>
              <td><label>Extra Delay<input type="number" id="addLegDelay" min="0" value="0" placeholder="0 mins" /></label></td>
              <td></td>
            </tr>
          </table>
        </div>

        <!-- SECTION 2: ROUTE DETAILS -->
        <div class="leg-section">
          <div class="leg-section-title">Route Details</div>
          <label style="display:block;">
            ATC Route
            <textarea id="addLegRoute" rows="2" placeholder="Enter or paste ATC route..." style="font-family:monospace;font-size:12px;resize:none;overflow:hidden;"></textarea>
          </label>
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button type="button" id="addLegSimbriefGen" class="action-btn" style="font-size:12px;padding:6px 14px;background:var(--accent);color:#020617;font-weight:600;">Plan with SimBrief</button>
            <button type="button" id="addLegSimbriefFetch" class="action-btn" style="font-size:12px;padding:6px 14px;" disabled>Pull SimBrief Data</button>
          </div>
          <div id="addLegSimbriefMsg" style="font-size:11px;color:var(--muted);margin-top:6px;display:none;"></div>

          <label id="addLegFirSection" style="display:none;margin-top:10px;">
            FIR Transit (Staffing Timings)
            <div id="addLegFirList" style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;min-height:28px;"></div>
          </label>
        </div>

        <!-- SECTION 3: FLOW RESTRICTIONS -->
        <div class="leg-section">
          <div class="leg-section-title">Flow Restrictions</div>
          <table class="leg-fields" style="width:100%;border-collapse:separate;border-spacing:6px 0;">
            <tr>
              <td style="width:50%;"><label>Dep Flow (per hour)<input type="number" id="addLegFlow" min="0" placeholder="0" /></label></td>
              <td style="width:50%;"><label>Flow Type<select id="addLegFlowType"><option value="NONE">None</option><option value="SLOTTED">Slotted</option><option value="BOOKING_ONLY">Booking Only</option></select></label></td>
              <td style="width:36px;"></td>
            </tr>
          </table>
        </div>

        <div id="addLegMsg" class="modal-message hidden"></div>

        <div class="modal-actions" style="margin-top:auto;padding-top:12px;">
          <button type="button" class="modal-btn modal-btn-cancel" id="closeAddLeg">Cancel</button>
          <button type="submit" class="modal-btn modal-btn-submit" id="submitAddLeg">Add Leg</button>
        </div>
      </div>

      <!-- RIGHT: MAP -->
      <div id="addLegMapPanel" style="flex:1;border-left:1px solid var(--border);position:relative;background:#0b1220;">
        <div id="addLegMap" style="position:absolute;inset:0;"></div>
        <div id="addLegMapPlaceholder" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:14px;">
          Enter a destination to preview the route
        </div>
      </div>

    </div>
    </form>
  </div>
</div>

<style>
  .leg-section {
    background: rgba(255,255,255,0.02);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .leg-section-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--accent);
    margin-bottom: 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }
  .leg-section label {
    display: block;
    margin-top: 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .leg-section label:first-of-type {
    margin-top: 0;
  }
  .leg-section input,
  .leg-section select,
  .leg-section textarea {
    width: 100%;
    margin-top: 3px;
    padding: 7px 8px;
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 6px;
    color: #e5e7eb;
    font-size: 13px;
    box-sizing: border-box;
  }
  .leg-section input[readonly] {
    color: #64748b;
    background: #080d17;
    cursor: not-allowed;
  }
  #addLegDialog ::-webkit-scrollbar { width: 4px; }
  #addLegDialog ::-webkit-scrollbar-track { background: transparent; }
  #addLegDialog ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
  #addLegDialog ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }
  #addLegDialog { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.08) transparent; }
</style>

<!-- SECTOR OVERVIEW MODAL -->
<div id="sectorModal" class="modal hidden">
  <div class="modal-backdrop"></div>
  <div class="modal-dialog" style="width:560px;">
    <div class="sector-overview">
      <div class="sector-header">
        <span id="sectorWf" class="sector-wf"></span>
        <span id="sectorRoute" class="sector-route-badge"></span>
      </div>

      <div class="sector-airports">
        <div class="sector-airport">
          <span class="sector-label">FROM</span>
          <span id="sectorFrom" class="sector-icao"></span>
        </div>
        <div class="sector-arrow">&#x2708;</div>
        <div class="sector-airport">
          <span class="sector-label">TO</span>
          <span id="sectorTo" class="sector-icao"></span>
        </div>
      </div>

      <div class="sector-times">
        <div class="sector-time-item">
          <span class="sector-label">Date</span>
          <span id="sectorDate" class="sector-value"></span>
        </div>
        <div class="sector-time-item">
          <span class="sector-label">Departure</span>
          <span id="sectorDep" class="sector-value"></span>
        </div>
        <div class="sector-time-item">
          <span class="sector-label">Arrival</span>
          <span id="sectorArr" class="sector-value"></span>
        </div>
        <div class="sector-time-item">
          <span class="sector-label">Block Time</span>
          <span id="sectorBlock" class="sector-value"></span>
        </div>
      </div>

      <div class="sector-route-section">
        <span class="sector-label">ATC Route</span>
        <div id="sectorAtcRoute" class="sector-route-text"></div>
      </div>
    </div>

    <div class="modal-actions" style="margin-top:16px;">
      <button type="button" class="modal-btn modal-btn-cancel" id="closeSectorModal">Close</button>
    </div>
  </div>
</div>

<style>
  .sector-link {
    color: var(--accent); font-weight: 700; text-decoration: none;
    font-family: monospace; font-size: 14px;
  }
  .sector-link:hover { text-decoration: underline; }

  .sector-overview { }
  .sector-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 20px;
  }
  .sector-wf {
    font-size: 28px; font-weight: 700; color: var(--accent);
    font-family: monospace; letter-spacing: 1px;
  }
  .sector-route-badge {
    font-size: 11px; color: var(--muted); background: rgba(255,255,255,0.05);
    padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border);
  }

  .sector-airports {
    display: flex; align-items: center; justify-content: center;
    gap: 24px; margin-bottom: 24px;
  }
  .sector-airport { text-align: center; }
  .sector-icao {
    display: block; font-size: 32px; font-weight: 700; color: var(--text);
    font-family: monospace; letter-spacing: 2px;
  }
  .sector-arrow { font-size: 28px; color: var(--muted); }
  .sector-label {
    font-size: 11px; color: var(--muted); text-transform: uppercase;
    font-weight: 600; letter-spacing: 0.5px;
  }

  .sector-times {
    display: grid; grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 12px; margin-bottom: 20px;
    background: rgba(255,255,255,0.02); border: 1px solid var(--border);
    border-radius: 8px; padding: 14px;
  }
  .sector-time-item { text-align: center; }
  .sector-value {
    display: block; font-size: 16px; font-weight: 600; color: var(--text);
    margin-top: 4px;
  }

  .sector-route-section { margin-top: 12px; }
  .sector-route-text {
    margin-top: 6px; padding: 10px 14px;
    background: rgba(255,255,255,0.02); border: 1px solid var(--border);
    border-radius: 8px; font-family: monospace; font-size: 12px;
    color: var(--text); line-height: 1.6; word-break: break-word;
  }
</style>

<!-- AIRPORT MAP MODAL -->
<div id="airportMapModal" class="modal hidden" style="z-index:10000;">
  <div class="modal-backdrop"></div>
  <div class="modal-dialog" style="width:90vw;max-width:1200px;height:80vh;padding:0;overflow:hidden;display:flex;flex-direction:column;">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border);">
      <h3 style="margin:0;">Select Destination — Suggested Airports</h3>
      <button type="button" id="closeMapModal2" style="background:none;border:none;color:var(--text);font-size:20px;cursor:pointer;">✕</button>
    </div>
    <div id="suggestMap" style="flex:1;"></div>
  </div>
</div>

<script>
  window.MAP_AIRPORTS = ${JSON.stringify(mapAirports)};
</script>

  <script>
if (document.getElementById('refreshScheduleBtn')) {
  document.getElementById('refreshScheduleBtn').onclick = () => {
    openConfirmModal({
      title: 'Refresh from Google Sheet',
      message: 'This will re-import the schedule from the Google Sheet. Any manual edits to fields that also exist in the sheet will be overwritten. Continue?'
    }).then(async (ok) => {
      if (!ok) return;
      var btn = document.getElementById('refreshScheduleBtn');
      btn.disabled = true;
      btn.textContent = 'Refreshing...';
      await fetch('/wf-schedule/refresh-schedule', { method: 'POST' });
      location.reload();
    });
  };
}

if (document.getElementById('unlinkCsvBtn')) {
  document.getElementById('unlinkCsvBtn').onclick = () => {
    openConfirmModal({
      title: 'Unlink CSV?',
      message: 'This will convert this event to a fully editable schedule. The Google Sheet link will be removed and all current data will be kept as editable rows. This cannot be undone.'
    }).then(async (ok) => {
      if (!ok) return;
      var btn = document.getElementById('unlinkCsvBtn');
      btn.disabled = true;
      btn.textContent = 'Unlinking...';
      var res = await fetch('/admin/api/wf-events/' + window.WF_EVENT_ID + '/unlink-csv', { method: 'POST' });
      if (res.ok) location.reload();
    });
  };
}

/* ===== INLINE CELL EDITING ===== */
var saveTimer = {};
document.querySelectorAll('.sched-edit').forEach(function(input) {
  var isContentEditable = input.hasAttribute('contenteditable');
  var originalValue = isContentEditable ? input.textContent.trim() : input.value;
  var eventName = isContentEditable ? 'blur' : 'change';

  input.addEventListener(eventName, function() {
    var currentVal = isContentEditable ? input.textContent.trim() : input.value;
    if (currentVal === originalValue) return;

    var tr = input.closest('tr');
    var wfNumber = tr.dataset.wf;
    var field = input.dataset.field;
    var value = currentVal;

    input.style.borderColor = 'var(--accent)';

    fetch('/admin/api/schedule-row/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: window.WF_EVENT_ID,
        number: wfNumber,
        field: field,
        value: value
      })
    }).then(function(res) {
      if (res.ok) {
        originalValue = value;
        // Reload if a time-affecting field changed
        var timeFields = ['blockTime', 'dateUtc', 'depTimeUtc'];
        if (timeFields.indexOf(field) !== -1) {
          location.reload();
          return;
        }
        input.style.borderColor = 'var(--success)';
        setTimeout(function() { input.style.borderColor = ''; }, 1500);
        if (field === 'number') tr.dataset.wf = value;
      } else {
        input.style.borderColor = 'var(--danger)';
        setTimeout(function() { input.style.borderColor = ''; }, 2000);
      }
    });
  });
});

/* ===== TURNAROUND TIME ===== */
if (document.getElementById('editTurnaroundBtn')) document.getElementById('editTurnaroundBtn').addEventListener('click', function() {
  var currentVal = Number(document.getElementById('turnaroundInput').value) || 45;

  // Reuse callsign modal for input
  var modal = document.getElementById('callsignModal');
  var h3 = modal.querySelector('h3');
  var help = modal.querySelector('.modal-help');
  var input = document.getElementById('callsignModalInput');
  var confirm = document.getElementById('callsignConfirm');
  var cancel = document.getElementById('callsignCancel');
  var hint = modal.querySelector('.modal-hint');
  var error = modal.querySelector('.modal-error');

  h3.textContent = 'Turnaround Time';
  help.textContent = 'All times will be recalculated.';
  input.style.display = '';
  input.type = 'number';
  input.placeholder = 'Minutes';
  input.value = currentVal;
  input.step = '5';
  input.min = '0';
  input.maxLength = '';
  if (hint) hint.style.display = 'none';
  if (error) error.classList.add('hidden');

  // Make modal smaller
  var card = modal.querySelector('.modal-card');
  card.style.maxWidth = '320px';

  modal.classList.remove('hidden');
  input.focus();
  input.select();

  function cleanup() {
    confirm.removeEventListener('click', onConfirm);
    cancel.removeEventListener('click', onCancel);
    input.removeEventListener('keydown', onKey);
    modal.classList.add('hidden');
    input.type = 'text';
    input.step = '';
    input.min = '';
    card.style.maxWidth = '';
    if (hint) hint.style.display = '';
  }

  async function onConfirm() {
    var val = Number(input.value);
    if (!Number.isFinite(val) || val < 0) return;

    var res = await fetch('/admin/api/wf-events/' + window.WF_EVENT_ID + '/turnaround', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnaroundMins: val })
    });

    if (res.ok) {
      document.getElementById('turnaroundInput').value = val;
      cleanup();

      // Show recalculating overlay
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(2,6,23,0.9);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;';
      overlay.innerHTML = '<div style="text-align:center;">' +
        '<div style="width:36px;height:36px;border:3px solid rgba(255,255,255,0.1);border-top-color:var(--accent,#38bdf8);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px;"></div>' +
        '<h2 style="color:var(--text,#e5e7eb);font-size:18px;margin:0 0 6px;">Recalculating...</h2>' +
        '<p style="color:var(--muted,#94a3b8);font-size:13px;">Updating all departure and arrival times</p>' +
        '</div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
      document.body.appendChild(overlay);

      recalcTimes();
    }
  }

  function onCancel() { cleanup(); }
  function onKey(e) {
    if (e.key === 'Enter') onConfirm();
    if (e.key === 'Escape') onCancel();
  }

  confirm.addEventListener('click', onConfirm);
  cancel.addEventListener('click', onCancel);
  input.addEventListener('keydown', onKey);
});

/* ===== TIME RECALCULATION ===== */
function recalcTimes() {
  fetch('/admin/api/schedule-row/recalc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId: window.WF_EVENT_ID })
  }).then(function() {
    location.reload();
  });
}

// Trigger recalc on block time change
document.querySelectorAll('.sched-edit[data-field="blockTime"]').forEach(function(input) {
  input.addEventListener('change', recalcTimes);
});

// Trigger recalc on leg 1 dep time or date change
var firstRowInputs = document.querySelectorAll('tr[data-idx="0"] .sched-edit[data-field="depTimeUtc"], tr[data-idx="0"] .sched-edit[data-field="dateUtc"]');
firstRowInputs.forEach(function(input) {
  input.addEventListener('change', recalcTimes);
});


/* ===== ADD LEG MODAL ===== */
(function() {
  var modal = document.getElementById('addLegModal');
  if (!modal) return;
  var form = document.getElementById('addLegForm');
  var prevSelect = document.getElementById('addLegPrev');
  var fromInput = document.getElementById('addLegFrom');
  var toInput = document.getElementById('addLegTo');
  var msg = document.getElementById('addLegMsg');

  var depTimeInput = document.getElementById('addLegDepTime');
  var delayInput = document.getElementById('addLegDelay');
  var turnaroundMins = Number(document.getElementById('turnaroundInput')?.value) || 45;

  function updateFrom() {
    var opt = prevSelect.options[prevSelect.selectedIndex];
    if (prevSelect.value === 'START') {
      fromInput.value = 'YSSY';
      depTimeInput.value = 'Set in schedule';
    } else {
      fromInput.value = opt.dataset.to || '';
      // Calculate departure time from previous leg arrival + turnaround + delay
      var prevArr = opt.dataset.arr || '';
      var prevDate = opt.dataset.date || '';
      updateDepTime(prevArr, prevDate);
    }
    fromInput.setAttribute('readonly', true);
  }

  function updateDepTime(prevArr, prevDate) {
    if (!prevArr || !prevArr.includes(':')) {
      depTimeInput.value = 'Pending';
      return;
    }
    var parts = prevArr.split(':');
    var h = Number(parts[0]);
    var m = Number(parts[1]);
    var totalMins = h * 60 + m + turnaroundMins + (Number(delayInput.value) || 0);
    var depH = Math.floor(totalMins / 60) % 24;
    var depM = totalMins % 60;
    depTimeInput.value = String(depH).padStart(2, '0') + ':' + String(depM).padStart(2, '0') + ' UTC';
  }

  delayInput.addEventListener('input', function() {
    var opt = prevSelect.options[prevSelect.selectedIndex];
    if (prevSelect.value !== 'START') {
      updateDepTime(opt.dataset.arr || '', opt.dataset.date || '');
    }
  });

  prevSelect.addEventListener('change', updateFrom);
  if (prevSelect.options.length > 1) {
    prevSelect.selectedIndex = prevSelect.options.length - 1;
  }
  updateFrom();

  if (document.getElementById('addRowBtn')) document.getElementById('addRowBtn').addEventListener('click', function() {
    msg.classList.add('hidden');
    modal.classList.remove('hidden');
  });

  document.getElementById('closeAddLeg').addEventListener('click', function() {
    modal.classList.add('hidden');
  });
  modal.querySelector('.modal-backdrop').addEventListener('click', function() {
    modal.classList.add('hidden');
  });

  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    var fromVal = fromInput.value.trim().toUpperCase();
    var toVal = toInput.value.trim().toUpperCase();

    if (!fromVal || !toVal) {
      msg.textContent = 'From and To are required.';
      msg.style.color = 'var(--danger)';
      msg.classList.remove('hidden');
      return;
    }

    var submitBtn = document.getElementById('submitAddLeg');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding...';

    var res = await fetch('/admin/api/schedule-row/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId: window.WF_EVENT_ID,
        from: fromVal,
        to: toVal,
        depFlow: Number(document.getElementById('addLegFlow').value) || 0,
        flowType: document.getElementById('addLegFlowType').value,
        atcRoute: (document.getElementById('addLegRoute').value || '').trim(),
        blockTime: (document.getElementById('addLegSimbriefFetch')?.dataset?.blockTime || '')
      })
    });

    if (res.ok) location.reload();
    else {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Leg';
      msg.textContent = 'Failed to add leg.';
      msg.style.color = 'var(--danger)';
      msg.classList.remove('hidden');
    }
  });

  /* ===== MAP MODAL ===== */
  var mapModal = document.getElementById('airportMapModal');
  var leafletMap = null;

  document.getElementById('openMapBtn').addEventListener('click', function() {
    mapModal.classList.remove('hidden');

    if (!leafletMap) {
      leafletMap = L.map('suggestMap', { zoomControl: true }).setView([20, 0], 2);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '',
        maxZoom: 18
      }).addTo(leafletMap);

      var colorMap = { green: '#22c55e', amber: '#f59e0b', red: '#ef4444' };

      window.MAP_AIRPORTS.forEach(function(ap) {
        var markerColor = colorMap[ap.color] || '#94a3b8';

        var icon = L.divIcon({
          className: 'map-suggest-marker',
          html: '<div style="background:' + markerColor + ';width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,255,255,0.3);"></div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        });

        var marker = L.marker([ap.lat, ap.lon], { icon: icon }).addTo(leafletMap);

        marker.bindTooltip(
          '<strong style="color:' + markerColor + ';">' + ap.icao + '</strong>' +
          (ap.name ? ' — ' + ap.name : '') +
          '<br>' + ap.votes + ' vote' + (ap.votes !== 1 ? 's' : '') +
          '<br><span style="color:#94a3b8;">' + ap.tooltip + '</span>',
          { className: 'map-suggest-tooltip' }
        );

        marker.on('click', function() {
          openConfirmModal({
            title: 'Select ' + ap.icao + '?',
            message: (ap.name || ap.icao) + ' — ' + ap.votes + ' vote' + (ap.votes !== 1 ? 's' : '') + '. ' + ap.tooltip
          }).then(function(ok) {
            if (!ok) return;
            toInput.value = ap.icao;
            toInput.dispatchEvent(new Event('input'));
            mapModal.classList.add('hidden');
          });
        });
      });

      setTimeout(function() { leafletMap.invalidateSize(); }, 200);
    } else {
      setTimeout(function() { leafletMap.invalidateSize(); }, 200);
    }
  });

  document.getElementById('closeMapModal2').addEventListener('click', function() {
    mapModal.classList.add('hidden');
  });
  mapModal.querySelector('.modal-backdrop').addEventListener('click', function() {
    mapModal.classList.add('hidden');
  });
})();

/* ===== DELETE ROW ===== */
document.addEventListener('click', function(e) {
  var btn = e.target.closest('.btn-delete-row');
  if (!btn) return;

  openConfirmModal({
    title: 'Delete Leg',
    message: 'Remove ' + btn.dataset.wf + ' from the schedule?'
  }).then(async function(ok) {
    if (!ok) return;
    var res = await fetch('/admin/api/schedule-row/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: window.WF_EVENT_ID, number: btn.dataset.wf })
    });
    if (res.ok) location.reload();
  });
});

/* ===== GREAT CIRCLE HELPER ===== */
function greatCircleArc(lat1, lon1, lat2, lon2, numPoints) {
  var toRad = Math.PI / 180;
  var toDeg = 180 / Math.PI;
  var f1 = lat1 * toRad, l1 = lon1 * toRad;
  var f2 = lat2 * toRad, l2 = lon2 * toRad;
  var d = 2 * Math.asin(Math.sqrt(
    Math.pow(Math.sin((f2 - f1) / 2), 2) +
    Math.cos(f1) * Math.cos(f2) * Math.pow(Math.sin((l2 - l1) / 2), 2)
  ));
  var points = [];
  for (var i = 0; i <= numPoints; i++) {
    var frac = i / numPoints;
    var a = Math.sin((1 - frac) * d) / Math.sin(d);
    var b = Math.sin(frac * d) / Math.sin(d);
    var x = a * Math.cos(f1) * Math.cos(l1) + b * Math.cos(f2) * Math.cos(l2);
    var y = a * Math.cos(f1) * Math.sin(l1) + b * Math.cos(f2) * Math.sin(l2);
    var z = a * Math.sin(f1) + b * Math.sin(f2);
    points.push([Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg, Math.atan2(y, x) * toDeg]);
  }
  return points;
}

/* ===== ROUTE PREVIEW MAP ===== */
(function() {
  var toInput = document.getElementById('addLegTo');
  var fromInput = document.getElementById('addLegFrom');
  var mapPanel = document.getElementById('addLegMapPanel');
  var dialog = document.getElementById('addLegDialog');

  var placeholder = document.getElementById('addLegMapPlaceholder');

  if (!toInput || !fromInput || !mapPanel) return;

  var legMap = null;
  var legMarkers = [];
  var legLine = null;
  var mapDebounce = null;

  function updateRouteMap() {
    clearTimeout(mapDebounce);
    var fromVal = (fromInput.value || '').trim().toUpperCase();
    var toVal = (toInput.value || '').trim().toUpperCase();

    if (!/^[A-Z]{4}$/.test(fromVal) || !/^[A-Z]{4}$/.test(toVal)) {
      if (placeholder) placeholder.style.display = '';
      return;
    }

    mapDebounce = setTimeout(async function() {
      try {
        var r1 = await fetch('/api/airport-coords/' + fromVal);
        var r2 = await fetch('/api/airport-coords/' + toVal);
        if (!r1.ok || !r2.ok) return;
        var fromAp = await r1.json();
        var toAp = await r2.json();

        if (placeholder) placeholder.style.display = 'none';

        if (!legMap) {
          legMap = L.map('addLegMap', { zoomControl: false, attributionControl: false }).setView([0, 0], 2);
          L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 18 }).addTo(legMap);

          // Load FIR boundaries
          fetch('/api/fir-merged.geojson').then(function(r) { return r.json(); }).then(function(geojson) {
            var firLayer = L.geoJSON(geojson, {
              interactive: false,
              style: { color: '#334155', weight: 1, opacity: 0.4, fillColor: 'transparent', fillOpacity: 0 }
            }).addTo(legMap);

            // FIR name labels — show when zoomed in
            var firLabels = L.layerGroup();
            var seenLabels = {};
            geojson.features.forEach(function(f) {
              if (!f.properties?.id || !f.properties?.label_lat) return;
              var base = f.properties.id.split('-')[0];
              if (seenLabels[base]) return;
              seenLabels[base] = true;
              var label = L.marker(
                [parseFloat(f.properties.label_lat), parseFloat(f.properties.label_lon)],
                { icon: L.divIcon({
                  className: 'fir-label',
                  html: '<span>' + base + '</span>',
                  iconSize: [60, 16],
                  iconAnchor: [30, 8]
                })}
              );
              firLabels.addLayer(label);
            });

            function toggleFirLabels() {
              if (legMap.getZoom() >= 4) {
                if (!legMap.hasLayer(firLabels)) legMap.addLayer(firLabels);
              } else {
                if (legMap.hasLayer(firLabels)) legMap.removeLayer(firLabels);
              }
            }
            legMap.on('zoomend', toggleFirLabels);
            toggleFirLabels();

          }).catch(function() {});
        }

        setTimeout(function() { legMap.invalidateSize(); }, 350);

        legMarkers.forEach(function(m) { legMap.removeLayer(m); });
        legMarkers = [];
        if (legLine) { legMap.removeLayer(legLine); legLine = null; }

        var fromIcon = L.divIcon({ className: '', html: '<div style="background:#4ade80;width:10px;height:10px;border-radius:50%;border:2px solid #fff;"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
        var toIcon = L.divIcon({ className: '', html: '<div style="background:#38bdf8;width:10px;height:10px;border-radius:50%;border:2px solid #fff;"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });

        var m1 = L.marker([fromAp.lat, fromAp.lon], { icon: fromIcon }).addTo(legMap);
        m1.bindTooltip('<strong>' + fromAp.icao + '</strong>', { className: 'map-suggest-tooltip', permanent: true, direction: 'top', offset: [0, -8] });

        var m2 = L.marker([toAp.lat, toAp.lon], { icon: toIcon }).addTo(legMap);
        m2.bindTooltip('<strong>' + toAp.icao + '</strong>', { className: 'map-suggest-tooltip', permanent: true, direction: 'top', offset: [0, -8] });

        legMarkers = [m1, m2];

        // Read route from the Add Leg modal textarea
        var routeTextarea = document.getElementById('addLegRoute');
        var routeStr = routeTextarea ? routeTextarea.value.trim() : '';

        if (routeStr) {
          // Resolve route via API
          var depTimeEl = document.getElementById('addLegDepTime');
          var depTimeVal = depTimeEl ? depTimeEl.value.replace(' UTC', '').trim() : '';
          var blockTimeVal = document.getElementById('addLegSimbriefFetch')?.dataset?.blockTime || '';

          fetch('/api/resolve-route?from=' + fromVal + '&to=' + toVal + '&route=' + encodeURIComponent(routeStr) + '&depTime=' + encodeURIComponent(depTimeVal) + '&blockTime=' + encodeURIComponent(blockTimeVal))
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (data.points && data.points.length >= 2) {
                var routeCoords = data.points.map(function(p) { return [p.lat, p.lon]; });

                // Draw resolved route as solid line
                var routeLine = L.polyline(routeCoords, { color: '#f59e0b', weight: 2.5, opacity: 0.9 }).addTo(legMap);
                legMarkers.push(routeLine);

                // Add small dots for each waypoint
                data.points.forEach(function(p, i) {
                  if (i === 0 || i === data.points.length - 1) return;
                  var wpIcon = L.divIcon({ className: '', html: '<div style="background:#f59e0b;width:4px;height:4px;border-radius:50%;"></div>', iconSize: [4, 4], iconAnchor: [2, 2] });
                  var wpM = L.marker([p.lat, p.lon], { icon: wpIcon }).addTo(legMap);
                  wpM.bindTooltip(p.name, { className: 'map-suggest-tooltip' });
                  legMarkers.push(wpM);
                });

                legMap.fitBounds(routeLine.getBounds(), { padding: [20, 20], animate: false });
              }

            }).catch(function() {});
        }

        // Great circle arc (always shown as dashed reference)
        var gcPoints = greatCircleArc(fromAp.lat, fromAp.lon, toAp.lat, toAp.lon, 80);
        legLine = L.polyline(gcPoints, {
          color: '#38bdf8', weight: 1.5, opacity: 0.3, dashArray: '4,6'
        }).addTo(legMap);

        legMap.fitBounds(legLine.getBounds(), { padding: [20, 20], animate: false });

      } catch(err) { console.error('[ROUTE MAP ERROR]', err); }
    }, 400);
  }

  toInput.addEventListener('input', updateRouteMap);
  toInput.addEventListener('change', updateRouteMap);

  var routeTextarea = document.getElementById('addLegRoute');
  if (routeTextarea) {
    var routeDebounce = null;
    routeTextarea.addEventListener('input', function() {
      routeTextarea.style.height = 'auto';
      routeTextarea.style.height = routeTextarea.scrollHeight + 'px';
      clearTimeout(routeDebounce);
      routeDebounce = setTimeout(updateRouteMap, 600);
    });
  }
})();

/* ===== ADD LEG SIMBRIEF ===== */
(function() {
  var genBtn = document.getElementById('addLegSimbriefGen');
  var fetchBtn = document.getElementById('addLegSimbriefFetch');
  var msgEl = document.getElementById('addLegSimbriefMsg');
  var routeTextarea = document.getElementById('addLegRoute');
  var fromInput = document.getElementById('addLegFrom');
  var toInput = document.getElementById('addLegTo');

  if (!genBtn || !fetchBtn) return;

  genBtn.addEventListener('click', function() {
    var from = (fromInput.value || '').trim().toUpperCase();
    var to = (toInput.value || '').trim().toUpperCase();
    var route = (routeTextarea.value || '').trim();

    if (!from || !to) { alert('Enter From and To first.'); return; }

    var pilotId = (document.getElementById('simbriefPilotId')?.value || '').trim();

    var url = 'https://dispatch.simbrief.com/options/custom'
      + '?orig=' + encodeURIComponent(from)
      + '&dest=' + encodeURIComponent(to)
      + (route ? '&route=' + encodeURIComponent(route) : '')
      + '&type=B738'
      + '&cruise=M78'
      + '&manualrmk=' + encodeURIComponent('WorldFlight Validated Route - www.planning.worldflight.center');

    window.open(url, 'simbrief', 'width=1100,height=750,scrollbars=yes,resizable=yes');

    // Enable fetch button
    fetchBtn.disabled = false;
    fetchBtn.style.background = 'var(--success)';
    fetchBtn.style.color = '#020617';
    fetchBtn.style.fontWeight = '600';
    msgEl.textContent = 'Generate your plan in SimBrief, then click Pull SimBrief Data.';
    msgEl.style.display = '';
    msgEl.style.color = 'var(--accent)';
  });

  fetchBtn.addEventListener('click', async function() {
    var pilotId = (document.getElementById('simbriefPilotId')?.value || '').trim();
    if (!pilotId) { alert('Enter your SimBrief Pilot ID first.'); return; }

    var from = (fromInput.value || '').trim().toUpperCase();
    var to = (toInput.value || '').trim().toUpperCase();

    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Fetching...';
    msgEl.textContent = 'Fetching from SimBrief...';
    msgEl.style.color = 'var(--accent)';

    try {
      var res = await fetch('https://www.simbrief.com/api/xml.fetcher.php?userid=' + encodeURIComponent(pilotId) + '&json=1');
      var data = await res.json();

      if (!data || !data.times) throw new Error('No flight plan found');

      var ofpOrig = (data.origin?.icao_code || '').toUpperCase();
      var ofpDest = (data.destination?.icao_code || '').toUpperCase();

      if (ofpOrig !== from || ofpDest !== to) {
        msgEl.textContent = 'Latest plan is ' + ofpOrig + ' → ' + ofpDest + ', expected ' + from + ' → ' + to + '. Generate the correct plan first.';
        msgEl.style.color = 'var(--danger)';
        fetchBtn.disabled = false;
        fetchBtn.textContent = 'Pull SimBrief Data';
        return;
      }

      // Extract route and block time
      var ofpRoute = data.general?.route || '';
      var blockSecs = Number(data.times?.sched_block) || Number(data.times?.est_block) || 0;
      var blockHrs = Math.floor(blockSecs / 3600);
      var blockMins = Math.floor((blockSecs % 3600) / 60);
      var blockStr = String(blockHrs).padStart(2, '0') + ':' + String(blockMins).padStart(2, '0');

      // Fill in route
      if (ofpRoute) {
        routeTextarea.value = ofpRoute;
        routeTextarea.dispatchEvent(new Event('input'));
      }

      msgEl.innerHTML = 'Route and block time (' + blockStr + ') loaded from SimBrief.';
      msgEl.style.color = 'var(--success)';

      // Store block time for when we submit
      fetchBtn.dataset.blockTime = blockStr;
      fetchBtn.textContent = 'Pull SimBrief Data';
      fetchBtn.disabled = true;

      // Now fetch FIR transit data with block time available
      var depTimeEl = document.getElementById('addLegDepTime');
      var depTimeVal = depTimeEl ? depTimeEl.value.replace(' UTC', '').trim() : '';
      var firSection = document.getElementById('addLegFirSection');

      if (from && to && ofpRoute && depTimeVal && blockStr) {
        fetch('/api/resolve-route?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + '&route=' + encodeURIComponent(ofpRoute) + '&depTime=' + encodeURIComponent(depTimeVal) + '&blockTime=' + encodeURIComponent(blockStr))
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.firs && data.firs.length && firSection) {
              firSection.style.display = 'block';
              var firList = document.getElementById('addLegFirList');
              firList.innerHTML = data.firs.map(function(f) {
                var label = f.fir;
                if (f.staffStart && f.staffEnd) {
                  label += ' <span class="fir-time">' + f.staffStart + ' – ' + f.staffEnd + '</span>';
                }
                return '<span class="fir-tag">' + label + '</span>';
              }).join('');
            }
          }).catch(function() {});
      }

    } catch(err) {
      msgEl.textContent = 'Failed: ' + err.message;
      msgEl.style.color = 'var(--danger)';
      fetchBtn.disabled = false;
      fetchBtn.textContent = 'Pull SimBrief Data';
    }
  });
})();

/* ===== SIMBRIEF PILOT ID (persist in localStorage) ===== */
(function() {
  var pidInput = document.getElementById('simbriefPilotId');
  if (!pidInput) return;
  pidInput.value = localStorage.getItem('simbriefPilotId') || '52776';
  pidInput.addEventListener('change', function() {
    localStorage.setItem('simbriefPilotId', pidInput.value.trim());
  });
})();

/* ===== SECTOR OVERVIEW ===== */
(function() {
  var sectorModal = document.getElementById('sectorModal');
  if (!sectorModal) return;

  document.addEventListener('click', function(e) {
    var link = e.target.closest('.sector-link');
    if (!link) return;
    e.preventDefault();

    document.getElementById('sectorWf').textContent = link.dataset.wf;
    document.getElementById('sectorFrom').textContent = link.dataset.from || '—';
    document.getElementById('sectorTo').textContent = link.dataset.to || '—';
    document.getElementById('sectorDate').textContent = link.dataset.date || '—';
    document.getElementById('sectorDep').textContent = link.dataset.dep || '—';
    document.getElementById('sectorArr').textContent = link.dataset.arr || '—';
    document.getElementById('sectorBlock').textContent = link.dataset.block || '—';
    document.getElementById('sectorAtcRoute').textContent = link.dataset.route || 'No route set';
    document.getElementById('sectorRoute').textContent = (link.dataset.from || '') + ' → ' + (link.dataset.to || '');

    sectorModal.classList.remove('hidden');
  });

  document.getElementById('closeSectorModal').addEventListener('click', function() {
    sectorModal.classList.add('hidden');
  });
  sectorModal.querySelector('.modal-backdrop').addEventListener('click', function() {
    sectorModal.classList.add('hidden');
  });
})();

/* ===== SIMBRIEF GENERATE ===== */
document.addEventListener('click', function(e) {
  var btn = e.target.closest('.simbrief-launch');
  if (!btn) return;
  e.preventDefault();

  var tr = btn.closest('tr');
  var from = btn.dataset.from;
  var to = btn.dataset.to;
  var routeEl = tr.querySelector('[data-field="atcRoute"]');
  var route = routeEl ? (routeEl.value || routeEl.textContent || '').trim() : '';

  var url = 'https://dispatch.simbrief.com/options/custom'
    + '?orig=' + encodeURIComponent(from)
    + '&dest=' + encodeURIComponent(to)
    + (route ? '&route=' + encodeURIComponent(route) : '')
    + '&type=B738'
    + '&cruise=M78'
    + '&manualrmk=' + encodeURIComponent('WorldFlight Validated Route - www.planning.worldflight.center');

  window.open(url, 'simbrief', 'width=1100,height=750,scrollbars=yes,resizable=yes');
});

/* ===== SIMBRIEF FETCH RESULT ===== */
document.addEventListener('click', async function(e) {
  var btn = e.target.closest('.sb-fetch');
  if (!btn) return;

  var pilotId = (document.getElementById('simbriefPilotId')?.value || '').trim();
  if (!pilotId) {
    alert('Enter your SimBrief Pilot ID in the top bar first.');
    return;
  }

  var tr = btn.closest('tr');
  var wfNum = btn.dataset.wf;
  var from = btn.dataset.from;
  var to = btn.dataset.to;

  btn.disabled = true;

  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(2,6,23,0.9);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = '<div style="text-align:center;">'
    + '<div style="width:36px;height:36px;border:3px solid rgba(255,255,255,0.1);border-top-color:var(--accent,#38bdf8);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px;"></div>'
    + '<h2 style="color:var(--text,#e5e7eb);font-size:18px;margin:0 0 6px;">Fetching from SimBrief...</h2>'
    + '<p style="color:var(--muted,#94a3b8);font-size:13px;">' + from + ' to ' + to + '</p>'
    + '</div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
  document.body.appendChild(overlay);

  try {
    var res = await fetch('https://www.simbrief.com/api/xml.fetcher.php?userid=' + encodeURIComponent(pilotId) + '&json=1');
    var data = await res.json();

    if (!data || !data.times) {
      throw new Error('No flight plan found');
    }

    // Verify it matches our route
    var ofpOrig = (data.origin?.icao_code || '').toUpperCase();
    var ofpDest = (data.destination?.icao_code || '').toUpperCase();

    if (ofpOrig !== from.toUpperCase() || ofpDest !== to.toUpperCase()) {
      overlay.remove();
      // Show as info-only modal (hide cancel, change confirm to OK)
      var modal = document.getElementById('callsignModal');
      var card = modal.querySelector('.modal-card');
      var h3 = card.querySelector('h3');
      var help = card.querySelector('.modal-help');
      var input = document.getElementById('callsignModalInput');
      var confirmBtn = document.getElementById('callsignConfirm');
      var cancelBtn = document.getElementById('callsignCancel');
      var hint = card.querySelector('.modal-hint');

      h3.textContent = 'Wrong Flight Plan';
      help.textContent = 'Your latest SimBrief plan is ' + ofpOrig + ' \u2192 ' + ofpDest + ', but this leg is ' + from + ' \u2192 ' + to + '. Please generate the correct plan in SimBrief first (click SB), then try Fetch again.';
      input.style.display = 'none';
      if (hint) hint.style.display = 'none';
      cancelBtn.style.display = 'none';
      confirmBtn.textContent = 'OK';
      modal.classList.remove('hidden');

      await new Promise(function(resolve) {
        function done() {
          modal.classList.add('hidden');
          input.style.display = '';
          if (hint) hint.style.display = '';
          cancelBtn.style.display = '';
          confirmBtn.textContent = 'Confirm';
          confirmBtn.removeEventListener('click', done);
          resolve();
        }
        confirmBtn.addEventListener('click', done);
      });
      btn.disabled = false;
      btn.textContent = '⤓';
      return;
    }

    // Extract block time (in seconds) and route
    var blockSecs = Number(data.times?.sched_block) || Number(data.times?.est_block) || 0;
    var blockHrs = Math.floor(blockSecs / 3600);
    var blockMins = Math.floor((blockSecs % 3600) / 60);
    var blockStr = String(blockHrs).padStart(2, '0') + ':' + String(blockMins).padStart(2, '0');

    var ofpRoute = data.general?.route || '';

    // Save block time
    await fetch('/admin/api/schedule-row/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: window.WF_EVENT_ID, number: wfNum, field: 'blockTime', value: blockStr })
    });

    // Save route from SimBrief
    if (ofpRoute) {
      await fetch('/admin/api/schedule-row/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: window.WF_EVENT_ID, number: wfNum, field: 'atcRoute', value: ofpRoute })
      });
    }

    location.reload();
  } catch(err) {
    overlay.remove();
    alert('Failed to fetch from SimBrief: ' + err.message);
    btn.disabled = false;
    btn.textContent = '\u2913';
  }
});

</script>

<style>
  .sched-edit {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text);
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 13px;
    font-family: inherit;
    transition: border-color .2s;
  }
  .sched-edit:hover { border-color: var(--border); }
  .sched-edit:focus {
    border-color: var(--accent);
    outline: none;
    background: rgba(56,189,248,0.05);
  }
  div.sched-route {
    font-family: monospace;
    font-size: 12px;
    line-height: 1.5;
    word-break: break-word;
    white-space: normal;
    padding: 4px 6px;
    border: 1px solid transparent;
    border-radius: 4px;
    outline: none;
    transition: border-color .2s;
  }
  div.sched-route:hover { border-color: var(--border); }
  div.sched-route:focus { border-color: var(--accent); background: rgba(56,189,248,0.05); }
  div.sched-route:empty::before {
    content: 'Enter ATC route...';
    color: var(--muted2);
  }
  #mainDeparturesTable .col-route {
    max-width: none;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  ${isScratch ? `
  #mainDeparturesTable { table-layout:auto; }
  ` : `
  #mainDeparturesTable { table-layout:auto; }
  #mainDeparturesTable td { font-size:13px; white-space:nowrap; }
  #mainDeparturesTable td:last-child { white-space:normal; }
  `}
  .calc-cell {
    color: var(--text);
    font-size: 13px;
    padding: 4px 6px;
  }
  .map-suggest-tooltip {
    background: #0b1220 !important;
    border: 1px solid #1e293b !important;
    color: #e5e7eb !important;
    font-size: 12px !important;
    padding: 8px 12px !important;
    border-radius: 8px !important;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5) !important;
  }
  .map-suggest-tooltip::before { border-top-color: #1e293b !important; }
  .map-suggest-marker { background: transparent !important; border: none !important; }
  #addLegMap path { pointer-events: visibleStroke; cursor: default; }
  #addLegMap path:focus { outline: none; }
  .fir-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    background: rgba(56,189,248,0.08);
    border: 1px solid rgba(56,189,248,0.2);
    border-radius: 4px;
    font-size: 11px;
    font-family: monospace;
    font-weight: 600;
    color: var(--accent);
  }
  .fir-time {
    color: var(--muted);
    font-weight: 400;
    font-size: 10px;
  }
  .fir-label {
    background: none !important; border: none !important; box-shadow: none !important;
    text-align: center;
  }
  .fir-label span {
    font-size: 9px; font-weight: 600; color: rgba(148,163,184,0.5);
    letter-spacing: 1px; text-transform: uppercase;
  }
  .col-del { width:0; padding:0 !important; white-space:nowrap; }
  .btn-delete-row {
    background:none; border:none; color:var(--danger); cursor:pointer;
    font-size:11px; padding:2px 4px; opacity:0.3; transition:opacity .15s; line-height:1;
  }
  .btn-delete-row:hover { opacity:1; }
  .row-icon {
    background: none; border: none; cursor: pointer;
    font-size: 10px; font-weight: 700; padding: 2px 3px;
    border-radius: 3px; text-decoration: none;
    opacity: 0.4; transition: opacity .15s;
    display: inline-block; line-height: 1;
  }
  .row-icon:hover { opacity: 1; }
  a.row-icon.simbrief-launch { color: #60a5fa; }
  button.row-icon.sb-fetch { color: #4ade80; font-size: 13px; }
</style>

<script src="/socket.io/socket.io.js"></script>

<script>
const socket = io({
  query: {
    icao: window.ICAO
  }
});


/* ===== DEP FLOW COLOUR LOGIC ===== */
function applyDepFlowStyle(input) {
  const val = Number(input.value);

  input.classList.remove('dep-flow-low', 'dep-flow-mid', 'dep-flow-high');

  if (!val) return;

  if (val <= 20) {
    input.classList.add('dep-flow-low');    // RED
  } else if (val >= 21 && val <= 40) {
    input.classList.add('dep-flow-mid');    // ORANGE
  } else if (val >= 41) {
    input.classList.add('dep-flow-high');   // GREEN
  }
}

/* ===== DEP FLOW: LOADING STATE ===== */
document.querySelectorAll('.dep-flow-input').forEach(function(inp) {
  inp.style.opacity = '0.3';
  inp.disabled = true;
});

/* ===== DEP FLOW: REQUEST EVENT-SPECIFIC FLOWS ===== */
if (window.WF_EVENT_ID) {
  socket.emit('requestEventFlows', { eventId: window.WF_EVENT_ID });
}

/* ===== DEP FLOW: INITIAL SYNC (+ COLOUR) ===== */
socket.on('syncDepFlows', flows => {
  // Remove loading state
  document.querySelectorAll('.dep-flow-input').forEach(function(inp) {
    inp.style.opacity = '';
    inp.disabled = false;
  });

  window.sharedFlowRates = flows;
  Object.entries(flows).forEach(([sector, value]) => {
    const input = document.querySelector('.dep-flow-input[data-sector="' + sector + '"]');
    if (input) {
      input.value = value;
      applyDepFlowStyle(input);
    }
  });
});

/* ===== DEP FLOW: LIVE UPDATE ===== */
socket.on('depFlowUpdated', ({ sector, value }) => {
  const input = document.querySelector('.dep-flow-input[data-sector="' + sector + '"]');
  if (input) {
    input.value = value;
    applyDepFlowStyle(input);
  }
});

/* ===== DEP FLOW: LOCAL EDIT ===== */
document.querySelectorAll('.dep-flow-input').forEach(input => {
  input.addEventListener('input', () => {
    applyDepFlowStyle(input);

    socket.emit('updateDepFlow', {
      sector: input.dataset.sector,
      value: input.value,
      eventId: window.WF_EVENT_ID || null
    });
  });
});


</script>
<script>
/* ===============================
   USER CONTEXT
================================ */

// These values already exist server-side
const USER_CONTEXT = {
  cid: ${req.session.user?.data?.cid || 'null'},
  isAdmin: ${ADMIN_CIDS.includes(Number(req.session.user?.data?.cid))},
  isATC: ${!!req.session.user?.data?.controller},
};

/* ===============================
   ROLE VISIBILITY
================================ */

document.querySelectorAll('.admin-only').forEach(el => {
  if (!USER_CONTEXT.isAdmin) el.remove();
});

document.querySelectorAll('.atc-only').forEach(el => {
  if (!USER_CONTEXT.isATC) el.remove();
});

document.querySelectorAll('.pilot-only').forEach(el => {
  if (USER_CONTEXT.isATC) el.remove();
});

/* ===============================
   ACTIVE PAGE HIGHLIGHT
================================ */

const path = window.location.pathname;
document.querySelectorAll('.nav-item').forEach(link => {
  if (path.startsWith(link.dataset.path)) {
    link.classList.add('active');
  }
});

/* ===============================
   SIDEBAR TOGGLE (PERSISTENT)
================================ */

const sidebar = document.getElementById('sidebar');
const toggleBtn = document.getElementById('sidebarToggle');

const collapsed = localStorage.getItem('sidebarCollapsed') === 'true';

if (collapsed) {
  sidebar.classList.add('collapsed');
  document.body.classList.add('sidebar-collapsed');
}

toggleBtn.onclick = () => {
  sidebar.classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed');

  localStorage.setItem(
    'sidebarCollapsed',
    sidebar.classList.contains('collapsed')
  );
};

function onSidebarToggle() {
  document.body.classList.toggle('sidebar-collapsed');

  // Give CSS time to finish transition
  setTimeout(() => {
    if (window.wfWorldMap) {
      window.wfWorldMap.invalidateSize({ animate: false });
    }
  }, 260); // match CSS transition duration
}

</script>
<script>
document.addEventListener('click', function (e) {
  const btn = e.target.closest('.route-toggle');
  if (!btn) return;

  const wrapper = btn.closest('.route-collapsible');
  const text = wrapper.querySelector('.route-text');

  const expanded = btn.getAttribute('aria-expanded') === 'true';

  btn.setAttribute('aria-expanded', String(!expanded));
  btn.textContent = expanded ? 'Show route' : 'Hide route';

  text.classList.toggle('collapsed', expanded);
});
</script>
<script>
document.addEventListener('DOMContentLoaded', () => {

  /* ===== FLOW TYPE: LOADING STATE ===== */
  document.querySelectorAll('.flowtype-select').forEach(function(sel) {
    sel.style.opacity = '0.3';
    sel.disabled = true;
  });

  /* ===== FLOW TYPE: INITIAL SYNC ===== */
  socket.on('syncFlowTypes', types => {
    document.querySelectorAll('.flowtype-select').forEach(function(sel) {
      sel.style.opacity = '';
      sel.disabled = false;
    });

    window.sharedFlowTypes = types || {};

    document.querySelectorAll('.flowtype-select').forEach(sel => {
      const sector = sel.dataset.sector;
      const value = window.sharedFlowTypes[sector] || 'NONE';
      sel.value = value;
    });
  });

  /* ===== FLOW TYPE: LIVE UPDATE ===== */
  socket.on('depFlowTypeUpdated', ({ sector, flowtype }) => {
    const sel = document.querySelector(
      '.flowtype-select[data-sector="' + sector + '"]'
    );
    if (sel) sel.value = flowtype || 'NONE';
  });

  /* ===== FLOW TYPE: LOCAL EDIT ===== */
  document.querySelectorAll('.flowtype-select').forEach(sel => {
    sel.addEventListener('change', () => {
      socket.emit('updateDepFlowType', {
        sector: sel.dataset.sector,
        flowtype: sel.value,
        eventId: window.WF_EVENT_ID || null
      });
    });
  });

});
</script>



`;
res.send(
  renderLayout({
    title: event.name + ' — Schedule',
    user,
    isAdmin,
    layoutClass: 'dashboard-full',
    content
  })
);

});

app.get('/api/fir-merged.geojson', (req, res) => {
  const merged = {};

  for (const f of firFeatures) {
    const rawId = f.properties?.id;
    if (!rawId) continue;
    const base = rawId.split('-')[0];

    if (!merged[base]) {
      merged[base] = {
        type: 'Feature',
        properties: {
          id: base,
          region: f.properties?.region || '',
          division: f.properties?.division || '',
          label_lat: f.properties?.label_lat,
          label_lon: f.properties?.label_lon
        },
        geometry: { type: 'MultiPolygon', coordinates: [] }
      };
    }

    const geom = f.geometry;
    if (!geom) continue;
    if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) merged[base].geometry.coordinates.push(poly);
    } else if (geom.type === 'Polygon') {
      merged[base].geometry.coordinates.push(geom.coordinates);
    }
  }

  res.json({
    type: 'FeatureCollection',
    features: Object.values(merged)
  });
});

app.get('/api/airport-coords/:icao', async (req, res) => {
  const icao = req.params.icao?.toUpperCase();
  if (!icao || !/^[A-Z]{4}$/.test(icao)) return res.status(400).json({ error: 'Invalid' });
  const ap = await prisma.airport.findUnique({ where: { icao }, select: { icao: true, name: true, lat: true, lon: true } });
  if (!ap) return res.status(404).json({ error: 'Not found' });
  res.json(ap);
});

app.get('/api/resolve-route', async (req, res) => {
  const { from, to, route } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const points = [];

  // Add departure airport
  const depAp = await prisma.airport.findUnique({ where: { icao: from.toUpperCase() }, select: { lat: true, lon: true } });
  if (depAp) points.push({ name: from.toUpperCase(), lat: depAp.lat, lon: depAp.lon });

  // Parse route tokens — always pick the fix closest to the previous resolved point
  if (route) {
    const tokens = route.split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const lastPt = points.length > 0 ? points[points.length - 1] : (depAp || { lat: 0, lon: 0 });

      // Lat/lon fix (e.g. 52N020W, 8128S17000W)
      const llFix = parseNavLatLon(tok);
      if (llFix) { points.push({ name: tok, lat: llFix.lat, lon: llFix.lon }); continue; }

      // Skip airway identifiers (e.g. P2, UL416, A338, Q475, J92, V115, DCT)
      const upper = tok.toUpperCase();
      if (/^(DCT|[A-Z]{1,2}\d{1,4}|[A-Z]\d{1,4}[A-Z]?)$/.test(upper) && upper.length <= 5 && /\d/.test(upper)) continue;
      if (upper === 'DCT') continue;

      // Named fix from navdata — pick closest to previous point
      const fix = closestFix(upper, lastPt.lat, lastPt.lon);
      if (fix) { points.push({ name: upper, lat: fix.lat, lon: fix.lon }); continue; }

      // ICAO airport code
      if (/^[A-Z]{4}$/.test(tok.toUpperCase())) {
        const ap = await prisma.airport.findUnique({ where: { icao: tok.toUpperCase() }, select: { lat: true, lon: true } });
        if (ap) { points.push({ name: tok.toUpperCase(), lat: ap.lat, lon: ap.lon }); continue; }
      }
      // Skip unresolvable tokens (airway names like UL416, SID/STAR names)
    }
  }

  // Add arrival airport
  const arrAp = await prisma.airport.findUnique({ where: { icao: to.toUpperCase() }, select: { lat: true, lon: true } });
  if (arrAp) points.push({ name: to.toUpperCase(), lat: arrAp.lat, lon: arrAp.lon });

  // Deduplicate consecutive identical points
  const cleaned = [];
  for (const p of points) {
    const prev = cleaned[cleaned.length - 1];
    if (!prev || prev.lat !== p.lat || prev.lon !== p.lon) cleaned.push({ ...p });
  }

  // Fix antimeridian crossings — adjust longitudes so no segment jumps >180°
  for (let i = 1; i < cleaned.length; i++) {
    const diff = cleaned[i].lon - cleaned[i - 1].lon;
    if (diff > 180) cleaned[i].lon -= 360;
    else if (diff < -180) cleaned[i].lon += 360;
  }

  // Calculate cumulative distances between route points (in nm)
  const toRad = Math.PI / 180;
  function haversineNm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 3440.065;
  }

  let totalDist = 0;
  const cumDist = [0];
  for (let i = 1; i < cleaned.length; i++) {
    totalDist += haversineNm(cleaned[i - 1].lat, cleaned[i - 1].lon, cleaned[i].lat, cleaned[i].lon);
    cumDist.push(totalDist);
  }

  // Sample route at fine intervals and determine FIR at each point
  const SAMPLES = 100;
  const firSegments = []; // { fir, entryFrac, exitFrac }
  let lastFir = null;

  for (let s = 0; s <= SAMPLES; s++) {
    const frac = s / SAMPLES;
    const targetDist = frac * totalDist;

    // Find which segment this falls in
    let segIdx = 0;
    for (let i = 1; i < cumDist.length; i++) {
      if (cumDist[i] >= targetDist) { segIdx = i - 1; break; }
      if (i === cumDist.length - 1) segIdx = i - 1;
    }

    const segLen = cumDist[segIdx + 1] - cumDist[segIdx];
    const segFrac = segLen > 0 ? (targetDist - cumDist[segIdx]) / segLen : 0;
    const sLat = cleaned[segIdx].lat + (cleaned[segIdx + 1].lat - cleaned[segIdx].lat) * segFrac;
    const sLon = cleaned[segIdx].lon + (cleaned[segIdx + 1].lon - cleaned[segIdx].lon) * segFrac;

    const firs = getFirsForPoint(sLat, sLon);
    const firId = firs[0] || null;

    if (firId && firId !== lastFir) {
      if (firSegments.length > 0) {
        firSegments[firSegments.length - 1].exitFrac = frac;
      }
      firSegments.push({ fir: firId, entryFrac: frac, exitFrac: 1.0 });
      lastFir = firId;
    }
  }
  if (firSegments.length > 0) {
    firSegments[firSegments.length - 1].exitFrac = 1.0;
  }

  // Calculate staffing windows using depTime and blockTime from query
  const depTimeStr = req.query.depTime || '';
  const blockTimeStr = req.query.blockTime || '';
  const depParts = depTimeStr.split(':');
  const blockParts = blockTimeStr.split(':');
  const depMins = depParts.length >= 2 ? Number(depParts[0]) * 60 + Number(depParts[1]) : null;
  const blockMins = blockParts.length >= 2 ? Number(blockParts[0]) * 60 + Number(blockParts[1]) : null;

  const firTransits = firSegments.map(seg => {
    const result = { fir: seg.fir, entryFrac: seg.entryFrac, exitFrac: seg.exitFrac };

    if (depMins !== null && blockMins !== null && blockMins > 0) {
      const entryMins = depMins + seg.entryFrac * blockMins;
      const exitMins = depMins + seg.exitFrac * blockMins;
      const staffStart = Math.floor((entryMins - 60) / 5) * 5;
      const staffEnd = Math.ceil((exitMins + 60) / 5) * 5;

      result.staffStart = String(Math.floor(((staffStart % 1440) + 1440) % 1440 / 60)).padStart(2, '0') + ':' + String(Math.floor(((staffStart % 1440) + 1440) % 1440 % 60)).padStart(2, '0');
      result.staffEnd = String(Math.floor(((staffEnd % 1440) + 1440) % 1440 / 60)).padStart(2, '0') + ':' + String(Math.floor(((staffEnd % 1440) + 1440) % 1440 % 60)).padStart(2, '0');
    }

    return result;
  });

  res.json({ points: cleaned, firs: firTransits });
});

// ===== AIRSPACE MANAGEMENT API =====
// Cache FIR analysis per event to avoid recomputing on every page load
let firAnalysisCache = { eventId: null, data: null, building: null };

async function buildFirAnalysis() {
  if (firAnalysisCache.eventId === activeEventId && firAnalysisCache.data) {
    return firAnalysisCache.data;
  }
  // De-dupe concurrent builds
  if (firAnalysisCache.building) return firAnalysisCache.building;

  const buildPromise = _buildFirAnalysisInner();
  firAnalysisCache.building = buildPromise;
  try {
    const result = await buildPromise;
    firAnalysisCache = { eventId: activeEventId, data: result, building: null };
    return result;
  } catch (err) {
    firAnalysisCache.building = null;
    throw err;
  }
}

async function _buildFirAnalysisInner() {
  const legs = adminSheetCache.filter(r => r?.from && r?.to);
  const firMap = {}; // firId -> { legs: [...], totalStaffMins, ... }

  // Batch-load all airports in one query to avoid N+1
  const allIcaos = new Set();
  for (const leg of legs) {
    allIcaos.add(leg.from);
    allIcaos.add(leg.to);
    if (leg.atc_route) {
      for (const tok of leg.atc_route.split(/\s+/).filter(Boolean)) {
        if (/^[A-Z]{4}$/.test(tok.toUpperCase())) allIcaos.add(tok.toUpperCase());
      }
    }
  }
  const airportRows = await prisma.airport.findMany({
    where: { icao: { in: Array.from(allIcaos) } },
    select: { icao: true, lat: true, lon: true }
  });
  const airportLookup = {};
  for (const ap of airportRows) airportLookup[ap.icao] = ap;

  for (const leg of legs) {
    const points = [];

    // Resolve route points using in-memory lookup
    const depAp = airportLookup[leg.from];
    if (depAp) points.push({ name: leg.from, lat: depAp.lat, lon: depAp.lon });

    if (leg.atc_route) {
      const tokens = leg.atc_route.split(/\s+/).filter(Boolean);
      for (const tok of tokens) {
        const lastPt = points.length > 0 ? points[points.length - 1] : (depAp || { lat: 0, lon: 0 });
        const llFix = parseNavLatLon(tok);
        if (llFix) { points.push({ name: tok, lat: llFix.lat, lon: llFix.lon }); continue; }
        const upper = tok.toUpperCase();
        if (/^(DCT|[A-Z]{1,2}\d{1,4}|[A-Z]\d{1,4}[A-Z]?)$/.test(upper) && upper.length <= 5 && /\d/.test(upper)) continue;
        if (upper === 'DCT') continue;
        const fix = closestFix(upper, lastPt.lat, lastPt.lon);
        if (fix) { points.push({ name: upper, lat: fix.lat, lon: fix.lon }); continue; }
        if (/^[A-Z]{4}$/.test(upper)) {
          const ap = airportLookup[upper];
          if (ap) { points.push({ name: upper, lat: ap.lat, lon: ap.lon }); continue; }
        }
      }
    }

    const arrAp = airportLookup[leg.to];
    if (arrAp) points.push({ name: leg.to, lat: arrAp.lat, lon: arrAp.lon });

    if (points.length < 2) continue;

    // Fix antimeridian crossings
    for (let k = 1; k < points.length; k++) {
      const diff = points[k].lon - points[k - 1].lon;
      if (diff > 180) points[k].lon -= 360;
      else if (diff < -180) points[k].lon += 360;
    }

    // Calculate cumulative distances
    const toRad = Math.PI / 180;
    function haversineNm(lat1, lon1, lat2, lon2) {
      const dLat = (lat2 - lat1) * toRad;
      const dLon = (lon2 - lon1) * toRad;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
      return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 3440.065;
    }

    let totalDist = 0;
    const cumDist = [0];
    for (let i = 1; i < points.length; i++) {
      totalDist += haversineNm(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
      cumDist.push(totalDist);
    }

    // Sample route for FIR transits
    const SAMPLES = 100;
    let lastFir = null;
    const legFirSegments = [];

    for (let s = 0; s <= SAMPLES; s++) {
      const frac = s / SAMPLES;
      const targetDist = frac * totalDist;
      let segIdx = 0;
      for (let i = 1; i < cumDist.length; i++) {
        if (cumDist[i] >= targetDist) { segIdx = i - 1; break; }
        if (i === cumDist.length - 1) segIdx = i - 1;
      }
      const segLen = cumDist[segIdx + 1] - cumDist[segIdx];
      const segFrac = segLen > 0 ? (targetDist - cumDist[segIdx]) / segLen : 0;
      const sLat = points[segIdx].lat + (points[segIdx + 1].lat - points[segIdx].lat) * segFrac;
      const sLon = points[segIdx].lon + (points[segIdx + 1].lon - points[segIdx].lon) * segFrac;

      const firs = getFirsForPoint(sLat, sLon);
      const firId = firs[0] || null;

      if (firId && firId !== lastFir) {
        if (legFirSegments.length > 0) legFirSegments[legFirSegments.length - 1].exitFrac = frac;
        legFirSegments.push({ fir: firId, entryFrac: frac, exitFrac: 1.0 });
        lastFir = firId;
      }
    }

    // Parse dep/block times
    const depParts = (leg.dep_time_utc || '').split(':');
    const blockParts = (leg.block_time || '').split(':');
    const depMins = depParts.length >= 2 ? Number(depParts[0]) * 60 + Number(depParts[1]) : null;
    const blockMins = blockParts.length >= 2 ? Number(blockParts[0]) * 60 + Number(blockParts[1]) : null;

    const sectorKey = `${leg.from}-${leg.to}`;

    for (const seg of legFirSegments) {
      if (!firMap[seg.fir]) {
        // Look up FIR metadata (match base code)
        const firFeature = firFeatures.find(f => f.properties?.id && f.properties.id.split('-')[0] === seg.fir);
        firMap[seg.fir] = {
          fir: seg.fir,
          region: firFeature?.properties?.region || '',
          division: firFeature?.properties?.division || '',
          legs: []
        };
      }

      const legEntry = {
        wf: leg.number,
        from: leg.from,
        to: leg.to,
        date: leg.date_utc,
        atcRoute: leg.atc_route || '',
        entryFrac: seg.entryFrac,
        exitFrac: seg.exitFrac,
        depFlow: sharedDepFlows[sectorKey] || 0,
        flowType: sharedFlowTypes[sectorKey] || 'NONE'
      };

      if (depMins !== null && blockMins !== null && blockMins > 0) {
        const entryMins = depMins + seg.entryFrac * blockMins;
        const exitMins = depMins + seg.exitFrac * blockMins;
        const staffStart = Math.floor((entryMins - 60) / 5) * 5;
        const staffEnd = Math.ceil((exitMins + 60) / 5) * 5;
        const fmt = m => String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0') + ':' + String(Math.floor(((m % 1440) + 1440) % 1440 % 60)).padStart(2, '0');
        legEntry.entryTime = fmt(entryMins);
        legEntry.exitTime = fmt(exitMins);
        legEntry.staffStart = fmt(staffStart);
        legEntry.staffEnd = fmt(staffEnd);
        legEntry.staffMins = Math.round((staffEnd - staffStart));

        // Absolute timestamps for weekly timeline
        const dateObj = parseServerDate(leg.date_utc);
        if (dateObj) {
          const dayBase = dateObj.getTime();
          legEntry.staffStartAbs = dayBase + staffStart * 60000;
          legEntry.staffEndAbs = dayBase + staffEnd * 60000;
        }
      }

      firMap[seg.fir].legs.push(legEntry);
    }
  }

  // Merge multiple transits of the same leg through the same FIR
  for (const fir of Object.values(firMap)) {
    const merged = [];
    for (const leg of fir.legs) {
      const prev = merged.find(m => m.wf === leg.wf && m.from === leg.from && m.to === leg.to);
      if (prev) {
        // Extend the existing entry to cover both transits
        prev.exitFrac = Math.max(prev.exitFrac, leg.exitFrac);
        prev.entryFrac = Math.min(prev.entryFrac, leg.entryFrac);
        if (leg.entryTime && prev.entryTime && leg.entryTime < prev.entryTime) prev.entryTime = leg.entryTime;
        if (leg.exitTime && prev.exitTime && leg.exitTime > prev.exitTime) prev.exitTime = leg.exitTime;
        if (leg.staffStart && prev.staffStart && leg.staffStart < prev.staffStart) prev.staffStart = leg.staffStart;
        if (leg.staffEnd && prev.staffEnd && leg.staffEnd > prev.staffEnd) prev.staffEnd = leg.staffEnd;
        if (prev.staffMins && leg.staffMins) {
          // Recalculate from merged window
          const sp = prev.staffStart.split(':'), ep = prev.staffEnd.split(':');
          prev.staffMins = (Number(ep[0]) * 60 + Number(ep[1])) - (Number(sp[0]) * 60 + Number(sp[1]));
          if (prev.staffMins < 0) prev.staffMins += 1440;
        }
      } else {
        merged.push(Object.assign({}, leg));
      }
    }
    fir.legs = merged;

    // Sort by date then entry time
    fir.legs.sort((a, b) => {
      if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
      return (a.entryTime || '').localeCompare(b.entryTime || '');
    });
  }

  const result = Object.values(firMap).sort((a, b) => a.fir.localeCompare(b.fir));
  firAnalysisCache = { eventId: activeEventId, data: result };
  return result;
}

app.get('/api/airspace-management', async (req, res) => {
  try {
    const allFirs = await buildFirAnalysis();
    const fir = (req.query.fir || '').toUpperCase().trim();

    if (fir) {
      const match = allFirs.find(f => f.fir === fir);
      if (!match) return res.json({ fir, legs: [], region: '', division: '' });
      return res.json(match);
    }

    // Return summary (no full leg details)
    const summary = allFirs.map(f => ({
      fir: f.fir,
      region: f.region,
      division: f.division,
      legCount: f.legs.length
    }));
    res.json({ eventId: activeEventId, firs: summary });
  } catch (err) {
    console.error('[AIRSPACE] Analysis failed:', err);
    res.status(500).json({ error: 'Failed to build analysis' });
  }
});

// Clear FIR analysis cache when schedule or flows change
function clearFirAnalysisCache() { firAnalysisCache = { eventId: null, data: null }; }

function parseNavLatLon(token) {
  const t = token.toUpperCase().trim();
  // 52N020W
  let m = t.match(/^(\d{2})(N|S)(\d{3})(E|W)$/);
  if (m) {
    return { lat: Number(m[1]) * (m[2] === 'S' ? -1 : 1), lon: Number(m[3]) * (m[4] === 'W' ? -1 : 1) };
  }
  // 5230N02000W (ddmm + dddmm)
  m = t.match(/^(\d{2})(\d{2})(N|S)(\d{3})(\d{2})(E|W)$/);
  if (m) {
    return {
      lat: (Number(m[1]) + Number(m[2]) / 60) * (m[3] === 'S' ? -1 : 1),
      lon: (Number(m[4]) + Number(m[5]) / 60) * (m[6] === 'W' ? -1 : 1)
    };
  }
  // 8128S17000W (dddmm format)
  m = t.match(/^(\d{2,3})(\d{2})(S|N)(\d{3,5})(W|E)$/);
  if (m) {
    const latDeg = m[1].length === 3 ? Number(m[1]) : Number(m[1]);
    return {
      lat: (Number(m[1]) + Number(m[2]) / 60) * (m[3] === 'S' ? -1 : 1),
      lon: Number(m[4]) * (m[5] === 'W' ? -1 : 1)
    };
  }
  return null;
}

/* ===== SCHEDULE ROW EDITING API ===== */
app.post('/admin/api/schedule-row/update', requireAdmin, async (req, res) => {
  const { eventId, number, field, value } = req.body;

  const allowed = ['number', 'from', 'to', 'dateUtc', 'depTimeUtc', 'arrTimeUtc', 'blockTime', 'atcRoute'];
  if (!allowed.includes(field)) {
    return res.status(400).json({ error: 'Invalid field' });
  }

  try {
    await prisma.wfScheduleRow.update({
      where: { eventId_number: { eventId, number } },
      data: { [field]: value }
    });

    // Recalc times if a time-affecting field changed
    const timeFields = ['blockTime', 'dateUtc', 'depTimeUtc'];
    if (timeFields.includes(field)) {
      await recalcScheduleTimes(eventId);
    } else {
      await loadScheduleFromDb(eventId);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/schedule-row/add', requireAdmin, async (req, res) => {
  const { eventId, from, to, depFlow, flowType, atcRoute, blockTime } = req.body;

  // Find next WF number
  const existing = await prisma.wfScheduleRow.findMany({
    where: { eventId },
    orderBy: { sortOrder: 'desc' },
    take: 1
  });

  const lastOrder = existing.length ? existing[0].sortOrder : -1;
  const evt = wfEvents.find(e => e.id === eventId);
  const yearPrefix = String(evt?.year || new Date().getFullYear()).slice(-2);
  const sectorCount = existing.length
    ? parseInt(existing[0].number.replace(/\D/g, '').slice(-2)) || existing.length
    : 0;
  const nextNum = 'WF' + yearPrefix + String(sectorCount + 1).padStart(2, '0');

  const row = await prisma.wfScheduleRow.create({
    data: {
      eventId,
      sortOrder: lastOrder + 1,
      number: nextNum,
      from: (from || '').toUpperCase(),
      to: (to || '').toUpperCase(),
      dateUtc: '',
      depTimeUtc: '',
      arrTimeUtc: '',
      blockTime: (blockTime || '').trim(),
      atcRoute: (atcRoute || '').trim()
    }
  });

  // Create dep flow if provided
  const sectorKey = (from || '').toUpperCase() + '-' + (to || '').toUpperCase();
  if (from && to && (depFlow || flowType)) {
    const rate = Number(depFlow) || 0;
    const ft = (flowType || 'NONE').toUpperCase();
    await prisma.depFlow.upsert({
      where: { eventId_sector: { eventId, sector: sectorKey } },
      update: { rate, flowtype: ft },
      create: { eventId, sector: sectorKey, rate, flowtype: ft }
    });

    if (eventId === activeEventId) {
      sharedDepFlows[sectorKey] = rate;
      sharedFlowTypes[sectorKey] = ft;
    }
  }

  await recalcScheduleTimes(eventId);
  res.json({ ok: true });
});

app.post('/admin/api/schedule-row/delete', requireAdmin, async (req, res) => {
  const { eventId, number } = req.body;

  try {
    await prisma.wfScheduleRow.delete({
      where: { eventId_number: { eventId, number } }
    });
    await recalcScheduleTimes(eventId);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.json({ ok: true });
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/api/schedule-row/recalc', requireAdmin, async (req, res) => {
  const { eventId } = req.body;
  if (!eventId) return res.status(400).json({ error: 'Invalid' });

  await recalcScheduleTimes(eventId);
  res.json({ ok: true });
});

app.post('/admin/api/wf-events/:id/turnaround', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { turnaroundMins } = req.body;
  if (!Number.isFinite(turnaroundMins) || turnaroundMins < 0) {
    return res.status(400).json({ error: 'Invalid value' });
  }
  await prisma.wfEvent.update({ where: { id }, data: { turnaroundMins } });
  const evt = wfEvents.find(e => e.id === id);
  if (evt) evt.turnaroundMins = turnaroundMins;

  // Recalculate all times server-side
  await recalcScheduleTimes(id);

  res.json({ ok: true });
});

async function recalcScheduleTimes(eventId) {
  const evt = wfEvents.find(e => e.id === eventId);
  const turnaround = evt?.turnaroundMins || 45;

  const rows = await prisma.wfScheduleRow.findMany({
    where: { eventId },
    orderBy: { sortOrder: 'asc' }
  });

  if (!rows.length) return;

  // Parse first leg's departure
  const first = rows[0];
  const startDate = parseServerDate(first.dateUtc);
  if (!startDate || !first.depTimeUtc) return;

  const depParts = first.depTimeUtc.split(':');
  if (depParts.length < 2) return;

  let currentTime = new Date(startDate);
  currentTime.setUTCHours(Number(depParts[0]), Number(depParts[1]), 0, 0);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const blockParts = (r.blockTime || '').split(':');
    const blockMins = blockParts.length >= 2
      ? Number(blockParts[0]) * 60 + Number(blockParts[1])
      : 0;

    const hasBlock = blockMins > 0;
    const depTime = new Date(currentTime);
    const arrTime = hasBlock ? new Date(depTime.getTime() + blockMins * 60000) : null;

    const depStr = String(depTime.getUTCHours()).padStart(2, '0') + ':' + String(depTime.getUTCMinutes()).padStart(2, '0');
    const arrStr = arrTime
      ? String(arrTime.getUTCHours()).padStart(2, '0') + ':' + String(arrTime.getUTCMinutes()).padStart(2, '0')
      : '';
    const dateStr = formatServerDate(depTime);

    const updateData = { arrTimeUtc: arrStr };
    if (i > 0) {
      updateData.dateUtc = dateStr;
      updateData.depTimeUtc = depStr;
    }

    await prisma.wfScheduleRow.update({
      where: { id: r.id },
      data: updateData
    });

    // Next leg departs after turnaround (only if we have an arrival time)
    if (arrTime) {
      currentTime = new Date(arrTime.getTime() + turnaround * 60000);
    } else {
      // No block time — next leg can't be calculated, stop here
      break;
    }
  }

  await loadScheduleFromDb(eventId);
  console.log(`[RECALC] Recalculated ${rows.length} legs for event ${eventId} (turnaround: ${turnaround}min)`);
}

function parseServerDate(str) {
  if (!str) return null;
  // ISO: 2025-11-01
  const iso = Date.parse(str);
  if (!isNaN(iso)) return new Date(iso);

  // "Sat 1st Nov" style
  const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const m = str.match(/(\d{1,2})\s*(?:st|nd|rd|th)?\s+([A-Za-z]+)/);
  if (m) {
    const day = Number(m[1]);
    const mon = months[m[2].toLowerCase().slice(0, 3)];
    if (mon !== undefined) return new Date(Date.UTC(new Date().getFullYear(), mon, day));
  }
  return null;
}

function formatServerDate(d) {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = d.getUTCDate();
  const suffix = day === 1 || day === 21 || day === 31 ? 'st'
    : day === 2 || day === 22 ? 'nd'
    : day === 3 || day === 23 ? 'rd' : 'th';
  return days[d.getUTCDay()] + ' ' + day + suffix + ' ' + months[d.getUTCMonth()];
}

app.post('/admin/api/wf-events/:id/unlink-csv', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await prisma.wfEvent.update({
    where: { id },
    data: { mode: 'scratch', sheetUrl: '' }
  });
  const evt = wfEvents.find(e => e.id === id);
  if (evt) {
    evt.mode = 'scratch';
    evt.sheetUrl = '';
  }
  console.log('[EVENT] Unlinked CSV for event ' + id + ' — now editable');
  res.json({ ok: true });
});

/* ===== WF EVENT API ===== */
app.post('/admin/api/wf-events', requireAdmin, async (req, res) => {
  const { name, year, sheetUrl, mode, importFromEventId } = req.body;
  const eventMode = mode === 'scratch' ? 'scratch' : 'csv';

  if (!name || !year) {
    return res.status(400).json({ error: 'Name and year are required' });
  }
  if (eventMode === 'csv' && !sheetUrl) {
    return res.status(400).json({ error: 'Google Sheet URL is required for CSV mode' });
  }

  const existing = await prisma.wfEvent.findUnique({ where: { year } });
  if (existing) {
    return res.status(409).json({ error: 'An event for ' + year + ' already exists' });
  }

  const event = await prisma.wfEvent.create({
    data: { name, year, sheetUrl: sheetUrl || '', mode: eventMode, isActive: false }
  });

  // Import dep flow rates from another event (flow types reset to NONE)
  if (importFromEventId) {
    const sourceFlows = await prisma.depFlow.findMany({
      where: { eventId: Number(importFromEventId) }
    });
    if (sourceFlows.length > 0) {
      await prisma.depFlow.createMany({
        data: sourceFlows.map(f => ({
          eventId: event.id,
          sector: f.sector,
          rate: f.rate,
          flowtype: 'NONE'
        })),
        skipDuplicates: true
      });
      console.log(`[EVENT] Imported ${sourceFlows.length} dep flow rates from event ${importFromEventId} to ${event.id} (flow types reset)`);
    }
  }

  // Load the sheet for this new event
  await refreshSheetForEvent(event);
  wfEvents = await prisma.wfEvent.findMany({ orderBy: { year: 'desc' } });

  res.json({ success: true, id: event.id });
});

app.get('/admin/api/wf-events/:id/backup-count', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const count = await prisma.tobtBookingBackup.count({ where: { eventId: id } });
  res.json({ count });
});

app.post('/admin/api/wf-events/:id/activate', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { restoreBookings } = req.body || {};
  const previousEventId = activeEventId;

  // 1. Backup all existing bookings from current active event
  const existingBookings = await prisma.tobtBooking.findMany();
  if (existingBookings.length > 0) {
    // Clear any old backups for the previous event first
    await prisma.tobtBookingBackup.deleteMany({ where: { eventId: previousEventId || 0 } });

    await prisma.tobtBookingBackup.createMany({
      data: existingBookings.map(b => ({
        eventId: previousEventId || 0,
        slotKey: b.slotKey,
        cid: b.cid,
        callsign: b.callsign,
        from: b.from,
        to: b.to,
        dateUtc: b.dateUtc,
        depTimeUtc: b.depTimeUtc,
        tobtTimeUtc: b.tobtTimeUtc,
        originalId: b.id
      }))
    });
    console.log(`[EVENT] Backed up ${existingBookings.length} bookings from event ${previousEventId}`);
  }

  // 2. Clear all live bookings
  await prisma.tobtBooking.deleteMany({});

  // 3. Clear all in-memory state
  Object.keys(tobtBookingsByKey).forEach(k => delete tobtBookingsByKey[k]);
  Object.keys(tobtBookingsByCid).forEach(k => delete tobtBookingsByCid[k]);
  Object.keys(sharedToggles).forEach(k => delete sharedToggles[k]);
  Object.keys(sharedTSAT).forEach(k => delete sharedTSAT[k]);
  Object.keys(tsatQueues).forEach(k => delete tsatQueues[k]);
  Object.keys(allTobtSlots).forEach(k => delete allTobtSlots[k]);
  Object.keys(recentlyStarted).forEach(k => delete recentlyStarted[k]);

  // 4. Switch active event
  await prisma.$transaction([
    prisma.wfEvent.updateMany({ data: { isActive: false } }),
    prisma.wfEvent.update({ where: { id }, data: { isActive: true } })
  ]);

  activeEventId = id;
  adminSheetCache = eventSheetCaches[id] || [];
  wfEvents = await prisma.wfEvent.findMany({ orderBy: { year: 'desc' } });

  // 5. Reload dep flows and rebuild slots for the new event
  await loadDepFlowsFromDb();
  rebuildAllTobtSlots();

  // 6. Restore bookings from backup if requested
  let restoredCount = 0;
  if (restoreBookings) {
    const backups = await prisma.tobtBookingBackup.findMany({ where: { eventId: id } });
    if (backups.length > 0) {
      for (const b of backups) {
        try {
          await prisma.tobtBooking.create({
            data: {
              slotKey: b.slotKey,
              cid: b.cid,
              callsign: b.callsign,
              from: b.from,
              to: b.to,
              dateUtc: b.dateUtc,
              depTimeUtc: b.depTimeUtc,
              tobtTimeUtc: b.tobtTimeUtc
            }
          });
          restoredCount++;
        } catch (err) {
          // skip duplicates or invalid entries
        }
      }
      // Reload in-memory booking caches
      await loadTobtBookingsFromDb();
      console.log(`[EVENT] Restored ${restoredCount}/${backups.length} bookings for event ${id}`);
    }
  }

  // Clear caches so they rebuild from the new schedule
  wfWorldMapCache.clear();
  clearFirAnalysisCache();

  console.log(`[EVENT] Activated event ID ${id} — ${adminSheetCache.length} rows, ${Object.keys(sharedDepFlows).length} flows`);
  res.json({ success: true });
});

app.delete('/admin/api/wf-events/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const event = await prisma.wfEvent.findUnique({ where: { id } });
  if (!event) return res.json({ ok: true });
  if (event.isActive) return res.status(400).json({ error: 'Cannot delete the active event' });

  await prisma.depFlow.deleteMany({ where: { eventId: id } });
  await prisma.wfEvent.delete({ where: { id } });
  delete eventSheetCaches[id];
  wfEvents = await prisma.wfEvent.findMany({ orderBy: { year: 'desc' } });

  res.json({ ok: true });
});

app.post('/admin/api/wf-events/:id/refresh', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const event = wfEvents.find(e => e.id === id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  await refreshSheetForEvent(event);
  if (id === activeEventId) {
    adminSheetCache = eventSheetCaches[id] || [];
  }

  res.json({ success: true, rows: (eventSheetCaches[id] || []).length });
});

/* ===== AIRAC DATA PAGE ===== */
function parseAiracHeader(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const head = fs.readFileSync(filePath, 'utf-8').split('\n').slice(0, 3).join(' ');
    let m = head.match(/data cycle (\d{4}),\s*build (\d{8})/);
    if (!m) m = head.match(/AIRAC Cycle (\d{4})\s+Rev\.\s*\d+,\s*parsed on (\d{8})/);
    if (!m) return { exists: true, cycle: 'Unknown', buildDate: 'Unknown', valid: false };

    const cycle = m[1];
    const buildStr = m[2];
    const buildDate = new Date(buildStr.slice(0, 4) + '-' + buildStr.slice(4, 6) + '-' + buildStr.slice(6, 8));

    // AIRAC cycles are 28 days. Calculate expiry.
    const expiryDate = new Date(buildDate.getTime() + 28 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const valid = now < expiryDate;
    const daysLeft = Math.ceil((expiryDate - now) / (24 * 60 * 60 * 1000));

    const stats = fs.statSync(filePath);
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').length;

    return {
      exists: true,
      cycle,
      buildDate: buildDate.toISOString().slice(0, 10),
      expiryDate: expiryDate.toISOString().slice(0, 10),
      valid,
      daysLeft,
      fileSize: (stats.size / 1024 / 1024).toFixed(1) + ' MB',
      lines
    };
  } catch { return null; }
}

app.get('/admin/airac', requireAdmin, (req, res) => {
  const user = req.session.user.data;
  const isAdmin = true;
  const navDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'navdata');

  const fixInfo = parseAiracHeader(path.join(navDir, 'earth_fix.dat'));
  const awyInfo = parseAiracHeader(path.join(navDir, 'earth_awy.dat'));

  // Determine overall AIRAC status
  const cycle = fixInfo?.cycle || awyInfo?.cycle || 'None';
  const isValid = fixInfo?.valid || false;
  const daysLeft = fixInfo?.daysLeft || 0;

  function statusBadge(info) {
    if (!info || !info.exists) return '<span class="badge badge-denied">Missing</span>';
    if (info.valid) return '<span class="badge" style="background:rgba(34,197,94,0.15);color:#4ade80;">Current</span>';
    return '<span class="badge badge-denied">Expired</span>';
  }

  function fileCard(title, info, fieldName) {
    return '<div class="leg-section">' +
      '<div class="leg-section-title">' + title + '</div>' +
      (info && info.exists
        ? '<table style="width:100%;font-size:13px;color:var(--text);">' +
          '<tr><td style="color:var(--muted);padding:4px 0;">Cycle</td><td style="font-weight:600;">' + info.cycle + ' ' + statusBadge(info) + '</td></tr>' +
          '<tr><td style="color:var(--muted);padding:4px 0;">Build Date</td><td>' + info.buildDate + '</td></tr>' +
          '<tr><td style="color:var(--muted);padding:4px 0;">Expires</td><td>' + info.expiryDate + (info.valid ? ' (' + info.daysLeft + ' days left)' : ' (expired)') + '</td></tr>' +
          '<tr><td style="color:var(--muted);padding:4px 0;">File Size</td><td>' + info.fileSize + '</td></tr>' +
          '<tr><td style="color:var(--muted);padding:4px 0;">Entries</td><td>' + info.lines.toLocaleString() + ' lines</td></tr>' +
          '</table>'
        : '<p style="color:var(--muted);font-size:13px;">File not found. Upload to enable route planning.</p>'
      ) +
      '<div style="margin-top:12px;">' +
        '<form method="POST" action="/admin/api/airac/upload" enctype="multipart/form-data" style="display:flex;align-items:center;gap:8px;">' +
          '<input type="hidden" name="fileType" value="' + fieldName + '" />' +
          '<input type="file" name="navfile" accept=".dat" required style="font-size:12px;color:var(--muted);" />' +
          '<button type="submit" class="action-btn primary" style="font-size:12px;padding:6px 14px;">Upload</button>' +
        '</form>' +
      '</div>' +
    '</div>';
  }

  const content = `
    <section class="card card-full">
      <h2>AIRAC Data</h2>

      <div class="leg-section" style="margin-bottom:20px;">
        <div class="leg-section-title">AIRAC Summary</div>
        <div style="display:flex;align-items:center;gap:16px;">
          <div style="font-size:48px;">🧭</div>
          <div>
            <div style="font-size:22px;font-weight:700;color:var(--text);">Cycle ${cycle}</div>
            <div style="font-size:13px;color:var(--muted);margin-top:2px;">
              ${isValid
                ? '<span style="color:#4ade80;">&#9679;</span> Current — ' + daysLeft + ' days until expiry'
                : cycle !== 'None'
                  ? '<span style="color:#f87171;">&#9679;</span> Expired — please upload a new cycle'
                  : '<span style="color:#f87171;">&#9679;</span> No data loaded — upload navdata files below'}
            </div>
            <div style="font-size:12px;color:var(--muted2);margin-top:4px;">
              Fixes loaded: <strong style="color:var(--text);">${navFixes.size.toLocaleString()}</strong> unique waypoints
            </div>
            <div style="font-size:12px;color:var(--muted2);margin-top:6px;">
              Download <strong>X-Plane 10 Native</strong> format from
              <a href="https://navigraph.com/downloads" target="_blank" style="color:var(--accent);">navigraph.com/downloads</a>
              and upload the .dat files below.
            </div>
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        ${fileCard('Waypoints / Fixes (earth_fix.dat)', fixInfo, 'earth_fix')}
        ${fileCard('Navaids (earth_nav.dat)', parseAiracHeader(path.join(navDir, 'earth_nav.dat')), 'earth_nav')}
        ${fileCard('Airways (earth_awy.dat)', awyInfo, 'earth_awy')}
        ${(() => {
          const firPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'fir-boundaries.geojson');
          let firInfo = null;
          try {
            if (fs.existsSync(firPath)) {
              const stats = fs.statSync(firPath);
              const raw = fs.readFileSync(firPath, 'utf-8');
              const data = JSON.parse(raw);
              firInfo = {
                exists: true,
                cycle: 'N/A',
                buildDate: stats.mtime.toISOString().slice(0, 10),
                expiryDate: null,
                valid: true,
                daysLeft: null,
                fileSize: (stats.size / 1024 / 1024).toFixed(1) + ' MB',
                lines: (data.features || []).length,
                noExpiry: true
              };
            }
          } catch {}

          const info = firInfo;
          const title = 'FIR Boundaries (VATSpy)';
          const fieldName = 'fir_boundaries';

          if (!info || !info.exists) {
            return '<div class="leg-section">' +
              '<div class="leg-section-title">' + title + '</div>' +
              '<p style="color:var(--muted);font-size:13px;">File not found. Upload to enable FIR display.</p>' +
              '<div style="margin-top:12px;">' +
                '<form method="POST" action="/admin/api/airac/upload" enctype="multipart/form-data" style="display:flex;align-items:center;gap:8px;">' +
                  '<input type="hidden" name="fileType" value="' + fieldName + '" />' +
                  '<input type="file" name="navfile" accept=".geojson,.json" required style="font-size:12px;color:var(--muted);" />' +
                  '<button type="submit" class="action-btn primary" style="font-size:12px;padding:6px 14px;">Upload</button>' +
                '</form>' +
              '</div>' +
            '</div>';
          }

          return '<div class="leg-section">' +
            '<div class="leg-section-title">' + title + '</div>' +
            '<table style="width:100%;font-size:13px;color:var(--text);">' +
              '<tr><td style="color:var(--muted);padding:4px 0;">Source</td><td style="font-weight:600;">VATSpy <span class="badge" style="background:rgba(34,197,94,0.15);color:#4ade80;">Loaded</span></td></tr>' +
              '<tr><td style="color:var(--muted);padding:4px 0;">Last Updated</td><td>' + info.buildDate + '</td></tr>' +
              '<tr><td style="color:var(--muted);padding:4px 0;">Expiry</td><td style="color:var(--muted);">No expiry</td></tr>' +
              '<tr><td style="color:var(--muted);padding:4px 0;">File Size</td><td>' + info.fileSize + '</td></tr>' +
              '<tr><td style="color:var(--muted);padding:4px 0;">FIR Regions</td><td>' + info.lines.toLocaleString() + ' boundaries</td></tr>' +
            '</table>' +
            '<div style="margin-top:12px;">' +
              '<form method="POST" action="/admin/api/airac/upload" enctype="multipart/form-data" style="display:flex;align-items:center;gap:8px;">' +
                '<input type="hidden" name="fileType" value="' + fieldName + '" />' +
                '<input type="file" name="navfile" accept=".geojson,.json" required style="font-size:12px;color:var(--muted);" />' +
                '<button type="submit" class="action-btn primary" style="font-size:12px;padding:6px 14px;">Upload</button>' +
              '</form>' +
            '</div>' +
          '</div>';
        })()}
      </div>
    </section>
  `;

  res.send(renderLayout({ title: 'AIRAC Data', user, isAdmin, content, layoutClass: 'dashboard-full' }));
});

app.post('/admin/api/airac/upload', requireAdmin, multer({
  dest: path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'navdata', 'tmp')
}).single('navfile'), async (req, res) => {
  const { fileType } = req.body;
  const isFir = fileType === 'fir_boundaries';
  const allowed = { earth_fix: 'earth_fix.dat', earth_awy: 'earth_awy.dat', earth_nav: 'earth_nav.dat' };
  const targetName = isFir ? 'fir-boundaries.geojson' : allowed[fileType];

  if (!targetName || !req.file) {
    return res.status(400).send('Invalid upload');
  }

  const targetPath = isFir
    ? path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', targetName)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'navdata', targetName);

  try {
    const content = fs.readFileSync(req.file.path, 'utf-8').slice(0, 1000);

    if (isFir) {
      // Validate it's valid GeoJSON with features
      if (!content.includes('FeatureCollection') && !content.includes('features')) {
        fs.unlinkSync(req.file.path);
        return res.status(400).send('Invalid file — does not appear to be a GeoJSON FeatureCollection');
      }
    } else {
      // Validate it's a valid navdata file
      if (!content.includes('data cycle') && !content.includes('AIRAC Cycle') && !content.includes('Version')) {
        fs.unlinkSync(req.file.path);
        return res.status(400).send('Invalid file — does not contain AIRAC data header');
      }
    }

    // Replace the file
    fs.copyFileSync(req.file.path, targetPath);
    fs.unlinkSync(req.file.path);

    // Reload data
    if (fileType === 'earth_fix' || fileType === 'earth_nav') {
      navFixes.clear();
      loadNavFixes();
    }
    if (isFir) {
      loadFirData();
    }

    console.log('[AIRAC] Uploaded ' + targetName);
    res.redirect('/admin/airac');
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).send('Upload failed: ' + err.message);
  }
});

/* ===== SETTINGS PAGE ===== */
app.get('/admin/settings', requireAdmin, async (req, res) => {
  const user = req.session.user.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

  const pages = [
    { key: 'schedule',        label: 'WF Schedule',         icon: '🏠', desc: 'Main event schedule with slot booking' },
    { key: 'world-map',       label: 'Route Map',           icon: '🗺️', desc: 'Interactive world map with live flights' },
    { key: 'my-slots',        label: 'My Slots / Bookings', icon: '✈️', desc: 'Personal slot and booking overview' },
    { key: 'atc',             label: 'WF Slot Management',  icon: '🎧', desc: 'Controller departure management view' },
    { key: 'suggest-airport', label: 'Suggest Airport',     icon: '💡', desc: 'Community airport suggestions' },
    { key: 'airspace',        label: 'Airspace Management',  icon: '🌐', desc: 'FIR staffing requirements and timelines' },
    { key: 'arrival-info',    label: 'Arrival Info',         icon: '🛬', desc: 'Arrival banner on airport portal pages' },
    { key: 'departure-info',  label: 'Departure Info',       icon: '🛫', desc: 'Departure banner on airport portal pages' },
    { key: 'book-slot',       label: 'Book Slot Column',     icon: '📋', desc: 'Book Slot column on the schedule page' }
  ];

  const toggleRows = pages.map(p => {
    const enabled = isPageEnabled(p.key);
    return `
      <div class="settings-row" data-page="${p.key}">
        <div class="settings-row-info">
          <span class="settings-row-icon">${p.icon}</span>
          <div>
            <div class="settings-row-label">${p.label}</div>
            <div class="settings-row-desc">${p.desc}</div>
          </div>
        </div>
        <div class="settings-row-controls">
          <span class="vis-pill ${enabled ? 'vis-on' : 'vis-off'}" data-page="${p.key}">
            ${enabled ? 'Visible' : 'Hidden'}
          </span>
          <label class="toggle-switch">
            <input type="checkbox" data-page="${p.key}" ${enabled ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>`;
  }).join('');

  const content = `
    <section class="card card-full">
      <h2>Site Banner</h2>
      <p class="settings-subtitle">
        Display an announcement banner at the top of every page.
      </p>

      <div class="settings-row">
        <div class="settings-row-info">
          <span class="settings-row-icon">📢</span>
          <div>
            <div class="settings-row-label">Banner Enabled</div>
            <div class="settings-row-desc">Toggle the site-wide announcement banner</div>
          </div>
        </div>
        <div class="settings-row-controls">
          <span class="vis-pill ${siteBanner.enabled ? 'vis-on' : 'vis-off'}" id="bannerPill">
            ${siteBanner.enabled ? 'Visible' : 'Hidden'}
          </span>
          <label class="toggle-switch">
            <input type="checkbox" id="bannerToggle" ${siteBanner.enabled ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div style="margin-top:16px;">
        <label style="display:block;font-size:13px;color:var(--muted);margin-bottom:6px;">Banner Text</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="bannerTextInput" value="${(siteBanner.text || '').replace(/"/g, '&quot;')}" placeholder="Enter banner message..." style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,0.04);color:var(--text);font-size:14px;" />
          <button id="bannerTextSave" class="action-btn primary" style="white-space:nowrap;">Save Text</button>
        </div>
      </div>
    </section>

    <section class="card card-full">
      <h2>Page Visibility</h2>
      <p class="settings-subtitle">
        Control which pages are visible to pilots and controllers.
        Disabled pages are hidden from navigation and return 403 for non-admin users.
        Admins always have access.
      </p>

      <div class="settings-list">
        ${toggleRows}
      </div>
    </section>

    <style>
      .settings-subtitle {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
        margin-bottom: 24px;
      }

      .settings-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .settings-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-radius: 8px;
        background: rgba(255,255,255,0.02);
        border: 1px solid var(--border);
        transition: background .15s;
      }
      .settings-row:hover {
        background: rgba(255,255,255,0.04);
      }

      .settings-row-info {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .settings-row-icon {
        font-size: 22px;
        width: 36px;
        text-align: center;
      }
      .settings-row-label {
        font-weight: 600;
        font-size: 14px;
        color: var(--text);
      }
      .settings-row-desc {
        font-size: 12px;
        color: var(--muted);
        margin-top: 2px;
      }

      .settings-row-controls {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-shrink: 0;
      }

      .vis-pill {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: .5px;
        text-transform: uppercase;
        padding: 3px 10px;
        border-radius: 12px;
        min-width: 60px;
        text-align: center;
        transition: all .2s;
      }
      .vis-pill.vis-on {
        background: rgba(34,197,94,0.15);
        color: #4ade80;
      }
      .vis-pill.vis-off {
        background: rgba(239,68,68,0.15);
        color: #f87171;
      }

      .toggle-switch {
        position: relative;
        display: inline-block;
        width: 44px;
        height: 24px;
        flex-shrink: 0;
      }
      .toggle-switch input { opacity: 0; width: 0; height: 0; }
      .toggle-slider {
        position: absolute; cursor: pointer; inset: 0;
        background: rgba(255,255,255,0.1);
        border-radius: 24px;
        transition: background .2s;
      }
      .toggle-slider::before {
        content: "";
        position: absolute;
        height: 18px; width: 18px;
        left: 3px; bottom: 3px;
        background: #fff;
        border-radius: 50%;
        transition: transform .2s;
      }
      .toggle-switch input:checked + .toggle-slider {
        background: var(--accent, #3b82f6);
      }
      .toggle-switch input:checked + .toggle-slider::before {
        transform: translateX(20px);
      }
    </style>

    <script>
      document.querySelectorAll('.toggle-switch input[data-page]').forEach(cb => {
        cb.addEventListener('change', async () => {
          const key = cb.dataset.page;
          const enabled = cb.checked;
          const pill = document.querySelector('.vis-pill[data-page="' + key + '"]');

          const res = await fetch('/api/admin/page-visibility', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, enabled })
          });

          if (res.ok) {
            pill.textContent = enabled ? 'Visible' : 'Hidden';
            pill.className = 'vis-pill ' + (enabled ? 'vis-on' : 'vis-off');
          } else {
            cb.checked = !enabled;
            alert('Failed to update');
          }
        });
      });

      // Banner toggle
      document.getElementById('bannerToggle').addEventListener('change', async function() {
        const enabled = this.checked;
        const pill = document.getElementById('bannerPill');
        const res = await fetch('/api/admin/banner', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'banner-enabled', value: String(enabled) })
        });
        if (res.ok) {
          pill.textContent = enabled ? 'Visible' : 'Hidden';
          pill.className = 'vis-pill ' + (enabled ? 'vis-on' : 'vis-off');
        } else {
          this.checked = !enabled;
          alert('Failed to update');
        }
      });

      // Banner text save
      document.getElementById('bannerTextSave').addEventListener('click', async function() {
        const text = document.getElementById('bannerTextInput').value.trim();
        const res = await fetch('/api/admin/banner', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'banner-text', value: text })
        });
        if (res.ok) {
          this.textContent = 'Saved!';
          setTimeout(() => { this.textContent = 'Save Text'; }, 1500);
        } else {
          alert('Failed to save');
        }
      });
    </script>
  `;

  res.send(renderLayout({ title: 'Page Visibility', user, isAdmin, content, layoutClass: 'dashboard-full' }));
});

app.post('/api/admin/banner', requireAdmin, async (req, res) => {
  const { key, value } = req.body;
  if (!['banner-enabled', 'banner-text'].includes(key) || typeof value !== 'string') {
    return res.status(400).json({ error: 'Invalid key or value' });
  }

  await prisma.siteSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value }
  });

  if (key === 'banner-enabled') siteBanner.enabled = value === 'true';
  if (key === 'banner-text') siteBanner.text = value;

  res.json({ success: true });
});

app.post('/api/admin/page-visibility', requireAdmin, async (req, res) => {
  const { key, enabled } = req.body;
  if (!PAGE_KEYS.includes(key) || typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Invalid key or value' });
  }

  await prisma.pageVisibility.upsert({
    where: { key },
    update: { enabled },
    create: { key, enabled }
  });

  pageVisibility[key] = enabled;
  res.json({ ok: true });
});

app.get('/api/page-visibility', (req, res) => {
  res.json(pageVisibility);
});

/* ===== ADMIN: MAILING LIST ===== */
app.get('/admin/mailing-list', requireAdmin, async (req, res) => {
  const user = req.session.user.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

  const subscribers = await prisma.mailingListSubscriber.findMany({
    orderBy: { createdAt: 'desc' }
  });

  const rows = subscribers.map(s => `
    <tr>
      <td>${s.email}</td>
      <td>${[s.firstName, s.lastName].filter(Boolean).join(' ') || '—'}</td>
      <td>${s.cid || '—'}</td>
      <td>${new Date(s.createdAt).toLocaleDateString()}</td>
      <td><button class="ml-remove-btn" data-id="${s.id}">Remove</button></td>
    </tr>
  `).join('');

  const content = `
    <section class="card card-full">
      <h2>Mailing List</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:8px;">
        ${subscribers.length} subscriber${subscribers.length !== 1 ? 's' : ''} opted in to route announcements.
      </p>

      <div class="ml-send-section">
        <h3>Send Route Announcement</h3>
        <label>
          Subject
          <input type="text" id="mlSubject" value="WorldFlight 2026 — Route Announced!" style="width:100%;" />
        </label>
        <label>
          Message (HTML supported)
          <textarea id="mlBody" rows="10" placeholder="Write your announcement email here..."></textarea>
        </label>
        <div style="display:flex;align-items:center;gap:12px;margin-top:12px;">
          <button id="mlSendBtn" class="modal-btn modal-btn-submit">Send to All Subscribers</button>
          <button id="mlTestBtn" class="modal-btn" style="background:var(--border);color:var(--text);">Send Test to Me</button>
          <span id="mlStatus" style="font-size:13px;color:var(--muted);"></span>
        </div>
      </div>

      <h3 style="margin-top:32px;">Subscribers</h3>
      <div style="overflow-x:auto;">
        <table class="ml-table">
          <thead>
            <tr><th>Email</th><th>Name</th><th>CID</th><th>Subscribed</th><th></th></tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="5" class="empty">No subscribers yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <style>
      .ml-send-section {
        background: rgba(255,255,255,0.02);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 20px;
        margin-top: 16px;
      }
      .ml-send-section h3 { font-size: 15px; margin-bottom: 12px; }
      .ml-send-section label {
        display: block;
        font-size: 13px;
        font-weight: 600;
        margin-top: 10px;
      }
      .ml-send-section input,
      .ml-send-section textarea {
        width: 100%;
        margin-top: 4px;
        padding: 8px;
        background: #0f172a;
        border: 1px solid #1e293b;
        border-radius: 6px;
        color: #e5e7eb;
        font-family: inherit;
        font-size: 13px;
      }
      .ml-send-section textarea { resize: vertical; }

      .ml-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
        margin-top: 8px;
      }
      .ml-table th {
        text-align: left;
        padding: 8px 12px;
        border-bottom: 1px solid var(--border);
        color: var(--muted);
        font-weight: 600;
      }
      .ml-table td {
        padding: 8px 12px;
        border-bottom: 1px solid rgba(255,255,255,0.04);
        color: var(--text);
      }
      .ml-remove-btn {
        background: none;
        border: 1px solid var(--danger, #ef4444);
        color: var(--danger, #ef4444);
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
      }
      .ml-remove-btn:hover {
        background: var(--danger, #ef4444);
        color: #fff;
      }
    </style>

    <script>
    (function() {
      // Remove subscriber
      document.querySelectorAll('.ml-remove-btn').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          if (!confirm('Remove this subscriber?')) return;
          var id = btn.dataset.id;
          var res = await fetch('/admin/api/mailing-list/' + id, { method: 'DELETE' });
          if (res.ok) btn.closest('tr').remove();
        });
      });

      // Send email
      document.getElementById('mlSendBtn').addEventListener('click', async function() {
        if (!confirm('Send this email to ALL ${subscribers.length} subscribers?')) return;
        await sendMail(false);
      });

      document.getElementById('mlTestBtn').addEventListener('click', async function() {
        await sendMail(true);
      });

      async function sendMail(testOnly) {
        var btn = testOnly ? document.getElementById('mlTestBtn') : document.getElementById('mlSendBtn');
        var status = document.getElementById('mlStatus');
        var subject = document.getElementById('mlSubject').value.trim();
        var body = document.getElementById('mlBody').value.trim();

        if (!subject || !body) {
          status.textContent = 'Subject and message are required.';
          status.style.color = 'var(--danger)';
          return;
        }

        btn.disabled = true;
        status.textContent = 'Sending...';
        status.style.color = 'var(--muted)';

        try {
          var res = await fetch('/admin/api/mailing-list/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subject: subject, body: body, testOnly: testOnly })
          });
          var data = await res.json();
          if (data.success) {
            status.textContent = testOnly ? 'Test email sent!' : 'Sent to ' + data.sent + ' subscribers!';
            status.style.color = 'var(--success)';
          } else {
            throw new Error(data.error || 'Failed');
          }
        } catch(err) {
          status.textContent = err.message;
          status.style.color = 'var(--danger)';
        }
        btn.disabled = false;
      }
    })();
    </script>
  `;

  res.send(renderLayout({ title: 'Mailing List', user, isAdmin, content, layoutClass: 'dashboard-full' }));
});

app.delete('/admin/api/mailing-list/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  try {
    await prisma.mailingListSubscriber.delete({ where: { id } });
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

app.post('/admin/api/mailing-list/send', requireAdmin, async (req, res) => {
  const { subject, body, testOnly } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'Subject and body are required' });
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const from = process.env.SMTP_FROM || '"WorldFlight" <noreply@worldflight.center>';

  const htmlEmail = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background:#020617;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#020617;padding:40px 20px;">
    <tr>
      <td align="center">
        <table cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#0b1220;border:1px solid #1e293b;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:32px;text-align:center;">
              <img src="https://planning.worldflight.center/logo.png" width="64" height="64" style="border-radius:50%;" alt="WorldFlight" />
              <h1 style="color:#38bdf8;font-size:22px;margin:16px 0 0;">WorldFlight</h1>
              <p style="color:#94a3b8;font-size:13px;margin:4px 0 0;">Route Announcement</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <div style="color:#e5e7eb;font-size:15px;line-height:1.7;">
                ${body}
              </div>
              <hr style="border:none;border-top:1px solid #1e293b;margin:24px 0;" />
              <p style="color:#94a3b8;font-size:12px;margin:0;text-align:center;">
                You received this because you opted in to WorldFlight route announcements.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  if (testOnly) {
    const adminEmail = req.session.user.data.personal?.email;
    if (!adminEmail) return res.status(400).json({ error: 'No email on your VATSIM account' });

    try {
      await transporter.sendMail({ from, to: adminEmail, subject, html: htmlEmail });
      return res.json({ success: true, sent: 1 });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to send: ' + err.message });
    }
  }

  // Send to all subscribers
  const subscribers = await prisma.mailingListSubscriber.findMany({ select: { email: true } });
  let sent = 0;

  for (const sub of subscribers) {
    try {
      await transporter.sendMail({ from, to: sub.email, subject, html: htmlEmail });
      sent++;
    } catch (err) {
      console.error(`[MAILING] Failed to send to ${sub.email}:`, err.message);
    }
  }

  res.json({ success: true, sent });
});

/* ===== DEPARTURES PAGE ===== */
app.get('/departures', async (req, res) => {

  // 1️⃣ Auth guard
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/');
  }

  const user = req.session.user.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

  

  // 2️⃣ ICAO — DEFINE ONCE
  const pageIcao = req.query.icao?.toUpperCase();
  if (!pageIcao || pageIcao.length !== 4) {
    return res.redirect('/atc');
  }


  
  // 3️⃣ Controller connection check
  const controllerCallsign = user.callsign || '';

  // "Connected" to the aerodrome if callsign is ICAO_* and not ICAO_OBS
  const isAerodromeController =
    controllerCallsign.startsWith(pageIcao + '_') &&
    !controllerCallsign.endsWith('_OBS');

  // Kept for backwards compatibility (if anything still uses it)
  const isConnectedToIcao = controllerCallsign.startsWith(pageIcao + '_');

  // Admins can always edit; otherwise must be connected as ICAO_* (except ICAO_OBS)
  const canEdit = isAdmin || isAerodromeController;
  const disabledAttr = canEdit ? '' : 'disabled';

  // 4️⃣ Fetch VATSIM data
  const response = await axios.get('https://data.vatsim.net/v3/vatsim-data.json');
  const pilots = response.data.pilots;

  // 5️⃣ Use pageIcao everywhere
  const departures = pilots.filter(
    p =>
      p.flight_plan &&
      p.flight_plan.departure === pageIcao &&
      p.groundspeed < 5
  );
  
// DEBUG (safe now)
  console.log('--- EDIT PERMISSION DEBUG ---');
  console.log('CID:', user.cid);
  console.log('Callsign:', controllerCallsign);
  console.log('Page ICAO:', pageIcao);
  console.log('Is Admin:', isAdmin);
  console.log('Can Edit:', canEdit);
  console.log('-----------------------------');

  
  const CAN_EDIT = canEdit;


  
  const tsatRefreshHtml = CAN_EDIT
  ? `
    <button
      class="tsat-refresh"
      data-callsign=""
      style="display:none;"
    >
      ⟳
    </button>
  `
  : '';

  
  const rowsHtml = departures.map(p => {
  const disabledAttr = CAN_EDIT ? '' : 'disabled';

  const sectorKey = `${p.flight_plan.departure}-${p.flight_plan.arrival}`;

  // ✅ define wfStatus BEFORE using it
  const wfStatus = getWorldFlightStatus(p);
const isEventFlight = wfStatus.isWF;

// Look up booking BY PILOT CALLSIGN
const tobtBooking = getTobtBookingForCallsign(p.callsign, pageIcao);
const isBooked = !!tobtBooking;
const isManualTobt = !!tobtBooking && tobtBooking.cid === null;


let tobtCellHtml = '';

if (isEventFlight) {
  if (tobtBooking) {
    // 🔴 ATC-assigned TOBT → removable
    if (CAN_EDIT && tobtBooking.cid === null) {
      tobtCellHtml = `
        <div class="tobt-assigned">
          <strong>${tobtBooking.tobtTimeUtc}</strong>
          <button
  class="tobt-remove-btn"
  data-callsign="${p.callsign}"
  data-icao="${pageIcao}"
  title="Remove manual TOBT"
  aria-label="Remove manual TOBT"
>

  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    aria-hidden="true"
  >
    <path
      d="M7 7l10 10M17 7L7 17"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
    />
  </svg>
</button>


        </div>
      `;
    } else {
      // 🟢 Pilot-booked → read-only
      tobtCellHtml = `<strong>${tobtBooking.tobtTimeUtc}</strong>`;
    }
  } else {
    // No TOBT → dropdown
    const availableTobts = getNextAvailableTobts(
      pageIcao,
      p.flight_plan.arrival
    );

    if (!availableTobts.length) {
      tobtCellHtml = `<em>None</em>`;
    } else {
      tobtCellHtml = `
      <div class="tobt-select-wrapper">
        <select class="tobt-select" data-callsign="${p.callsign}">
          <option value="">Select TOBT</option>
          ${availableTobts.map(s =>
            `<option value="${s.slotKey}">${s.tobt}</option>`
          ).join('')}
        </select>
      </div>
      `;
    }
  }
}





let primaryStatusHtml = '';
  let showRouteWarning = false;

  if (!isEventFlight) {
  primaryStatusHtml = `
    <span
      class="status-pill non-event"
      title="Flying to a non-event destination"
    >
      Non-Event
    </span>`;
} else {
  if (isManualTobt) {
  primaryStatusHtml = `
    <span
      class="status-pill manual"
      title="TOBT manually assigned by ATC"
    >
      <span class="status-icon">!</span>
      Manual
    </span>`;
} else if (isBooked) {
  primaryStatusHtml = `
    <span
      class="status-pill booked"
      title="Has an event booking"
    >
      Booked
    </span>`;
} else {
  primaryStatusHtml = `
    <span
      class="status-pill non-booked"
      title="Flying to WF destination without a booking"
    >
      Non-Booked
    </span>`;
}

  showRouteWarning = !wfStatus.routeMatch;
}



  const routeHtml = p.flight_plan.route
    ? `<span class="route-collapsed">Click to expand</span><span class="route-expanded" style="display:none;">${p.flight_plan.route}</span>`
    : 'N/A';

  return `
<tr>
  <td class="col-status">
    ${primaryStatusHtml}
    ${showRouteWarning
  ? `<span
       class="status-pill route-warning"
       title="Wrong route for event traffic"
     >
       Route!
     </span>`
  : ''
}
  </td>

  <td class="callsign">
  <span class="callsign-link" data-callsign="${p.callsign}">
    ${p.callsign}
  </span>
</td>


  <td>${p.flight_plan.aircraft_faa || 'N/A'}</td>
  <td>${p.flight_plan.arrival || 'N/A'}</td>

  <td class="col-tobt">
  ${tobtCellHtml}
</td>

  <td class="col-toggle">
    <button
      class="toggle-btn"
      data-type="start"
      data-callsign="${p.callsign}"
      data-sector="${sectorKey}"
      ${disabledAttr}
    >⬜</button>
  </td>

  <td class="tsat-cell" data-callsign="${p.callsign}">
    <span class="tsat-time">-</span>
    ${CAN_EDIT ? `<button class="tsat-refresh" data-callsign="${p.callsign}" style="display:none;">⟳</button>` : ''}
  </td>

  <td class="col-route">${routeHtml}</td>
</tr>`;
}).join('');


 const content = `
  <section class="card dashboard-wide">

    <section class="card">

    <!-- TOP ROW HEADERS (aligned horizontally) -->
<div class="tsat-wrapper">    

${!isAerodromeController ? `
  <div class="icao-warning">
    ${canEdit ? `
      You are not connected as an ${pageIcao}_ position, but you can edit because you are an Admin.
    ` : `
      You are not connected as an ${pageIcao}_ position and therefore the following information is read-only.
    `}
  </div>
` : ``}
<div class="tsat-top-row three-cols">

  <!-- UPCOMING TSATs -->
  <div class="tsat-col">
    <h3 class="tsat-header">Upcoming Start</h3>
    <div class="table-scroll">
      <table class="departures-table" id="tsatQueueTable">
        <thead>
          <tr>
            <th>Callsign</th>
            <th>TSAT</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <!-- RECENTLY STARTED -->
  <div class="tsat-col">
    <h3 class="tsat-header">Recently Started</h3>
    <div class="table-scroll">
      <table class="departures-table" id="recentlyStartedTable">
        <thead>
          <tr>
            <th>Callsign</th>
            <th>Started At</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <!-- UNASSIGNED TOBTs -->
  <div class="tsat-col">
    <h3 class="tsat-header">Available WF TOBT's</h3>
    <div class="table-scroll">
      <table class="departures-table" id="unassignedTobtTable">
  <thead>
    <tr>
      <th>TOBT</th>
      <th>Dest</th>
      <th>TOBT</th>
      <th>Dest</th>
    </tr>
  </thead>

        <tbody>
          <tr>
            <td colspan="4"><em>None Available</em></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

</div>


</div>
    </div>
    <!-- END TSAT TOP ROW -->


    <!-- SEARCH + TIMER + MAIN TABLE -->
    <input id="callsignSearch" placeholder="Search by callsign..." />
    
    <div class="table-scroll">
      <table class="departures-table" id="mainDeparturesTable">
        <thead>
          <tr>
            <th>Status</th>
            <th>Callsign</th>
            <th>Aircraft</th>
            <th>Dest</th>
            <th>WF TOBT</th>
            <th class="col-toggle">READY?</th>
            <th>TSAT</th>
            <th class="col-route">ATC Route</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>

  </section>
</section>


  <!-- ALL scripts stay exactly the same -->
  <script>
  const CAN_EDIT = ${canEdit ? 'true' : 'false'};
</script>
  <script>
  

/* ----------------------------------------------------
   SEARCH FILTER
---------------------------------------------------- */
const searchInput = document.getElementById('callsignSearch');
const savedFilter = localStorage.getItem('callsignFilter') || '';
searchInput.value = savedFilter;
applyFilter(savedFilter);

function applyFilter(filter) {
  const upper = filter.toUpperCase();
  document.querySelectorAll('#mainDeparturesTable tbody tr').forEach(row => {

    const txt = row.children[1].innerText.toUpperCase();
    row.style.display = txt.includes(upper) ? '' : 'none';
  });
}

searchInput.addEventListener('input', function () {
  const val = this.value;
  localStorage.setItem('callsignFilter', val);
  applyFilter(val);
});

/* ----------------------------------------------------
   ROUTE EXPAND/COLLAPSE
---------------------------------------------------- */
function bindRouteExpanders() {
  document.querySelectorAll('.route-collapsed').forEach(el => {
    el.onclick = () => {
      const exp = el.nextElementSibling;
      if (!exp) return;

      const isExpanded = exp.style.display === 'block';

      if (isExpanded) {
        exp.style.display = 'none';
        el.textContent = 'Click to expand';
      } else {
        exp.style.display = 'block';
        el.textContent = 'Click to collapse';
      }
    };
  });
}


// Initial bind on page load
bindRouteExpanders();


/* ----------------------------------------------------
   REFRESH TIMER + SMART REFRESH
---------------------------------------------------- */
const icao = new URLSearchParams(window.location.search).get('icao');
let countdown = 20;

setInterval(() => {
  const timerEl = document.getElementById('refreshTimer');
  if (timerEl) {
    timerEl.innerText = 'Next auto-refresh in: ' + countdown + 's';
  }
  countdown = countdown <= 0 ? 20 : countdown - 1;
}, 1000);

setInterval(async () => {
  const res = await fetch('/departures/check-changes?icao=' + icao);
  const data = await res.json();
  if (data.changed) {
  refreshDeparturesTable();
}
}, 20000);

setInterval(() => {
  refreshDeparturesTable();
}, 120000);

</script>

<script src="/socket.io/socket.io.js"></script>

<script>
/* ============================================================
   TSAT → FULL ROW COLOURING HELPER
============================================================ */
/* ============================================================
   TSAT → FULL ROW COLOURING (CDM –10 / –5 / +5 / +10 LOGIC)
============================================================ */
function getRowColorClass(tsatStr) {
    if (!tsatStr || tsatStr === '-' || tsatStr === '----') return '';

    const now = new Date();
    now.setSeconds(0, 0);

    const [hh, mm] = tsatStr.split(':').map(Number);
    if (isNaN(hh) || isNaN(mm)) return '';

    const tsatDate = new Date(now);
    tsatDate.setHours(hh, mm, 0, 0);

    const diffMin = (tsatDate - now) / 60000;  // positive = TSAT in future

    // GREEN → TSAT ±5 minutes
    if (diffMin >= -5 && diffMin <= 5) return 'row-green';

    // AMBER → TSAT –10 to –6 OR +6 to +10
    if ((diffMin >= -10 && diffMin <= -6) || (diffMin >= 6 && diffMin <= 10)) {
        return 'row-amber';
    }

    // RED → anything earlier/later than these
    return 'row-red';
}


/* ----------------------------------------------------
   SOCKET INIT
---------------------------------------------------- */
const socket = io({
  query: { icao }
});



// Passive viewers: keep Upcoming TSATs in sync



function renderUnassignedTobtTable(data) {
  const tbody = document.querySelector('#unassignedTobtTable tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  const MAX_ROWS = 6;
  const MAX_ITEMS = MAX_ROWS * 2;

  const visible = data.slice(0, MAX_ITEMS);

  if (!visible.length) {
    tbody.innerHTML =
      '<tr><td colspan="4"><em>None Available</em></td></tr>';
    return;
  }

  const half = Math.ceil(visible.length / 2);
  const left = visible.slice(0, half);
  const right = visible.slice(half);

  for (let i = 0; i < MAX_ROWS; i++) {
    const tr = document.createElement('tr');

    const leftItem = left[i];
    const rightItem = right[i];

    // Left column
    if (leftItem) {
      tr.innerHTML +=
        '<td>' + leftItem.tobt + '</td>' +
        '<td>' + leftItem.to + '</td>';
    } else {
      tr.innerHTML += '<td></td><td></td>';
    }

    // Right column
    if (rightItem) {
      tr.innerHTML +=
        '<td>' + rightItem.tobt + '</td>' +
        '<td>' + rightItem.to + '</td>';
    } else {
      tr.innerHTML += '<td></td><td></td>';
    }

    tbody.appendChild(tr);
  }
  
}





/* ----------------------------------------------------
   UPCOMING TSAT TABLE RENDERER
---------------------------------------------------- */
function renderUpcomingTSATTable(data) {
  const tbody = document.querySelector('#tsatQueueTable tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  const MAX_ROWS = 5;

  // Render real TSAT rows first
  data.slice(0, MAX_ROWS).forEach(function (item) {
    const tr = document.createElement('tr');

const tsatValue = item.tsat || '-';
const rowClass = getRowColorClass(tsatValue);
if (rowClass) tr.classList.add(rowClass);

tr.innerHTML =
  '<td>' + item.callsign + '</td>' +
  '<td>' + tsatValue + '</td>' +
  '<td>' +
    '<input type="checkbox" class="tsat-started-check" data-callsign="' +
    item.callsign +
    '"' + (CAN_EDIT ? '' : ' disabled') + '>' +
  '</td>';



tbody.appendChild(tr);

  });

  // Pad remaining empty rows to force consistent height
  const missing = MAX_ROWS - Math.min(data.length, MAX_ROWS);

  for (let i = 0; i < missing; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>&nbsp;</td>' +
      '<td>&nbsp;</td>' +
      '<td>&nbsp;</td>';
    tbody.appendChild(tr);
  }
}

/* ----------------------------------------------------
   UPCOMING TSAT EVENTS
---------------------------------------------------- */
socket.on('upcomingTSATUpdate', data => {
  renderUpcomingTSATTable(data);
});

socket.on('recentlyStartedUpdate', data => {
  renderRecentlyStartedTable(data);
});

socket.on('unassignedTobtUpdate', data => {
  renderUnassignedTobtTable(data);
});


socket.on('tsatStartedUpdated', started => {
  document.querySelectorAll('.tsat-started-check').forEach(cb => {
    const callsign = cb.dataset.callsign;
    cb.checked = !!started[callsign];
  });
});

/* Checkbox for Started / Unstarted */
document.addEventListener('change', function (e) {
  if (!CAN_EDIT) {
    e.target.checked = !e.target.checked;
    return;
  }

  if (!e.target.classList.contains('tsat-started-check')) return;


  const callsign = e.target.dataset.callsign;

  if (e.target.checked) {
    socket.emit('markTSATStarted', { callsign });
  } else {
    socket.emit('unmarkTSATStarted', { callsign });
  }
});

document.addEventListener('click', e => {

  // 1️⃣ Ignore all interactive controls
  if (
    e.target.closest('button') ||
    e.target.closest('select') ||
    e.target.closest('option') ||
    e.target.closest('input') ||
    e.target.closest('textarea') ||
    e.target.closest('.action-btn') ||
    e.target.closest('.tobt-select') ||   // if you have a class
    e.target.closest('.toggle')
  ) {
    return;
  }

  // 2️⃣ Only react to explicit callsign click
  const el = e.target.closest('[data-callsign]');
  if (!el) return;

  openFlightPlanModal(el.dataset.callsign);
});


document.addEventListener('keydown', async e => {
  if (!e.target.classList.contains('callsign-input')) return;

  if (e.key === 'Enter') {
    e.preventDefault();
    await saveCallsign(e.target);
    e.target.blur(); // optional: visually confirms save
  }
});



document.addEventListener('click', async e => {
  const btn = e.target.closest('.tobt-remove-btn');
  if (!btn) return;
  if (!CAN_EDIT) return;

  const callsign = btn.dataset.callsign;
const icao = btn.dataset.icao;

const ok = await openConfirmModal({
  title: 'Remove Manual TOBT',
  message: 'Remove manual TOBT for ' + callsign + '?'
});

if (!ok) return;


  const res = await fetch('/api/tobt/clear-manual', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'same-origin',
  body: JSON.stringify({ callsign, icao })
});


  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Failed to remove TOBT');
    return;
  }

  location.reload();
});


  document.addEventListener('change', async e => {
  const select = e.target.closest('.tobt-select');
  if (!select || !select.value) return;

  const callsign = select.dataset.callsign;
  const slotKey = select.value; // IMPORTANT: already a full slotKey

  const res = await fetch('/api/tobt/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ slotKey, callsign, manual: true })

  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Failed to book TOBT');
    select.value = '';
    return;
  }

  location.reload();
});


/* ----------------------------------------------------
   RESTORE TOGGLES
---------------------------------------------------- */
socket.on('syncState', state => {
  Object.entries(state).forEach(([callsign, toggles]) => {
    if (!toggles.start) return;

    const btn = document.querySelector(
      '.toggle-btn[data-callsign="' + callsign + '"][data-type="start"]'
    );
    if (!btn) return;

    btn.innerText = '✅';
    btn.classList.add('active');
  });
});



socket.on('toggleUpdated', ({ callsign, type, value }) => {
  if (type !== 'start') return;

  const btn = document.querySelector(
    '.toggle-btn[data-callsign="' + callsign + '"][data-type="' + type + '"]'
  );
  if (!btn) return;

  btn.innerText = value ? '✅' : '⬜';
  btn.classList.toggle('active', value);
});

/* ----------------------------------------------------
   TSAT SYNC
---------------------------------------------------- */
socket.on('syncTSAT', data => {
  Object.entries(data).forEach(([callsign, tsat]) => {
    const cell = document.querySelector(
      '.tsat-cell[data-callsign="' + callsign + '"]'
    );
    if (!cell) return;

    const span = cell.querySelector('.tsat-time');
    const refreshBtn = cell.querySelector('.tsat-refresh');

    if (span) span.innerText = tsat || '-';
    if (refreshBtn) refreshBtn.style.display = tsat ? 'inline-block' : 'none';
  });
});

/* TSAT Live Update */
socket.on('tsatUpdated', ({ callsign, tsat }) => {
  const cell = document.querySelector(
    '.tsat-cell[data-callsign="' + callsign + '"]'
  );
  if (!cell) return;

  const span = cell.querySelector('.tsat-time');
  const refreshBtn = cell.querySelector('.tsat-refresh');

  if (span) span.innerText = tsat || '-';
  if (refreshBtn) refreshBtn.style.display = tsat ? 'inline-block' : 'none';
});

/* ----------------------------------------------------
   CLR / START BUTTON HANDLERS
---------------------------------------------------- */
document.addEventListener('click', function (e) {
  if (!CAN_EDIT) return;

  const btn = e.target.closest('.toggle-btn');
  if (!btn) return;


  const callsign = btn.dataset.callsign;
  const type = btn.dataset.type;
  const sector = btn.getAttribute('data-sector') || null;

  const isActive = btn.classList.toggle('active');
  btn.innerText = isActive ? '✅' : '⬜';

  socket.emit('updateToggle', { callsign, type, value: isActive, sector });

  if (type === 'start') {
    const row = btn.closest('tr');
    const tsatCell = row?.querySelector('.tsat-cell[data-callsign="' + callsign + '"]');
    const span = tsatCell?.querySelector('.tsat-time');
    const refreshBtn = tsatCell?.querySelector('.tsat-refresh');

    if (isActive) {
      
    } else {
      if (span) span.innerText = '-';
      if (refreshBtn) refreshBtn.style.display = 'none';
      socket.emit('cancelTSAT', { callsign, sector });
    }
  }
});

/* ----------------------------------------------------
   TSAT REFRESH BUTTON
---------------------------------------------------- */
document.addEventListener('click', function (e) {
  if (!e.target.classList.contains('tsat-refresh')) return;

  const callsign = e.target.getAttribute('data-callsign');
  const row = e.target.closest('tr');
  if (!row) return;

  const startBtn = row.querySelector(
    '.toggle-btn[data-type="start"][data-callsign="' + callsign + '"]'
  );
  if (!startBtn) return;

  const sector = startBtn.getAttribute('data-sector');
  if (!sector) return;

  socket.emit('recalculateTSAT', { callsign, sector });
});
</script>

<script>
function renderRecentlyStartedTable(data) {
  const tbody = document.querySelector('#recentlyStartedTable tbody');
  tbody.innerHTML = '';
    const disabledAttr = CAN_EDIT ? '' : ' disabled';


  const MAX_ROWS = 5;

  data.slice(0, MAX_ROWS).forEach(item => {
    const tr = document.createElement('tr');

    tr.innerHTML =
  '<td>' + item.callsign + '</td>' +
  '<td>' + item.startedAt + '</td>' +
  '<td>' +
  '<button class="send-back-btn action-btn" data-callsign="' + item.callsign + '"' + disabledAttr + '>' +
    'Send Back' +
  '</button>' +
  '<button class="delete-started-btn action-btn" data-callsign="' + item.callsign + '" title="Delete entry"' + disabledAttr + '>' +
    '<svg class="trash-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="3 6 5 6 21 6"></polyline>' +
      '<path d="M19 6l-1 14H6L5 6"></path>' +
      '<path d="M10 11v6"></path>' +
      '<path d="M14 11v6"></path>' +
      '<path d="M9 6V4h6v2"></path>' +
    '</svg>' +
  '</button>' +
'</td>';


    tbody.appendChild(tr);
  });

  // Pad empty rows
  const missing = MAX_ROWS - data.length;

  for (let i = 0; i < missing; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>&nbsp;</td>' +
      '<td>&nbsp;</td>' +
      '<td>&nbsp;</td>';
    tbody.appendChild(tr);
  }
}

/* Handle Send Back button in Recently Started */
document.addEventListener('click', e => {
  const btn = e.target.closest('.send-back-btn');
  if (!btn) return;
  if (btn.disabled || !CAN_EDIT) return;

  const callsign = btn.dataset.callsign;
  if (!callsign) return;

  socket.emit('sendBackToUpcoming', { callsign, icao });
});

document.addEventListener('click', async e => {
  const btn = e.target.closest('.delete-started-btn');
  if (!btn) return;
  if (btn.disabled || !CAN_EDIT) return;

  const callsign = btn.dataset.callsign;
  if (!callsign) return;

  const ok = await openConfirmModal({
    title: 'Confirm Removal',
    message: 'Are you sure you want to permanently remove ' +
             callsign +
             ' from Recently Started?'
  });

  if (!ok) return;

  socket.emit('deleteStartedEntry', { callsign });
});


</script>
<script>
async function refreshDeparturesTable() {
  const res = await fetch(window.location.href);
  const html = await res.text();

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const newMain = doc.querySelector('#mainDeparturesTable tbody');
  const oldMain = document.querySelector('#mainDeparturesTable tbody');

  if (newMain && oldMain) {
    oldMain.innerHTML = newMain.innerHTML;
  }

  // Restore search filter
  const saved = localStorage.getItem('callsignFilter') || '';
  applyFilter(saved);

  // Re-bind "Click to expand" handlers on the new rows
  if (typeof bindRouteExpanders === 'function') {
    bindRouteExpanders();
  }

  // Allow DOM to finish updating BEFORE syncing toggle state
  setTimeout(() => {
    // Re-apply CLR / START states
    socket.emit('requestToggleStateSync');

    // Re-apply TSAT values in bottom table
    socket.emit('requestTSATSync');

    // Re-sync STARTED checkbox state in bottom table
    socket.emit('requestStartedStateSync');
  }, 150);
}


/* ============================================================
   PERIODIC ROW COLOUR REFRESH (1 min)
============================================================ */
setInterval(() => {
  document.querySelectorAll('#tsatQueueTable tbody tr').forEach(row => {
    const tsatCell = row.children[1];
    if (!tsatCell) return;

    const tsat = tsatCell.innerText.trim();
    const rowClass = getRowColorClass(tsat);

    row.classList.remove('row-green', 'row-amber', 'row-red');
    if (rowClass) row.classList.add(rowClass);
  });
}, 60000);

</script>
<script>
document.addEventListener('DOMContentLoaded', () => {

  // IMPORTANT: listeners must already be defined ABOVE this
  socket.emit('requestSyncAllState', { icao });


});
</script>



`;

res.send(
  renderLayout({
    title: 'ATC Slot Management',
    user,
    isAdmin,
    layoutClass: 'dashboard-full',
    content
  })
);



});

app.post('/api/tobt/clear-manual', requireLogin, async (req, res) => {
  const { callsign, icao } = req.body;
  if (!callsign || !icao) {
    return res.status(400).json({ error: 'Missing data' });
  }

  const cs = callsign.trim().toUpperCase();
  const from = icao.trim().toUpperCase();

  if (!canEditIcao(req.session.user.data, from)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // 1) Identify matching manual bookings from in-memory cache (source of UI truth)
  const matchingSlotKeys = Object.keys(tobtBookingsByKey).filter(k => {
    const b = tobtBookingsByKey[k];
    return b && b.from === from && b.callsign === cs && b.cid === null;
  });

  if (matchingSlotKeys.length === 0) {
    // Still attempt DB cleanup in case cache is stale, but tell client nothing was found in memory
    await prisma.tobtBooking.deleteMany({
      where: { from, callsign: cs, cid: null }
    });
    return res.json({ success: true, removed: 0 });
  }

  // 2) Delete from DB (authoritative persistence)
  await prisma.tobtBooking.deleteMany({
    where: { from, callsign: cs, cid: null }
  });

  // 3) Remove from in-memory cache so the UI updates
  for (const slotKey of matchingSlotKeys) {
    delete tobtBookingsByKey[slotKey];
  }

  // 4) Clear TSAT using normalized callsign
  delete sharedTSAT[cs];

  // 5) Notify clients
  emitToIcao(
    from,
    'unassignedTobtUpdate',
    buildUnassignedTobtsForICAO(from)
  );
  emitToIcao(from, 'departures:update');

  return res.json({ success: true, removed: matchingSlotKeys.length });
});



app.post('/api/tobt/remove', async (req, res) => {
  const user = req.session?.user?.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user?.cid));
  const isATC = !!user?.controller;

  if (!isAdmin && !isATC) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { slotKey } = req.body;
  if (!slotKey) {
    return res.status(400).json({ error: 'Missing slotKey' });
  }

  // ✅ DB is source of truth
  const booking = await prisma.tobtBooking.findUnique({
    where: { slotKey }
  });

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  // 🔒 Only ATC-assigned TOBTs (cid === null)
  if (booking.cid !== null) {
    return res.status(403).json({
      error: 'Pilot-booked TOBTs cannot be removed by ATC'
    });
  }

  await prisma.tobtBooking.delete({
    where: { slotKey }
  });

  delete tobtBookingsByKey[slotKey];

  emitToIcao(booking.from, 'departures:update');


  res.json({ success: true });
});




app.get('/airport-portal', (req, res) => {
  const user = req.session?.user?.data || null;
  const isAdmin = user ? ADMIN_CIDS.includes(Number(user.cid)) : false;

  const content = `
    <section class="card card-full">
      <h2>Airport Portal</h2>
      <p style="color:var(--muted);margin-bottom:24px;">Enter an ICAO code to view airport information, charts, scenery, and documentation.</p>

      <form id="portalForm" class="icao-search">
        <input
          type="text"
          id="portalIcao"
          placeholder="Enter ICAO (e.g. EGLL)"
          maxlength="4"
          required
          autocomplete="off"
        />
        <button type="submit">Open Portal</button>
      </form>
    </section>

    <script>
    document.getElementById('portalForm').addEventListener('submit', function(e) {
      e.preventDefault();
      var raw = document.getElementById('portalIcao').value.trim().toUpperCase();
      var icao = null;
      if (/^[A-Z]{3}$/.test(raw)) { icao = 'K' + raw; }
      else if (/^[A-Z]{4}$/.test(raw)) { icao = raw; }
      else { alert('Please enter a valid ICAO (e.g. LAX or KLAX)'); return; }
      window.location.href = '/icao/' + icao;
    });
    </script>
  `;

  res.send(renderLayout({
    title: 'Airport Portal',
    user,
    isAdmin,
    content,
    layoutClass: 'dashboard-full'
  }));
});

app.get('/atc', requireLogin, requirePageEnabled('atc'), (req, res) => {
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/');
  }

  const user = req.session.user.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

  

  const content = `
    <section class="card">
      <h2>ATC Slot Management</h2>
      <p>Select an airport to manage ground departures.</p>

      <form action="/departures" method="GET" class="icao-search">
        <input
          type="text"
          name="icao"
          placeholder="Enter ICAO (e.g. EGLL)"
          maxlength="4"
          required
        />
        <button type="submit">Load Departures</button>
      </form>
    </section>
  `;

  res.send(
    renderLayout({
      title: 'ATC Slot Management',
      user,
      isAdmin,
      layoutClass: 'dashboard-full',
      content
    })
  );
});

// ===== AIRSPACE MANAGEMENT PAGE =====
app.get('/airspace', requirePageEnabled('airspace'), async (req, res) => {
  const user = req.session?.user?.data || null;
  const cid = Number(user?.cid) || null;
  const isAdmin = cid && ADMIN_CIDS.includes(cid);

  const content = `
  <style>
    .airspace-page { }
    .airspace-search-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
    .airspace-search-row input, .airspace-search-row select {
      padding: 8px 12px; background: var(--panel); border: 1px solid var(--border);
      border-radius: 6px; color: var(--text); font-size: 13px;
    }
    .airspace-search-row input { width: 140px; text-transform: uppercase; }
    .airspace-search-row select { min-width: 140px; }
    .airspace-search-row button {
      padding: 8px 16px; background: var(--accent); color: #020617; border: none;
      border-radius: 6px; font-weight: 600; cursor: pointer;
    }
    .airspace-filter-label { font-size: 11px; color: var(--muted); margin-bottom: 2px; display: block; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    .filter-btn-group { display: flex; flex-wrap: wrap; gap: 4px; }
    .filter-btn {
      padding: 4px 12px; font-size: 12px; font-weight: 500;
      background: rgba(255,255,255,0.03); border: 1px solid var(--border);
      border-radius: 6px; color: var(--muted); cursor: pointer; transition: all .15s;
    }
    .filter-btn:hover { border-color: var(--accent); color: var(--text); }
    .filter-btn.active { background: var(--accent); color: #020617; border-color: var(--accent); font-weight: 600; }
    #airspaceFirMap { width: 100%; height: 340px; border-radius: 8px; margin-top: 12px; border: 1px solid var(--border); background: #0b1220; }
    #airspaceFirMap path:focus { outline: none; }
    #airspaceFirMap .leaflet-control-zoom a { background: #0b1220; color: var(--text); border-color: var(--border); }
    .fir-summary-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 8px; margin-top: 16px; max-height: 260px; overflow-y: auto;
    }
    .fir-chip {
      padding: 8px 12px; background: var(--panel); border: 1px solid var(--border);
      border-radius: 6px; cursor: pointer; font-size: 13px; display: flex;
      justify-content: space-between; align-items: center; transition: border-color .2s;
    }
    .fir-chip:hover { border-color: var(--accent); }
    .fir-chip .fir-name { font-weight: 600; color: var(--text); }
    .fir-chip .fir-count { font-size: 11px; color: var(--muted); }
    .fir-detail-card { margin-top: 20px; }
    .fir-detail-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .fir-detail-header h2 { margin: 0; }
    .fir-detail-meta { font-size: 13px; color: var(--muted); }
    .fir-detail-header .back-link { color: var(--accent); text-decoration: none; font-size: 13px; }
    #firDetailTable { border-collapse: collapse; width: 100%; }
    #firDetailTable th, #firDetailTable td { padding: 6px 10px; text-align: left; border-top: 1px solid var(--border); white-space: nowrap; }
    #firDetailTable th { font-size: 13px; font-weight: 600; color: var(--muted); }
    #firDetailTable td { font-size: 13px; }
    .staff-window { font-family: monospace; font-size: 12px; }
    .flow-badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
    }
    .flow-badge.none { background: rgba(255,255,255,0.05); color: var(--muted); }
    .flow-badge.slotted { background: rgba(34,197,94,0.15); color: #4ade80; }
    .flow-badge.booking { background: rgba(251,146,60,0.15); color: #fb923c; }
    .fir-highlight { fill: rgba(56,189,248,0.2); stroke: var(--accent); stroke-width: 2; }
    .fir-timeline {
      margin-top: 16px; padding: 12px; background: rgba(255,255,255,0.02);
      border: 1px solid var(--border); border-radius: 8px;
    }

    .tl-weekly { overflow-x: auto; min-width: 100%; }
    .tl-header { position: relative; height: 28px; border-bottom: 1px solid var(--border); margin-bottom: 0; min-width: 800px; margin-left: 68px; }
    .tl-day-header {
      position: absolute; top: 0; height: 28px;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 600; color: var(--text);
      border-right: 1px solid var(--border);
      background: rgba(255,255,255,0.02);
    }
    .tl-body { position: relative; min-width: 800px; }
    .tl-grid { position: absolute; top: 0; bottom: 0; left: 68px; right: 0; pointer-events: none; }
    .tl-gridline {
      position: absolute; top: 0; bottom: 0;
      border-left: 1px solid rgba(255,255,255,0.04);
    }
    .tl-gridline span {
      position: absolute; top: -14px;
      font-size: 9px; color: var(--muted2);
      transform: translateX(-50%);
    }
    .tl-row { display: flex; align-items: center; min-height: 30px; border-bottom: 1px solid rgba(255,255,255,0.08); }
    .tl-row-label {
      flex: 0 0 60px; font-size: 11px; font-weight: 600; color: var(--accent);
      font-family: monospace; padding-right: 8px; text-align: right;
    }
    .tl-row-bar { flex: 1; position: relative; min-height: 24px; }
    .tl-seg {
      position: absolute; height: 18px;
      background: rgba(56,189,248,0.3); border: 1px solid rgba(56,189,248,0.5);
      border-radius: 3px; font-size: 9px; color: #fff; font-weight: 600;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden; white-space: nowrap; cursor: default;
      transition: background .15s;
    }
    .tl-seg:hover { background: rgba(56,189,248,0.5); }

    .fir-timeline-bar {
      position: relative; height: 32px; background: rgba(255,255,255,0.03);
      border-radius: 4px; margin-bottom: 4px; border: 1px solid var(--border);
    }
    .fir-timeline-segment {
      position: absolute; top: 2px; bottom: 2px; border-radius: 3px;
      background: rgba(56,189,248,0.3); border: 1px solid rgba(56,189,248,0.5);
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; color: var(--text); overflow: hidden; white-space: nowrap;
    }
    .fir-timeline-label { font-size: 11px; color: var(--muted); margin-bottom: 2px; }
    #firDetailTable td.fir-route-col {
      font-family: monospace; font-size: 11px;
      max-width: 300px; line-height: 1.5; cursor: pointer;
    }
    #firDetailTable td.fir-route-col .route-text {
      display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #firDetailTable td.fir-route-col.expanded .route-text {
      display: block; -webkit-line-clamp: unset; white-space: normal; word-break: break-all;
    }
    .fir-view-btn {
      padding: 3px 10px; background: rgba(56,189,248,0.12); color: var(--accent);
      border: 1px solid rgba(56,189,248,0.3); border-radius: 4px; cursor: pointer;
      font-size: 11px; font-weight: 600; white-space: nowrap;
    }
    .fir-view-btn:hover { background: rgba(56,189,248,0.25); }
    .fir-route-modal-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 9999;
      display: flex; align-items: center; justify-content: center;
    }
    .fir-route-modal {
      background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
      width: 700px; max-width: 90vw; max-height: 85vh; overflow: hidden;
      display: flex; flex-direction: column;
    }
    .fir-route-modal-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 12px 16px; border-bottom: 1px solid var(--border);
    }
    .fir-route-modal-header h3 { margin: 0; font-size: 15px; }
    .fir-route-modal-close {
      background: none; border: none; color: var(--muted); font-size: 20px; cursor: pointer;
    }
    .fir-route-modal-map { height: 400px; width: 100%; }

    /* Mobile cards layout */
    .fir-leg-cards { display: none; }
    .fir-leg-cards { box-sizing: border-box; }
    .fir-leg-card {
      background: rgba(255,255,255,0.03); border: 1px solid var(--border);
      border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;
      overflow: hidden; word-break: break-word;
    }
    .fir-leg-card-actions { display: flex; gap: 6px; margin-top: 8px; }
    .fir-leg-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .fir-leg-card-header .wf { font-weight: 700; color: var(--accent); font-size: 14px; }
    .fir-leg-card-header .fir { font-family: monospace; color: var(--accent); font-size: 12px; }
    .fir-leg-card-route { font-size: 11px; color: var(--muted); display: flex; gap: 4px; }
    .fir-leg-card-row { font-size: 12px; padding: 2px 0; }

    @media (max-width: 900px) {
      .airspace-page { padding: 0; margin: 0; width: 100vw; box-sizing: border-box; }
      .airspace-page .card { padding: 10px 8px; margin: 8px 4px; width: calc(100vw - 44px); box-sizing: border-box; }
      .airspace-search-row { flex-direction: column; align-items: stretch; gap: 8px; }
      .airspace-search-row input, .airspace-search-row select { width: 100%; min-width: 0; box-sizing: border-box; }
      .airspace-search-row > div[style*="border-left"] { display: none; }
      #firSearchBtn { width: 100%; }
      #airspaceFirMap { height: 220px; }
      .fir-summary-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); max-height: 180px; }
      .fir-timeline, #tlToggleRow { display: none !important; }
      .fir-timeline-segment { font-size: 8px; }
      .fir-route-modal { width: 95vw; max-height: 90vh; }
      .fir-route-modal-map { height: 250px; }
      .fir-detail-header h2 { font-size: 16px; }
      .fir-detail-meta { font-size: 11px; }

      /* Hide table, show cards */
      .fir-desktop-table { display: none !important; }
      .fir-leg-cards { display: block !important; }
    }
  </style>

  <main class="dashboard-full airspace-page">
    <!-- Search / Select Section -->
    <section class="card" id="airspaceSearchSection">
      <h2>Airspace Management</h2>
      <p style="color:var(--muted);margin-bottom:12px;">Enter an FIR code or click one on the map to view staffing requirements for the active schedule.</p>

      <div class="airspace-search-row" style="margin-bottom:12px;">
        <div>
          <label class="airspace-filter-label">FIR Code</label>
          <input type="text" id="firSearchInput" placeholder="e.g. EGTT" maxlength="10" />
        </div>
        <button id="firSearchBtn" style="align-self:flex-end;">Load FIR</button>
      </div>

      <!-- Hidden selects for JS compat -->
      <select id="firFilterRegion" style="display:none;"><option value="">All Regions</option></select>
      <select id="firFilterDivision" style="display:none;"><option value="">All Divisions</option></select>

      <div style="margin-bottom:12px;">
        <label class="airspace-filter-label" style="margin-bottom:6px;display:block;">Region</label>
        <div id="regionBtns" class="filter-btn-group">
        </div>
      </div>

      <div style="margin-bottom:12px;">
        <label class="airspace-filter-label" style="margin-bottom:6px;display:block;">Division</label>
        <div id="divisionBtns" class="filter-btn-group">
        </div>
      </div>

      <div id="airspaceFirMap"></div>

      <div id="firChipContainer" style="margin-top:16px;">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">FIRs on the active schedule (click to view):</div>
        <div class="fir-summary-grid" id="firSummaryGrid"></div>
      </div>
    </section>

    <!-- Detail Section (hidden until FIR selected) -->
    <section class="card fir-detail-card" id="firDetailSection" style="display:none;">
      <div class="fir-detail-header">
        <div>
          <a href="#" class="back-link" id="firBackLink">&larr; Back to all FIRs</a>
          <h2 id="firDetailTitle"></h2>
          <div class="fir-detail-meta" id="firDetailMeta"></div>
        </div>
      </div>

      <!-- Timeline -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px;" id="tlToggleRow" class="hidden">
        <span style="font-size:13px;font-weight:600;">Staffing Timeline</span>
        <div style="display:flex;align-items:center;gap:12px;">
          <div class="filter-btn-group" id="tlDaySelector" style="display:none;"></div>
          <div class="filter-btn-group">
            <button class="filter-btn active" data-view="weekly" id="tlWeeklyBtn">Weekly</button>
            <button class="filter-btn" data-view="daily" id="tlDailyBtn">Daily</button>
          </div>
        </div>
      </div>
      <div class="fir-timeline" id="firTimeline"></div>

      <!-- Desktop table -->
      <div class="fir-desktop-table" style="overflow-x:auto;margin-top:16px;">
        <table id="firDetailTable">
          <thead>
            <tr>
              <th>WF</th>
              <th>FIR</th>
              <th>From</th>
              <th>To</th>
              <th>Date</th>
              <th>Staff Window</th>
              <th>Staff Duration</th>
              <th>ATC Route</th>
              <th>Dep Flow</th>
              <th>Flow Type</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="firDetailBody"></tbody>
        </table>
      </div>

      <!-- Mobile cards -->
      <div class="fir-leg-cards" id="firDetailCards"></div>
    </section>
  </main>

  <script>
  document.addEventListener('DOMContentLoaded', function() {
    var map = null;
    var firGeoLayer = null;
    var highlightLayer = null;
    var currentTlView = 'weekly';
    var currentTlDay = 0; // index into event days
    var currentTlData = null;
    var eventDays = []; // [{ start, label }]

    function buildEventDays(legs) {
      var dayMs = 86400000;
      var dNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

      var absMin = Infinity, absMax = -Infinity;
      legs.forEach(function(l) {
        if (l.staffStartAbs) absMin = Math.min(absMin, l.staffStartAbs);
        if (l.staffEndAbs) absMax = Math.max(absMax, l.staffEndAbs);
      });
      if (!isFinite(absMin)) return [];

      var start = Math.floor(absMin / dayMs) * dayMs;
      var end = Math.ceil(absMax / dayMs) * dayMs;
      var days = [];
      for (var t = start; t < end; t += dayMs) {
        var dt = new Date(t);
        days.push({
          start: t,
          label: dNames[dt.getUTCDay()] + ' ' + dt.getUTCDate() + ' ' + mNames[dt.getUTCMonth()]
        });
      }
      return days;
    }

    function renderDaySelector() {
      var sel = document.getElementById('tlDaySelector');
      if (currentTlView !== 'daily' || !eventDays.length) {
        sel.style.display = 'none';
        return;
      }
      sel.style.display = '';
      sel.innerHTML = eventDays.map(function(d, i) {
        return '<button class="filter-btn' + (i === currentTlDay ? ' active' : '') + '" data-day="' + i + '">' + d.label + '</button>';
      }).join('');
    }

    function renderTimeline(legs, mode, view) {
      var timeline = document.getElementById('firTimeline');
      var toggleRow = document.getElementById('tlToggleRow');
      var hasAbs = legs.some(function(l) { return l.staffStartAbs && l.staffEndAbs; });

      if (!legs.length || !hasAbs) {
        timeline.innerHTML = '';
        toggleRow.classList.add('hidden');
        return;
      }

      toggleRow.classList.remove('hidden');
      document.getElementById('tlWeeklyBtn').classList.toggle('active', view === 'weekly');
      document.getElementById('tlDailyBtn').classList.toggle('active', view === 'daily');

      eventDays = buildEventDays(legs);
      if (currentTlDay >= eventDays.length) currentTlDay = 0;
      renderDaySelector();

      var dayMs = 86400000;
      var dNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

      var rangeStart, rangeEnd, totalRange;

      if (view === 'daily' && eventDays.length) {
        // Single day view
        rangeStart = eventDays[currentTlDay].start;
        rangeEnd = rangeStart + dayMs;
        totalRange = dayMs;
      } else {
        // Full event range
        var absMin = Infinity, absMax = -Infinity;
        legs.forEach(function(l) {
          if (l.staffStartAbs) absMin = Math.min(absMin, l.staffStartAbs);
          if (l.staffEndAbs) absMax = Math.max(absMax, l.staffEndAbs);
        });
        rangeStart = Math.floor(absMin / dayMs) * dayMs;
        rangeEnd = Math.ceil(absMax / dayMs) * dayMs;
        totalRange = rangeEnd - rangeStart || dayMs;
      }

      var html = '<div class="tl-weekly">';

      if (view === 'weekly') {
        var numDays = Math.ceil(totalRange / dayMs);
        var dateHeaders = '';
        for (var d = 0; d < numDays; d++) {
          var dt = new Date(rangeStart + d * dayMs);
          var dayLabel = dNames[dt.getUTCDay()] + ' ' + dt.getUTCDate() + ' ' + mNames[dt.getUTCMonth()];
          dateHeaders += '<div class="tl-day-header" style="left:' + (d * dayMs / totalRange * 100) + '%;width:' + (dayMs / totalRange * 100) + '%;">' + dayLabel + '</div>';
        }
        html += '<div class="tl-header">' + dateHeaders + '</div>';
        html += '<div class="tl-body">';
      } else {
        // Daily: hour gridlines every 1 hour
        var gridLines = '';
        for (var h = 0; h < dayMs; h += 3600000) {
          var hourLabel = String(Math.floor(h / 3600000)).padStart(2, '0') + ':00';
          gridLines += '<div class="tl-gridline" style="left:' + (h / dayMs * 100) + '%;"><span>' + hourLabel + '</span></div>';
        }
        html += '<div style="text-align:center;font-size:12px;font-weight:600;color:var(--text);padding:4px 0;">' + eventDays[currentTlDay].label + ' (UTC)</div>';
        html += '<div class="tl-header" style="height:20px;"></div>';
        html += '<div class="tl-body"><div class="tl-grid">' + gridLines + '</div>';
      }

      // Filter legs for daily view (only those overlapping the selected day)
      var visibleLegs = legs;
      if (view === 'daily') {
        visibleLegs = legs.filter(function(l) {
          return l.staffStartAbs && l.staffEndAbs && l.staffEndAbs > rangeStart && l.staffStartAbs < rangeEnd;
        });
      }

      // Assign vertical lanes to overlapping segments
      function assignLanes(segs) {
        var lanes = [];
        segs.forEach(function(s) {
          var sStart = Math.max(s.staffStartAbs || 0, rangeStart);
          s._lane = 0;
          for (var i = 0; i < lanes.length; i++) {
            if (sStart >= lanes[i]) { s._lane = i; lanes[i] = s.staffEndAbs || 0; return; }
          }
          s._lane = lanes.length;
          lanes.push(s.staffEndAbs || 0);
        });
        return lanes.length;
      }

      if (mode === 'grouped') {
        var firGroups = {};
        visibleLegs.forEach(function(l) {
          var fir = l._fir || l.fir || 'Unknown';
          if (!firGroups[fir]) firGroups[fir] = [];
          firGroups[fir].push(l);
        });
        Object.keys(firGroups).sort().forEach(function(fir) {
          var segs = firGroups[fir].filter(function(l) { return l.staffStartAbs && l.staffEndAbs; });
          segs.sort(function(a, b) { return a.staffStartAbs - b.staffStartAbs; });
          var numLanes = assignLanes(segs);
          var rowH = Math.max(24, numLanes * 20 + 4);
          html += '<div class="tl-row"><div class="tl-row-label">' + fir + '</div><div class="tl-row-bar" style="height:' + rowH + 'px;">';
          segs.forEach(function(l) {
            var sClamp = Math.max(l.staffStartAbs, rangeStart);
            var eClamp = Math.min(l.staffEndAbs, rangeEnd);
            var left = ((sClamp - rangeStart) / totalRange * 100);
            var width = ((eClamp - sClamp) / totalRange * 100);
            var top = l._lane * 20 + 2;
            html += '<div class="tl-seg" style="left:' + left + '%;width:' + Math.max(width, 0.3) + '%;top:' + top + 'px;" title="' + l.wf + ' ' + l.from + '-' + l.to + '\\nStaff: ' + l.staffStart + ' - ' + l.staffEnd + '">' + l.wf + '</div>';
          });
          html += '</div></div>';
        });
      } else {
        visibleLegs.forEach(function(l) {
          if (!l.staffStartAbs || !l.staffEndAbs) return;
          var sClamp = Math.max(l.staffStartAbs, rangeStart);
          var eClamp = Math.min(l.staffEndAbs, rangeEnd);
          var left = ((sClamp - rangeStart) / totalRange * 100);
          var width = ((eClamp - sClamp) / totalRange * 100);
          html += '<div class="tl-row"><div class="tl-row-label">' + l.wf + '</div><div class="tl-row-bar">';
          html += '<div class="tl-seg" style="left:' + left + '%;width:' + Math.max(width, 0.3) + '%;top:2px;" title="' + l.wf + ' ' + l.from + '-' + l.to + '\\nStaff: ' + l.staffStart + ' - ' + l.staffEnd + '">' + l.from + '-' + l.to + '</div>';
          html += '</div></div>';
        });
      }

      if (!visibleLegs.length && view === 'daily') {
        html += '<div style="padding:16px;text-align:center;color:var(--muted);font-size:13px;">No FIR transits on this day</div>';
      }

      html += '</div></div>';
      timeline.innerHTML = html;
    }

    // Toggle handlers
    document.getElementById('tlWeeklyBtn').addEventListener('click', function() {
      currentTlView = 'weekly';
      if (currentTlData) renderTimeline(currentTlData.legs, currentTlData.mode, 'weekly');
    });
    document.getElementById('tlDailyBtn').addEventListener('click', function() {
      currentTlView = 'daily';
      if (currentTlData) renderTimeline(currentTlData.legs, currentTlData.mode, 'daily');
    });
    document.getElementById('tlDaySelector').addEventListener('click', function(e) {
      var btn = e.target.closest('.filter-btn');
      if (!btn || !btn.dataset.day) return;
      currentTlDay = Number(btn.dataset.day);
      if (currentTlData) renderTimeline(currentTlData.legs, currentTlData.mode, 'daily');
    });

    // Init map
    map = L.map('airspaceFirMap', { zoomControl: true }).setView([30, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 8, noWrap: true
    }).addTo(map);
    setTimeout(function() { map.invalidateSize(); }, 200);

    // FIR metadata lookup (populated from geojson)
    var firMeta = {}; // firId -> { region, division }
    var allFirSummary = []; // stored for filtering
    var activeRegions = new Set();
    var activeDivisions = new Set();
    var btnsPopulated = false;
    var summaryLoaded = false;

    function disableInactiveBtns() {
      if (!btnsPopulated || !summaryLoaded) return;

      // Rebuild active sets from firMeta + allFirSummary
      activeRegions.clear();
      activeDivisions.clear();
      allFirSummary.forEach(function(f) {
        var meta = firMeta[f.fir] || {};
        if (meta.region) activeRegions.add(meta.region);
        if (meta.division) activeDivisions.add(meta.division);
      });

      document.querySelectorAll('#regionBtns .filter-btn').forEach(function(btn) {
        if (btn.dataset.value && !activeRegions.has(btn.dataset.value)) {
          btn.disabled = true;
          btn.style.opacity = '0.3';
          btn.style.cursor = 'not-allowed';
        }
      });
      document.querySelectorAll('#divisionBtns .filter-btn').forEach(function(btn) {
        if (btn.dataset.value && !activeDivisions.has(btn.dataset.value)) {
          btn.disabled = true;
          btn.style.opacity = '0.3';
          btn.style.cursor = 'not-allowed';
        }
      });
    }

    // Load FIR boundaries onto map
    fetch('/api/fir-merged.geojson')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var defaultStyle = { color: 'rgba(255,255,255,0.12)', weight: 1, fillOpacity: 0 };
        var hoverStyle = { color: '#38bdf8', weight: 2, fillColor: 'rgba(56,189,248,0.15)', fillOpacity: 0.25 };

        // FIRs that belong to additional divisions beyond what's in the geojson
        var extraDivisions = {
          'EGGX': ['NATFSS'],
          'CZQX': ['NATFSS'],
          'CZQO': ['NATFSS'],
          'BIRD': ['NATFSS'],
          'LPPO': ['NATFSS'],
          'ENOB': ['NATFSS']
        };

        // Build metadata + populate dropdowns (use base FIR codes)
        var regions = new Set(), divisions = new Set();
        data.features.forEach(function(f) {
          var p = f.properties || {};
          if (p.id) {
            var base = p.id.split('-')[0];
            if (!firMeta[base]) {
              var divs = [p.division || ''];
              if (extraDivisions[base]) divs = divs.concat(extraDivisions[base]);
              firMeta[base] = { region: p.region || '', division: p.division || '', divisions: divs };
            }
          }
          if (p.region) regions.add(p.region);
          if (p.division) divisions.add(p.division);
        });
        // Add extra divisions to the dropdown set
        Object.values(extraDivisions).forEach(function(arr) { arr.forEach(function(d) { divisions.add(d); }); });

        // Populate region buttons
        var regionBtns = document.getElementById('regionBtns');
        Array.from(regions).sort().forEach(function(r) {
          regionBtns.innerHTML += '<button class="filter-btn" data-value="' + r + '">' + r + '</button>';
        });

        // Populate division buttons
        var divBtns = document.getElementById('divisionBtns');
        Array.from(divisions).sort().forEach(function(d) {
          divBtns.innerHTML += '<button class="filter-btn" data-value="' + d + '">' + d + '</button>';
        });

        // Also populate hidden selects for backward compat
        var regionSel = document.getElementById('firFilterRegion');
        Array.from(regions).sort().forEach(function(r) {
          regionSel.innerHTML += '<option value="' + r + '">' + r + '</option>';
        });
        var divSel = document.getElementById('firFilterDivision');
        Array.from(divisions).sort().forEach(function(d) {
          divSel.innerHTML += '<option value="' + d + '">' + d + '</option>';
        });

        // Button click handlers
        // Region buttons — load grouped view for that region
        regionBtns.addEventListener('click', function(e) {
          var btn = e.target.closest('.filter-btn');
          if (!btn) return;
          regionBtns.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
          divBtns.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          var val = btn.dataset.value;
          if (!val) return;
          var matching = allFirSummary.filter(function(f) {
            return (firMeta[f.fir] || {}).region === val;
          });
          if (matching.length) loadGroupDetail(matching, val, '');
        });

        // Division buttons — load grouped view for that division
        divBtns.addEventListener('click', function(e) {
          var btn = e.target.closest('.filter-btn');
          if (!btn) return;
          divBtns.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
          regionBtns.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          var val = btn.dataset.value;
          if (!val) return;
          var matching = allFirSummary.filter(function(f) {
            var meta = firMeta[f.fir] || {};
            return meta.divisions ? meta.divisions.indexOf(val) !== -1 : meta.division === val;
          });
          if (matching.length) loadGroupDetail(matching, '', val);
        });

        firGeoLayer = L.geoJSON(data, {
          style: defaultStyle,
          onEachFeature: function(feature, layer) {
            var rawId = feature.properties && feature.properties.id;
            var firId = rawId ? rawId.split('-')[0] : null;
            if (firId) {
              layer._firId = firId;
              layer._firRegion = (feature.properties.region || '');
              layer._firDivision = (feature.properties.division || '');
              layer.on('mouseover', function() { layer.setStyle(hoverStyle); layer.bringToFront(); });
              layer.on('mouseout', function() { firGeoLayer.resetStyle(layer); });
              layer.on('click', function() {
                layer.setStyle({ color: '#38bdf8', weight: 3, fillColor: 'rgba(56,189,248,0.35)', fillOpacity: 0.4 });
                setTimeout(function() { layer.setStyle({ color: '#38bdf8', weight: 2, fillColor: 'rgba(56,189,248,0.2)', fillOpacity: 0.3 }); }, 150);
                setTimeout(function() { layer.setStyle({ color: '#38bdf8', weight: 3, fillColor: 'rgba(56,189,248,0.35)', fillOpacity: 0.4 }); }, 300);
                setTimeout(function() { loadFirDetail(firId); }, 500);
              });
              layer.bindTooltip(firId, { sticky: true, className: 'fir-tooltip' });
            }
          }
        }).addTo(map);

        btnsPopulated = true;
        disableInactiveBtns();
      });

    // Load summary
    fetch('/api/airspace-management', { credentials: 'same-origin' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var grid = document.getElementById('firSummaryGrid');
        if (!data.firs || !data.firs.length) {
          grid.innerHTML = '<div style="color:var(--muted);font-size:13px;">No FIR data available. Ensure the active schedule has routes defined.</div>';
          return;
        }
        allFirSummary = data.firs;
        grid.innerHTML = data.firs.map(function(f) {
          var meta = firMeta[f.fir] || {};
          return '<div class="fir-chip" data-fir="' + f.fir + '" data-region="' + (meta.region || f.region || '') + '" data-division="' + (meta.division || f.division || '') + '">'
            + '<span class="fir-name">' + f.fir + '</span>'
            + '<span class="fir-count">' + f.legCount + ' leg' + (f.legCount !== 1 ? 's' : '') + '</span>'
            + '</div>';
        }).join('');

        grid.querySelectorAll('.fir-chip').forEach(function(chip) {
          chip.addEventListener('click', function() {
            loadFirDetail(chip.dataset.fir);
          });
        });

        summaryLoaded = true;
        disableInactiveBtns();
      });

    // Search
    document.getElementById('firSearchBtn').addEventListener('click', function() {
      var val = document.getElementById('firSearchInput').value.trim().toUpperCase();
      if (val) loadFirDetail(val);
    });
    document.getElementById('firSearchInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var val = this.value.trim().toUpperCase();
        if (val) loadFirDetail(val);
      }
    });

    // Back link
    document.getElementById('firBackLink').addEventListener('click', function(e) {
      e.preventDefault();
      document.getElementById('firDetailSection').style.display = 'none';
      document.getElementById('airspaceSearchSection').style.display = '';
      if (highlightLayer) { map.removeLayer(highlightLayer); highlightLayer = null; }
    });

    window.loadFirDetailFn = loadFirDetail;
    function loadFirDetail(firId) {
      fetch('/api/airspace-management?fir=' + encodeURIComponent(firId), { credentials: 'same-origin' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          document.getElementById('airspaceSearchSection').style.display = 'none';
          document.getElementById('firDetailSection').style.display = '';

          document.getElementById('firDetailTitle').textContent = data.fir + ' Airspace';
          var metaParts = [];
          if (data.region) metaParts.push('Region: ' + data.region);
          if (data.division) metaParts.push('Division: ' + data.division);
          metaParts.push(data.legs.length + ' leg' + (data.legs.length !== 1 ? 's' : '') + ' transiting');
          document.getElementById('firDetailMeta').textContent = metaParts.join(' — ');

          // Highlight FIR on map
          if (highlightLayer) { map.removeLayer(highlightLayer); }
          if (firGeoLayer) {
            firGeoLayer.eachLayer(function(layer) {
              if (layer.feature && layer.feature.properties && layer.feature.properties.id === data.fir) {
                highlightLayer = L.geoJSON(layer.feature, {
                  style: { color: 'var(--accent)', weight: 2, fillColor: 'rgba(56,189,248,0.15)', fillOpacity: 0.3 }
                }).addTo(map);
                map.fitBounds(highlightLayer.getBounds(), { padding: [30, 30], maxZoom: 6 });
              }
            });
          }

          // Build timeline for single FIR
          currentTlData = { legs: data.legs, mode: 'single' };
          renderTimeline(data.legs, 'single', currentTlView);

          // Build table
          var tbody = document.getElementById('firDetailBody');
          if (!data.legs.length) {
            tbody.innerHTML = '<tr><td colspan="10" style="color:var(--muted);text-align:center;padding:20px;">No WorldFlight legs transit this FIR.</td></tr>';
            return;
          }
          // Store legs for modal use
          window._firLegs = data.legs;
          window._firId = data.fir;

          tbody.innerHTML = data.legs.map(function(l, idx) {
            var flowClass = l.flowType === 'SLOTTED' ? 'slotted' : (l.flowType === 'BOOKING_ONLY' ? 'booking' : 'none');
            var flowLabel = l.flowType === 'BOOKING_ONLY' ? 'Booking' : (l.flowType === 'SLOTTED' ? 'Slotted' : 'None');
            return '<tr>'
              + '<td style="font-weight:600;color:var(--accent);">' + l.wf + '</td>'
              + '<td class="" style="font-family:monospace;font-weight:600;color:var(--accent);">' + data.fir + '</td>'
              + '<td>' + l.from + '</td>'
              + '<td>' + l.to + '</td>'
              + '<td>' + (l.date || '-') + '</td>'
              + '<td class="staff-window">' + (l.staffStart && l.staffEnd ? l.staffStart + ' – ' + l.staffEnd : '-') + '</td>'
              + '<td class="">' + (l.staffMins ? l.staffMins + ' min' : '-') + '</td>'
              + '<td class="fir-route-col"><div class="route-text">' + (l.atcRoute || '-') + '</div></td>'
              + '<td class="">' + (l.depFlow || '-') + '</td>'
              + '<td class=""><span class="flow-badge ' + flowClass + '">' + flowLabel + '</span></td>'
              + '<td class=""><button class="fir-view-btn" data-leg-idx="' + idx + '">View</button></td>'
              + '</tr>';
          }).join('');

          // Attach view button handlers
          tbody.querySelectorAll('.fir-view-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
              var idx = Number(this.dataset.legIdx);
              openFirRouteModal(window._firLegs[idx], window._firId);
            });
          });
          // Click to expand route column
          tbody.querySelectorAll('.fir-route-col').forEach(function(td) {
            td.addEventListener('click', function() { this.classList.toggle('expanded'); });
          });

          // Mobile cards
          var cards = document.getElementById('firDetailCards');
          if (cards) {
            cards.innerHTML = data.legs.map(function(l) {
              var flowClass = l.flowType === 'SLOTTED' ? 'slotted' : (l.flowType === 'BOOKING_ONLY' ? 'booking' : 'none');
              var flowLabel = l.flowType === 'BOOKING_ONLY' ? 'Booking' : (l.flowType === 'SLOTTED' ? 'Slotted' : 'None');
              return '<div class="fir-leg-card">'
                + '<div class="fir-leg-card-header"><span class="wf">' + l.wf + '</span><span class="fir">' + data.fir + '</span></div>'
                + '<div class="fir-leg-card-route"><span>' + l.from + '</span><span>→</span><span>' + l.to + '</span></div>'
                + '<div class="fir-leg-card-row">Date: <b>' + (l.date || '-') + '</b></div>'
                + '<div class="fir-leg-card-row">Staff Window: <b>' + (l.staffStart && l.staffEnd ? l.staffStart + ' – ' + l.staffEnd : '-') + '</b></div>'
                + '<div class="fir-leg-card-row">Duration: <b>' + (l.staffMins ? l.staffMins + ' min' : '-') + '</b></div>'
                + '<div class="fir-leg-card-row">Flow: <b>' + flowLabel + '</b></div>'
                + '<div class="fir-leg-card-actions"><button class="fir-view-btn" data-card-idx="' + idx + '" style="flex:1;padding:6px;background:rgba(56,189,248,0.12);color:var(--accent);border:1px solid rgba(56,189,248,0.3);border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;">View on Map</button></div>'
                + '</div>';
            }).join('');
            cards.querySelectorAll('.fir-view-btn[data-card-idx]').forEach(function(btn) {
              btn.addEventListener('click', function() {
                openFirRouteModal(window._firLegs[Number(btn.dataset.cardIdx)], window._firId);
              });
            });
          }
        })
        .catch(function(err) {
          console.error('Failed to load FIR detail:', err);
        });
    }

    // Route view modal
    function loadGroupDetail(matchingFirs, region, division) {
      // Fetch all FIR details in parallel
      var fetches = matchingFirs.map(function(f) {
        return fetch('/api/airspace-management?fir=' + encodeURIComponent(f.fir), { credentials: 'same-origin' })
          .then(function(r) { return r.json(); });
      });

      Promise.all(fetches).then(function(results) {
        document.getElementById('airspaceSearchSection').style.display = 'none';
        document.getElementById('firDetailSection').style.display = '';

        var label = division || region || 'Filtered';
        document.getElementById('firDetailTitle').textContent = label + ' Airspace';
        document.getElementById('firDetailMeta').textContent = results.length + ' FIR' + (results.length !== 1 ? 's' : '') + ' — ' + results.reduce(function(sum, r) { return sum + (r.legs || []).length; }, 0) + ' total leg transits';

        // Clear highlight
        if (highlightLayer) { map.removeLayer(highlightLayer); highlightLayer = null; }

        // Build combined table grouped by FIR
        var allLegs = [];
        results.forEach(function(r) {
          if (!r.legs || !r.legs.length) return;
          r.legs.forEach(function(l) {
            allLegs.push(Object.assign({}, l, { _fir: r.fir }));
          });
        });

        // Sort by date then staff start
        allLegs.sort(function(a, b) {
          if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
          return (a.staffStart || '').localeCompare(b.staffStart || '');
        });

        // Build timeline grouped by FIR
        currentTlData = { legs: allLegs, mode: 'grouped' };
        renderTimeline(allLegs, 'grouped', currentTlView);

        // Build table
        window._firLegs = allLegs;
        window._firId = null;

        var tbody = document.getElementById('firDetailBody');
        tbody.innerHTML = allLegs.map(function(l, idx) {
          var flowClass = l.flowType === 'SLOTTED' ? 'slotted' : (l.flowType === 'BOOKING_ONLY' ? 'booking' : 'none');
          var flowLabel = l.flowType === 'BOOKING_ONLY' ? 'Booking' : (l.flowType === 'SLOTTED' ? 'Slotted' : 'None');
          return '<tr>'
            + '<td style="font-weight:600;color:var(--accent);">' + l.wf + '</td>'
            + '<td class=""><span style="font-family:monospace;font-weight:600;color:var(--accent);">' + l._fir + '</span></td>'
            + '<td>' + l.from + '</td>'
            + '<td>' + l.to + '</td>'
            + '<td>' + (l.date || '-') + '</td>'
            + '<td class="staff-window">' + (l.staffStart && l.staffEnd ? l.staffStart + ' – ' + l.staffEnd : '-') + '</td>'
            + '<td class="">' + (l.staffMins ? l.staffMins + ' min' : '-') + '</td>'
            + '<td class="fir-route-col"><div class="route-text">' + (l.atcRoute || '-') + '</div></td>'
            + '<td class="">' + (l.depFlow || '-') + '</td>'
            + '<td class=""><span class="flow-badge ' + flowClass + '">' + flowLabel + '</span></td>'
            + '<td class="" style="white-space:nowrap;">'
            + '<button class="fir-view-btn" data-group-leg-idx="' + idx + '" data-leg-fir="' + l._fir + '" style="font-size:11px;padding:3px 8px;margin-right:4px;">View</button>'
            + '<button class="fir-view-btn" data-view-fir="' + l._fir + '" style="font-size:11px;padding:3px 8px;">Open ' + l._fir + '</button>'
            + '</td>'
            + '</tr>';
        }).join('');

        tbody.querySelectorAll('.fir-route-col').forEach(function(td) {
          td.addEventListener('click', function() { this.classList.toggle('expanded'); });
        });
        tbody.querySelectorAll('.fir-view-btn[data-view-fir]').forEach(function(btn) {
          btn.addEventListener('click', function() { loadFirDetail(btn.dataset.viewFir); });
        });
        tbody.querySelectorAll('.fir-view-btn[data-group-leg-idx]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var idx = Number(btn.dataset.groupLegIdx);
            var fir = btn.dataset.legFir;
            openFirRouteModal(window._firLegs[idx], fir);
          });
        });

        // Mobile cards
        var cards = document.getElementById('firDetailCards');
        if (cards) {
          cards.innerHTML = allLegs.map(function(l, idx) {
            var flowClass = l.flowType === 'SLOTTED' ? 'slotted' : (l.flowType === 'BOOKING_ONLY' ? 'booking' : 'none');
            var flowLabel = l.flowType === 'BOOKING_ONLY' ? 'Booking' : (l.flowType === 'SLOTTED' ? 'Slotted' : 'None');
            return '<div class="fir-leg-card">'
              + '<div class="fir-leg-card-header"><span class="wf">' + l.wf + '</span><span class="fir">' + (l._fir || '') + '</span></div>'
              + '<div class="fir-leg-card-route"><span>' + l.from + '</span><span>→</span><span>' + l.to + '</span></div>'
              + '<div class="fir-leg-card-row">Date: <b>' + (l.date || '-') + '</b></div>'
              + '<div class="fir-leg-card-row">Staff Window: <b>' + (l.staffStart && l.staffEnd ? l.staffStart + ' – ' + l.staffEnd : '-') + '</b></div>'
              + '<div class="fir-leg-card-row">Duration: <b>' + (l.staffMins ? l.staffMins + ' min' : '-') + '</b></div>'
              + '<div class="fir-leg-card-row">Flow: <b>' + flowLabel + '</b></div>'
              + '<div class="fir-leg-card-actions">'
              + '<button class="fir-view-btn" data-card-grp-idx="' + idx + '" data-card-fir="' + (l._fir || '') + '" style="flex:1;padding:6px;background:rgba(56,189,248,0.12);color:var(--accent);border:1px solid rgba(56,189,248,0.3);border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;">View</button>'
              + '<button class="fir-open-btn" data-open-fir="' + (l._fir || '') + '" style="flex:1;padding:6px;background:rgba(56,189,248,0.12);color:var(--accent);border:1px solid rgba(56,189,248,0.3);border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;">Open ' + (l._fir || '') + '</button>'
              + '</div>'
              + '</div>';
          }).join('');
          cards.querySelectorAll('.fir-view-btn[data-card-grp-idx]').forEach(function(btn) {
            btn.addEventListener('click', function() {
              openFirRouteModal(window._firLegs[Number(btn.dataset.cardGrpIdx)], btn.dataset.cardFir);
            });
          });
          cards.querySelectorAll('.fir-open-btn[data-open-fir]').forEach(function(btn) {
            btn.addEventListener('click', function() { loadFirDetail(btn.dataset.openFir); });
          });
        }
      });
    }

    function openFirRouteModal(leg, firId) {
      // Remove existing modal
      var existing = document.getElementById('firRouteModal');
      if (existing) existing.remove();

      var overlay = document.createElement('div');
      overlay.id = 'firRouteModal';
      overlay.className = 'fir-route-modal-overlay';
      overlay.innerHTML = '<div class="fir-route-modal">'
        + '<div class="fir-route-modal-header">'
        + '<h3>' + leg.wf + ': ' + leg.from + ' → ' + leg.to + ' through ' + firId + '</h3>'
        + '<button class="fir-route-modal-close">&times;</button>'
        + '</div>'
        + '<div class="fir-route-modal-map" id="firRouteModalMap"></div>'
        + '</div>';
      document.body.appendChild(overlay);

      // Close handlers
      overlay.querySelector('.fir-route-modal-close').addEventListener('click', function() { overlay.remove(); });
      overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

      // Init map
      setTimeout(function() {
        var modalMap = L.map('firRouteModalMap', { zoomControl: true, worldCopyJump: true }).setView([30, 0], 3);

        var darkTile = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 10 });
        var lightTile = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 10 });
        darkTile.addTo(modalMap);
        var isDark = true;

        // Add toggle button
        var toggleDiv = document.createElement('div');
        toggleDiv.style.cssText = 'position:absolute;top:10px;right:10px;z-index:1000;';
        toggleDiv.innerHTML = '<button style="background:#0b1220;border:1px solid rgba(255,255,255,0.2);color:#e5e7eb;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;" id="mapThemeToggle">☀️ Light</button>';
        document.getElementById('firRouteModalMap').appendChild(toggleDiv);

        document.getElementById('mapThemeToggle').addEventListener('click', function() {
          if (isDark) {
            modalMap.removeLayer(darkTile);
            lightTile.addTo(modalMap);
            this.innerHTML = '🌙 Dark';
            this.style.background = '#fff';
            this.style.color = '#333';
            this.style.borderColor = '#ccc';
          } else {
            modalMap.removeLayer(lightTile);
            darkTile.addTo(modalMap);
            this.innerHTML = '☀️ Light';
            this.style.background = '#0b1220';
            this.style.color = '#e5e7eb';
            this.style.borderColor = 'rgba(255,255,255,0.2)';
          }
          isDark = !isDark;
        });

        // Draw FIR boundary
        fetch('/api/fir-merged.geojson')
          .then(function(r) { return r.json(); })
          .then(function(geoData) {
            var firFeature = geoData.features.find(function(f) { return f.properties && f.properties.id === firId; });
            if (firFeature) {
              var firLayer = L.geoJSON(firFeature, {
                style: { color: '#6366f1', weight: 2, fillColor: 'rgba(99,102,241,0.1)', fillOpacity: 0.2 }
              }).addTo(modalMap);
            }

            // Draw route, highlight waypoints inside this FIR
            fetch('/api/resolve-route?from=' + leg.from + '&to=' + leg.to + '&route=' + encodeURIComponent(leg.atcRoute) + '&depTime=&blockTime=')
              .then(function(r) { return r.json(); })
              .then(function(routeData) {
                if (!routeData.points || routeData.points.length < 2) return;

                // Point-in-polygon (ray casting) against the FIR geometry
                function pointInFir(lat, lon) {
                  if (!firFeature) return false;
                  var geom = firFeature.geometry;
                  var polys = geom.type === 'MultiPolygon' ? geom.coordinates : geom.type === 'Polygon' ? [geom.coordinates] : [];
                  for (var p = 0; p < polys.length; p++) {
                    var ring = polys[p][0];
                    if (!ring) continue;
                    var inside = false;
                    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                      var yi = ring[i][0], xi = ring[i][1]; // GeoJSON [lon, lat]
                      var yj = ring[j][0], xj = ring[j][1];
                      if (((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi)) inside = !inside;
                    }
                    if (inside) return true;
                  }
                  return false;
                }

                // Tag each waypoint as inside/outside FIR
                var pts = routeData.points.map(function(p) {
                  return { name: p.name, lat: p.lat, lon: p.lon, inFir: pointInFir(p.lat, p.lon) };
                });

                // Draw full route dim (with antimeridian-aware wrapping)
                var allCoords = pts.map(function(p) { return [p.lat, p.lon]; });
                var routeLine = L.polyline(allCoords, { color: '#60a5fa', weight: 2.5, opacity: 0.6 }).addTo(modalMap);

                // If route crosses antimeridian, center map on the route midpoint
                var hasWrapped = pts.some(function(p) { return p.lon > 180 || p.lon < -180; });
                if (hasWrapped) {
                  var midIdx = Math.floor(pts.length / 2);
                  modalMap.setView([pts[midIdx].lat, pts[midIdx].lon], 3);
                }

                // Find boundary crossing point by binary search
                function findCrossing(insidePt, outsidePt, steps) {
                  var a = [insidePt.lat, insidePt.lon], b = [outsidePt.lat, outsidePt.lon];
                  for (var s = 0; s < (steps || 15); s++) {
                    var mid = [(a[0]+b[0])/2, (a[1]+b[1])/2];
                    if (pointInFir(mid[0], mid[1])) a = mid; else b = mid;
                  }
                  return [(a[0]+b[0])/2, (a[1]+b[1])/2];
                }

                // Draw highlighted segments, clipped to FIR boundary
                for (var i = 0; i < pts.length - 1; i++) {
                  var a = pts[i], b = pts[i + 1];
                  if (a.inFir && b.inFir) {
                    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: '#f59e0b', weight: 3 }).addTo(modalMap);
                  } else if (a.inFir && !b.inFir) {
                    var cross = findCrossing(a, b);
                    L.polyline([[a.lat, a.lon], cross], { color: '#f59e0b', weight: 3 }).addTo(modalMap);
                  } else if (!a.inFir && b.inFir) {
                    var cross = findCrossing(b, a);
                    L.polyline([cross, [b.lat, b.lon]], { color: '#f59e0b', weight: 3 }).addTo(modalMap);
                  } else {
                    // Both outside — check if segment passes through FIR by sampling
                    var found = false;
                    for (var s = 1; s <= 20; s++) {
                      var frac = s / 21;
                      var mLat = a.lat + (b.lat - a.lat) * frac;
                      var mLon = a.lon + (b.lon - a.lon) * frac;
                      if (pointInFir(mLat, mLon)) { found = true; break; }
                    }
                    if (found) {
                      // Find entry and exit crossings
                      var entry = findCrossing({ lat: mLat, lon: mLon }, a);
                      var exit = findCrossing({ lat: mLat, lon: mLon }, b);
                      L.polyline([entry, exit], { color: '#f59e0b', weight: 3 }).addTo(modalMap);
                    }
                  }
                }

                // Draw waypoints
                pts.forEach(function(p) {
                  var inside = p.inFir;
                  L.circleMarker([p.lat, p.lon], {
                    radius: inside ? 4 : 2,
                    color: inside ? '#38bdf8' : 'rgba(255,255,255,0.4)',
                    fillColor: inside ? '#38bdf8' : 'rgba(255,255,255,0.4)',
                    fillOpacity: 1
                  }).bindTooltip(p.name, { permanent: inside, direction: 'top', className: 'fir-tooltip', offset: [0, -6] }).addTo(modalMap);
                });
              });

            // Fit to FIR bounds (centered on the FIR in question)
            if (firFeature && firLayer) {
              modalMap.fitBounds(firLayer.getBounds(), { padding: [30, 30] });
            }
          });
      }, 100);
    }

    // Allow direct FIR from URL hash
    if (location.hash && location.hash.length > 1) {
      loadFirDetail(location.hash.slice(1).toUpperCase());
    }
  });
  </script>
  `;

  res.send(
    renderLayout({
      title: 'Airspace Management',
      user,
      isAdmin,
      layoutClass: 'dashboard-full',
      content
    })
  );
});

app.get('/book', (req, res) => {
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/auth/login');
  }

  const { from, to, depTimeUtc } = req.query;

  const preselectedKey =
    from && to && depTimeUtc
      ? `${from}-${to}-${depTimeUtc}`
      : null;


  const user = req.session.user.data;
  const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

  const content = `
  <div id="bookingSuccessBanner" class="booking-banner success hidden">
  <span id="successMessage"></span>
  <button id="viewBookingsBtn" class="banner-action success">
    View my booked slots →
  </button>
</div>

<div id="bookingCancelBanner" class="booking-banner cancel hidden">
  <span id="cancelMessage"></span>
  <button id="viewBookingsBtnCancel" class="banner-action cancel">
    View my booked slots →
  </button>
</div>

<div id="bookingErrorBanner" class="booking-banner cancel hidden">
  <span id="errorMessage"></span>
</div>




  <section class="card card-full tobt-card">

      <h2>Make a Booking</h2>
<div class="tobt-controls">
  <label for="depSelect">Departure</label>
  <select id="depSelect" class="tobt-select">
        <option value="">Select a departure</option>
        ${adminSheetCache.map(s => {
  const value = `${s.from}-${s.to}-${s.dep_time_utc}`;
const selected = value === preselectedKey ? 'selected' : '';


  return `
    <option
      value="${value}"
      data-from="${s.from}"
      data-to="${s.to}"
      data-date="${s.date_utc}"
      data-dep="${s.dep_time_utc}"
      ${selected}
    >
      ${s.number} | ${s.from}–${s.to}
    </option>
  `;
}).join('')}

      </select>
</div>
      <table class="tobt-table">
        <thead>
          <tr>
            <th>Off-Blocks Time</th><th>Book</th>
            <th>Off-Blocks Time</th><th>Book</th>
          </tr>
        </thead>
        <tbody id="tobtBody"></tbody>
      </table>
    </section>
    <script>
  const select = document.getElementById('depSelect');
  const body = document.getElementById('tobtBody');

  /* =========================
     LOAD TOBT SLOTS
     ========================= */
  async function isReservedTeamCallsign(callsign, cid) {
  const normalized = callsign.trim().toUpperCase();

  const team = await prisma.officialTeam.findFirst({
    where: {
      callsign: normalized,
      participatingWf26: true
    }
  });

  if (!team) {
    return { reserved: false };
  }

  if (Number(team.mainCid) !== Number(cid)) {
    return {
      reserved: true,
      allowed: false,
      teamName: team.teamName
    };
  }

  return {
    reserved: true,
    allowed: true
  };
}

  
     async function loadTobtSlots() {
    body.innerHTML = '';
    if (!select.value) return;

    const opt = select.selectedOptions[0];
    const params = new URLSearchParams({
      from: opt.dataset.from,
      to: opt.dataset.to,
      dateUtc: opt.dataset.date,
      depTimeUtc: opt.dataset.dep
    });

    const res = await fetch('/api/tobt/slots?' + params);
    const data = await res.json();

    if (data.noFlow) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'tobt-message';
      td.textContent = data.message;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }

    const slots = data;
    // 🔒 Detect if user already has a booking in this sector
let mySectorKey = null;

for (const slot of slots) {
  if (slot.byMe) {
    const parts = slot.slotKey.split('|');
    mySectorKey = parts.slice(0, 3).join('|'); // FROM-TO|date|dep
    break;
  }
}

    const half = Math.ceil(slots.length / 2);
    const leftCol = slots.slice(0, half);
    const rightCol = slots.slice(half);

    for (let i = 0; i < half; i++) {
      const tr = document.createElement('tr');

      [leftCol[i], rightCol[i]].forEach(slot => {
        if (!slot) {
          tr.innerHTML += '<td></td><td></td>';
          return;
        }

        let btn = '';

        const slotSectorKey = slot.slotKey.split('|').slice(0, 3).join('|');

if (slot.byMe) {
  // ✅ ALWAYS show Cancel for own booking
  btn =
    '<button class="tobt-btn cancel" data-action="cancel" data-slot-key="' +
    slot.slotKey + '">Cancel</button>';

} else if (mySectorKey && slotSectorKey === mySectorKey) {
  // 🔒 Same sector, but NOT my slot
  btn =
    '<button class="tobt-btn booked disabled" disabled>' +
    'Booked' +
    '</button>';

} else if (slot.booked) {
  btn =
    '<button class="tobt-btn booked" disabled>Booked</button>';

} else {
  btn =
    '<button class="tobt-btn book" data-action="book" data-slot-key="' +
    slot.slotKey + '">Book</button>';
}




        tr.innerHTML +=
          '<td>' + slot.tobt + '</td>' +
          '<td>' + btn + '</td>';
      });

      body.appendChild(tr);
    }
  }

  /* =========================
     DROPDOWN CHANGE
     ========================= */
  select.addEventListener('change', () => {
    loadTobtSlots();
  });

  /* =========================
     BUTTON HANDLING (BOOK / CANCEL)
     ========================= */
  body.addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn) return;

    const action = btn.dataset.action;
    if (!action) return;

    const slotKey = btn.dataset.slotKey;
    const opt = select.selectedOptions[0];
    const tobt = btn.closest('td').previousElementSibling.textContent;

    let callsign;
    if (action === 'book') {
      callsign = await new Promise(resolve => {
        const modal = document.getElementById('callsignModal');
        const input = document.getElementById('callsignModalInput');
        const confirmBtn = document.getElementById('callsignConfirm');
        const cancelBtn = document.getElementById('callsignCancel');
        const errorEl = document.getElementById('modalError');

        modal.classList.remove('hidden');
        input.value = '';
        input.focus();
        if (errorEl) { errorEl.classList.add('hidden'); errorEl.textContent = ''; }

        function cleanup() {
          confirmBtn.removeEventListener('click', onConfirm);
          cancelBtn.removeEventListener('click', onCancel);
          input.removeEventListener('keydown', onKey);
        }
        function closeModal() { modal.classList.add('hidden'); if (errorEl) errorEl.classList.add('hidden'); cleanup(); }
        function showErr(msg) { if (errorEl) { errorEl.textContent = msg; errorEl.classList.remove('hidden'); } input.focus(); }

        async function onConfirm() {
          const value = input.value.trim();
          if (!value) return;
          if (!/^[0-9]+$/.test(value)) { showErr('Please enter a valid numeric CID.'); return; }

          const r = await fetch('/api/tobt/book', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slotKey, callsign: value })
          });

          if (!r.ok) {
            const err = await r.json();
            showErr(err.error || 'Booking failed. Please try again.');
            return;
          }

          closeModal();
          resolve(value);
        }

        function onCancel() { closeModal(); resolve(null); }
        function onKey(e) { if (e.key === 'Enter') onConfirm(); if (e.key === 'Escape') onCancel(); }

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        input.addEventListener('keydown', onKey);
      });
      if (!callsign) return;
    } else {
      const res = await fetch('/api/tobt/' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotKey, callsign })
      });

      if (!res.ok) {
        const err = await res.json();
        showBookingError(err.error || 'Action failed. Please try again.');
        return;
      }
    }


    if (action === 'book') {
      showBookingSuccess({
        from: opt.dataset.from,
        to: opt.dataset.to,
        tobt
      });
    }

    if (action === 'cancel') {
      showBookingCancelled({
        from: opt.dataset.from,
        to: opt.dataset.to,
        tobt
      });
    }

    loadTobtSlots();
  });

  /* =========================
     BANNERS
     ========================= */
  function hideBookingBanners() {
    const s = document.getElementById('bookingSuccessBanner');
    const c = document.getElementById('bookingCancelBanner');
    if (s) s.classList.add('hidden');
    if (c) c.classList.add('hidden');
  }

  function showBookingSuccess(data) {
    hideBookingBanners();
    const banner = document.getElementById('bookingSuccessBanner');
    const msg = document.getElementById('successMessage');
    if (!banner || !msg) return;

    msg.textContent =
      'You have successfully booked a slot for ' +
      data.from + ' → ' + data.to +
      ' at ' + data.tobt + ' UTC.';

    banner.classList.remove('hidden');
  }

  function showBookingCancelled(data) {
    hideBookingBanners();
    const banner = document.getElementById('bookingCancelBanner');
    const msg = document.getElementById('cancelMessage');
    if (!banner || !msg) return;

    msg.textContent =
      'Your slot for ' +
      data.from + ' → ' + data.to +
      ' at ' + data.tobt + ' UTC has been cancelled.';

    banner.classList.remove('hidden');
  }
</script>
<script>
  const viewBtn = document.getElementById('viewBookingsBtn');
  if (viewBtn) {
    viewBtn.addEventListener('click', () => {
      window.location.href = '/my-slots';
    });
  }

  const viewBtnCancel = document.getElementById('viewBookingsBtnCancel');
  if (viewBtnCancel) {
    viewBtnCancel.addEventListener('click', () => {
      window.location.href = '/my-slots';
    });
  }
</script>
<script>
function showBookingError(message) {
  hideBookingBanners();
  const banner = document.getElementById('bookingErrorBanner');
  const msg = document.getElementById('errorMessage');
  if (!banner || !msg) return;

  msg.textContent = message;
  banner.classList.remove('hidden');
}
</script>
<script>
document.addEventListener('DOMContentLoaded', () => {
  const select = document.getElementById('depSelect');
  if (!select) return;

  // 🔑 AUTO-LOAD when arriving from "Book Slot" link
  if (select.value) {
    loadTobtSlots();
  }
});
</script>



  `;

  res.send(
    renderLayout({
      title: 'Book a Slot',
      user,
      isAdmin,
      layoutClass: 'dashboard-full', // ✅ ADD THIS
      content
    })
  );
});

app.get('/my-slots', requireLogin, requirePageEnabled('my-slots'), (req, res) => {
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/auth/login');
  }

  const user = req.session.user.data;
  const cid = Number(user.cid);
  const isAdmin = ADMIN_CIDS.includes(cid);

  // 🔑 bookingKeys, not slotKeys (MODEL 2)
  const myBookingKeys = Array.from(tobtBookingsByCid[cid] || []);

  const rows = myBookingKeys
    .map(bookingKey => {
      const booking = tobtBookingsByKey[bookingKey];
      if (!booking) return null;

      const slotKey = booking.slotKey;

      // slotKey may be:
      // FROM-TO|date|dep
      // FROM-TO|date|dep|tobt
      const parts = slotKey.split('|');
      const sectorPart = parts[0];
      const dateUtc = parts[1];
      const depTimeUtc = parts[2];
      const tobtTimeUtc = parts.length === 4 ? parts[3] : null;

      const [from, to] = sectorPart.split('-');

      const wfRow = adminSheetCache.find(
        r =>
          r.from === from &&
          r.to === to &&
          r.date_utc === dateUtc &&
          r.dep_time_utc === depTimeUtc
      );

      const wfSector = wfRow?.number || '-';
      const atcRoute = wfRow?.atc_route || '-';
      const callsign = booking.callsign || '';

      let connectBy = '—';
      let simbriefUrl =
        'https://dispatch.simbrief.com/options/custom' +
        '?orig=' + from +
        '&dest=' + to +
        '&route=' + encodeURIComponent(atcRoute || '') +
        '&manualrmk=' + encodeURIComponent(
          'Route validated from www.worldflight.center'
        );

      let tobtDisplay = 'N/A';

      // ✅ TOBT SLOT
      if (typeof booking.tobtTimeUtc === 'string') {
        tobtDisplay = booking.tobtTimeUtc;

        const [h, m] = booking.tobtTimeUtc.split(':').map(Number);
        const hh = String(h).padStart(2, '0');
        const mm = String(m).padStart(2, '0');

        const connectDate = new Date(Date.UTC(2000, 0, 1, hh, mm - 30));
        connectBy =
          connectDate.getUTCHours().toString().padStart(2, '0') +
          ':' +
          connectDate.getUTCMinutes().toString().padStart(2, '0');

        simbriefUrl +=
          '&callsign=' + encodeURIComponent(callsign) +
          '&deph=' + hh +
          '&depm=' + mm +
          '&manualrmk=' + encodeURIComponent(
            `WF TOBT [SLOT] ${hh}:${mm} UTC - Route validated from www.worldflight.center`
          );
      }

      return {
        bookingKey,
        slotKey,
        callsign,
        wfSector,
        from,
        to,
        tobt: tobtDisplay,
        connectBy,
        atcRoute,
        simbriefUrl
      };
    })
    .filter(Boolean);

  const content = `
 <section class="card card-full my-slots-card">
      <h2>My Slots</h2>

      ${rows.length === 0 ? `
        <p><em>You have no booked slots.</em></p>
      ` : `
        <div class="table-scroll my-slots-table-wrapper">
          <table class="my-slots-table">
           <thead>
              <tr>
                <th class="col-wf-sector">WF Sector</th>
                <th class="col-callsign">CID</th>
                <th class="col-departure">Departure</th>
                <th class="col-destination">Destination</th>
                <th class="col-tobt">TOBT</th>
                <th class="col-connect">Connect by</th>
                <th class="col-route">ATC Route</th>
                <th class="col-plan">Plan with SimBrief</th>
                <th class="col-actions">Actions</th>
              </tr>
          </thead>

            <tbody>
  ${rows.map(r => `
    <tr>
  <td class="col-wf-sector">${r.wfSector}</td>

  <td class="col-callsign">${r.cid || cid}</td>

  <td class="col-departure"><a href="/icao/${r.from}">${r.from}</a></td>
  <td class="col-destination"><a href="/icao/${r.to}">${r.to}</a></td>

  <td class="col-tobt ${r.tobt && r.tobt !== '—' && r.tobt !== 'N/A' ? 'tobt-primary' : ''}">
  ${r.tobt && r.tobt !== '—' && r.tobt !== 'N/A' ? (r.tobt + 'Z') : 'N/A'}
</td>

<td class="col-connect">
  ${r.connectBy && r.connectBy !== '—' && r.connectBy !== 'N/A' ? (r.connectBy + 'Z') : 'N/A'}
</td>


  <td class="col-route">
    <div class="route-box">
      ${r.atcRoute}
    </div>
  </td>

  <td class="col-plan">
    <a class="simbrief-btn"
       href="${r.simbriefUrl}"
       target="_blank"
       rel="noopener">
      <span class="simbrief-logo">SB</span>
      <span class="simbrief-text">Plan with SimBrief</span>
    </a>
  </td>

  <td class="col-actions">
    <button
      type="button"
      class="tobt-btn cancel cancel-slot-btn"
      data-slot-key="${r.slotKey}"
      data-callsign="${r.callsign}">
      Cancel
    </button>
  </td>
</tr>



  `).join('')}
</tbody>

          </table>
        </div>
      `}
      
    </section>
    <script>
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.cancel-slot-btn');
  if (!btn) return;

  e.preventDefault();

  const slotKey = btn.dataset.slotKey;
  if (!slotKey) return;

  openConfirmModalAsync({
    title: 'Cancel TOBT Slot',
    message: 'Are you sure you want to cancel this booking?',
    confirmText: 'Confirm',
    cancelText: 'Cancel',

    onConfirm: async ({ set }) => {
      const res = await fetch('/api/tobt/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotKey })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        set('Cancel failed', err.error || 'Unable to cancel slot');
        return false;
      }

      setTimeout(() => location.reload(), 500);
      return true;
    }
  });
});
</script>
<script>
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.callsign-edit-btn');
  if (!btn) return;

  const slotKey = btn.dataset.slotkey;
  const callsign = await openCallsignModal();
  if (!callsign) return;

  const res = await fetch('/api/tobt/update-callsign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotKey, callsign })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Failed to update callsign');
    return;
  }

  location.reload();
});
</script>


`;

  res.send(
    renderLayout({
      title: 'My Slots',
      user,
      isAdmin,
      layoutClass: 'dashboard-full',
      content
    })
  );
});



/* ===== LOGOUT ===== */
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).send('Logout failed');
    }

    res.clearCookie('worldflight.sid', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax'
    });

    return res.redirect('/');
  });
});


/* ===== SERVER START ===== */
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`WorldFlight Planning is running on ${port}`);
});