import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import path from 'path';

const prisma = new PrismaClient();

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
const PAGE_KEYS = ['schedule', 'world-map', 'my-slots', 'atc', 'suggest-airport', 'arrival-info', 'departure-info', 'book-slot'];
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
  const flows = await prisma.depFlow.findMany();

  flows.forEach(f => {
    // rate
    sharedDepFlows[f.sector] = Number(f.rate) || 0;

    // flow type (default NONE)
    const ft = (f.flowtype || 'NONE').toString().toUpperCase();
    sharedFlowTypes[f.sector] =
      ft === 'SLOTTED' || ft === 'BOOKING_ONLY' || ft === 'NONE'
        ? ft
        : 'NONE';
  });

  console.log(`[DEP FLOW] Loaded ${flows.length} flow rates/types from DB`);
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

/* ===== GOOGLE SHEET ===== */
const GOOGLE_SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRG6DbmhAQpFmOophiGjjSh_UUGdTo-LA_sNNexrMpkkH2ECHl8eDsdxM24iY8Itw06pUZZXWtvmUNg/pub?output=csv';

let adminSheetCache = [];
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
  await refreshPilots();
  await loadDepFlowsFromDb();
  await loadTobtBookingsFromDb();
  await loadPageVisibility();
  await loadSiteBanner();

  await refreshAdminSheet();   // 🔑 REQUIRED
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

  const [suggestions, visitedAirports] = await Promise.all([
    prisma.airportSuggestion.findMany({ orderBy: { createdAt: 'desc' } }),
    prisma.wfVisitedAirport.findMany({ select: { icao: true } })
  ]);

  const visitedSet = new Set(visitedAirports.map(v => v.icao));

  const visits = suggestions.filter(s => s.type !== 'avoid');
  const avoids = suggestions.filter(s => s.type === 'avoid');

  // Unique ICAOs from visit suggestions that we've never been to (exclude wildcards)
  const neverVisitedMap = {};
  for (const s of visits) {
    if (/\*/.test(s.icao)) continue;
    if (visitedSet.has(s.icao)) continue;
    if (!neverVisitedMap[s.icao]) neverVisitedMap[s.icao] = 0;
    neverVisitedMap[s.icao]++;
  }
  const neverVisited = Object.entries(neverVisitedMap)
    .sort((a, b) => b[1] - a[1])
    .map(([icao, count]) => ({ icao, count }));

  function buildRows(list) {
    if (!list.length) return '<tr><td colspan="7" class="empty">None yet</td></tr>';
    return list.map(s => {
      const date = new Date(s.createdAt).toISOString().replace('T', ' ').slice(0, 16);
      return `
        <tr data-icao="${s.icao}" data-name="${s.firstName} ${s.lastName}" data-assoc="${s.association}" data-date="${s.createdAt}">
          <td><strong>${s.icao}</strong></td>
          <td>${s.firstName} ${s.lastName}</td>
          <td>${s.association}</td>
          <td style="max-width:300px;font-size:12px;">
            <div class="reason-cell">${s.reason}</div>
            ${s.reason.length > 100 ? '<button class="reason-expand">Show more</button>' : ''}
          </td>
          <td style="font-size:12px;">${s.contact}</td>
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
      <h2 style="color:#4ade80;">Suggested Airports to Visit</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">${visits.length} suggestion${visits.length !== 1 ? 's' : ''}</p>
      <div class="admin-table-scroll">
        ${buildTable('visitTable', buildRows(visits))}
      </div>
    </section>

    <section class="card card-full" style="margin-top:24px;">
      <h2 style="color:#f87171;">Suggested Airports to Avoid</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">${avoids.length} suggestion${avoids.length !== 1 ? 's' : ''}</p>
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

      .sortable { cursor: pointer; user-select: none; }
      .sortable:hover { color: var(--accent); }
      .sort-arrow { font-size: 10px; margin-left: 4px; }
      .sort-arrow.asc::after { content: '▲'; }
      .sort-arrow.desc::after { content: '▼'; }
    </style>

    <script>
    (function() {
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
          <input type="text" id="suggestIcao" placeholder="e.g. EGLL, EG**, K***" maxlength="4" required autocomplete="off" style="text-transform:uppercase;font-family:monospace;" />
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

  <style>
    .suggest-layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      align-items: start;
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
      var hasEmail = emailInput.value.trim().length > 0;
      if (!hasEmail) {
        notifyBox.checked = false;
        notifyBox.disabled = true;
      } else {
        notifyBox.disabled = false;
      }
    }
    emailInput.addEventListener('input', updateNotifyState);
    updateNotifyState();

    var icaoInput = document.getElementById('suggestIcao');
    var visitInfo = document.getElementById('icaoVisitInfo');
    var debounceTimer = null;

    function iataToIcao(code) {
      if (code.length === 3 && /^[A-Z]{3}$/.test(code)) {
        return code.charAt(0) === 'Y' ? 'C' + code : 'K' + code;
      }
      return code;
    }

    icaoInput.addEventListener('input', function() {
      clearTimeout(debounceTimer);
      var val = icaoInput.value.trim().toUpperCase();

      if (!/^[A-Z*]{2,4}$/.test(val) || !/[A-Z]/.test(val)) {
        visitInfo.classList.add('hidden');
        return;
      }

      debounceTimer = setTimeout(async function() {
        try {
          var lookup = iataToIcao(val);
          var res = await fetch('/api/airport-visits/' + lookup);
          if (!res.ok) { visitInfo.classList.add('hidden'); return; }
          var data = await res.json();

          if (data.icao === 'YSSY') {
            visitInfo.innerHTML = 'We start and finish at <span class="visit-count">YSSY</span> every year!';
            visitInfo.className = 'icao-visit-info visited';
          } else if (data.totalVisits > 0) {
            visitInfo.innerHTML = data.totalVisits === 1
              ? 'We have visited <span class="visit-count">' + data.icao + '</span> once before. Last visit was <span class="visit-count">' + data.lastVisit + '</span>.'
              : 'We have visited <span class="visit-count">' + data.icao + '</span> <span class="visit-count">' + data.totalVisits + '</span> times. Last visit was <span class="visit-count">' + data.lastVisit + '</span>.';
            visitInfo.className = 'icao-visit-info visited';
          } else {
            visitInfo.innerHTML =
              'We have never visited <strong>' + data.icao + '</strong> before — great suggestion!';
            visitInfo.className = 'icao-visit-info not-visited';
          }
        } catch(err) {
          visitInfo.classList.add('hidden');
        }
      }, 300);
    });

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

  const visits = await prisma.wfVisitedAirport.findMany({
    where: { icao },
    orderBy: { year: 'desc' }
  });

  res.json({
    icao,
    totalVisits: visits.length,
    lastVisit: visits.length > 0 ? visits[0].year : null,
    visits: visits.map(v => ({ year: v.year, eventName: v.eventName }))
  });
});

app.post('/api/suggest-airport', async (req, res) => {
  const { firstName, lastName, icao, type, association, reason, contact, email, notifyRoute } = req.body;

  if (!firstName || !lastName || !icao || !association || !reason) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (!/^[A-Z*]{2,4}$/.test(icao.toUpperCase()) || !/[A-Z]/.test(icao.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid ICAO code' });
  }

  const suggestionType = type === 'avoid' ? 'avoid' : 'visit';
  const cid = Number(req.session?.user?.data?.cid) || null;

  await prisma.airportSuggestion.create({
    data: {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      icao: icao.toUpperCase(),
      type: suggestionType,
      association,
      reason: reason.trim(),
      contact: (contact || '').trim(),
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

app.get('/view-suggestions', requirePageEnabled('suggest-airport'), (req, res) => {
  const user = req.session?.user?.data || null;
  const cid = Number(user?.cid) || null;
  const isAdmin = cid && ADMIN_CIDS.includes(cid);

  const content = `
  <div class="suggestions-view">

    <section class="card">
      <h2>Recent Suggestions</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">Latest airports the community wants WorldFlight to visit</p>
      <div id="recentVisitList" class="suggestion-list">
        <div class="empty" style="padding:20px;text-align:center;color:var(--muted);">Loading...</div>
      </div>
    </section>

    <section class="card">
      <h2>Recent Avoids</h2>
      <p style="color:var(--muted);font-size:13px;margin-bottom:16px;">Latest airports the community has suggested we avoid</p>
      <div id="recentAvoidList" class="suggestion-list">
        <div class="empty" style="padding:20px;text-align:center;color:var(--muted);">Loading...</div>
      </div>
    </section>

  </div>

  <style>
    .suggestions-view {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      align-items: start;
    }
    @media (max-width: 900px) {
      .suggestions-view { grid-template-columns: 1fr; }
    }

    .suggestion-list { display: flex; flex-direction: column; gap: 4px; }

    .suggestion-rank {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      border-radius: 8px;
      background: rgba(255,255,255,0.02);
      border: 1px solid var(--border);
      transition: background .15s;
    }
    .suggestion-rank:hover { background: rgba(255,255,255,0.04); }

    .rank-icao {
      font-family: monospace;
      font-size: 15px;
      font-weight: 700;
      color: var(--accent);
      min-width: 56px;
    }

    .rank-name {
      flex: 1;
      font-size: 13px;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-left: 8px;
    }

    .rank-time {
      text-align: right;
      flex-shrink: 0;
      margin-left: 12px;
      font-size: 12px;
      color: var(--muted2);
      white-space: nowrap;
    }

    .suggestion-empty {
      padding: 32px;
      text-align: center;
      color: var(--muted);
      font-size: 14px;
    }
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
      var months = Math.floor(days / 30);
      return months + 'mo ago';
    }

    function renderList(containerId, items, dotClass) {
      var el = document.getElementById(containerId);
      if (!items.length) {
        el.innerHTML = '<div class="suggestion-empty">No suggestions yet. Be the first to <a href="/suggest-airport" style="color:var(--accent);">suggest an airport</a>!</div>';
        return;
      }

      el.innerHTML = items.map(function(item) {
        return '<div class="suggestion-rank">' +
          '<span class="rank-icao">' + item.icao + '</span>' +
          (item.name ? '<span class="rank-name">' + item.name + '</span>' : '') +
          '<span class="rank-time">' + timeAgo(item.createdAt) + '</span>' +
        '</div>';
      }).join('');
    }

    renderList('recentVisitList', data.recentVisit, 'visit');
    renderList('recentAvoidList', data.recentAvoid, 'avoid');
  })();
  </script>
  `;

  res.send(renderLayout({
    title: 'View Suggestions',
    user,
    isAdmin,
    content,
    layoutClass: 'dashboard-full'
  }));
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

socket.on('updateDepFlow', async ({ sector, value }) => {
  const key = normalizeSectorKey(sector);
  const rate = Number(value);

  // treat blank / 0 / invalid as "remove rate"
  if (!Number.isFinite(rate) || rate <= 0) {
    delete sharedDepFlows[key];

    await prisma.depFlow.deleteMany({ where: { sector: key } });

    io.emit('depFlowUpdated', { sector: key, value: 0 });
    rebuildAllTobtSlots();

    const fromIcao = key.split('-')[0];
    io.to(`icao:${fromIcao}`).emit(
      'unassignedTobtUpdate',
      buildUnassignedTobtsForICAO(fromIcao)
    );

    return;
  }

  sharedDepFlows[key] = rate;

  // preserve existing flowtype if row already exists
  await prisma.depFlow.upsert({
    where: { sector: key },
    update: { rate },
    create: {
      sector: key,
      rate,
      flowtype: sharedFlowTypes[key] || 'NONE'
    }
  });

  io.emit('depFlowUpdated', { sector: key, value: rate });
  rebuildAllTobtSlots();

  const fromIcao = key.split('-')[0];
  io.to(`icao:${fromIcao}`).emit(
    'unassignedTobtUpdate',
    buildUnassignedTobtsForICAO(fromIcao)
  );
});

socket.on('updateDepFlowType', async ({ sector, flowtype }) => {
  const key = normalizeSectorKey(sector);

  const ft = (flowtype || 'NONE').toString().toUpperCase();
  const normalized =
    ft === 'SLOTTED' || ft === 'BOOKING_ONLY' || ft === 'NONE'
      ? ft
      : 'NONE';

  sharedFlowTypes[key] = normalized;

  // ensure there is a row to store it
  await prisma.depFlow.upsert({
    where: { sector: key },
    update: { flowtype: normalized },
    create: {
      sector: key,
      rate: sharedDepFlows[key] || 0,
      flowtype: normalized
    }
  });

  io.emit('depFlowTypeUpdated', { sector: key, flowtype: normalized });
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

  socket.on('registerUser', ({ cid, position }) => {
    connectedUsers[socket.id] = { cid, position };
    io.emit('connectedUsersUpdate', Object.values(connectedUsers));
  });

  socket.on('disconnect', () => {
    delete connectedUsers[socket.id];
    io.emit('connectedUsersUpdate', Object.values(connectedUsers));
    console.log('Client disconnected:', socket.id);
  });
});




/* ===== ADMIN SHEET REFRESH ===== */
async function refreshAdminSheet() {
  try {
    const res = await axios.get(GOOGLE_SHEET_CSV_URL);

    const lines = res.data.split('\n').map(l => l.trim()).filter(Boolean);
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

    adminSheetCache = lines.slice(1).map(line => {
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

    console.log('✅ Admin Sheet refreshed:', adminSheetCache.length, 'rows');
  } catch (err) {
    console.error('❌ Failed to refresh Admin Sheet:', err.message);
  }
}

refreshAdminSheet();
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
    { title: 'View Suggestions',   desc: 'Browse and vote on community airport suggestions.',                             icon: '📊', href: '/view-suggestions',    public: true,  visKey: 'suggest-airport' },
    { title: 'Previous Destinations', desc: 'Explore every airport WorldFlight has visited over the years.',                icon: '📍', href: '/previous-destinations', public: true },
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
    title: 'WorldFlight CDM',
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
    return res.json({ builtAt: cached.builtAt, ...cached.payload });
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
    return res.json({ builtAt: built.builtAt, ...built.payload });
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
                This is an automated message from the WorldFlight CDM system.
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
      desc: 'Manage official teams and WF affiliates with WF26 participation toggles.',
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
            <th class="col-wf26 col-center">WF26</th>
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
      <th class="col-wf26 col-center">WF26</th>
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
    Participating in WF26
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
          alert('Failed to update WF26 flag');
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
app.get('/wf-schedule', requireAdmin, (req, res) => {
if (!req.session.user || !req.session.user.data) {
  return res.redirect('/');
}

const user = req.session.user.data;
const isAdmin = ADMIN_CIDS.includes(Number(user.cid));

if (!isAdmin) {
  return res.status(403).send('You do not have Admin access');
}

const content = `
 <main class="dashboard-full">
<section class="card dashboard-full">

<h2>WorldFlight Admin Schedule</h2>
<button id="refreshScheduleBtn" style="margin-bottom:16px;">⟳ Force Refresh Schedule</button>

<div class="table-scroll">
<table class="departures-table" id="mainDeparturesTable">

<thead>
<tr>
  <th>WF</th>
  <th>From</th>
  <th>To</th>
  <th>Dep Flow</th>
  <th>Flow Type</th>
  <th>Date</th>
  <th>Dep</th>
  <th>Arr</th>
  <th class="col-route">ATC Route</th>
</tr>
</thead>
<tbody>
${adminSheetCache.map(r => {
  const sectorKey = `${r.from}-${r.to}`;
  return `
<tr>
  <td>${r.number}</td>
  <td>${r.from}</td>
  <td>${r.to}</td>
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


  <td>${r.date_utc}</td>
  <td>${r.dep_time_utc}</td>
  <td>${r.arr_time_utc}</td>
  <td>
  <div class="route-collapsible">
    <span class="route-text collapsed">
      ${r.atc_route}
      </span>

    <button
      type="button"
      class="route-toggle"
      aria-expanded="false">
      Show route
    </button>
  </div>
</td>
</tr>`;
}).join('')}
</tbody>
</table>
</div>

</section>
</main> 

<footer>
<section class="card">
    <!-- EVERYTHING that was inside <main> goes here -->
    <footer class="connected-users-footer">
  <strong>Connected Users:</strong>
  <div id="connectedUsersList">Loading...</div>
</footer>
  </section>

  <!-- KEEP ALL EXISTING <script> TAGS EXACTLY AS THEY ARE -->
  <script>
document.getElementById('refreshScheduleBtn').onclick = async () => {
  await fetch('/wf-schedule/refresh-schedule', { method: 'POST' });
  location.reload();
};
</script>

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

/* ===== DEP FLOW: INITIAL SYNC (+ COLOUR) ===== */
socket.on('syncDepFlows', flows => {
  window.sharedFlowRates = flows; // exposed for any client-side TSAT logic if needed
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
      value: input.value
    });
  });
});

/* ===== ADMIN REGISTRATION FOR CONNECTED USERS FOOTER ===== */
socket.emit('registerUser', {
  cid: "${req.session.user?.data?.cid || 'UNKNOWN'}",
  position: "${req.session.user?.data?.controller?.callsign || 'UNKNOWN'}"
});

/* ===== CONNECTED USERS FOOTER ===== */
socket.on('connectedUsersUpdate', users => {
  const container = document.getElementById('connectedUsersList');
  if (!users.length) {
    container.innerHTML = '<em>No users connected</em>';
    return;
  }
  container.innerHTML = users
    .map(u => 'CID ' + u.cid + ' - ' + u.position)
    .join('<br>');
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

  /* ===== FLOW TYPE: INITIAL SYNC ===== */
  socket.on('syncFlowTypes', types => {
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
        flowtype: sel.value
      });
    });
  });

});
</script>



`;
res.send(
  renderLayout({
    title: 'WF Schedule',
    user,
    isAdmin,
    layoutClass: 'dashboard-full',
    content
  })
);

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
  console.log(`WorldFlight CDM is running on ${port}`);
});