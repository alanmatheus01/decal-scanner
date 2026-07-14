#!/usr/bin/env python3
"""
Nightly Jira -> robots.json sync.

Pulls the fleet's robot Epics (one Epic per robot) plus their open child
tickets from Jira Cloud, computes a cone color + action per robot, writes
robots.json, and commits + pushes it if anything changed.

Auth: Jira Cloud Basic auth (email + API token). Create a token at
https://id.atlassian.com/manage-profile/security/api-tokens

Configuration is via environment variables (see env.example) -- deliberately
never read from a file inside this repo, so the token can't accidentally get
committed. Real environment variables (already exported, or set by systemd's
EnvironmentFile) always take precedence. As a convenience for manual runs,
if ~/.config/decal-scanner/env exists it's loaded for any variables not
already set in the environment; see README.md for where to put it.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import requests

try:
    from dotenv import load_dotenv

    load_dotenv(Path.home() / ".config" / "decal-scanner" / "env")
except ImportError:
    pass

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("sync_jira")

# ---------------------------------------------------------------------------
# configuration
# ---------------------------------------------------------------------------

JIRA_BASE_URL = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
JIRA_EMAIL = os.environ.get("JIRA_EMAIL", "")
JIRA_API_TOKEN = os.environ.get("JIRA_API_TOKEN", "")

# Epics: one per robot. The placeholder default below deliberately doesn't
# work as-is -- your real project/field/site names are org-internal
# structure, so they're configured the same way as the API token: set via
# JIRA_EPIC_JQL in your environment or ~/.config/decal-scanner/env, never
# committed to this (potentially public) repo.
JIRA_EPIC_JQL = os.environ.get(
    "JIRA_EPIC_JQL",
    'project = YOUR_PROJECT AND type = Epic AND "your rover-location field[dropdown]" IN '
    '(YOUR_SITE_A, YOUR_SITE_B)',
)

# Child tickets: fetched in batches of `parent IN (...)` scoped to the epic
# keys found above, restricted to open (non-Done) tickets of the types that
# drive cone color. Same deal -- set the real project key(s) via env.
JIRA_CHILD_PROJECTS = os.environ.get("JIRA_CHILD_PROJECTS", "YOUR_PROJECT")
JIRA_CHILD_TYPES = os.environ.get(
    "JIRA_CHILD_TYPES",
    "Robot Calibration,Oncall - Tier 1,Tech Support Service Request,Task",
)
JIRA_EPIC_CHUNK_SIZE = int(os.environ.get("JIRA_EPIC_CHUNK_SIZE", "150"))

REPO_DIR = Path(os.environ.get("REPO_DIR", Path(__file__).parent.parent)).resolve()
ROBOTS_JSON_PATH = Path(os.environ.get("ROBOTS_JSON_PATH", REPO_DIR / "robots.json"))
GIT_PUSH = os.environ.get("GIT_PUSH", "true").lower() not in ("0", "false", "no")

# Cone priority: purple > red > green. See cone_for_tickets() below.
PURPLE_TYPES = {"Robot Calibration", "Oncall - Tier 1", "Tech Support Service Request"}
RED_TYPES = {"Task"}

PURPLE_ACTION = "Connect to power and ethernet. Ensure offload begins."
RED_ACTION = "Drop off in Fleet Management room."
GREEN_ACTION = "Connect to power and ethernet."


def jql_quote_list(items: Iterable[str]) -> str:
    return ", ".join(f'"{item}"' if any(c in item for c in " -") else item for item in items)


# ---------------------------------------------------------------------------
# Jira API
# ---------------------------------------------------------------------------


def jira_session() -> requests.Session:
    if not (JIRA_BASE_URL and JIRA_EMAIL and JIRA_API_TOKEN):
        log.error("JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN must all be set")
        sys.exit(1)
    session = requests.Session()
    session.auth = (JIRA_EMAIL, JIRA_API_TOKEN)
    session.headers.update({"Accept": "application/json", "Content-Type": "application/json"})
    return session


def jira_search(session: requests.Session, jql: str, fields: list[str]) -> list[dict[str, Any]]:
    """Runs a JQL search against the Jira Cloud enhanced search endpoint,
    paging through nextPageToken until exhausted."""
    url = f"{JIRA_BASE_URL}/rest/api/3/search/jql"
    issues: list[dict[str, Any]] = []
    next_token: str | None = None

    while True:
        body: dict[str, Any] = {"jql": jql, "maxResults": 100, "fields": fields}
        if next_token:
            body["nextPageToken"] = next_token
        resp = session.post(url, json=body, timeout=30)
        if not resp.ok:
            log.error("Jira search failed (%s): %s", resp.status_code, resp.text[:500])
            resp.raise_for_status()
        data = resp.json()
        issues.extend(data.get("issues", []))
        next_token = data.get("nextPageToken")
        if data.get("isLast", next_token is None) or not next_token:
            break

    return issues


def chunked(items: list[str], size: int) -> Iterable[list[str]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


# ---------------------------------------------------------------------------
# fetch + transform
# ---------------------------------------------------------------------------


def fetch_epics(session: requests.Session) -> dict[str, dict[str, Any]]:
    log.info("Fetching robot epics...")
    issues = jira_search(session, JIRA_EPIC_JQL, ["summary", "status"])
    epics = {}
    for issue in issues:
        key = issue["key"]
        fields = issue["fields"]
        epics[key] = {
            "epic_key": key,
            "name": fields.get("summary", key).strip(),
            "epic_status": (fields.get("status") or {}).get("name", "Unknown"),
            "tickets": [],
        }
    log.info("Found %d robot epics", len(epics))
    return epics


def fetch_child_tickets(session: requests.Session, epic_keys: list[str]) -> dict[str, list[dict[str, Any]]]:
    log.info("Fetching child tickets for %d epics...", len(epic_keys))
    projects = jql_quote_list(p.strip() for p in JIRA_CHILD_PROJECTS.split(","))
    types = jql_quote_list(t.strip() for t in JIRA_CHILD_TYPES.split(","))

    by_epic: dict[str, list[dict[str, Any]]] = {key: [] for key in epic_keys}
    for batch in chunked(epic_keys, JIRA_EPIC_CHUNK_SIZE):
        parents = jql_quote_list(batch)
        jql = (
            f"project IN ({projects}) AND parent IN ({parents}) "
            f"AND type IN ({types}) AND statusCategory != Done"
        )
        # Deliberately not fetching "summary": it's free text written by
        # staff and could contain anything, the UI never displays it, and
        # robots.json is world-readable once this repo (or its Pages site)
        # is public. Same reasoning for not building a Jira browse URL here,
        # which would otherwise bake the org's Jira domain into a public file.
        issues = jira_search(session, jql, ["status", "issuetype", "parent"])
        for issue in issues:
            fields = issue["fields"]
            parent_key = (fields.get("parent") or {}).get("key")
            if parent_key not in by_epic:
                continue
            by_epic[parent_key].append(
                {
                    "key": issue["key"],
                    "type": fields["issuetype"]["name"],
                    "status": fields["status"]["name"],
                }
            )
    total = sum(len(v) for v in by_epic.values())
    log.info("Found %d open child tickets", total)
    return by_epic


def cone_for_tickets(tickets: list[dict[str, Any]]) -> tuple[str, str, list[str]]:
    types_present = {t["type"] for t in tickets}

    purple_hits = types_present & PURPLE_TYPES
    if purple_hits:
        reasons = [f"Open {t['type']}: {t['key']}" for t in tickets if t["type"] in PURPLE_TYPES]
        return "purple", PURPLE_ACTION, reasons

    red_hits = types_present & RED_TYPES
    if red_hits:
        reasons = [f"Open {t['type']}: {t['key']}" for t in tickets if t["type"] in RED_TYPES]
        return "red", RED_ACTION, reasons

    return "green", GREEN_ACTION, []


def build_robots_json(epics: dict[str, dict[str, Any]], tickets_by_epic: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    robots = {}
    for key, epic in epics.items():
        tickets = tickets_by_epic.get(key, [])
        cone, action, reasons = cone_for_tickets(tickets)
        norm_name = normalize(epic["name"])
        robots[norm_name] = {
            "name": epic["name"],
            "epic_key": epic["epic_key"],
            "epic_status": epic["epic_status"],
            "cone": cone,
            "action": action,
            "reasons": reasons,
            "tickets": tickets,
        }
    return {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "jira",
        "robots": robots,
    }


def normalize(name: str) -> str:
    return "".join(ch for ch in name.upper() if ch.isalnum())


# ---------------------------------------------------------------------------
# git
# ---------------------------------------------------------------------------


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(REPO_DIR), *args], capture_output=True, text=True)


def commit_and_push(robot_count: int, ticket_count: int) -> None:
    status = git("status", "--porcelain", "--", str(ROBOTS_JSON_PATH.relative_to(REPO_DIR)))
    if not status.stdout.strip():
        log.info("robots.json unchanged, nothing to commit")
        return

    git("add", str(ROBOTS_JSON_PATH.relative_to(REPO_DIR)))
    message = f"Sync robots.json from Jira ({robot_count} robots, {ticket_count} open tickets)"
    result = git("commit", "-m", message)
    if result.returncode != 0:
        log.error("git commit failed: %s", result.stderr)
        sys.exit(1)
    log.info("Committed: %s", message)

    if not GIT_PUSH:
        log.info("GIT_PUSH disabled, skipping push")
        return

    result = git("push")
    if result.returncode != 0:
        log.error("git push failed: %s", result.stderr)
        sys.exit(1)
    log.info("Pushed to remote")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> None:
    session = jira_session()
    epics = fetch_epics(session)
    tickets_by_epic = fetch_child_tickets(session, list(epics.keys()))
    payload = build_robots_json(epics, tickets_by_epic)

    ROBOTS_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    ROBOTS_JSON_PATH.write_text(json.dumps(payload, indent=2) + "\n")
    log.info("Wrote %s", ROBOTS_JSON_PATH)

    ticket_count = sum(len(v) for v in tickets_by_epic.values())
    commit_and_push(len(epics), ticket_count)


if __name__ == "__main__":
    main()
