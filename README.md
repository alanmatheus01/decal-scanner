# decal-scanner

A static PWA that OCRs a robot's name decal (client-side, via
[Tesseract.js](https://github.com/naptha/tesseract.js)) using the phone's
selfie camera, looks the robot up in `robots.json`, and tells the operator
what cone color to apply and what to do next. A Python script keeps
`robots.json` in sync with Jira nightly.

## How it works

- **`index.html` / `app.js` / `style.css`** — the PWA. Designed to sit
  propped up by the door as a hands-free kiosk (see "Hands-free design"
  below): it opens the front (selfie) camera, continuously OCRs the region
  inside the on-screen guide box with no button to press, normalizes the
  text (uppercase, alphanumeric-only) and matches it against `robots.json`
  (see "Name matching" below). Hosted publicly on GitHub Pages — this code
  contains no robot names or Jira specifics, see "Serving robots.json
  privately" below for why that split exists.
- **`robots.json`** — one entry per robot (Jira Epic), with a precomputed
  cone color, action text, and the open tickets that drove that decision.
  Written by the sync script to a private server on your own machine, never
  committed to this repo. The PWA fetches it cross-origin at runtime.
- **`scripts/sync_jira.py`** — pulls robot Epics + their open child tickets
  from Jira Cloud, computes the cone color, and writes `robots.json` to a
  local directory.
- **`scripts/serve_robots.py`** — a small dependency-free HTTP server that
  serves that one file with a CORS header, for the PWA to fetch cross-origin.
- **`launchd/`** — macOS agents to run the sync nightly and keep the server
  running.

## Cone logic

Priority order, first match wins:

| Cone | Trigger | Action |
|---|---|---|
| 🟣 Purple | An open **Robot Calibration**, **Oncall - Tier 1**, or **Tech Support Service Request** ticket | Connect to power and ethernet. Ensure offload begins. |
| 🔴 Red | An open **Task** ticket | Drop off in Fleet Management room. |
| 🟢 Green | None of the above | Connect to power and ethernet. |

If the decal doesn't match any known robot (even fuzzily), the app asks the
operator to create an RSV to replace the decal and drop the robot off in the
Fleet Management room.

## Hands-free design

The intended setup: the phone sits propped up by the door on a stand, and
the agent controls the robot with both hands, only glancing at (or
listening to) the screen. So the whole flow is built to need zero taps for
the common case:

- **No scan button.** `app.js`'s `scanLoop()` runs continuously in the
  background the whole time the app is open, OCRing frames roughly every
  150ms + however long `Tesseract.recognize()` takes.
- **Debounced, not instant.** A reading only "commits" (updates the screen,
  speaks, increments the counter) after it's been read the same way for
  `CONFIRM_FRAMES` (2) loop iterations in a row. This filters out one-off
  OCR noise from an empty or incidental camera view — it does not act on
  the first frame it sees.
- **No double-counting while a decal sits in frame.** Once a reading
  commits, the app remembers it (`currentKey`) and won't re-trigger or
  re-count for the same robot while it's still being held up to the camera.
- **Auto-reset when the decal is no longer visible.** After
  `EMPTY_RESET_FRAMES` (2) consecutive frames with no text at all, the
  current match clears and the display returns to the live camera view —
  ready to recognize the *same* robot again later (it left and came back)
  or a different one next.
- **Full-screen color, not a small icon.** The result covers the whole
  camera view in a solid cone color (purple/red/green) with large text, so
  it reads at a glance from across the room — an amber "needs attention"
  color is used for the not-recognized and ambiguous-match screens, since
  those require actually reading the text.
- **Spoken feedback.** Every committed result is read aloud via the Web
  Speech API (`speak()` in `app.js`) — e.g. "Purple cone. Connect to power
  and ethernet. Ensure offload begins." — so the agent doesn't need to look
  at all for the common case. Tap the speaker icon in the top bar to mute;
  the setting persists in `localStorage`.
- **Screen stays on.** Uses the Screen Wake Lock API so the phone doesn't
  lock itself while sitting idle by the door (re-requested automatically
  if the tab is backgrounded and becomes visible again).
- **The only taps that exist** are for cases that genuinely need a human
  decision: picking a robot off the "multiple close matches" list (or
  tapping "none of these — create RSV"), the manual-search fallback if OCR
  can't get a clean read, and tapping anywhere on a result to dismiss it
  early instead of waiting for the auto-reset. None of these are part of
  the common per-robot path.

Tuning knobs, all in `app.js`: `CONFIRM_FRAMES`, `EMPTY_RESET_FRAMES`,
`LOOP_YIELD_MS` (delay between OCR attempts).

### If OCR reads backwards/mirrored text

The live preview mirrors the front camera (cosmetic only — makes hand-eye
aiming easier, moving the decal left in your hand moves it left on screen)
via CSS `transform: scaleX(-1)` on `#video`. This does **not** affect OCR:
`canvas.drawImage()` reads a video element's decoded frame directly,
ignoring any CSS transform on it. Capture-side orientation is controlled
independently by `FLIP_CAPTURE_HORIZONTALLY` in `app.js` (default `false`
— confirmed on this fleet's phones that the raw camera stream is already
correctly oriented). If a different device reads backwards text, that's a
sign its stream is mirrored at the frame level (inconsistent across
browsers/platforms) — flip this to `true` and watch the "Last read" text
under the camera view to confirm which case you're in.

## Name matching

OCR text is normalized (uppercase, letters/digits only) and matched against
every robot name by edit distance (`app.js`, `findMatch`). Three outcomes:

- **Exact** — normalized text matches a robot name exactly, and no other
  robot name is close enough to be confusable. Shown with no warning.
- **Fuzzy** — no exact match, but exactly one robot name is close enough
  (within ~25% of its length in edits) to be a confident guess. Shown with a
  "double-check" banner.
- **Ambiguous** — two or more robot names are close enough to each other
  that picking one would be a guess (e.g. **Paola** vs **Paolo** are one
  edit apart). The app does *not* silently pick one — it shows the
  candidates and asks the operator to tap the right one, or create an RSV
  if they can't tell. This also fires on an otherwise-exact match: if OCR
  reads a decal as "Paola" but "Paolo" exists too, that's still flagged,
  since the OCR itself could be the thing that's wrong.

This matters because decals are commonly damaged or missing letters. A
decal that's actually "Paolo" but has lost its final letter reads as "Paol",
which is genuinely equidistant from both "Paola" and "Paolo" — there's no
correct automatic answer, so the app asks rather than guessing wrong. The
confusability window is `CONFUSABLE_DISTANCE_GAP` in `app.js` (default 2);
lower it if your fleet has many names that are legitimately this close and
the ambiguous screen fires too often, raise it if near-miss robots still
slip through as confident matches.

## Deploying the PWA to GitHub Pages

1. Push this repo to GitHub. It's fine for this to be public — the app
   shell contains no robot names or org-specific Jira details (see below).
2. Repo Settings → Pages → Deploy from branch → `main` / `(root)`.
3. Camera access requires HTTPS, which GitHub Pages provides by default.

### Confirming a deploy actually landed

The top-right corner shows a small `vYYYY-MM-DD.N` build string
(`APP_VERSION` in `app.js`). There's no build step generating it — it's a
plain hardcoded string, bumped by hand on every meaningful change. Since
both GitHub Pages propagation *and* this app's own service-worker caching
(stale-while-revalidate) can delay a phone from seeing the latest code
after a push, this is the simplest way to confirm a given phone has
actually picked it up: reload the page and check the version matches what
you just pushed.

## Serving robots.json privately

Robot names and their Jira ticket status are considered private, so
`robots.json` is deliberately kept off GitHub entirely — it's served from
your own machine (e.g. a work laptop, reachable over
[Tailscale](https://tailscale.com/)) instead of alongside the public app
shell. Architecture:

```
Phone (kiosk)  --https-->  GitHub Pages        (public: app shell, no robot data)
Phone (kiosk)  --https-->  your laptop         (private: robots.json only)
your laptop    --https-->  Jira Cloud          (nightly sync, API token)
```

**The scanning phone itself must be on the same tailnet.** `ROBOTS_JSON_URL`
in `app.js` is public source code (anyone can read it off GitHub Pages), but
that alone doesn't grant access to it. This setup uses `tailscale serve`,
not `tailscale funnel` -- `serve` only makes the endpoint reachable *within
your tailnet*, over Tailscale's own encrypted mesh, with no public IP:port
exposed anywhere (`funnel` is the separate, explicit "expose this to the
whole internet" feature, and is not used here). So a stranger with the
GitHub Pages URL gets the (harmless) app shell and, at most, learns a
private endpoint exists -- they have no network path to actually reach it.
`serve_robots.py` binding to `127.0.0.1` only is a second layer of the same
thing: the only way in is through Tailscale's proxy.

The practical consequence: the phone needs the Tailscale app installed,
logged into this same tailnet, and connected at scan time, or the
`robots.json` fetch will fail/timeout (the app shell itself will still load
fine over any normal connection -- only the private data fetch depends on
Tailscale).

Because the app shell and `robots.json` are now on two different origins,
the browser requires the fetch to be an explicit CORS request — that's what
`serve_robots.py`'s `Access-Control-Allow-Origin` header is for — and
because the app shell loads over HTTPS, fetching from a plain `http://`
address would be blocked outright as mixed content (this is also why
camera access needs HTTPS in the first place). So HTTPS on the private
side is required, not optional.

### Setup (macOS + Tailscale)

1. **Confirm Tailscale can issue you a cert.** MagicDNS + the tailnet's
   "HTTPS Certificates" feature need to be on (an org-wide, admin-controlled
   setting) — test with:
   ```bash
   tailscale cert your-machine-name.your-tailnet.ts.net
   ```
   If that succeeds, you're set. (If your org hasn't enabled it and you
   can't get an admin to, fall back to a LAN-only setup with
   [mkcert](https://github.com/FiloSottile/mkcert) instead — same
   `serve_robots.py`, just a different way of getting a trusted cert onto
   the scanning phone(s); not covered in detail here since it wasn't
   needed for this deployment.)

2. **Set up credentials and config** (see "Credentials" below) in
   `~/.config/decal-scanner/env`, including `SERVE_ALLOWED_ORIGIN` set to
   your actual GitHub Pages origin (e.g. `https://yourusername.github.io`
   — scheme + host only, no path).

3. **Install the two `launchd` agents** — see "Running nightly via
   launchd" below.

4. **Point `tailscale serve` at the local server:**
   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:8787
   ```
   This persists across reboots (Tailscale stores the config), and its
   certs auto-renew — nothing to maintain. Your data is now live at
   `https://your-machine-name.your-tailnet.ts.net/robots.json`.

5. **Update `ROBOTS_JSON_URL` in `app.js`** to that same URL, then commit
   and push (this one line is the only thing in the public repo that even
   references your private endpoint's address — and knowing the address
   doesn't grant access, Tailscale's network-level ACLs do that).

### Accepted tradeoff

If the laptop is off, asleep, or disconnected, the PWA falls back to
whatever `robots.json` its service worker last cached (stale but
functional) — there's no always-on fallback host. That's a deliberate
choice for this deployment; tune the laptop's sleep/power settings (e.g.
"prevent sleep when on power adapter") if overnight availability matters,
or reconsider hosting on an always-on device if staleness becomes a
problem.

## Credentials: kept outside the repo

`JIRA_API_TOKEN` (and the rest of the config) is read from **environment
variables only** — neither script ever reads a file inside this repo, so
there's nothing to accidentally commit or gitignore-and-forget.

Get a Jira Cloud API token at
https://id.atlassian.com/manage-profile/security/api-tokens.

**Option A — export in your shell** (good for one-off/manual runs):

```bash
export JIRA_BASE_URL=https://yourcompany.atlassian.net
export JIRA_EMAIL=you@yourcompany.com
export JIRA_API_TOKEN=xxxxx
```

Put those lines in your shell profile (`~/.zshrc`, etc.) if you want them
available every session — still nowhere near the repo.

**Option B — an env file outside the repo** (what the launchd agents use):

```bash
mkdir -p ~/.config/decal-scanner
cp scripts/env.example ~/.config/decal-scanner/env
chmod 600 ~/.config/decal-scanner/env
# edit ~/.config/decal-scanner/env and fill in the real values
```

Both `sync_jira.py` and `serve_robots.py` auto-load
`~/.config/decal-scanner/env` if it exists, but anything already exported
in your environment (Option A) takes precedence over it.

## Running the Jira sync manually

```bash
cd scripts
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python sync_jira.py   # picks up credentials per "Credentials" above
```

Writes `robots.json` to `ROBOTS_JSON_PATH` (defaults to
`~/decal-scanner-data/robots.json`) — no git involved at all.

### Config knobs (all optional, see `scripts/env.example`)

- `JIRA_EPIC_JQL` — which Epics count as robots. The in-repo default is a
  non-working placeholder on purpose (see "Credentials" above) — your real
  project key, custom field name, and site names are org-internal
  structure, so set the real JQL via this env var, never in committed
  source.
- `JIRA_CHILD_PROJECTS` / `JIRA_CHILD_TYPES` — which projects/issue types are
  considered when computing cone color. Same deal for `JIRA_CHILD_PROJECTS`
  (your real project key) — set it via env, not in the repo.
- `JIRA_EPIC_CHUNK_SIZE` — how many epic keys go into each `parent IN (...)`
  batch query (Jira has practical limits on JQL clause size).
- `ROBOTS_JSON_PATH` — where the file is written/served from (defaults to
  `~/decal-scanner-data/robots.json`). Must match between `sync_jira.py` and
  `serve_robots.py`.
- `SERVE_HOST` / `SERVE_PORT` / `SERVE_ALLOWED_ORIGIN` — `serve_robots.py`
  settings; the origin must match your GitHub Pages origin exactly.

## Running nightly via launchd (macOS)

```bash
mkdir -p ~/decal-scanner/scripts
# clone/copy the repo to ~/decal-scanner, then:
cd ~/decal-scanner/scripts
python3 -m venv venv && venv/bin/pip install -r requirements.txt

mkdir -p ~/.config/decal-scanner
cp env.example ~/.config/decal-scanner/env
chmod 600 ~/.config/decal-scanner/env
# edit ~/.config/decal-scanner/env and fill in credentials + SERVE_ALLOWED_ORIGIN

mkdir -p ~/Library/LaunchAgents
for f in ~/decal-scanner/launchd/*.plist; do
  sed "s|__HOME__|$HOME|g" "$f" > ~/Library/LaunchAgents/"$(basename "$f")"
done

launchctl load ~/Library/LaunchAgents/com.decalscanner.serve-robots.plist
launchctl load ~/Library/LaunchAgents/com.decalscanner.sync-jira.plist

# then point tailscale serve at the running server, see "Serving robots.json
# privately" above
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

`com.decalscanner.serve-robots` keeps `serve_robots.py` running continuously
(restarted automatically if it ever exits). `com.decalscanner.sync-jira`
runs `sync_jira.py` once nightly at 03:00.

Check on them:

```bash
launchctl list | grep decalscanner
tail -f ~/Library/Logs/decal-scanner-serve.log
tail -f ~/Library/Logs/decal-scanner-sync.log
```

Run the sync on demand with:
```bash
~/decal-scanner/scripts/venv/bin/python ~/decal-scanner/scripts/sync_jira.py
```

## Notes / things to double check for your Jira instance

- Your dropdown/location custom field's JQL clause name is workspace
  specific — find it (and its custom field ID, if the clause name doesn't
  resolve) under Jira admin → Custom fields, and put the real JQL in
  `JIRA_EPIC_JQL` via env, not in this repo.
- The child-ticket query filters to `statusCategory != Done`, i.e. only
  currently-open tickets affect cone color. Resolved/closed tickets of any
  type are ignored.
- OCR character whitelist (`OCR_CHAR_WHITELIST` in `app.js`) currently
  assumes decals are letters, spaces and hyphens only (no digits) — widen
  it if decals use other characters.
- The "robots processed" counter lives in the browser's `localStorage`, per
  device — it does not sync across phones.
- The Screen Wake Lock API isn't available on all browsers (notably older
  iOS Safari) — on unsupported browsers the phone will fall back to its
  normal auto-lock behavior, so set a longer auto-lock timeout on the
  device itself as a backstop.
- Spoken feedback uses whatever voice/language the device's Web Speech API
  defaults to; there's no in-app language selection.
