import contextlib
import io
import json
import threading
import unittest
from unittest.mock import Mock, patch

from voyager import Voyager
from voyager.env import VoyagerEnv
from voyager.tasks import TaskClient, MinecraftConnectionLost


class ReadinessAndDispatchTests(unittest.TestCase):
    def test_starting_controller_is_retried_without_an_http_error(self):
        client = TaskClient(Mock(server="http://localhost:3000"))
        starting = Mock(status_code=409)
        starting.json.return_value = {"code": "BOT_STARTING", "error": "Waiting for spawn"}
        ready = Mock(status_code=200)
        ready.json.return_value = {"suspended": False, "tasks": [], "active": None}
        with patch("voyager.tasks.requests.post", side_effect=[starting, ready]), patch("voyager.tasks.time.sleep") as sleep:
            self.assertFalse(client.snapshot()["suspended"])
        sleep.assert_called_once_with(0.2)

    def test_disconnection_reason_is_preserved_and_wait_reconnects_once(self):
        env = Mock(server="http://localhost:3000")
        client = TaskClient(env)
        ended = Mock(status_code=409)
        ended.json.return_value = {"code": "BOT_DISCONNECTED", "error": "Server closed"}
        with patch("voyager.tasks.requests.post", return_value=ended):
            with self.assertRaisesRegex(MinecraftConnectionLost, "Server closed"):
                client.snapshot()
        client.snapshot = Mock(side_effect=[MinecraftConnectionLost("Server closed"), {"suspended": False}])
        with contextlib.redirect_stdout(io.StringIO()):
            client.wait_ready()
        env.reconnect.assert_called_once()

    def test_paused_recovery_explains_how_to_resume_instead_of_appearing_stuck(self):
        client = TaskClient(Mock())
        client.snapshot = Mock(side_effect=[{"suspended": True, "active": {"id": "task", "state": "paused"}}, {"suspended": False}])
        output = io.StringIO()
        with patch("voyager.tasks.time.sleep"), contextlib.redirect_stdout(output):
            client.wait_ready()
        self.assertIn("resume", output.getvalue())

    def test_reconnection_never_uses_a_hard_reset_or_old_player_coordinates(self):
        with patch.object(VoyagerEnv, "get_mineflayer_process"):
            env = VoyagerEnv(mc_port=25565, mc_pause_mode="none")
        env.has_reset = env.connected = True
        env.reset_options = {"port": 25565, "reset": "soft", "position": {"x": 100, "y": 60, "z": 100}, "waitTicks": 20}
        probe = Mock(status_code=409)
        started = Mock(status_code=200)
        started.json.return_value = json.dumps([])
        restored = Mock(status_code=200)
        with patch("voyager.env.bridge.requests.post", side_effect=[probe, started, restored]) as post:
            env.reconnect()
        payload = post.call_args_list[1].kwargs["json"]
        self.assertEqual(payload["reset"], "soft")
        self.assertIsNone(payload["position"])
        self.assertEqual(payload["inventory"], {})
        self.assertEqual(payload["waitTicks"], 0)
        self.assertEqual(post.call_args_list[2].kwargs["json"], {"waitTicks": 20})

    def test_chat_work_is_claimed_while_curriculum_generation_is_blocked(self):
        agent = Voyager.__new__(Voyager)
        agent.task_controller = Mock()
        agent.action_agent = Mock()
        agent.last_events = []
        agent.curriculum_agent = Mock()
        entered, release = threading.Event(), threading.Event()
        def propose(**kwargs):
            entered.set()
            release.wait(2)
            return "Old curriculum suggestion", "old context"
        agent.curriculum_agent.propose_next_task.side_effect = propose
        request = {"id": "chat-request", "task": "Come to Alice", "requester": "Alice", "recipient": None}
        def poll():
            return request if entered.is_set() else None
        agent.conversation = Mock()
        agent.conversation.pop_task.side_effect = poll
        try:
            selected, proposal = agent._next_work()
            self.assertEqual(selected["id"], "chat-request")
            self.assertIsNone(proposal)
            self.assertFalse(release.is_set())
            self.assertTrue(agent._discard_curriculum)
        finally:
            release.set()
            agent._curriculum_future.result(timeout=2)

    def test_chat_status_explains_pause_and_filters_private_queue_descriptions(self):
        from langchain.schema import AIMessage
        from voyager.conversation import ConversationWorker
        llm = Mock(return_value=AIMessage(content='{"reply":"Work is paused; resume is needed"}'))
        worker = ConversationWorker(Mock(), llm=llm)
        worker.request = Mock(return_value={"delivered": True})
        worker.respond({"session": "queue", "history": [], "task": {"description": "stale finished task"}, "taskControl": {
            "suspended": True, "planning": False, "busy": False,
            "active": {"state": "paused", "task": "Alice secret project", "recipient": "Alice", "recovery": True},
            "tasks": [{"state": "queued", "task": "Bring Bob supplies", "recipient": None},
                      {"state": "queued", "task": "Alice secret request", "recipient": "Alice"}]}},
            {"id": 1, "sender": "Bob", "text": "Why is the queue waiting?", "channel": "public"})
        context = json.loads(llm.call_args.args[0][1].content)
        self.assertTrue(context["execution"]["suspended"])
        self.assertEqual(context["execution"]["active"]["state"], "paused")
        self.assertNotIn("secret", json.dumps(context))
        self.assertEqual(context["queued_tasks"], ["Bring Bob supplies"])

    def test_an_abandoned_curriculum_suggestion_is_not_reused_after_player_work(self):
        from concurrent.futures import Future
        agent = Voyager.__new__(Voyager)
        agent.task_controller = Mock()
        agent.conversation = Mock()
        agent.conversation.pop_task.return_value = None
        agent.action_agent = Mock()
        agent.last_events = []
        old = Future()
        old.set_result(("Stale task", "stale context"))
        agent._curriculum_future = old
        agent._discard_curriculum = True
        agent.curriculum_agent = Mock()
        agent.curriculum_agent.propose_next_task.return_value = ("Fresh task", "fresh context")
        request, proposal = agent._next_work()
        self.assertIsNone(request)
        self.assertEqual(proposal, ("Fresh task", "fresh context"))

    def test_shutdown_after_failed_reconnection_does_not_hide_the_disconnect_reason(self):
        with patch.object(VoyagerEnv, "get_mineflayer_process"):
            env = VoyagerEnv(mc_port=25565, mc_pause_mode="tick")
        env.connected = False
        env.server_paused = True
        with patch("voyager.env.bridge.requests.post") as post:
            env.close()
        post.assert_not_called()
        env.mineflayer.stop.assert_called_once()
