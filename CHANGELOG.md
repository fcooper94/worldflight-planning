# Changelog

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
