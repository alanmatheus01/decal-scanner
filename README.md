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
  (see "Name matching" below).
- **`robots.json`** — one entry per robot (Jira Epic), with a precomputed
  cone color, action text, and the open tickets that drove that decision.
  Committed to the repo by the sync script; the PWA fetches it at runtime.
- **`scripts/sync_jira.py`** — pulls robot Epics + their open child tickets
  from Jira Cloud, computes the cone color, writes `robots.json`, and
  commits + pushes it.
- **`systemd/`** — a user timer to run the sync script nightly.

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

1. Push this repo to GitHub.
2. Repo Settings → Pages → Deploy from branch → `main` / `(root)`.
3. Camera access requires HTTPS, which GitHub Pages provides by default.

The app is entirely static — `robots.json` is just a file the sync script
overwrites, no backend required.

## Credentials: kept outside the repo

`JIRA_API_TOKEN` (and the rest of the config) is read from **environment
variables only** — `sync_jira.py` never reads a file inside this repo, so
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

**Option B — an env file outside the repo** (what systemd uses, see below):

```bash
mkdir -p ~/.config/decal-scanner
cp scripts/env.example ~/.config/decal-scanner/env
chmod 600 ~/.config/decal-scanner/env
# edit ~/.config/decal-scanner/env and fill in the real values
```

`sync_jira.py` auto-loads `~/.config/decal-scanner/env` if it exists (for
manual runs), but anything already exported in your environment (Option A)
takes precedence over it.

## Running the Jira sync manually

```bash
cd scripts
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python sync_jira.py   # picks up credentials per "Credentials" above
```

Set `GIT_PUSH=false` (env var, or in `~/.config/decal-scanner/env`) to do a
dry run that writes `robots.json` locally without committing/pushing.

### Config knobs (all optional, see `scripts/env.example`)

- `JIRA_EPIC_JQL` — which Epics count as robots. Defaults to the current
  fleet filter (`project = FLEET AND type = Epic AND "rover location[dropdown]"
  IN (...)`).
- `JIRA_CHILD_PROJECTS` / `JIRA_CHILD_TYPES` — which projects/issue types are
  considered when computing cone color.
- `JIRA_EPIC_CHUNK_SIZE` — how many epic keys go into each `parent IN (...)`
  batch query (Jira has practical limits on JQL clause size).
- `REPO_DIR` — local clone the script commits into (defaults to the repo
  this script lives in). Needs `git push` to work non-interactively, i.e. an
  SSH key or credential helper already set up for the machine the sync runs
  on.

## Nightly sync via systemd (Linux, per-user)

```bash
mkdir -p ~/decal-scanner/scripts
# clone/copy the repo to ~/decal-scanner, then:
cd ~/decal-scanner/scripts
python3 -m venv venv && venv/bin/pip install -r requirements.txt

mkdir -p ~/.config/decal-scanner
cp env.example ~/.config/decal-scanner/env
chmod 600 ~/.config/decal-scanner/env
# edit ~/.config/decal-scanner/env and fill in credentials -- this is what
# the systemd unit's EnvironmentFile= points at, kept outside the repo

mkdir -p ~/.config/systemd/user
cp ~/decal-scanner/systemd/jira-robot-sync.{service,timer} ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now jira-robot-sync.timer

# Run once at 03:00 (with a 0-5 min random delay). To let it run even when
# you're logged out:
loginctl enable-linger "$USER"

# Check it:
systemctl --user list-timers jira-robot-sync.timer
journalctl --user -u jira-robot-sync.service -f
```

Run it on demand with `systemctl --user start jira-robot-sync.service`.

## Notes / things to double check for your Jira instance

- `"rover location[dropdown]"` in the epic JQL is the field's JQL clause
  name in this workspace — if it doesn't resolve, find the actual clause
  name/custom field ID under Jira admin → Custom fields, and override via
  `JIRA_EPIC_JQL`.
- The child-ticket query filters to `statusCategory != Done`, i.e. only
  currently-open tickets affect cone color. Resolved/closed tickets of any
  type are ignored.
- OCR character whitelist (`OCR_CHAR_WHITELIST` in `app.js`) currently
  assumes decals are uppercase letters, digits, spaces and hyphens — widen
  it if decals use other characters.
- The "robots processed" counter lives in the browser's `localStorage`, per
  device — it does not sync across phones.
- The Screen Wake Lock API isn't available on all browsers (notably older
  iOS Safari) — on unsupported browsers the phone will fall back to its
  normal auto-lock behavior, so set a longer auto-lock timeout on the
  device itself as a backstop.
- Spoken feedback uses whatever voice/language the device's Web Speech API
  defaults to; there's no in-app language selection.
