"""No real network: exercise transition edges, durable retries and Discord payloads."""

import copy
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import notifications


FAKE_WEBHOOK = "https://discord.com/api/webhooks/123456/fake_test_token"


def session(status="running", agents=None, tasks=None):
    return {"id": "work", "title": "作業 @everyone", "project": "/Users/test/private/project", "status": status,
            "message": "現在の報告", "agents": agents or [], "tasks": tasks or [],
            "updatedAt": "2026-10-29T00:00:00Z", "events": [{"id": "event-1"}]}


class NotificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="luma-notification-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.path = self.directory / "state.json"
        self.config = self.directory / "config.json"
        self.environment = patch.dict(os.environ, {"LUMA_CONFIG_PATH": str(self.config)})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.settings = {"discordWebhook": FAKE_WEBHOOK, "enabled": True, "notifyErrors": True,
                         "notifyWaiting": True, "notifyCompletion": True}
        self.config.write_text(json.dumps(self.settings), encoding="utf-8")

    def config_value(self):
        return notifications.load_config()

    def test_config_only_accepts_explicit_discord_https_endpoint(self):
        self.assertTrue(self.config_value()["url"].endswith("?wait=true"))
        for endpoint in ("http://discord.com/api/webhooks/1/token", "https://evil.example/api/webhooks/1/token", "https://discord.com@evil.example/api/webhooks/1/token", FAKE_WEBHOOK + "?foo=bar"):
            self.settings["discordWebhook"] = endpoint
            self.config.write_text(json.dumps(self.settings))
            self.assertIsNone(self.config_value())
        self.config.unlink()
        self.assertIsNone(self.config_value())

    def test_edges_do_not_repeat_and_recovery_allows_another_incident(self):
        before = session()
        after = session("error")
        first = notifications.transition_notices(before, after, self.config_value())
        self.assertEqual(len(first), 1)
        self.assertEqual(notifications.transition_notices(after, copy.deepcopy(after), self.config_value()), [])
        recovered = session()
        again = session("error")
        again["events"][-1]["id"] = "event-2"
        second = notifications.transition_notices(recovered, again, self.config_value())
        self.assertNotEqual(first[0]["id"], second[0]["id"])

    def test_only_session_completion_not_subtask_completion_notifies(self):
        before = session(tasks=[{"id": "one", "title": "調査", "status": "running", "message": ""}])
        after = copy.deepcopy(before)
        after["tasks"][0]["status"] = "done"
        self.assertEqual(notifications.transition_notices(before, after, self.config_value()), [])
        after["status"] = "done"
        notices = notifications.transition_notices(before, after, self.config_value())
        self.assertEqual(len(notices), 1)
        self.assertIn("作業完了", notices[0]["payload"]["content"])

    def test_task_and_agent_attention_edges_are_reported(self):
        after = session(agents=[{"id": "review", "name": "Review", "status": "waiting", "message": "確認してください", "task": "Review"}],
                        tasks=[{"id": "build", "title": "実装", "status": "error", "message": "Build failed"}])
        self.assertEqual(len(notifications.transition_notices(session(), after, self.config_value())), 2)

    def test_one_report_coalesces_session_and_task_for_the_same_incident(self):
        after = session("error", tasks=[{"id": "build", "title": "実装", "status": "error", "message": "Build failed"}])
        notices = notifications.transition_notices(session(), after, self.config_value())
        self.assertEqual(len(notices), 1)
        self.assertIn("対象: 実装", notices[0]["payload"]["content"])
        repeated = copy.deepcopy(after)
        repeated["agents"].append({"id": "review", "name": "Review", "status": "error", "message": "Another issue", "task": "Review"})
        notices = notifications.transition_notices(after, repeated, self.config_value())
        self.assertEqual(len(notices), 1)
        self.assertIn("Review", notices[0]["payload"]["content"])

    def test_payload_disables_mentions_and_omits_absolute_paths(self):
        after = session("error")
        after["message"] = "@everyone /Users/test/private/key.txt " + FAKE_WEBHOOK
        payload = notifications.transition_notices(session(), after, self.config_value())[0]["payload"]
        self.assertEqual(payload["allowed_mentions"], {"parse": []})
        self.assertNotIn("/Users/test", payload["content"])
        self.assertNotIn("fake_test_token", payload["content"])
        self.assertIn("プロジェクト: project", payload["content"])

    def test_queue_persists_deduplicates_and_worker_confirms_delivery(self):
        before, after = session(), session("done")
        notifications.queue_transitions(self.path, before, after)
        notifications.queue_transitions(self.path, before, after)
        data = json.loads(notifications.queue_path(self.path).read_text())
        self.assertEqual(len(data["pending"]), 1)
        with patch.object(notifications, "send_payload", return_value=(True, 0, "")) as sender:
            notifications.run_worker(self.path, budget=1)
        self.assertEqual(sender.call_count, 1)
        saved = json.loads(notifications.queue_path(self.path).read_text())
        self.assertEqual(saved["pending"], [])
        self.assertIsNotNone(saved["lastDelivery"])

    def test_worker_preserves_rate_limit_and_failed_delivery_for_later(self):
        notifications.queue_transitions(self.path, session(), session("error"))
        with patch.object(notifications, "send_payload", return_value=(False, 120, "Rate limited")) as sender:
            notifications.run_worker(self.path, budget=0.1)
        self.assertEqual(sender.call_count, 1)
        data = json.loads(notifications.queue_path(self.path).read_text())
        self.assertEqual(data["pending"][0]["attempts"], 1)
        self.assertGreater(data["pending"][0]["nextAttemptAt"], 0)
        self.assertEqual(data["lastError"], "Rate limited")

    def test_concurrent_incidents_are_not_lost(self):
        def queue(index):
            after = session("error")
            after["events"][-1]["id"] = "event-" + str(index)
            notifications.queue_transitions(self.path, session(), after)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(queue, range(24)))
        data = json.loads(notifications.queue_path(self.path).read_text())
        self.assertEqual(len(data["pending"]), 24)
        self.assertEqual(len({item["id"] for item in data["pending"]}), 24)

    def test_rate_limit_pauses_all_notifications_in_the_same_bucket(self):
        after = session("error")
        notifications.queue_transitions(self.path, session(), after)
        after["status"] = "waiting"
        after["events"][-1]["id"] = "event-2"
        notifications.queue_transitions(self.path, session(), after)
        with patch.object(notifications, "send_payload", return_value=(False, 120, "Rate limited")) as sender:
            notifications.run_worker(self.path, budget=0.1)
        self.assertEqual(sender.call_count, 1)
        data = json.loads(notifications.queue_path(self.path).read_text())
        self.assertEqual(len(data["pending"]), 2)
        self.assertGreater(data["nextSendAt"], 0)

    def test_final_completion_automatically_retries_after_long_server_backoff(self):
        notifications.queue_transitions(self.path, session(), session("done"))
        clock = {"seconds": 1000.0}
        sleeps = []
        def sleep(seconds):
            sleeps.append(seconds)
            clock["seconds"] += seconds
        outcomes = [(False, 120.0, "Rate limited"), (True, 0, "")]
        with patch.object(notifications.time, "time", side_effect=lambda: clock["seconds"]), \
             patch.object(notifications.time, "monotonic", side_effect=lambda: clock["seconds"]), \
             patch.object(notifications.time, "sleep", side_effect=sleep), \
             patch.object(notifications, "send_payload", side_effect=outcomes) as sender:
            # No new CLI update or manual retry happens after queuing completion.
            notifications.run_worker(self.path)
        self.assertEqual(sender.call_count, 2)
        self.assertEqual(sleeps, [120.0])
        saved = json.loads(notifications.queue_path(self.path).read_text())
        self.assertEqual(saved["pending"], [])
        self.assertEqual(saved["lastDelivery"], 1120.0)

    def test_deferred_retry_and_new_queue_additions_share_one_sender(self):
        notifications.queue_transitions(self.path, session(), session("done"))
        clock = {"seconds": 1000.0}
        calls_at = []
        def sleep(seconds):
            after = session("error")
            after["events"][-1]["id"] = "new-incident"
            notifications.queue_transitions(self.path, session(), after)
            # A competing launcher cannot send while this sender owns its lock.
            notifications.run_worker(self.path)
            clock["seconds"] += seconds
        def send(url, payload):
            calls_at.append(clock["seconds"])
            return (False, 120.0, "Rate limited") if len(calls_at) == 1 else (True, 0, "")
        with patch.object(notifications.time, "time", side_effect=lambda: clock["seconds"]), \
             patch.object(notifications.time, "monotonic", side_effect=lambda: clock["seconds"]), \
             patch.object(notifications.time, "sleep", side_effect=sleep), \
             patch.object(notifications, "send_payload", side_effect=send):
            notifications.run_worker(self.path)
        self.assertEqual(calls_at, [1000.0, 1120.0, 1120.0])
        self.assertEqual(json.loads(notifications.queue_path(self.path).read_text())["pending"], [])

    def test_deferred_retries_stop_after_five_network_attempts(self):
        notifications.queue_transitions(self.path, session(), session("done"))
        clock = {"seconds": 1000.0}
        def sleep(seconds):
            clock["seconds"] += seconds
        with patch.object(notifications.time, "time", side_effect=lambda: clock["seconds"]), \
             patch.object(notifications.time, "monotonic", side_effect=lambda: clock["seconds"]), \
             patch.object(notifications.time, "sleep", side_effect=sleep), \
             patch.object(notifications, "send_payload", return_value=(False, 120.0, "Rate limited")) as sender:
            notifications.run_worker(self.path)
        self.assertEqual(sender.call_count, 5)
        pending = json.loads(notifications.queue_path(self.path).read_text())["pending"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["attempts"], 5)

    def test_final_enqueue_during_empty_worker_exit_is_not_lost(self):
        notifications.queue_transitions(self.path, session(), session("error"))
        original_locked_queue = notifications.locked_queue
        injected = {"done": False}
        @contextmanager
        def interleaved_queue(state_path):
            with original_locked_queue(state_path) as data:
                # This is the worker's final empty-queue read, rather than the
                # update that removes the preceding delivered notification.
                empty_at_entry = not data["pending"]
                yield data
            if empty_at_entry and not injected["done"]:
                injected["done"] = True
                after = session("done")
                after["events"][-1]["id"] = "final-completion"
                notifications.queue_transitions(self.path, session(), after)
                # Equivalent to a newly launched sender at the exact old race:
                # queue lock released, incumbent function has not returned yet.
                notifications.run_worker(self.path)
        with patch.object(notifications, "locked_queue", side_effect=interleaved_queue), \
             patch.object(notifications, "send_payload", return_value=(True, 0, "")) as sender:
            notifications.run_worker(self.path)
        self.assertTrue(injected["done"])
        self.assertEqual(sender.call_count, 2)
        self.assertEqual(json.loads(notifications.queue_path(self.path).read_text())["pending"], [])

    def test_send_confirms_with_wait_and_handles_429(self):
        error = HTTPError(FAKE_WEBHOOK, 429, "Rate limit", {}, BytesIO(b'{"retry_after":12.5}'))
        with patch.object(notifications, "build_opener") as opener:
            opener.return_value.open.side_effect = error
            sent, retry, failure = notifications.send_payload(self.config_value()["url"], {"content": "Test", "allowed_mentions": {"parse": []}})
            self.assertFalse(sent)
            self.assertEqual(retry, 12.5)
            self.assertNotIn("fake_test_token", failure)
            request = opener.return_value.open.call_args.args[0]
            self.assertTrue(request.full_url.endswith("?wait=true"))
            self.assertEqual(json.loads(request.data)["allowed_mentions"], {"parse": []})
        with patch.object(notifications, "build_opener") as opener:
            opener.return_value.open.side_effect = URLError(FAKE_WEBHOOK)
            self.assertNotIn("fake_test_token", notifications.send_payload(FAKE_WEBHOOK, {})[2])

    def test_disabled_config_never_queues_or_launches_worker(self):
        self.settings["enabled"] = False
        self.config.write_text(json.dumps(self.settings))
        notifications.queue_transitions(self.path, session(), session("error"))
        self.assertFalse(notifications.queue_path(self.path).exists())
        with patch.object(notifications.subprocess, "Popen") as process:
            notifications.launch_worker(self.path)
            process.assert_not_called()


if __name__ == "__main__":
    unittest.main()
