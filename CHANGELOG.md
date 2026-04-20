# Changelog

## 2026-04-20 (even later)

### Admin · Suggestions modal + Privacy Policy

- **Scroll lock on suggestion modals.** Opening the "Who Suggested" and
  division modals on the Admin → Suggestions page now locks the background
  page scroll so the wheel doesn't scroll the table behind the dialog.
  Reference-counted across both modals so stacked opens (clicking an ICAO
  inside the division modal) keep the lock until the last one closes.
- **Privacy Policy rewrite.** `/privacy` replaced with a VATSIM
  compliance-aligned policy covering Data Controller, Scope, Personal Data,
  Lawful Basis (Art. 6 GDPR), Purposes, Sharing, Third-Party Services,
  International Transfers, Retention, Data Subject Rights, Cookies,
  Automated Decision-Making, and Policy Updates.

## 2026-04-20 (later)

### Public policy pages

- Added `/privacy` (Privacy Policy) and `/data-handling` (Data Handling)
  public pages describing what data is collected, how it's used, where it's
  stored, retention, user rights, and how to contact us for export or
  deletion. Both link to each other and carry a last-updated stamp.
- Extended the admin connected-users footer into a site-wide footer: admins
  still see the connected-users list on the left; every visitor now sees
  `Privacy Policy · Data Handling` links anchored to the far right. Styles
  moved out of the admin-only block.

## 2026-04-20

### Admin · Suggestions

- **Group by VATSIM division.** New "By VATSIM Division" card on the Admin →
  Suggestions page. Pills list each division/vACC/ARTCC with total votes and
  unique airport counts; clicking one opens a modal with the top suggestions
  in that area.
- **Granular mapping.** VATEUD is broken down into national vACCs (Spain,
  France, Germany, Netherlands, Belux, Italy, etc.) and VATUSA is broken down
  into ARTCCs via a per-airport lookup (ZNY, ZLA, ZAU, ZTL, ZBW, ZDC, ZJX,
  ZMA, ZMP, ZKC, ZFW, ZHU, ZID, ZAB, ZDV, ZLC, ZOA, ZOB, ZSE, ZAN, HCF).
- **Official division list aligned.** Corrected earlier mistakes: VATSSA is
  Sub-Sahara Africa (not South America), VATSUR for South America, VATCA for
  Central America, VATIL Israel, VATRUS Russia/CIS, VATROC Taiwan, VATWA
  Indian subcontinent. Hong Kong / Macau folded under VATPRC; Morocco moved
  to VATMENA; Spanish enclaves under Spain vACC.
- **"Who Suggested" modal.** Click any destination pill/chip anywhere on the
  page to open a modal listing each suggester with their name, role, date,
  and reason. Role pills are colour-coded (Director gold, Staff orange,
  Instructor red, Mentor pink, Controller sky, Student cyan, Pilot green,
  Member slate, other purple). Airport name is shown alongside the ICAO in
  the modal title. Avoid suggestions tinted red.
- **Search box on All Suggestions.** Filter rows live by ICAO, suggester
  name, or association. Client-side, shows "Showing N of M" count.
- **Reason "Show more" fix.** Previously only rendered when reason text was
  over 100 chars, missing short-but-wrapping cases. Now always rendered when
  a reason exists, then hidden post-render for rows that actually fit.
- **Visited Airports search.** Added an ICAO search box above the admin
  Visited Airports table.

### Suggest Airport form

- Fixed the ICAO lookup/"Great suggestion!" panel lingering after a
  successful submit; it's now cleared alongside the rest of the form.

### Previous Destinations

- **World-copy dots.** Markers and ICAO labels now repeat at ±360° so they
  appear on every horizontal iteration of the world rather than just the
  centre copy.
- **Search control.** Centred search box at the top of the map (below the
  site banner). Type ICAO or airport name → live dropdown; click or Enter
  flies the map to zoom ≥ 9 and opens the airport popup. Input clears after
  selection for the next search. Keyboard navigation (↑/↓/Enter/Escape).
  Empty-state message reads `WorldFlight has never visited <ICAO>` when the
  query looks like an ICAO.

## 2026-04-19 (later)

### Site password gate — double-prompt fix

- **Removed the gate from `/auth/callback`.** The VATSIM callback is only
  ever reached via a redirect from `/auth/login` (which is still gated),
  so re-gating the callback was redundant and flaky across the OAuth
  round-trip in some proxy/session setups.
- **`/auth/login` no longer captures gate/auth pages as `returnTo`.** When
  a visitor entered the password, got redirected to `/auth/login`, and the
  referer was `/site-password`, the login handler stored `/site-password`
  as the post-login return destination — so the VATSIM callback's final
  redirect would bounce them straight back to the password prompt. Skip
  list now also excludes `/auth/login`, `/auth/callback`, `/site-password`,
  and `/dev-login`; real page referers still work.

## 2026-04-19

### Site password gate

- **Login-path-only gate.** Replaced the site-wide redirect with a targeted
  guard that only fires on `/auth/login`, `/auth/callback`, and `/dev-login`.
  Public pages (dashboard, map, world view, etc.) remain accessible without
  the password; the prompt only appears the moment a visitor tries to start
  a login flow.
- **Admin runtime toggle.** Added a *Site Password* section at the top of
  Admin → Page Visibility. Enabled/disabled state is persisted in the
  `SiteSetting` table under `site-gate-enabled` and applied immediately
  without a server restart. The toggle is visually locked and rejected
  server-side when the `SITE_PASSWORD` env var is not set.
- **Dismiss affordances on the gate page.** The `/site-password` screen now
  offers four ways to back out without submitting: × close button, "Cancel
  and go back" link, click the backdrop, press Escape. All dismissals call
  `history.back()` with a `/` fallback.
- **Env-only secret.** `SITE_PASSWORD` is read from environment only and is
  never committed — `.env` / `.env.prod.bak` are gitignored.

### Earlier today

- Non-WF event configuration: WorldFlight toggle, custom suffix, first
  flight number, aircraft type, CI / Mach / KIAS cruise mode, forced cruise
  altitude, cost index, start date (themed calendar picker) + time.
- Flight-time column in the schedule and a "next sector after Block / Flight"
  mode that honours `est_time_enroute` from SimBrief and skips turnaround.
- Overpass hardening: mirror rotation, status-endpoint gating, exponential
  backoff, AbortController client timeout, User-Agent, tighter QL budgets.
- Streaming per-leg subprocess output with elapsed time for SCT generation.
- Cache-refresh fixes in `recalcScheduleTimes` on empty / incomplete first
  legs; honour `turnaroundMins=0` (replaced `|| 45` fallbacks).
