# I Got Bills

A self-hosted bills + income tracker, installable as a PWA. See `CLAUDE.md` for full
architecture, deployment, and gotcha notes.

## Local development

### Frontend (`frontend/`)

No build step — `index.html` loads React/Babel from a CDN and transpiles JSX live in
the browser. "Local dev" just means serving the folder over HTTP.

**Quick check (no service worker / PWA features):**
Just double-click `frontend/index.html`, or open it directly in a browser:
```
file:///C:/Users/dharr/my_apps/i-got-bills/frontend/index.html
```
Good enough for checking layout/visual changes. Service workers don't run on `file://`
origins, so PWA install behavior won't work this way.

**Full local test (service worker works correctly):**
```bash
cd frontend
python -m http.server 8000
```
Then open:
```
http://localhost:8000
```
Stop the server with `Ctrl+C` when done.

> ⚠️ **Heads up:** if you connect Sync in Settings while testing locally, it'll talk to
> whatever backend URL is saved (likely your real NAS backend) — same as the deployed
> app. Don't connect sync during a frontend test unless you mean to touch real data.

### Backend (`backend/`)

Run the real Node server locally, pointed at a throwaway data folder so it never
touches your actual bills on the NAS.

```bash
cd backend
npm install
```

Then start it with a temporary local config:
```bash
APP_KEY=test123 PORT=3001 DATA_DIR=./local-data node server.js
```

It'll be reachable at:
```
http://localhost:3001
```

Quick check it's alive:
```bash
curl http://localhost:3001/api/health
```

To point your locally-running **frontend** at this locally-running **backend** for a
full end-to-end test: open the local frontend (above), go to Settings → Sync across
devices, and enter:
- Server address: `http://localhost:3001`
- App key: `test123` (or whatever you set above)

`./local-data` is gitignored — delete that folder any time to reset your local test
data back to empty.

## Deploying for real

- **Frontend**: just `git push` to `main` — GitHub Actions deploys `frontend/` to
  GitHub Pages automatically in ~15-30 seconds.
- **Backend**: manual for now. Upload changed file(s) to the NAS via File Station
  (`docker/i-got-bills`), then in Container Manager → Project → i-got-bills →
  Action → Clean, then → Build.

See `CLAUDE.md` for the full picture (networking model, known gotchas, data model
conventions) before making backend changes.
