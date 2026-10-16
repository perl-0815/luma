"""Exercise the public CLI, including independent concurrent writer processes."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CLI = Path(__file__).resolve().parents[1] / "scripts" / "indicator.py"


class IndicatorCLITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="luma-cli-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.state = self.directory / "nested" / "state.json"
        self.environment = dict(os.environ, LUMA_STATE_PATH=str(self.state), PYTHONDONTWRITEBYTECODE="1")

    def run_cli(self, *arguments, expected=0):
        result = subprocess.run([sys.executable, str(CLI), *arguments], env=self.environment, cwd=self.directory, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, expected, msg=f"{' '.join(arguments)}\nstdout: {result.stdout}\nstderr: {result.stderr}")
        return result

    def start(self, session="build", **kwargs):
        arguments = ["start", "--session", session, "--title", kwargs.get("title", "Build the indicator"), "--no-open"]
        if "message" in kwargs:
            arguments.extend(["--message", kwargs["message"]])
        return json.loads(self.run_cli(*arguments).stdout)

    def show(self, session=None):
        arguments = ["show"] if session is None else ["show", "--session", session]
        return json.loads(self.run_cli(*arguments).stdout)

    def update(self, status, message="Status changed", session="build", expected=0):
        return self.run_cli("update", "--session", session, "--status", status, "--message", message, expected=expected)

    def agent(self, status, agent="worker", session="build", expected=0):
        return self.run_cli("agent", "--session", session, "--id", agent, "--status", status, expected=expected)

    def test_new_session_and_transitions_have_utc_events(self):
        reply = self.start(title="狐の作業台", message="準備を始める")
        self.assertEqual(reply["session"], "build")
        self.assertEqual(reply["status"], "running")
        session = self.show("build")
        self.assertEqual(session["title"], "狐の作業台")
        self.assertEqual(session["project"], str(self.directory.resolve()))
        self.assertEqual(session["events"][0]["message"], "準備を始める")
        self.assertTrue(session["startedAt"].endswith("Z"))
        for status in ("waiting", "error", "running", "idle", "done", "running"):
            self.update(status, f"Now {status}")
            session = self.show("build")
            self.assertEqual(session["status"], status)
            self.assertEqual(session["events"][-1]["status"], status)
        self.assertEqual(len(session["events"]), 7)
        self.assertEqual(self.show()["schemaVersion"], 1)

    def test_generated_id_is_returned(self):
        reply = json.loads(self.run_cli("start", "--title", "Generated ID", "--no-open").stdout)
        self.assertEqual(self.show(reply["session"])["title"], "Generated ID")

    def test_agent_updates_preserve_name_and_task_and_gate_completion(self):
        self.start()
        self.run_cli("agent", "--session", "build", "--id", "ui", "--name", "BALTHASAR", "--task", "Build the window", "--status", "running", "--message", "Drawing")
        for status in ("running", "waiting", "error"):
            self.agent(status, "ui")
            before = self.state.read_bytes()
            result = self.update("done", expected=1)
            self.assertIn(f"ui ({status})", result.stderr)
            self.assertEqual(self.state.read_bytes(), before)
        self.agent("done", "ui")
        session = self.show("build")
        self.assertEqual(session["agents"][0]["name"], "BALTHASAR")
        self.assertEqual(session["agents"][0]["task"], "Build the window")
        self.assertEqual(session["agents"][0]["message"], "Drawing")
        self.assertEqual(session["events"][-1]["agentId"], "ui")
        self.update("done")
        self.assertIn("completed session", self.agent("running", "new", expected=1).stderr)
        self.update("running", "Start next phase")
        self.agent("running", "new")

    def test_duplicate_and_unknown_sessions_do_not_change_saved_state(self):
        self.start()
        before = self.state.read_bytes()
        self.assertIn("already exists", self.run_cli("start", "--session", "build", "--title", "Replacement", "--no-open", expected=1).stderr)
        self.update("error", session="missing", expected=1)
        self.agent("running", session="missing", expected=1)
        self.run_cli("show", "--session", "missing", expected=1)
        self.assertEqual(self.state.read_bytes(), before)

    def test_invalid_cli_inputs_fail_before_creating_state(self):
        cases = [
            ("start", "--title", "", "--no-open"),
            ("start", "--title", "x" * 241, "--no-open"),
            ("start", "--title", "Bad\x01title", "--no-open"),
            ("start", "--session", "../../escape", "--title", "Test", "--no-open"),
            ("update", "--session", "x", "--status", "complete", "--message", "Test"),
            ("update", "--session", "x", "--status", "done"),
            ("agent", "--session", "x", "--id", "worker", "--status", "running", "--name", ""),
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                self.run_cli(*arguments, expected=2)
        self.assertFalse(self.state.exists())

    def test_corrupt_state_and_unsupported_schema_are_preserved(self):
        self.state.parent.mkdir(parents=True)
        invalid_states = [b"{broken", b"", b'{"schemaVersion":1,"schemaVersion":1}', b'{"schemaVersion":2,"updatedAt":"2026-10-16T00:00:00Z","sessions":[]}', b'{"schemaVersion":1,"updatedAt":"bad","sessions":[]}', b'\xff\xfe']
        for data in invalid_states:
            with self.subTest(data=data):
                self.state.write_bytes(data)
                result = self.run_cli("start", "--title", "Should fail", "--no-open", expected=1)
                self.assertIn("left unchanged", result.stderr)
                self.assertEqual(self.state.read_bytes(), data)

    def test_invalid_nested_state_is_preserved(self):
        self.start()
        valid = self.show()
        mutations = [
            lambda state: state["sessions"][0].update(status="in-progress"),
            lambda state: state["sessions"].append(dict(state["sessions"][0])),
            lambda state: state["sessions"][0]["events"][0].update(agentId="missing"),
            lambda state: state["sessions"][0]["events"][0].update(agentId=[]),
            lambda state: state["sessions"][0].update(agents="invalid"),
            lambda state: state["sessions"][0].update(message="\ud800"),
            lambda state: state.update(schemaVersion=True),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                state = json.loads(json.dumps(valid))
                mutate(state)
                self.state.write_text(json.dumps(state), encoding="utf-8")
                before = self.state.read_bytes()
                self.update("running", expected=1)
                self.assertEqual(self.state.read_bytes(), before)

    def test_message_is_plain_data_and_cannot_execute_shell(self):
        marker = self.directory / "must-not-exist"
        message = f"$(touch '{marker}') `touch '{marker}'` ; <script>red()</script>\n次の行"
        self.start(message=message)
        self.assertEqual(self.show("build")["message"], message)
        self.assertFalse(marker.exists())

    def test_concurrent_agent_writers_do_not_lose_updates(self):
        self.start()
        with ThreadPoolExecutor(max_workers=12) as pool:
            futures = [pool.submit(self.agent, "running", f"worker-{index}") for index in range(32)]
            for future in futures:
                future.result()
        session = self.show("build")
        self.assertEqual({agent["id"] for agent in session["agents"]}, {f"worker-{index}" for index in range(32)})
        self.assertEqual(len(session["events"]), 33)
        self.assertEqual(len({event["id"] for event in session["events"]}), 33)
        self.assertFalse(list(self.state.parent.glob("*.tmp")))

    def test_concurrent_same_id_creation_has_one_winner(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(subprocess.run, [sys.executable, str(CLI), "start", "--session", "same", "--title", "One session", "--no-open"], env=self.environment, capture_output=True, text=True, timeout=20) for _ in range(8)]
            results = [future.result() for future in futures]
        self.assertEqual(sum(result.returncode == 0 for result in results), 1)
        self.assertEqual(sum(result.returncode == 1 for result in results), 7)
        self.assertEqual(len(self.show()["sessions"]), 1)

    def test_events_are_bounded(self):
        self.start()
        with ThreadPoolExecutor(max_workers=12) as pool:
            futures = [pool.submit(self.update, "running", f"Event {index}") for index in range(115)]
            for future in futures:
                future.result()
        session = self.show("build")
        self.assertEqual(len(session["events"]), 100)
        self.assertNotIn("Session started", {event["message"] for event in session["events"]})

    def test_session_history_is_bounded_without_discarding_active_sessions(self):
        for index in range(34):
            session_id = f"history-{index}"
            self.start(session_id)
            self.update("done", session=session_id)
        self.assertEqual(len(self.show()["sessions"]), 30)
        self.assertNotIn("history-0", {session["id"] for session in self.show()["sessions"]})
        for index in range(34):
            self.start(f"active-{index}")
        sessions = self.show()["sessions"]
        self.assertEqual(len(sessions), 34)
        self.assertEqual({session["id"] for session in sessions}, {f"active-{index}" for index in range(34)})
        self.update("waiting", session="active-0")
        self.update("error", session="active-1")
        self.start("active-extra")
        self.assertEqual(len(self.show()["sessions"]), 35)

    def test_empty_state_is_readable_without_creating_json(self):
        self.assertEqual(self.show()["sessions"], [])
        self.assertFalse(self.state.exists())

    def test_idle_session_with_an_active_agent_is_not_pruned(self):
        self.start("keep")
        self.agent("running", session="keep")
        self.update("idle", session="keep")
        for index in range(31):
            self.start(f"other-{index}")
        self.assertEqual(self.show("keep")["agents"][0]["status"], "running")


if __name__ == "__main__":
    unittest.main()
