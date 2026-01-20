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
import renderLayout from './layout.js';

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
    tobtBookingsBySlot[b.slotKey] = {
  slotKey: b.slotKey,   // ← REQUIRED
  cid: b.cid,
  callsign: b.callsign,
  from: b.from,
  to: b.to,
  dateUtc: b.dateUtc,
  depTimeUtc: b.depTimeUtc,
  tobtTimeUtc: b.tobtTimeUtc,
  createdAtISO: b.createdAt.toISOString()
};


    // ONLY index by CID if CID exists (pilot booking)
    if (b.cid !== null) {
      if (!tobtBookingsByCid[b.cid]) {
        tobtBookingsByCid[b.cid] = new Set();
      }
      tobtBookingsByCid[b.cid].add(b.slotKey);
    }
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


const tobtBookingsBySlot = {}; // slotKey -> { cid, createdAtISO, callsign }
const tobtBookingsByCid = {};  // { cid: Set(slotKey) }


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

  for (const booking of Object.values(tobtBookingsBySlot)) {
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
      !tobtBookingsBySlot[slotKey]
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
        !tobtBookingsBySlot[key]   // ✅ NOT BOOKED
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

socket.on('createBookingOnly', async ({ sector, callsign }) => {

  console.log('[BOOKING ONLY]', sector, callsign);

  if (!sector || !callsign) return;
  if (!user || !user.cid) return;   // ✅ pilot-based permission

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
  if (tobtBookingsBySlot[slotKey]) return;

  await prisma.tobtBooking.create({
    data: {
      slotKey,
      cid: Number(user.cid),              // ✅ ALWAYS STORE CID
      callsign: callsign.trim().toUpperCase(),
      from,
      to,
      dateUtc: row.date_utc,
      depTimeUtc: row.dep_time_utc,
      tobtTimeUtc: null
    }
  });

  tobtBookingsBySlot[slotKey] = {
    slotKey,
    cid: Number(user.cid),
    callsign: callsign.trim().toUpperCase(),
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


app.get('/dashboard', (req, res) => {
  return res.redirect(301, '/schedule');
});



/* ===== ADMIN AUTH ===== */
function requireAdmin(req, res, next) {
  const cid = req.session?.user?.data?.cid;
  if (!cid || !ADMIN_CIDS.includes(Number(cid))) {
    return res.status(403).send('Access Denied: Admins Only');
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



app.use(express.static('public'));
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
  if (req.session?.user?.data) {
    return res.redirect('/schedule');
  }

  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
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






app.get('/wf/world-map', requireLogin, (req, res) => {
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



app.get('/auth/login', vatsimLogin);
app.get('/auth/callback', vatsimCallback);
app.get('/schedule', (req, res) => {
  const cid = Number(req.session?.user?.data?.cid);
  const isAdmin = ADMIN_CIDS.includes(cid);
  const myBookings = cid ? tobtBookingsByCid[cid] : null;

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
            <th class="col-window">Arr Window</th>
            <th class="col-time">Block Time</th>
            <th class="col-route">ATC Route</th>
            <th class="col-flowtype">Booking Type</th>
            <th class="col-book">Book Slot</th>
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
              <td class="col-window">${buildTimeWindow(r.arr_time_utc)}</td>
              <td class="col-time">${r.block_time}</td>

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

              <!-- ✅ FLOW TYPE COLUMN -->
              <td class="col-flowtype">
  <span class="flowtype-pill flowtype-${flowtype.toLowerCase()}">
    ${
      flowtype === 'SLOTTED'
        ? 'Slot Required'
        : flowtype === 'BOOKING_ONLY'
        ? 'Booking Required'
        : 'No Restrictions'
    }
  </span>
</td>



              <!-- ✅ BOOK SLOT -->
              <td class="col-book">
  ${
    (() => {

      /* ===== FLOW TYPE: NONE ===== */
      if (flowtype === 'NONE') {
        return `
          <span class="tobt-not-required">
            -
          </span>
        `;
      }

      if (flowtype === 'BOOKING_ONLY') {
  const sectorInstanceKey = `${r.from}-${r.to}|${r.date_utc}|${r.dep_time_utc}`;

  return `
    <button
  class="tobt-btn book booking-only"
  data-sector="${sectorInstanceKey}">
  Book
</button>

  `;
}



      /* ===== NO USER BOOKINGS ===== */
      if (!myBookings) {
        const label =
          flowtype === 'BOOKING_ONLY'
            ? 'Book'
            : 'Book Slot';

        return `
          <a class="tobt-btn book"
             href="/book?from=${r.from}&to=${r.to}&dateUtc=${encodeURIComponent(r.date_utc)}&depTimeUtc=${r.dep_time_utc}">
            ${label}
          </a>
        `;
      }

      /* ===== CHECK EXISTING BOOKING ===== */
      const sectorKey = `${r.from}-${r.to}|${r.date_utc}|${r.dep_time_utc}`;

      const mySlotKey = [...myBookings].find(k =>
        k.startsWith(sectorKey + '|') &&
        tobtBookingsBySlot[k]
      );

      if (!mySlotKey) {
        const label =
          flowtype === 'BOOKING_ONLY'
            ? 'Book'
            : 'Book Slot';

        return `
          <a class="tobt-btn book"
             href="/book?from=${r.from}&to=${r.to}&dateUtc=${encodeURIComponent(r.date_utc)}&depTimeUtc=${r.dep_time_utc}">
            ${label}
          </a>
        `;
      }

      /* ===== EXISTING BOOKING ===== */
      return `
        <button
          class="tobt-btn cancel"
          data-slot-key="${mySlotKey}">
          Cancel
        </button>
      `;
    })()
  }
</td>


              <!-- ✅ SIMBRIEF PLAN -->
              <td class="col-plan">
                ${
                  (() => {
                    let url =
                      `https://dispatch.simbrief.com/options/custom` +
                      `?orig=${r.from}` +
                      `&dest=${r.to}` +
                      `&route=${encodeURIComponent(r.atc_route)}`;

                    if (myBookings) {
                      const sectorKey = `${r.from}-${r.to}|${r.date_utc}|${r.dep_time_utc}`;
                      const mySlotKey = [...myBookings].find(k =>
                        k.startsWith(sectorKey + '|')
                      );

                      if (mySlotKey) {
                        const booking = tobtBookingsBySlot[mySlotKey];
                        if (!booking || !booking.tobtTimeUtc) {
                          return `
                            <a class="tobt-btn book"
                               href="/book?from=${r.from}&to=${r.to}&dateUtc=${encodeURIComponent(r.date_utc)}&depTimeUtc=${r.dep_time_utc}">
                              Book Slot
                            </a>
                          `;
                        }

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
                      } else {
                        url += `&manualrmk=${encodeURIComponent(
                          'Route validated from www.worldflight.center'
                        )}`;
                      }
                    } else {
                      url += `&manualrmk=${encodeURIComponent(
                        'Route validated from www.worldflight.center'
                      )}`;
                    }

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

  const callsign = await openCallsignModal();
  if (!callsign) return;

  console.log('[CLIENT] booking-only submit', sector, callsign);

  socket.emit('createBookingOnly', {
    sector,
    callsign
  });
});
</script>
<script>
let bookingOnlySector = null;
const socket = io(); // 🔑 THIS WAS MISSING

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
</script>
<script>
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.tobt-btn.cancel');
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
        <th>Pattern</th>
        <th>Requested</th>
        <th>Status</th>
<th>Actions</th>

      </tr>
    </thead>
    <tbody id="docAccessRequestsTable">
      <tr><td colspan="4" class="empty">Loading...</td></tr>
    </tbody>
  </table>
</section>

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

            // ✅ Then render row
            return (
              '<tr data-status="' + r.status + '">' +
                '<td>' + escapeHtml(r.cid) + '</td>' +
                '<td><strong>' + escapeHtml(r.pattern) + '</strong></td>' +
                '<td>' + requested + '</td>' +
                '<td>' + statusLabel + '</td>' +
                '<td>' + actionsHtml + '</td>' +
              '</tr>'
            );
          }).join('')
        : '<tr><td colspan="5" class="empty">No requests</td></tr>';
    })
    .catch(function () {
      requestsTable.innerHTML =
        '<tr><td colspan="5" class="empty">Failed to load requests</td></tr>';
    });
}



  requestsTable.addEventListener('click', function (e) {
    var approveBtn = e.target.closest('.btn-approve');
var denyBtn = e.target.closest('.btn-deny');
var deleteBtn = e.target.closest('.btn-delete');

    if (!approveBtn && !denyBtn && !deleteBtn) return;

var id = (approveBtn || denyBtn || deleteBtn).dataset.id;
var action = approveBtn
  ? 'approve'
  : denyBtn
    ? 'deny'
    : 'delete';


    openConfirmModal({
  title:
    action === 'delete'
      ? 'Delete Request'
      : action === 'approve'
        ? 'Approve Access'
        : 'Deny Access',
  message:
    action === 'delete'
      ? 'This will permanently remove the request. This cannot be undone.'
      : action === 'approve'
        ? 'Grant documentation upload access?'
        : 'Deny this access request?'
}).then(function (ok) {
  if (!ok) return;

  var url;
var method = 'POST';

if (action === 'approve') {
  url = '/admin/api/documentation-access-requests/' + id + '/approve';
} else if (action === 'deny') {
  url = '/admin/api/documentation-access-requests/' + id + '/deny';
} else if (action === 'delete') {
  url = '/admin/api/documentation-access-requests/' + id;
  method = 'DELETE';
}

fetch(url, {
  method,
  headers: { 'Content-Type': 'application/json' }
})
.then(function (r) {
  if (!r.ok) throw new Error('Request failed');
  return r.json();
})
.then(function () {
  loadRequests();
})
.catch(function (err) {
  alert(err.message || 'Failed to process request');
});

});

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

    await prisma.documentationAccessRequest.delete({
      where: { id }
    });

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

app.get('/icao/:icao', requireLogin, async (req, res) => {
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

  <div class="icao-top-row three-cols">

    <!-- LEFT: Upcoming Departures -->
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


    <!-- MIDDLE: Online Controllers -->
    <div class="controllers-card">
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
        <th>Last Updated</th>
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
              '<td>' + new Date(d.updated).toLocaleDateString('en-GB') + '</td>' +
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



<script>
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#requestDocAccess');
  if (!btn) return;

  const icao = btn.dataset.icao;

  openConfirmModalAsync({
    title: 'Request documentation access',
    message: 'Request permission to upload documents for ' + icao + '?',
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    onConfirm: async ({ showOk }) => {
      const res = await fetch('/api/documentation-access/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ icao: icao })
      });

      if (!res.ok) {
        showOk('Request failed', 'Unable to submit access request. Please try again.');
        return true;
      }

      // Success: update SAME modal content
      showOk('Request sent', 'Your request has been sent to an administrator for review.');

      // Optional: hide/disable the request button after success
      btn.classList.add('hidden');

      return true;
    }
  });
});
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
              '<th>Developer</th>' +
              '<th>Store</th>' +
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
    '<td>' + (r.developer || '-') + '</td>' +
    '<td>' + (r.store || '-') + '</td>' +
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
    title: `${icao} Airport Portal`,
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
    const { icao } = req.body;

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

    await prisma.documentationAccessRequest.create({
      data: {
        cid,
        pattern: icao.toUpperCase(),
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

    const bookedSlots = Object.keys(tobtBookingsBySlot)
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

    const bookedSlots = Object.keys(tobtBookingsBySlot)
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

  res.json({
    arrival: arrivalLeg ? {
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

    departure: departureLeg ? {
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

  // ✅ MUST check before using slots
  if (slots === null) {
    return res.json({
      noFlow: true,
      message: 'No flow rate has been defined for this sector.'
    });
  }

  const results = [];

  slots.forEach(tobt => {
    const slotKey = makeTobtSlotKey({
      from,
      to,
      dateUtc,
      depTimeUtc,
      tobtTimeUtc: tobt
    });

    const booking = tobtBookingsBySlot[slotKey];

    results.push({
      tobt,
      slotKey,                 // 🔑 REQUIRED
      booked: !!booking,
      byMe: booking?.cid === cid,
      callsign: booking?.callsign || null
    });
  });

  res.json(results);
});



/* ===== ADMIN MANUAL REFRESH ===== */
app.post('/wf-schedule/refresh-schedule', requireAdmin, async (req, res) => {
  await refreshAdminSheet();
  rebuildAllTobtSlots();
  res.json({ success: true });
});

app.post('/api/tobt/cancel', async (req, res) => {
  const cid = Number(req.session?.user?.data?.cid);
  if (!cid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { slotKey } = req.body;
  if (!slotKey) {
    return res.status(400).json({ error: 'Missing slotKey' });
  }

  const booking = tobtBookingsBySlot[slotKey];

  if (!booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const isAdmin =
  ADMIN_CIDS.includes(cid) ||
  !!req.session?.user?.data?.controller;

// Pilot can cancel own booking
if (booking.cid !== null && booking.cid !== cid) {
  return res.status(403).json({ error: 'Forbidden' });
}

// ATC/Admin can cancel ATC-assigned bookings
if (booking.cid === null && !isAdmin) {
  return res.status(403).json({ error: 'Forbidden' });
}


  await prisma.tobtBooking.delete({
    where: { slotKey }
  });

  delete tobtBookingsBySlot[slotKey];

  // 🔑 Maintain CID index (remove from My Slots)
if (booking.cid !== null && tobtBookingsByCid[booking.cid]) {
  tobtBookingsByCid[booking.cid].delete(slotKey);

  if (tobtBookingsByCid[booking.cid].size === 0) {
    delete tobtBookingsByCid[booking.cid];
  }
}


  if (tobtBookingsByCid[cid]) {
    tobtBookingsByCid[cid].delete(slotKey);
    if (tobtBookingsByCid[cid].size === 0) {
      delete tobtBookingsByCid[cid];
    }
  }

emitToIcao(
  booking.from,
  'unassignedTobtUpdate',
  buildUnassignedTobtsForICAO(booking.from)
);



  res.json({ success: true });
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
    const { slotKey, callsign, manual } = req.body;
    if (!slotKey || !callsign) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    // 2️⃣ Extract user basics
    const userData = req.session.user.data;
    const cid = Number(userData.cid);

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
    if (tobtBookingsBySlot[slotKey]) {
      return res.status(409).json({ error: 'Slot already booked' });
    }

    // 6️⃣ Normalize callsign
    const normalizedCallsign = callsign.trim().toUpperCase();

    // 7️⃣ Reserved team callsign enforcement (applies to both modes)
    const teamCheck = await isReservedTeamCallsign(normalizedCallsign, cid);
    if (teamCheck.reserved && !teamCheck.allowed) {
      return res.status(403).json({
        error: `Callsign ${normalizedCallsign} is reserved for an official team.`
      });
    }

    // 8️⃣ Prevent duplicate sector + callsign
    const sectorKey = parts.slice(0, 3).join('|');

    for (const existingSlotKey in tobtBookingsBySlot) {
      const existingSectorKey = existingSlotKey.split('|').slice(0, 3).join('|');
      const existing = tobtBookingsBySlot[existingSlotKey];

      if (existingSectorKey === sectorKey && existing.callsign === normalizedCallsign) {
        return res.status(409).json({
          error:
            'A booking has already been made with this callsign on ' +
            sectorKey.split('|')[0]
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
    tobtBookingsBySlot[slotKey] = {
      slotKey,
      cid: storedCid,
      callsign: normalizedCallsign,
      from: fromIcao,
      to: to.toUpperCase(),
      dateUtc,
      depTimeUtc,
      tobtTimeUtc
    };

    // 1️⃣1️⃣ Index My Slots (PILOT ONLY)
    if (storedCid !== null) {
      if (!tobtBookingsByCid[storedCid]) {
        tobtBookingsByCid[storedCid] = new Set();
      }
      tobtBookingsByCid[storedCid].add(slotKey);
    }

    // 1️⃣2️⃣ Notify clients
    emitToIcao(fromIcao, 'departures:update');
    emitToIcao(fromIcao, 'unassignedTobtUpdate', buildUnassignedTobtsForICAO(fromIcao));

    return res.json({ success: true });

  } catch (err) {
    console.error('[TOBT] Booking failed:', err);
    return res.status(500).json({ error: 'Failed to book TOBT slot' });
  }
});








app.post('/api/tobt/update-callsign', async (req, res) => {
  const cid = Number(req.session?.user?.data?.cid);
  if (!cid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { slotKey, callsign } = req.body;
  if (!slotKey || !callsign) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const booking = tobtBookingsBySlot[slotKey];
  if (!booking || booking.cid !== cid) {
    return res.status(403).json({ error: 'Not your booking' });
  }

// 🔒 Enforce unique callsign per sector on UPDATE
// 🔒 Enforce unique callsign per sector on UPDATE
const normalizedCallsign = callsign.trim().toUpperCase();

// 🔒 Reserved Official Team callsign enforcement (UPDATE)
const teamCheck = await isReservedTeamCallsign(normalizedCallsign, cid);

if (teamCheck.reserved && !teamCheck.allowed) {
  return res.status(403).json({
    error: `Callsign ${normalizedCallsign} is reserved for an official team.`
  });
}


// sector = FROM-TO|date|depTime
const sectorKey = slotKey.split('|').slice(0, 3).join('|');

for (const existingSlotKey in tobtBookingsBySlot) {
  if (existingSlotKey === slotKey) continue; // ignore own booking

  const existingSectorKey = existingSlotKey
    .split('|')
    .slice(0, 3)
    .join('|');

  const existing = tobtBookingsBySlot[existingSlotKey];

  if (
    existingSectorKey === sectorKey &&
    existing.callsign === normalizedCallsign
  ) {
    return res.status(409).json({
      error:
        'A booking has already been made with this callsign on ' +
        sectorKey.split('|')[0]
    });
  }
}
 

  try {
    await prisma.tobtBooking.update({
      where: { slotKey },
      data: {
        callsign: normalizedCallsign,
        from: booking.from,
        to: booking.to,
        dateUtc: booking.dateUtc,
        depTimeUtc: booking.depTimeUtc,
        tobtTimeUtc: booking.tobtTimeUtc
      }
    });
  } catch (err) {
    console.error('[TOBT] Callsign update failed:', err);
    return res.status(500).json({ error: 'Failed to update callsign' });
  }

  // ✅ Update in-memory cache
  booking.callsign = normalizedCallsign;


  res.json({ success: true });
});


// 🔒 Reserved Official Team callsign enforcement (UPDATE)



app.get('/admin', (req, res) => {
  res.redirect(301, '/wf-schedule');
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
  const matchingSlotKeys = Object.keys(tobtBookingsBySlot).filter(k => {
    const b = tobtBookingsBySlot[k];
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
    delete tobtBookingsBySlot[slotKey];
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

  delete tobtBookingsBySlot[slotKey];

  emitToIcao(booking.from, 'departures:update');


  res.json({ success: true });
});




app.get('/atc', requireLogin, (req, res) => {
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
      callsign = await openCallsignModal();
      if (!callsign) return;
      callsign = callsign.trim().toUpperCase();
    }

    const res = await fetch('/api/tobt/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotKey, callsign })
    });

    if (!res.ok) {
  const err = await res.json();
  showBookingError(
    err.error || 'Booking failed. Please try again.'
  );
  return;
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

app.get('/my-slots', requireLogin, (req, res) => {
  if (!req.session.user || !req.session.user.data) {
    return res.redirect('/auth/login');
  }

  const user = req.session.user.data;
  const cid = Number(user.cid);
  const isAdmin = ADMIN_CIDS.includes(cid);

  const mySlots = Array.from(tobtBookingsByCid[cid] || []);

  const rows = mySlots.map(slotKey => {
    const booking = tobtBookingsBySlot[slotKey];
    if (!booking) return null; // safety

    const [sectorKey, dateUtc, depTimeUtc] = slotKey.split('|');
    const [from, to] = sectorKey.split('-');

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
    let simbriefUrl = null;
    let tobtDisplay = '—';

    // ✅ NORMAL TOBT HANDLING
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

      simbriefUrl =
        'https://dispatch.simbrief.com/options/custom' +
        '?orig=' + from +
        '&dest=' + to +
        '&callsign=' + encodeURIComponent(callsign) +
        '&deph=' + hh +
        '&depm=' + mm +
        '&route=' + encodeURIComponent(atcRoute || '') +
        '&manualrmk=' + encodeURIComponent(
          `WF TOBT [SLOT] ${hh}:${mm} UTC - Route validated from www.worldflight.center`
        );
    }

    return {
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
  }).filter(Boolean); // remove null safety rows



  const content = `
  <div id="bookingErrorBanner" class="booking-banner cancel hidden">
  <span id="errorMessage"></span>
</div>
  
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
                <th class="col-callsign">Callsign</th>
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

  <td class="col-callsign">
  <span class="callsign-text">${r.callsign}</span>
  <button
    class="callsign-edit-btn"
    title="Edit callsign"
    data-slotkey="${r.slotKey}"
    data-callsign="${r.callsign}"
    aria-label="Edit callsign">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 20h9"/>
  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>
</svg>

  </button>
</td>

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
      Cancel Slot
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
  function showBookingError(message) {
    const banner = document.getElementById('bookingErrorBanner');
    const msg = document.getElementById('errorMessage');
    if (!banner || !msg) return;

    msg.textContent = message;
    banner.classList.remove('hidden');
  }

  function hideBookingError() {
    const banner = document.getElementById('bookingErrorBanner');
    if (banner) banner.classList.add('hidden');
  }

  async function saveCallsign(input) {
    hideBookingError();

    const callsign = input.value.trim().toUpperCase();
    const slotKey = input.dataset.slotkey;

    const res = await fetch('/api/tobt/update-callsign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotKey, callsign })
    });

    if (!res.ok) {
  let errText = 'Failed to update callsign';
  try {
    const err = await res.json();
    if (err && err.error) errText = err.error;
  } catch {}

  // 🔁 revert input to last valid value
  input.value = input.dataset.original || '';

  showBookingError(errText);
  return false;
}


    // success
input.dataset.original = callsign;
return true;
  }

  // Save when user clicks away
  document.addEventListener('change', e => {
    if (!e.target.classList.contains('callsign-input')) return;
    saveCallsign(e.target);
  });

  // Save when user presses Enter
  document.addEventListener('keydown', async e => {
    if (!e.target.classList.contains('callsign-input')) return;
    if (e.key !== 'Enter') return;

    e.preventDefault();
    await saveCallsign(e.target);
    e.target.blur();
  });
</script>

<script>
document.addEventListener('click', async e => {
  const btn = e.target.closest('.callsign-edit-btn');
  if (!btn) return;

  const slotKey = btn.dataset.slotkey;
  const currentCallsign = btn.dataset.callsign;

  const newCallsign = await openCallsignModal();
  if (!newCallsign) return;

  const res = await fetch('/api/tobt/update-callsign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotKey, callsign: newCallsign })
  });

  if (!res.ok) {
    let msg = 'Failed to update callsign';
    try {
      const err = await res.json();
      if (err?.error) msg = err.error;
    } catch {}
    showBookingError(msg);
    return;
  }

  location.reload(); // authoritative refresh
});
</script>
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

    onConfirm: async ({ set, showOk }) => {
      try {
        const res = await fetch('/api/tobt/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slotKey })
        });

        if (!res.ok) {
          let msg = 'Failed to cancel slot';
          try {
            const err = await res.json();
            if (err?.error) msg = err.error;
          } catch {}

          // Show error, allow retry
          set('Cancel failed', msg);
          return false;
        }

        
        // Refresh after short delay so user sees confirmation
        setTimeout(() => location.reload(), 600);
        return true;

      } catch (err) {
        set('Request failed', 'Network error. Please try again.');
        return false;
      }
    }
  });
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

    // IMPORTANT: must match session name
    res.clearCookie('worldflight.sid', {
      path: '/'
    });

    return res.redirect('/');
  });
});


/* ===== SERVER START ===== */
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`WorldFlight CDM is running on ${port}`);
});