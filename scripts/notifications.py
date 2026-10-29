#!/usr/bin/env python3
"""Local Discord settings and a durable, bounded background delivery queue.

The webhook is read from a user-owned config file, never stored with session
data or passed on a process command line. No network requests run in the CLI's
state lock. Discord confirms acceptance with wait=true.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


DEFAULT_CONFIG = Path.home() / "Library" / "Application Support" / "LUMA" / "notifications.json"
NETWORK_TIMEOUT = 8
# A rate-limited final completion must retry without another CLI invocation.
# The detached sender sleeps until Retry-After while retaining its sender lock;
# actual network attempts remain capped separately, so this is not a poll loop.
WORKER_BUDGET = 6 * 60 * 60
MAX_ATTEMPTS = 5
MAX_PENDING = 500
STATUS_LABELS = {"error": "問題あり", "waiting": "操作待ち", "done": "作業完了"}
STATUS_ICONS = {"error": "🔴", "waiting": "🟡", "done": "🟢"}
MAX_CONTENT_UNITS = 1900


def config_path() -> Path:
    return Path(os.environ.get("LUMA_CONFIG_PATH", str(DEFAULT_CONFIG))).expanduser()


def load_config() -> dict | None:
    try:
        config = json.loads(config_path().read_text(encoding="utf-8"))
        if not isinstance(config, dict) or config.get("enabled") is not True:
            return None
        webhook = config.get("discordWebhook", "")
        if not isinstance(webhook, str):
            return None
        url = urlsplit(webhook)
        # Do not follow redirects or accept another origin containing a token.
        if url.scheme != "https" or url.netloc != "discord.com" or not re.fullmatch(r"/api(?:/v\d+)?/webhooks/\d+/[A-Za-z0-9_-]+", url.path):
            return None
        if url.query or url.fragment:
            return None
        return {"url": urlunsplit((url.scheme, url.netloc, url.path, "wait=true", "")),
                "notifyErrors": config.get("notifyErrors", True) is True,
                "notifyWaiting": config.get("notifyWaiting", True) is True,
                "notifyCompletion": config.get("notifyCompletion", True) is True}
    except (OSError, ValueError, TypeError):
        return None


def queue_path(state_path: Path) -> Path:
    return state_path.with_name(state_path.name + ".notifications.json")


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def locked_queue(state_path: Path):
    path = queue_path(state_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(path.suffix + ".lock").open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            if path.exists():
                data = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(data, dict) or not isinstance(data.get("pending"), list):
                    raise ValueError("invalid notification queue")
            else:
                data = {"pending": [], "lastDelivery": None, "lastError": None}
            yield data
            atomic_json(path, data)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def sources(session: dict | None) -> dict:
    if not session:
        return {}
    result = {"session": (session["status"], session["title"], session["message"])}
    for agent in session.get("agents", []):
        result["agent:" + agent["id"]] = (agent["status"], agent["name"], agent["message"] or agent["task"])
    for task in session.get("tasks", []):
        result["task:" + task["id"]] = (task["status"], task["title"], task["message"])
    return result


def public_text(text: str, limit: int = 500) -> str:
    # Avoid posting local absolute paths or accidentally copied webhook tokens.
    text = re.sub(r"https://(?:canary\.|ptb\.)?discord(?:app)?\.com/api/[^\s]+", "[Webhook]", text)
    text = re.sub(r"(?<!\w)(?:/[A-Za-z0-9_.~\-]+){2,}", "[ローカルパス]", text)
    text = re.sub(r"[A-Za-z]:\\[^\s]+", "[ローカルパス]", text)
    return text[:limit]


def text_units(text: str) -> int:
    """Count UTF-16 units conservatively for supplementary characters."""
    return sum(2 if ord(character) > 0xFFFF else 1 for character in text)


def markdown_text(text: str, limit: int, *, multiline: bool = False) -> str:
    """Render user text literally without cutting an escape or Unicode scalar.

    Labels stay on one line. Reports preserve line breaks as continuations of
    their bullet field, so a copied heading/list cannot change the layout.
    """
    text = public_text(text, len(text)).replace("\r\n", "\n").replace("\r", "\n")
    if not multiline:
        text = " ".join(text.split())
    tokens = []
    used = 0
    for character in text:
        if character == "\n":
            token = "\n  "
        elif character in "\\`*_{}[]()<>#+-.!|~":
            token = "\\" + character
        else:
            token = character
        units = text_units(token)
        # Reserve one unit for an ellipsis when more user text is omitted.
        if used + units > max(0, limit - 1):
            return "".join(tokens) + ("…" if limit else "")
        tokens.append(token)
        used += units
    return "".join(tokens)


def notice_content(session: dict, status: str, changed: list[tuple]) -> str:
    title = markdown_text(session["title"], 240)
    lines = [f"# {STATUS_ICONS[status]} {STATUS_LABELS[status]}", f"**{title}**", ""]
    project = session.get("project", "").replace("\\", "/").rstrip("/").split("/")[-1]
    if project:
        lines.append("- **プロジェクト**: " + markdown_text(project, 160))
    names = [name for source_id, name, message in changed if source_id != "session"]
    if names:
        lines.append("- **対象**: " + markdown_text("、".join(names), 300))
    messages = list(dict.fromkeys(message for source_id, name, message in changed if message))
    if messages:
        prefix = "- **報告**: "
        remaining = MAX_CONTENT_UNITS - text_units("\n".join(lines) + "\n" + prefix)
        lines.append(prefix + markdown_text("\n".join(messages), remaining, multiline=True))
    return "\n".join(lines).rstrip()


def transition_notices(before: dict | None, after: dict, config: dict) -> list[dict]:
    previous = sources(before)
    result = []
    groups = {}
    event_id = after["events"][-1]["id"] if after.get("events") else after["updatedAt"]
    for source_id, (status, name, message) in sources(after).items():
        old_status = previous.get(source_id, (None, "", ""))[0]
        if status == old_status:
            continue
        enabled = ((status == "error" and config["notifyErrors"]) or
                   (status == "waiting" and config["notifyWaiting"]) or
                   (source_id == "session" and status == "done" and config["notifyCompletion"]))
        if not enabled:
            continue
        groups.setdefault(status, []).append((source_id, name, message))
    # A session and its current task often change together. Report that incident
    # once, retaining all newly affected source names in the same message.
    for status, changed in groups.items():
        source_ids = ",".join(source_id for source_id, name, message in changed)
        notice_id = hashlib.sha256((after["id"] + ":" + event_id + ":" + source_ids + ":" + status).encode()).hexdigest()
        result.append({"id": notice_id, "payload": {"content": notice_content(after, status, changed),
                       "allowed_mentions": {"parse": []}}, "attempts": 0, "nextAttemptAt": 0})
    return result


def queue_transitions(state_path: Path, before: dict | None, after: dict) -> None:
    config = load_config()
    if not config:
        return
    notices = transition_notices(before, after, config)
    if not notices:
        return
    with locked_queue(state_path) as data:
        ids = {item["id"] for item in data["pending"]}
        for notice in notices:
            if notice["id"] not in ids:
                if len(data["pending"]) >= MAX_PENDING:
                    raise ValueError("notification queue is full")
                data["pending"].append(notice)
                ids.add(notice["id"])


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def send_payload(url: str, payload: dict) -> tuple[bool, float, str]:
    request = Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                      headers={"Content-Type": "application/json", "User-Agent": "LUMA/1.0"}, method="POST")
    try:
        with build_opener(NoRedirect()).open(request, timeout=NETWORK_TIMEOUT) as response:
            if 200 <= response.status < 300:
                return True, 0, ""
            return False, 0, "Discord rejected the notification"
    except HTTPError as error:
        if error.code == 429:
            retry = 5.0
            try:
                body = json.loads(error.read(4096))
                suggested = float(body.get("retry_after", retry))
                if math.isfinite(suggested):
                    retry = max(0.5, suggested)
            except (ValueError, TypeError, OSError):
                pass
            return False, retry, "Discord rate limit; notification queued"
        if 500 <= error.code < 600:
            return False, 3.0, "Discord temporarily unavailable; notification queued"
        return False, -1, "Discord rejected the notification; check local settings"
    except (URLError, OSError, ValueError, TimeoutError):
        return False, 3.0, "Discord connection failed; notification queued"


def launch_worker(state_path: Path) -> None:
    if not load_config() or not queue_path(state_path).exists():
        return
    # Ownership checks and the incumbent's empty-queue exit use this same
    # queue lock. A notice cannot arrive in the gap between its final check
    # and relinquishing sender ownership.
    with locked_queue(state_path) as data:
        if not any(item.get("attempts", 0) < MAX_ATTEMPTS for item in data["pending"]):
            return
        worker_path = queue_path(state_path).with_suffix(".worker.lock")
        with worker_path.open("a") as worker_lock:
            try:
                fcntl.flock(worker_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            # Release before starting the child. Concurrent launchers may start
            # another child during interpreter startup, but the worker lock
            # permits only one to send and the others immediately exit.
            fcntl.flock(worker_lock.fileno(), fcntl.LOCK_UN)
            subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--state", str(state_path)],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             close_fds=True, start_new_session=True)


def run_worker(state_path: Path, budget: float = WORKER_BUDGET) -> None:
    """One sender per state file, with up to five attempts over six hours.

    Backoff is durable across restarts. Keep the sender alive through normal
    Discord Retry-After intervals, including when the completion was the CLI's
    final update. No further activity is needed to trigger these retries.
    """
    config = load_config()
    if not config or not queue_path(state_path).exists():
        return
    worker_path = queue_path(state_path).with_suffix(".worker.lock")
    with worker_path.open("a") as worker_lock:
        try:
            fcntl.flock(worker_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        deadline = time.monotonic() + budget
        while time.monotonic() < deadline:
            config = load_config()
            if not config:
                return
            with locked_queue(state_path) as data:
                candidates = [item for item in data["pending"] if item["attempts"] < MAX_ATTEMPTS]
                if not candidates:
                    fcntl.flock(worker_lock.fileno(), fcntl.LOCK_UN)
                    return
                item = min(candidates, key=lambda value: value["nextAttemptAt"])
                item = dict(item)
                not_before = max(item["nextAttemptAt"], data.get("nextSendAt", 0))
            delay = max(0, not_before - time.time())
            if delay:
                if time.monotonic() + delay >= deadline:
                    with locked_queue(state_path) as data:
                        latest = [value for value in data["pending"] if value["attempts"] < MAX_ATTEMPTS]
                        # A newly queued immediate incident may have arrived
                        # after selecting an older, deferred item. Recheck it
                        # before relinquishing ownership.
                        earliest = min((max(value["nextAttemptAt"], data.get("nextSendAt", 0)) for value in latest), default=not_before)
                        if earliest < not_before and time.monotonic() + max(0, earliest - time.time()) < deadline:
                            continue
                        fcntl.flock(worker_lock.fileno(), fcntl.LOCK_UN)
                    return
                time.sleep(delay)
                continue
            success, retry, failure = send_payload(config["url"], item["payload"])
            with locked_queue(state_path) as data:
                current = next((value for value in data["pending"] if value["id"] == item["id"]), None)
                if current is None:
                    continue
                if success:
                    data["pending"].remove(current)
                    data["lastDelivery"] = time.time()
                    data["lastError"] = None
                    data["nextSendAt"] = 0
                else:
                    current["attempts"] += 1
                    if retry < 0:
                        current["attempts"] = MAX_ATTEMPTS
                    current["nextAttemptAt"] = time.time() + max(1, retry, 2 ** current["attempts"])
                    if retry > 0:
                        # Discord's webhook bucket is shared by all queued items.
                        data["nextSendAt"] = max(data.get("nextSendAt", 0), time.time() + retry)
                    data["lastError"] = failure
        # A worker reaching its lifetime limit may have received new work while
        # it was sending its last item. Release ownership atomically with the
        # queue check, and hand off unattempted work to a replacement sender.
        with locked_queue(state_path) as data:
            new_work = any(item["attempts"] == 0 for item in data["pending"])
            fcntl.flock(worker_lock.fileno(), fcntl.LOCK_UN)
        if new_work and budget == WORKER_BUDGET:
            launch_worker(state_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--retry", action="store_true", help="retry retained failed notifications")
    args = parser.parse_args()
    try:
        if args.retry and queue_path(args.state).exists():
            with locked_queue(args.state) as data:
                for item in data["pending"]:
                    item["attempts"] = 0
                    item["nextAttemptAt"] = 0
        run_worker(args.state)
    except (OSError, ValueError, KeyError, TypeError):
        print("LUMA notification queue could not be processed; check local settings", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
