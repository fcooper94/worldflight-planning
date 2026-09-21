// Route A/B split planning for flow-restricted sectors.
//
// A sector with an agreed split carries two routes: A (primary) and B (the
// agreed alternative). The flow rate is what makes the split necessary in the
// first place — one route cannot absorb the traffic — so capacity, not a bare
// ratio, decides who flies which.
//
// Shared by the live server sweep (index.js) and rebalance-routes.mjs so the
// two can't drift. Pure: no Prisma, no in-memory caches, no I/O.

/* The departure window is dep ±1 hour, so a sector's capacity is its flow rate
   across two hours. Matches WINDOW_HOURS in generateTobtSlots and the
   rate × 2 in getBookingOnlyCapacity — change all three together. */
export const DEPARTURE_WINDOW_HOURS = 2;

/* Time Slot Required sectors are split per half-hour of connect time rather
   than over the window as a whole. Split the whole window in one pool and
   Route A fills from the earliest slots outwards, so everyone connecting at the
   start of the window is on A and the back half is all B. Bucketing keeps both
   routes represented throughout. Booking Required sectors have no set times, so
   they stay a single pool. */
export const SLOT_BUCKET_MINUTES = 30;

export const TEAM = 'team';
export const AFFILIATE = 'affiliate';
export const PILOT = 'pilot';

/* depSplitPct divides CAPACITY between the two routes, it is not a ratio
   applied to whatever happens to be booked.

   e.g. 30/hr over a 2-hour window is 60 movements; a 50% split gives Route A
   30 of them and Route B the other 30. Book 49 aircraft and the first 30 fill
   Route A, the remaining 19 overflow to Route B. */
export function routeCapacity({ flowRate, depSplitPct, hours = DEPARTURE_WINDOW_HOURS }) {
  const total = Math.floor((Number(flowRate) || 0) * hours);
  const capacityA = Math.round(total * (Number(depSplitPct) || 0) / 100);
  return { total, capacityA, capacityB: total - capacityA };
}

/* Clock half-hour a connect time falls in, e.g. "20:47" -> "20:30". */
function bucketOf(tobtTimeUtc, bucketMinutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(tobtTimeUtc || '').trim());
  if (!m) return '';
  const mins = Number(m[1]) * 60 + Number(m[2]);
  const start = Math.floor(mins / bucketMinutes) * bucketMinutes;
  return `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
}

/* Route A is filled in priority order and everything past its capacity
   overflows to Route B:

     1. WF teams        — earliest booking first.
     2. Affiliates      — affiliate-list order (sortOrder asc, id asc), so the
                          bottom of the list is what overflows.
     3. Ordinary pilots — earliest booking first, so the overflow is whoever
                          booked last.

   Teams therefore only reach Route B where the team fleet alone exceeds Route
   A's capacity, and a pilot is never on A while an affiliate sits on B.

   On a slotted sector that ordering is applied within each half-hour of
   connect time, against that bucket's share of the capacity. On a booking-only
   sector it is applied once across the whole window.

   `bookings` are the sector's rows: { id, cid, callsign, assignedRoute,
   createdAt, tobtTimeUtc }. `classify(cid)` returns TEAM / AFFILIATE / PILOT.
   `affiliateRank(cid)` gives a position in the affiliate list; unranked
   affiliates sort last within their group. Returns only the rows that
   change. */
export function planRouteRebalance({
  bookings, depSplitPct, flowRate, classify, affiliateRank,
  slotted = false, bucketMinutes = SLOT_BUCKET_MINUTES, windowHours = DEPARTURE_WINDOW_HOURS
}) {
  const rankOf = typeof affiliateRank === 'function' ? affiliateRank : () => 0;
  const GROUP = { [TEAM]: 0, [AFFILIATE]: 1, [PILOT]: 2 };

  const rows = bookings.map(b => ({
    id: b.id,
    cid: Number(b.cid),
    callsign: b.callsign || '',
    current: b.assignedRoute === 'B' ? 'B' : 'A',
    createdAt: b.createdAt ? new Date(b.createdAt).getTime() : 0,
    kind: classify(Number(b.cid)),
    bucket: slotted ? bucketOf(b.tobtTimeUtc, bucketMinutes) : ''
  }));

  // Slotted sectors split per bucket at the per-bucket rate; booking-only
  // sectors are one pool across the whole window.
  const perBucketHours = bucketMinutes / 60;
  const cap = slotted
    ? routeCapacity({ flowRate, depSplitPct, hours: perBucketHours })
    : routeCapacity({ flowRate, depSplitPct, hours: windowHours });

  const byBucket = new Map();
  for (const r of rows) {
    if (!byBucket.has(r.bucket)) byBucket.set(r.bucket, []);
    byBucket.get(r.bucket).push(r);
  }

  const toA = new Set();
  const buckets = [];
  for (const [key, group] of [...byBucket.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Priority queue for Route A. Affiliates go by list position, everyone
    // else by booking time; id breaks ties so the order is deterministic.
    const queue = [...group].sort((a, b) =>
      (GROUP[a.kind] ?? 9) - (GROUP[b.kind] ?? 9)
      || (a.kind === AFFILIATE ? rankOf(a.cid) - rankOf(b.cid) : a.createdAt - b.createdAt)
      || a.id - b.id);
    queue.slice(0, cap.capacityA).forEach(r => toA.add(r.id));
    buckets.push({
      key,
      total: group.length,
      onA: Math.min(group.length, cap.capacityA),
      onB: Math.max(0, group.length - cap.capacityA)
    });
  }

  const moves = [];
  for (const r of rows) {
    const target = toA.has(r.id) ? 'A' : 'B';
    if (target !== r.current) {
      moves.push({
        id: r.id, cid: r.cid, callsign: r.callsign,
        kind: r.kind, bucket: r.bucket, from: r.current, to: target
      });
    }
  }

  const counts = { [TEAM]: 0, [AFFILIATE]: 0, [PILOT]: 0 };
  rows.forEach(r => { counts[r.kind] = (counts[r.kind] || 0) + 1; });

  return {
    total: rows.length,
    slotted,
    capacity: cap.total,
    capacityA: cap.capacityA,
    capacityB: cap.capacityB,
    buckets,
    teamCount: counts[TEAM],
    affiliateCount: counts[AFFILIATE],
    pilotCount: counts[PILOT],
    targetA: buckets.reduce((n, b) => n + b.onA, 0),
    targetB: buckets.reduce((n, b) => n + b.onB, 0),
    moves
  };
}
