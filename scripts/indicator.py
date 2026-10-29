#!/usr/bin/env python3
"""Local, explicitly invoked status transport for the LUMA desktop indicator.

The JSON file is the interface between this CLI and the native viewer. Writers
lock a separate stable file and replace the state atomically, so the viewer can
always read a complete snapshot without taking a lock.
"""

from __future__ import annotations

import argparse
import copy
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid


ROOT = Path(__file__).resolve().parents[1]
STATUSES = ("idle", "running", "waiting", "error", "done")
ACTIVE_STATUSES = {"running", "waiting", "error"}
TASK_STATUSES = ("pending", "running", "waiting", "error", "done", "skipped")
MAX_EVENTS = 100
MAX_SESSIONS = 30
ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")


class IndicatorError(Exception):
    """An actionable CLI or persisted-state error."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def state_path() -> Path:
    override = os.environ.get("LUMA_STATE_PATH")
    if override is not None and not override.strip():
        raise IndicatorError("LUMA_STATE_PATH must be a non-empty file path")
    return Path(override).expanduser().resolve() if override else ROOT / ".runtime" / "state.json"


def validate_text(value: object, label: str, limit: int, *, allow_empty: bool = True) -> str:
    if not isinstance(value, str):
        raise IndicatorError(f"{label} must be text")
    if len(value) > limit:
        raise IndicatorError(f"{label} must be at most {limit} characters")
    if not allow_empty and not value.strip():
        raise IndicatorError(f"{label} must not be empty")
    if any(ord(char) < 32 and char not in "\n\t" for char in value):
        raise IndicatorError(f"{label} contains an unsupported control character")
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise IndicatorError(f"{label} contains invalid Unicode text")
    return value


def validate_id(value: object, label: str = "id") -> str:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise IndicatorError(f"{label} must be 1–128 ASCII letters, digits, '.', '_', ':' or '-', starting with a letter or digit")
    return value


def validate_time(value: object, label: str) -> None:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise IndicatorError(f"{label} must be an ISO 8601 UTC timestamp ending in Z")
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise IndicatorError(f"{label} is not a valid timestamp") from error


def validate_status(value: object, label: str = "status") -> None:
    if value not in STATUSES:
        raise IndicatorError(f"{label} must be one of: {', '.join(STATUSES)}")


def require_keys(value: object, keys: set[str], label: str) -> None:
    if not isinstance(value, dict) or set(value) != keys:
        raise IndicatorError(f"{label} must have exactly these fields: {', '.join(sorted(keys))}")


def validate_state(state: object) -> None:
    require_keys(state, {"schemaVersion", "updatedAt", "sessions"}, "state")
    if type(state["schemaVersion"]) is not int or state["schemaVersion"] != 1:
        raise IndicatorError("unsupported state schemaVersion; expected 1")
    validate_time(state["updatedAt"], "state.updatedAt")
    if not isinstance(state["sessions"], list):
        raise IndicatorError("state.sessions must be a list")
    session_ids = set()
    for session in state["sessions"]:
        session_keys = {"id", "title", "project", "status", "message", "startedAt", "updatedAt", "agents", "events"}
        if isinstance(session, dict) and "tasks" in session:
            session_keys.add("tasks")
        require_keys(session, session_keys, "session")
        session_id = validate_id(session["id"], "session.id")
        if session_id in session_ids:
            raise IndicatorError(f"duplicate session id: {session_id}")
        session_ids.add(session_id)
        validate_text(session["title"], "session.title", 240, allow_empty=False)
        validate_text(session["project"], "session.project", 4096)
        validate_text(session["message"], "session.message", 4000)
        validate_status(session["status"], "session.status")
        validate_time(session["startedAt"], "session.startedAt")
        validate_time(session["updatedAt"], "session.updatedAt")
        if not isinstance(session["agents"], list) or not isinstance(session["events"], list):
            raise IndicatorError("session.agents and session.events must be lists")
        agent_ids = set()
        for agent in session["agents"]:
            require_keys(agent, {"id", "name", "task", "status", "message", "updatedAt"}, "agent")
            agent_id = validate_id(agent["id"], "agent.id")
            if agent_id in agent_ids:
                raise IndicatorError(f"duplicate agent id in session {session_id}: {agent_id}")
            agent_ids.add(agent_id)
            validate_text(agent["name"], "agent.name", 120, allow_empty=False)
            validate_text(agent["task"], "agent.task", 2000)
            validate_text(agent["message"], "agent.message", 4000)
            validate_status(agent["status"], "agent.status")
            validate_time(agent["updatedAt"], "agent.updatedAt")
            if session["status"] == "done" and agent["status"] in ACTIVE_STATUSES:
                raise IndicatorError(f"completed session {session_id} contains an active agent: {agent_id}")
        validate_tasks(session, agent_ids)
        event_ids = set()
        for event in session["events"]:
            require_keys(event, {"id", "at", "status", "message", "agentId"}, "event")
            event_id = validate_id(event["id"], "event.id")
            if event_id in event_ids:
                raise IndicatorError(f"duplicate event id in session {session_id}: {event_id}")
            event_ids.add(event_id)
            validate_time(event["at"], "event.at")
            validate_status(event["status"], "event.status")
            validate_text(event["message"], "event.message", 4000)
            if event["agentId"] is not None:
                validate_id(event["agentId"], "event.agentId")
                if event["agentId"] not in agent_ids:
                    raise IndicatorError("event.agentId must refer to an agent in its session or be null")


def validate_tasks(session: dict, agent_ids: set[str]) -> None:
    tasks = session.get("tasks", [])
    if not isinstance(tasks, list) or len(tasks) > 200:
        raise IndicatorError("session.tasks must be a list of at most 200 tasks")
    ids = set()
    for task in tasks:
        require_keys(task, {"id", "title", "status", "parentId", "dependsOn", "agentId", "message", "updatedAt"}, "task")
        task_id = validate_id(task["id"], "task.id")
        if task_id in ids:
            raise IndicatorError(f"duplicate task id: {task_id}")
        ids.add(task_id)
        validate_text(task["title"], "task.title", 160, allow_empty=False)
        validate_text(task["message"], "task.message", 4000)
        validate_time(task["updatedAt"], "task.updatedAt")
        if task["status"] not in TASK_STATUSES:
            raise IndicatorError(f"task.status must be one of: {', '.join(TASK_STATUSES)}")
        for field in ("parentId", "agentId"):
            if task[field] is not None:
                validate_id(task[field], "task." + field)
        if task["agentId"] is not None and task["agentId"] not in agent_ids:
            raise IndicatorError("task.agentId must refer to an agent in its session")
        deps = task["dependsOn"]
        if not isinstance(deps, list) or any(not isinstance(dep, str) for dep in deps):
            raise IndicatorError("task.dependsOn must be a list of task IDs")
        if len(set(deps)) != len(deps):
            raise IndicatorError("task.dependsOn must not contain duplicates")
        for dep in deps:
            validate_id(dep, "task.dependsOn")
        if session["status"] == "done" and task["status"] not in {"done", "skipped"}:
            raise IndicatorError(f"completed session contains unfinished task: {task_id}")
    for task in tasks:
        refs = ([task["parentId"]] if task["parentId"] is not None else []) + task["dependsOn"]
        if any(ref not in ids for ref in refs):
            raise IndicatorError(f"task {task['id']} refers to an unknown task")
    # Hierarchy and dependency edges are separate relations. Each must be acyclic.
    for field in ("parentId", "dependsOn"):
        links = {task["id"]: ([task[field]] if task[field] is not None else []) if field == "parentId" else task[field] for task in tasks}
        visiting, visited = set(), set()
        def visit(task_id):
            if task_id in visiting:
                raise IndicatorError(f"task {field} contains a cycle")
            if task_id in visited:
                return
            visiting.add(task_id)
            for ref in links[task_id]:
                visit(ref)
            visiting.remove(task_id)
            visited.add(task_id)
        for task_id in links:
            visit(task_id)


def task_patches(value: str) -> list[dict]:
    try:
        result = json.loads(value, object_pairs_hook=unique_object)
        if not isinstance(result, list) or len(result) > 200:
            raise IndicatorError("tasks must be an array of at most 200 objects")
        allowed = {"id", "title", "status", "parentId", "dependsOn", "agentId", "message"}
        ids = set()
        for item in result:
            if not isinstance(item, dict) or "id" not in item or not set(item) <= allowed:
                raise IndicatorError("each task patch needs id and supported task fields")
            task_id = validate_id(item["id"], "task.id")
            if task_id in ids:
                raise IndicatorError(f"duplicate task patch id: {task_id}")
            ids.add(task_id)
        return result
    except (ValueError, TypeError, RecursionError, IndicatorError) as error:
        raise argparse.ArgumentTypeError(f"invalid tasks: {error}") from error


def apply_tasks(session: dict, patches: list[dict] | None, now: str) -> None:
    if patches is None:
        return
    tasks = session.setdefault("tasks", [])
    for patch in patches:
        task = next((item for item in tasks if item["id"] == patch["id"]), None)
        if task is None:
            if "title" not in patch:
                raise IndicatorError(f"new task {patch['id']} needs a title")
            task = {"id": patch["id"], "title": patch["title"], "status": "pending", "parentId": None,
                    "dependsOn": [], "agentId": None, "message": "", "updatedAt": now}
            tasks.append(task)
        task.update(patch)
        task["updatedAt"] = now


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise IndicatorError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def read_state(path: Path) -> dict:
    if not path.exists():
        return {"schemaVersion": 1, "updatedAt": utc_now(), "sessions": []}
    try:
        with path.open("r", encoding="utf-8") as handle:
            state = json.load(handle, object_pairs_hook=unique_object)
        validate_state(state)
        return state
    except (ValueError, UnicodeError, RecursionError, IndicatorError) as error:
        raise IndicatorError(f"state file is invalid and has been left unchanged: {path}: {error}") from error


@contextmanager
def locked_state(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(path.name + ".lock")
    with lock_path.open("a", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield read_state(path)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def write_state(path: Path, state: dict) -> None:
    validate_state(state)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def find_session(state: dict, session_id: str) -> dict:
    for session in state["sessions"]:
        if session["id"] == session_id:
            return session
    raise IndicatorError(f"session not found: {session_id}; use start to create one")


def append_event(session: dict, at: str, status: str, message: str, agent_id: str | None = None) -> None:
    session["events"].append({"id": uuid.uuid4().hex, "at": at, "status": status, "message": message, "agentId": agent_id})
    session["events"] = session["events"][-MAX_EVENTS:]


def prune_sessions(state: dict) -> None:
    """Keep recent history, retaining every session which may need attention."""
    excess = len(state["sessions"]) - MAX_SESSIONS
    if excess <= 0:
        return
    inactive = sorted(
        (session for session in state["sessions"]
         if session["status"] not in ACTIVE_STATUSES
         and not any(agent["status"] in ACTIVE_STATUSES for agent in session["agents"])
         and not any(task["status"] not in {"done", "skipped"} for task in session.get("tasks", []))),
        key=lambda session: session["updatedAt"],
    )
    removable = {session["id"] for session in inactive[:excess]}
    state["sessions"] = [session for session in state["sessions"] if session["id"] not in removable]


def open_app(path: Path) -> None:
    launcher = ROOT / "scripts" / "run.sh"
    if not launcher.is_file():
        raise IndicatorError(f"application launcher was not found: {launcher}")
    # Bash reads only the fixed launcher path. Status text remains JSON data.
    try:
        result = subprocess.run(
            ["/bin/bash", str(launcher)], cwd=ROOT,
            env=dict(os.environ, LUMA_STATE_PATH=str(path)),
            stdout=sys.stderr, stderr=sys.stderr, check=False,
        )
    except OSError as error:
        raise IndicatorError(f"could not launch application: {error}; session state remains saved") from error
    if result.returncode:
        raise IndicatorError(f"application launcher exited with code {result.returncode}; session state remains saved")


def cli_text(label: str, limit: int):
    def parse(value: str) -> str:
        try:
            return validate_text(value, label, limit, allow_empty=False)
        except IndicatorError as error:
            raise argparse.ArgumentTypeError(str(error)) from error
    return parse


def cli_id(value: str) -> str:
    try:
        return validate_id(value)
    except IndicatorError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)

    start = commands.add_parser("start", help="create a running session and open the indicator")
    start.add_argument("--session", type=cli_id, help="unique session id (generated if omitted)")
    start.add_argument("--title", required=True, type=cli_text("title", 240))
    start.add_argument("--project", type=cli_text("project", 4096), default=str(Path.cwd()))
    start.add_argument("--message", type=cli_text("message", 4000), default="Session started")
    start.add_argument("--no-open", action="store_true", help="write state without opening the app")
    start.add_argument("--tasks", type=task_patches, help="initial task array as JSON")

    update = commands.add_parser("update", help="set the session's current status and message")
    update.add_argument("--session", required=True, type=cli_id)
    update.add_argument("--status", required=True, choices=STATUSES)
    update.add_argument("--message", required=True, type=cli_text("message", 4000))
    update.add_argument("--tasks", type=task_patches, help="task create/update patches as JSON")
    update.add_argument("--task", type=cli_id, help="task to update together with this report")
    update.add_argument("--task-status", choices=TASK_STATUSES, help="task status (defaults to session status)")
    update.add_argument("--done-task", action="append", type=cli_id, default=[], help="mark a task done; repeatable")

    agent = commands.add_parser("agent", help="create or update an agent within a session")
    agent.add_argument("--session", required=True, type=cli_id)
    agent.add_argument("--id", required=True, type=cli_id)
    agent.add_argument("--name", type=cli_text("name", 120))
    agent.add_argument("--task", type=cli_text("task", 2000))
    agent.add_argument("--status", required=True, choices=STATUSES)
    agent.add_argument("--message", type=cli_text("message", 4000))

    show = commands.add_parser("show", help="print the complete state or one session as JSON")
    show.add_argument("--session", type=cli_id)
    commands.add_parser("open", help="open or raise the native indicator window")
    return result


def execute(args: argparse.Namespace) -> dict:
    path = state_path()
    if args.command == "open":
        open_app(path)
        return {"ok": True, "opened": True, "statePath": str(path)}

    with locked_state(path) as state:
        if args.command == "show":
            return find_session(state, args.session) if args.session else state

        now = utc_now()
        before = None
        if args.command == "start":
            session_id = args.session or uuid.uuid4().hex
            if any(session["id"] == session_id for session in state["sessions"]):
                raise IndicatorError(f"session already exists: {session_id}; use update or choose a new --session")
            session = {"id": session_id, "title": args.title, "project": args.project, "status": "running", "message": args.message, "startedAt": now, "updatedAt": now, "agents": [], "events": [], "tasks": []}
            apply_tasks(session, args.tasks, now)
            validate_tasks(session, set())
            append_event(session, now, "running", args.message)
            state["sessions"].append(session)
        else:
            session = find_session(state, args.session)
            before = copy.deepcopy(session)
            session_id = session["id"]
            if args.command == "update":
                if args.task_status is not None and args.task is None:
                    raise IndicatorError("--task-status requires --task")
                patches = list(args.tasks or [])
                patches.extend({"id": task_id, "status": "done"} for task_id in args.done_task)
                if args.task is not None:
                    task_status = args.task_status or args.status
                    if task_status not in TASK_STATUSES:
                        raise IndicatorError("specify --task-status when session status is idle")
                    patches.append({"id": args.task, "status": task_status, "message": args.message})
                apply_tasks(session, patches if patches else None, now)
                validate_tasks(dict(session, status="running"), {agent["id"] for agent in session["agents"]})
                blocking = [agent for agent in session["agents"] if agent["status"] in ACTIVE_STATUSES]
                if args.status == "done" and blocking:
                    details = ", ".join(f"{agent['id']} ({agent['status']})" for agent in blocking)
                    raise IndicatorError(f"cannot complete session while agents need attention: {details}; update those agents to done or idle first")
                unfinished = [task["id"] for task in session.get("tasks", []) if task["status"] not in {"done", "skipped"}]
                if args.status == "done" and unfinished:
                    raise IndicatorError(f"cannot complete session with unfinished tasks: {', '.join(unfinished)}")
                session["status"] = args.status
                session["message"] = args.message
                append_event(session, now, args.status, args.message)
            elif args.command == "agent":
                if session["status"] == "done" and args.status in ACTIVE_STATUSES:
                    raise IndicatorError("cannot activate an agent in a completed session; update the session to running first")
                agent = next((item for item in session["agents"] if item["id"] == args.id), None)
                if agent is None:
                    agent = {"id": args.id, "name": args.name or args.id, "task": args.task or "", "status": args.status, "message": "", "updatedAt": now}
                    session["agents"].append(agent)
                for field in ("name", "task", "message"):
                    value = getattr(args, field)
                    if value is not None:
                        agent[field] = value
                agent["status"] = args.status
                agent["updatedAt"] = now
                event_message = args.message if args.message is not None else f"{agent['name']}: {args.status}"
                append_event(session, now, args.status, event_message, args.id)
            session["updatedAt"] = now

        state["updatedAt"] = now
        prune_sessions(state)
        write_state(path, state)
        response = {"ok": True, "session": session_id, "status": session["status"], "statePath": str(path)}
        # Queue under the writer lock to preserve transition ordering; network I/O
        # runs only in a detached worker after releasing this lock.
        try:
            from notifications import queue_transitions
            queue_transitions(path, before, session)
        except Exception:
            response["notificationWarning"] = "Notification could not be queued; progress was saved"
        if args.command == "agent":
            response.update({"agent": args.id, "agentStatus": args.status})

    try:
        from notifications import launch_worker
        launch_worker(path)
    except Exception:
        response["notificationWarning"] = "Notification delivery could not start; progress was saved"
    # Do not hold the state lock while the app compiles or launches.
    if args.command == "start" and not args.no_open:
        try:
            open_app(path)
        except IndicatorError as error:
            response["opened"] = False
            response["warning"] = str(error)
            print(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
            raise
        response["opened"] = True
    return response


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        response = execute(args)
    except (IndicatorError, OSError) as error:
        print(f"indicator: {error}", file=sys.stderr)
        return 1
    print(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
