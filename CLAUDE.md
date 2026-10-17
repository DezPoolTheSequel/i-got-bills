# I Got Bills

A personal bills + income tracker, built as an installable PWA. Self-hosted end to end — no third-party backend services, no cloud database.

## Architecture

```
frontend/   Static PWA, deployed to GitHub Pages via GitHub Actions
backend/    Node/Express API, runs in Docker on a home Synology NAS
```

**Frontend** (`frontend/index.html`)
- Single-file React app. No build step — React, ReactDOM, and Babel Standalone are
  loaded from CDN, and the JSX is transpiled live in the browser at load time.
- This means there is no `npm run build`. Editing `index.html` directly *is* the
  whole development loop. Don't introduce a bundler/build step without good reason —
  it would break the "just edit and push" simplicity that's the point of this setup.
- The Babel transform is forced to `runtime: 'classic'` explicitly in the bootstrap
  script (not relying on Babel's default, which has changed between major versions).
- `manifest.json` + `sw.js` make it installable (Add to Home Screen / desktop install).
- `sw.js` deliberately does NOT intercept cross-origin requests (i.e. calls to the
  backend) — only same-origin app-shell files are cached. If you touch the service
  worker, preserve that origin check, or sync calls will get silently wrapped/cached
  in ways that break things.

**Backend** (`backend/server.js`)
- Minimal Express API: two resources, `bills` and `settings`, each stored as a single
  JSON file on disk (`/data/bills.json`, `/data/settings.json`). No real database.
- Every `/api/*` route except `/api/health` requires a header `x-app-key` matching the
  `APP_KEY` environment variable. This is the entire auth model — a single shared
  secret, not a user account system.
- Runs as a Docker container on the user's Synology NAS via Container Manager
  (a docker-compose project). `docker-compose.yml` (the real one, with the actual
  APP_KEY) is gitignored — only `docker-compose.example.yml` is committed.

## Deployment

- **Frontend**: `.github/workflows/deploy-pages.yml` runs `actions/upload-pages-artifact`
  on the `frontend/` folder, then `actions/deploy-pages`, on every push to `main`.
  Auto-deploys in ~15-30s. GitHub Pages source is set to "GitHub Actions" (not
  "Deploy from a branch") in repo Settings → Pages — don't change that back, it'll
  break the workflow.
- **Backend**: manual. There is no CI/CD for the backend yet. To deploy a change:
  upload the changed file(s) to the NAS via File Station (folder: `docker/i-got-bills`),
  then in Container Manager → Project → i-got-bills → Action → Clean, then → Build.
  "Clean" removes the container but NOT the data volume (`docker/i-got-bills-data`),
  so bills/settings survive a rebuild.

## Networking model (important context, not in any code file)

- The backend is exposed to the **public internet** via **Tailscale Funnel** — a
  WireGuard mesh VPN with a public relay. No Tailscale client is required on the
  accessing device (phone, PC, etc.), so the app works away from home without a VPN.
- The backend's address is `https://soast2.tail3a8b73.ts.net` → proxied by Tailscale
  Funnel to `127.0.0.1:3001` on the NAS. This was set up with
  `sudo tailscale funnel --bg 3001`, run on the NAS over SSH. The NAS node must have
  Funnel enabled in the Tailscale admin console (tailscale.com → Machines → NAS →
  Funnel). The config is re-applied automatically on boot via a DSM Task Scheduler
  job ("Tailscale Serve - I Got Bills", triggered on Boot-up, runs as root, command:
  `tailscale funnel --bg 3001`).
- HTTPS on the backend is NOT optional. The frontend is served over HTTPS
  (GitHub Pages), and browsers block a secure page from calling an insecure
  (`http://`) backend address — this bit us once already (mixed content / mixed
  origin failures). Always use the `https://*.ts.net` address, never the raw
  `http://100.x.x.x:3001` Tailscale IP, when configuring sync in the app.
- CORS in `server.js` is restricted to the GitHub Pages origin
  (`https://dezpoolthesequel.github.io`) and localhost. The APP_KEY is the real
  access gate — CORS just prevents arbitrary browser-origin requests since the
  backend is now public. If you add another frontend origin, update `ALLOWED_ORIGINS`
  in `server.js`.

## Known gotchas (hard-won, don't re-debug these)

1. **CORS origin restriction (Funnel era).** Since the backend is now on the public
   internet, `server.js` restricts `Access-Control-Allow-Origin` to a known allowlist
   (`ALLOWED_ORIGINS`). If you add a new frontend origin (e.g., a demo subdomain),
   update that set or requests from the new origin will get a blank CORS header and
   fail in browser. `Access-Control-Allow-Private-Network: true` is kept in the header
   set as a no-op — harmless, and avoids having to re-add it if ever switched back to
   Serve.
2. **Chrome's site-level "Local network" permission (historical, Serve era).** When
   the backend was on the private tailnet, Chrome required a per-site "Local network"
   permission (chrome://settings → Privacy → Site Settings → Local network). With
   Funnel this is no longer a private-network address and this permission is not needed.
   Kept here in case we ever revert.
3. **Service workers and Private Network Access (historical, Serve era).** A service
   worker in front of a private-network fetch() could interfere with permission
   negotiation. `sw.js` still excludes cross-origin requests from interception — keep
   that behavior regardless, as it's the correct pattern for any sync architecture.
4. **Docker build-time DNS on this Synology model.** `npm install` during the
   Docker image build can fail with `EAI_AGAIN` (DNS resolution failure) even
   though the NAS itself has working internet. Fixed by adding
   `build: { context: ., network: host }` to the compose file's build config —
   this makes the build step use the host's network/DNS directly. If backend
   rebuilds start failing with `EAI_AGAIN` again, check this is still present.
5. **GitHub Pages browser cache / service worker staleness.** After deploying a
   frontend update, an already-installed PWA can keep showing the old version
   for a surprisingly long time (service worker cache lag). If a "deployed" change
   doesn't appear on the installed app, try: clear the site's storage/cache for
   the GitHub Pages origin, or bump `CACHE_NAME` in `sw.js` to force the old
   cache to be invalidated.

## Build variants (owner build vs. demo build)

There are two intended builds of this app, sharing the same frontend codebase:

**Owner build** (current)
- Frontend on GitHub Pages + backend on Synology NAS (via Tailscale Funnel).
- Data is synced server-side in JSON files; all devices share the same state.
- Requires the APP_KEY and the backend to be reachable.

**Demo build** (planned — not yet implemented)
- Frontend only — no backend needed.
- All data stored in browser **IndexedDB** (localStorage is too small for bill history
  with recurring series).
- No APP_KEY, no sync, fully self-contained in the browser.
- Goal: anyone can try a live version of the app without running their own backend.
- Implementation plan: a storage-layer abstraction in `index.html` that checks a flag
  (e.g., `?demo=1` URL param or a separate `demo.html`) and routes all reads/writes
  to IndexedDB instead of the backend API. The rest of the UI is identical.
- When building the demo mode, don't duplicate the UI — parameterize the storage layer
  only. The demo and owner builds should share one HTML file if possible.

## Data model conventions

- `isBillPaid(bill)` is the single source of truth for "paid" status — derived
  from `paidAmount >= budgetAmount`, never trust a stored `isPaid` flag directly
  for UI logic. (An earlier version stored `isPaid` as an independently-editable
  flag, which could drift out of sync with the actual amounts — don't reintroduce
  that pattern.)
- Bills and income share the same record shape, distinguished by `type: 'bill' |
  'income'`. Income that is "received" (`isBillPaid` true) merges into the same
  "Paid" UI section as paid bills, rather than having its own separate paid state.
- Recurring entries (`recurring: true`) belong to a series via `seriesId`.
  Individual occurrences are generated ahead of time (`generateOccurrences`,
  rolling window via `FOREVER_GENERATION_WINDOW`) rather than computed on the fly.
  Editing "this occurrence only" detaches a record from its series (clears
  `seriesId`); editing "this and future" regenerates the forward window from
  that occurrence's date and propagates to all *unpaid* siblings, past or future
  — paid/received occurrences are always left untouched as real history.
- CSV/JSON export collapses an entire forever-recurring series' future unpaid
  occurrences into one marker row (`isSeriesPlaceholder: true`) rather than
  exporting dozens of generated rows; import re-expands it. Don't "simplify" this
  by exporting raw occurrences — it was deliberately built this way to keep
  export files from growing unbounded.

## What NOT to do

- Don't add a build step (webpack/vite/etc.) to the frontend without discussing
  it first — the no-build-step setup is intentional, not an oversight.
- Don't commit `backend/docker-compose.yml` (the real one). Only
  `docker-compose.example.yml` should ever be in git. Check `.gitignore` is
  still excluding it before any backend-related commit.
- Don't remove the `Access-Control-Allow-Private-Network` header or the
  same-origin check in `sw.js` — both were added to fix real, previously-broken
  behavior, not speculative hardening.
- Don't assume `npm install`/build tooling is available for the frontend — there
  is no `package.json` in `frontend/` and there shouldn't be one.
