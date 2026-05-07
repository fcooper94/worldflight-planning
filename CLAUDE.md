# WorldFlight Planning Portal — Claude Working Notes

This file is loaded automatically by Claude Code at the start of every conversation in this repo. It captures project context, tech overview, and collaboration rules so any Claude instance (this PC or another) is on the same page from turn one.

## Project

The **WorldFlight Planning Portal** is the operations site for the annual *WorldFlight* VATSIM round-the-world event.

- **Current active event:** WorldFlight 2026 (31 Oct – 7 Nov 2026)
- **Sectors** are individual legs identified as `WFxxxx` (e.g. `WF2624: KDEN → EGPK`)
- Pilots book TOBT slots and view briefings; controllers manage flow restrictions and ATIS
- Visited airports are tracked per year in `WfVisitedAirport` (data stretches back to early WorldFlights)

## Tech overview

- **Stack:** Express + Prisma + Leaflet + Socket.IO, vanilla JS templates (no React/Vue)
- **`index.js`** is the monolithic main file (~25k lines) — most routes and rendered HTML live here
- **`layout.js`** holds shared layout chrome and modal markup
- **`public/`** has client-side JS (`icao-map.js`, `wf-world-map.js`, `previous-destinations.js`) and `styles.css`
- **Auth:** VATSIM OAuth in production; `DEV_MODE=true` enables an offline dev login that bypasses VATSIM
- **Map tiles:** CartoDB dark/light via `wfAddTileLayer()`; tiles swap automatically when the footer Light/Dark toggle changes `data-theme`

## Two Prisma schemas, two databases

| File | Database | Used when |
|------|----------|-----------|
| `prisma/schema.prisma` | Production Postgres (Railway) | `npm start`, prod |
| `prisma/schema.dev.prisma` | Local SQLite at `prisma/dev.db` | `npm run dev` → option 2 (Offline Dev) |

**Both schemas must be edited together** for any column add/remove. They drift otherwise.

## Dev / prod sync workflow

- `start.js` is the entry for `npm run dev`. It prompts for Production vs Offline (Dev) and rewrites `.env` from `.env.dev` (offline) or `.env.prod.bak` (prod).
- `sync-prod.mjs` pulls live prod tables into the local SQLite DB. It reads the prod connection string from `.env.dev`'s `PROD_DATABASE_URL`.
- **After any schema change:**
  1. Edit both schema files.
  2. Push to dev SQLite: `npx prisma db push --schema=prisma/schema.dev.prisma --skip-generate`
  3. Push to prod Postgres: `DATABASE_URL="$PROD_URL" npx prisma db push --schema=prisma/schema.prisma --skip-generate` (read `PROD_URL` from `.env.dev`).
  4. If a column has a `@default(...)` and existing rows need a different value, run a one-off backfill query directly against each DB after the push.
  5. Restart `npm run dev` — Prisma client regen fails on Windows while nodemon holds the engine DLL.
- **Pushing to prod is a serious action.** Show a dry-run / preview first, get explicit go-ahead per push, and run a verification query after.

## Collaboration rules

### 1. Stay strictly within requested scope
When asked to change or remove X, do **only** that. Don't refactor adjacent code, don't delete "related" dead code, don't add improvements beyond the request. If supporting code looks orphaned afterwards, leave it or ask separately — bundling cleanup into a removal task has caused regressions before.

### 2. Propose A/B/C options for non-trivial UI restructures
For layout overhauls (new tab structure, page consolidation, big flow change), list 2–3 named options with their tradeoffs and recommend one. Wait for the user to pick before implementing. Small tweaks (colour, padding, single-element add/remove, copy changes) — just do them directly.

### 3. Cosmetic CSS is never a security boundary
For login-gated "preview" pages, the server must render a non-sensitive placeholder. CSS `filter: blur()` is purely visual and removable in DevTools — any page that sends real data and blurs it client-side leaks that data. Pattern:

1. Check authentication server-side at the route handler.
2. If unauthenticated, render hard-coded sample/skeleton — no DB lookups, no real CIDs, callsigns, sectors, names.
3. Apply blur and the login overlay only on top of that placeholder.

### 4. No CHANGELOG.md
Keep change history in `git log` only. Never create or maintain a `CHANGELOG.md` file. Write detailed commit messages instead.

### 5. Confirm git push explicitly
Always ask before `git push`, even right after a recently approved push. Each push is its own decision; "yes" once does not authorize subsequent pushes.

## Page-visibility model (3-state)

`PageVisibility.mode` is one of:

- **`visible`** — shown to everyone (in nav and accessible)
- **`admin-only`** — shown in admin's nav, hidden from non-admin nav, returns 403 for non-admins (admin can access)
- **`hidden`** — hidden from nav for everyone, returns 403 for non-admins (admin can still URL-navigate)

Helpers:

- `isPageVisibleTo(key, isAdmin)` — for inline feature checks (returns true if visible to all, OR admin-only and viewer is admin)
- `isPageEnabled(key)` — legacy shim that returns true only for `'visible'`. Use `isPageVisibleTo` for new code.
- `requirePageEnabled(key)` middleware passes if visible OR viewer is admin (so admins always have access)

The legacy `enabled` boolean on the row is kept in sync on every write for back-compat.

## Document validity scoping

`AirportDocument.eventId` controls when a document is shown:

- `NULL` = permanent — always visible to everyone with access
- A specific event id = visible only while that event is the active event (`WfEvent.isActive`)
- Non-admins never see archived (event != active) docs
- Only the *currently active* event id may be tagged at upload time — any other id is rejected server-side
- Admins see all docs regardless, with a scope badge (Permanent / event name / Archived: event name)

## Common gotchas

- Map padding for `fitBounds` is in **pixels**, not a percentage. For routes that span widely on one axis but not the other, use asymmetric padding (`[20, 50]`) and pick which axis gets more padding based on `spanLat > spanLon`.
- Leaflet doesn't auto-recompute its size when its container changes via CSS (e.g. ATIS card appears, sidebar toggles). Use a `ResizeObserver` on the map container that calls `map.invalidateSize()`.
- The `.modal-card input` global rules force `text-transform: uppercase` and `text-align: center` for the callsign/ICAO modal. Any new modal that wants normal input should scope its own overrides under a unique modal id.
- Inline arrow characters in `index.js` template literals are stored as `←` / `→` / `—` escape sequences. Multi-line `Edit` operations may need to use the literal escape sequence, not the rendered character — Python `replace` via Bash is a reliable fallback.
- US ICAOs (KLAX, KJFK, …) drop the leading `K` for *display only* on the airport portal heading; URLs and DB lookups still use the full 4-letter code.

## Tools the user values

- **Prisma db push** for schema changes (no formal migrations workflow set up).
- **`pg` directly** in scripts for one-shot data pushes/pulls to/from prod, with `--push` flag gating destructive runs and `INSERT … ON CONFLICT DO NOTHING` for idempotency.
- **Lucide-style line SVG icons** throughout the UI (sidebar, dashboard cards, admin panel cards). When adding a new icon, match this style (`fill: none; stroke: currentColor; stroke-width: 1.8/2`).
