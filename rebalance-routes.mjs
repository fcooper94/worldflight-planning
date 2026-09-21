// Rebalance Route A/B assignments across every sector with an agreed split.
//
// Usage:
//   node rebalance-routes.mjs                    (dry-run — shows every move)
//   node rebalance-routes.mjs --push             (writes the changes)
//   node rebalance-routes.mjs --only WF2632      (one sector, or a list)
//
// Bookings made through /api/tobt/book before the route assignment was wired
// up all defaulted to Route A, so sectors with an agreed split never actually
// split. This brings them onto their target ratio.
//
// depSplitPct divides the sector's CAPACITY (flow rate x the 2-hour departure
// window) between the two routes. Route A is filled in priority order — WF
// teams first, then affiliates down the affiliate list, then ordinary pilots by
// booking time — and whatever does not fit overflows to Route B.
//
// So 30/hr at a 50% split is 60 movements, 30 of them on Route A; book 49 and
// the last 19 in that order land on Route B.
//
// Time Slot Required sectors are split per half-hour of connect time instead,
// against that bucket's share of the rate. Splitting the window as one pool
// would put everyone connecting early on Route A and leave the back half of
// the window entirely on B.
//
// Reads the active event from WfEvent (isActive=true).

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { planRouteRebalance, routeCapacity, TEAM, AFFILIATE, PILOT } from './lib/route-split.mjs';

const prisma = new PrismaClient();
const PUSH = process.argv.includes('--push');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg !== -1
  ? new Set(String(process.argv[onlyArg + 1] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean))
  : null;

async function main() {
  const event = await prisma.wfEvent.findFirst({ where: { isActive: true } });
  if (!event) throw new Error('No active WfEvent');
  console.log(`Event: ${event.name} (id ${event.id})`);
  console.log(PUSH ? 'MODE: PUSH — changes will be written\n' : 'MODE: dry-run — nothing will be written\n');

  // WF team CIDs, and affiliate CIDs with their position in the affiliate list.
  const [roles, teams, affs, members] = await Promise.all([
    prisma.userAdditionalRole.findMany({
      where: { role: { in: ['WF_TEAM', 'WF_AFFILIATE'] } },
      select: { cid: true, role: true }
    }),
    prisma.officialTeam.findMany({ select: { mainCid: true } }),
    prisma.affiliate.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, cid: true } }),
    prisma.affiliateMember.findMany({ where: { active: true }, select: { affiliateId: true, cid: true } })
  ]);
  const teamCids = new Set([
    ...roles.filter(r => r.role === 'WF_TEAM').map(r => Number(r.cid)),
    ...teams.map(t => Number(t.mainCid))
  ].filter(Boolean));
  const affCids = new Set(roles.filter(r => r.role === 'WF_AFFILIATE').map(r => Number(r.cid)));

  const affRank = new Map();
  const posById = new Map();
  affs.forEach((a, i) => {
    posById.set(a.id, i);
    if (a.cid) { affRank.set(Number(a.cid), i); affCids.add(Number(a.cid)); }
  });
  for (const m of members) {
    const pos = posById.get(m.affiliateId);
    if (pos != null && !affRank.has(Number(m.cid))) affRank.set(Number(m.cid), pos);
  }

  const classify = cid =>
    teamCids.has(Number(cid)) ? TEAM : (affCids.has(Number(cid)) ? AFFILIATE : PILOT);
  const affiliateRank = cid => affRank.get(Number(cid)) ?? Number.MAX_SAFE_INTEGER;
  console.log(`${teamCids.size} team CIDs · ${affCids.size} affiliate CIDs across ${affs.length} affiliates \n`);

  const plans = await prisma.sectorPlan.findMany({ where: { eventId: event.id } });
  const split = plans.filter(p =>
    p.splitAgreed && p.depSplitRoute && p.depSplitPct != null
    && p.depFlowType !== 'NONE' && p.depFlowRate);   // no flow rate, no capacity ceiling
  if (!split.length) {
    console.log('No sectors have an agreed split. Nothing to do.');
    return;
  }

  let totalMoves = 0;
  for (const plan of split.sort((a, b) => a.wf.localeCompare(b.wf))) {
    if (ONLY && !ONLY.has(plan.wf.toUpperCase())) continue;

    const sched = await prisma.wfScheduleRow.findFirst({
      where: { number: plan.wf, eventId: event.id },
      select: { from: true, to: true }
    });
    if (!sched) { console.log(`${plan.wf}: no schedule row — skipped`); continue; }

    const bookings = await prisma.tobtBooking.findMany({
      where: { slotKey: { startsWith: `${sched.from}-${sched.to}|` } },
      select: { id: true, cid: true, callsign: true, assignedRoute: true, createdAt: true, tobtTimeUtc: true }
    });

    const plan_ = planRouteRebalance({
      bookings,
      depSplitPct: plan.depSplitPct,
      flowRate: plan.depFlowRate,
      slotted: plan.depFlowType === 'TIME_SLOT_REQUIRED',
      classify,
      affiliateRank
    });
    const curB = bookings.filter(b => b.assignedRoute === 'B').length;

    const per = plan_.slotted ? 'per 30 min' : 'over 2h';
    console.log(`${plan.wf}  ${sched.from} → ${sched.to}   ${plan.depFlowRate}/hr, ${plan.depSplitPct}% A — ${plan_.capacity} ${per}`);
    console.log(`  ${plan_.total} bookings — ${plan_.teamCount} team, ${plan_.affiliateCount} affiliate, ${plan_.pilotCount} pilot`);
    console.log(`  now:    A ${plan_.total - curB}  B ${curB}`);
    console.log(`  route capacity ${per}: A ${plan_.capacityA}  B ${plan_.capacityB}`);
    if (plan_.slotted) {
      plan_.buckets.filter(x => x.key).forEach(x =>
        console.log(`    ${x.key}  ${String(x.total).padStart(3)} booked -> A ${x.onA}  B ${x.onB}`));
    }
    console.log(`  target: A ${plan_.targetA}  B ${plan_.targetB}`);

    if (!plan_.moves.length) { console.log('  no changes\n'); continue; }

    for (const m of plan_.moves) {
      console.log(`    CID ${m.cid} ${(m.callsign || '').padEnd(8)} ${m.kind.padEnd(9)} ${(m.bucket || '').padEnd(6)} ${m.from} → ${m.to}`);
    }
    totalMoves += plan_.moves.length;

    if (PUSH) {
      for (const m of plan_.moves) {
        await prisma.tobtBooking.update({ where: { id: m.id }, data: { assignedRoute: m.to } });
      }
      console.log(`  ✓ wrote ${plan_.moves.length} change(s)`);
    }
    console.log('');
  }

  console.log(PUSH
    ? `Done — ${totalMoves} booking(s) updated. Restart the server so the in-memory cache reloads.`
    : `Dry-run complete — ${totalMoves} booking(s) would change. Re-run with --push to apply.`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
