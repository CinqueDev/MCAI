import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from langchain.schema import AIMessage
from voyager.conversation import ConversationWorker


def message(identifier=1, sender="Alice", channel="public", text="Voyager hello", **extra):
    return dict(id=identifier, sender=sender, channel=channel, text=text, outgoing=False) | extra


def snapshot(**extra):
    return dict(session="connection1", cursor=1, username="Voyager", players=["Alice", "Bob"],
                noPlayersOnline=False, pending=[], history=[], task=None, state={}, **extra)


class ConversationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.env = Mock(server="http://localhost:3000", connected=True)
        self.llm = Mock(return_value=AIMessage(content=json.dumps(dict(reply="Hello", memory=[], task=None))))
        self.worker = ConversationWorker(self.env, llm=self.llm, ckpt_dir=self.directory.name)
        self.worker.session = "connection1"
        self.worker.next_initiative = float("inf")

    def run_tick(self, data):
        self.worker.request = Mock(side_effect=lambda payload: {"delivered": True} if "text" in payload else data)
        self.worker.tick()

    def context(self):
        return json.loads(self.llm.call_args.args[0][1].content)

    def test_private_context_excludes_other_private_messages_and_notes(self):
        incoming = message(channel="private")
        data = snapshot()
        data.update(pending=[incoming], history=[incoming, message(2, "Bob", "private", "secret"),
                    message(3, "Voyager", "private", "private Bob answer", recipient="Bob", outgoing=True),
                    message(4, "Voyager", "public", "public answer", recipient=None, outgoing=True)])
        self.worker.memory = {"private:alice": ["Alice project"], "private:bob": ["Bob secret"]}
        self.run_tick(data)
        context = self.context()
        self.assertEqual([m["id"] for m in context["history"]], [1, 4])
        self.assertEqual(context["memory"], ["Alice project"])
        payload = self.worker.request.call_args.args[0]
        self.assertEqual(payload["replyTo"], 1)
        self.assertEqual(payload["recipient"], "Alice")

    def test_public_context_excludes_private_tasks_and_history(self):
        incoming = message()
        data = snapshot()
        data.update(pending=[incoming], history=[incoming, message(2, channel="private", text="private secret")],
                    task={"description": "private task secret", "recipient": "Alice"})
        self.worker.tasks.put(dict(task="secret queued task", recipient="Bob"))
        self.run_tick(data)
        self.assertNotIn("secret", json.dumps(self.context()))
        self.assertIsNone(self.worker.request.call_args.args[0]["recipient"])

    def test_required_message_bypasses_quiet_and_cooldown_and_null_reply(self):
        self.worker.quiet_until = self.worker.next_optional = float("inf")
        self.llm.return_value = AIMessage(content='{"reply": null}')
        data = snapshot()
        data["pending"] = [message()]
        self.run_tick(data)
        self.assertTrue(self.worker.request.call_args.args[0]["text"])

    def test_generation_failure_still_answers_required_message(self):
        self.llm.side_effect = RuntimeError("API unavailable")
        data = snapshot()
        data["pending"] = [message(channel="private")]
        with self.assertLogs("voyager.conversation", level="ERROR"):
            self.run_tick(data)
        self.assertEqual(self.worker.request.call_args.args[0]["recipient"], "Alice")
        self.assertIn("trouble", self.worker.request.call_args.args[0]["text"])

    def test_unsolicited_message_is_optional_and_alone_never_calls_llm(self):
        data = snapshot()
        data.update(players=[], noPlayersOnline=True, history=[message(text="hello everyone")])
        self.worker.next_initiative = 0
        self.run_tick(data)
        self.llm.assert_not_called()
        data["players"] = ["Alice"]
        self.llm.return_value = AIMessage(content='{"reply": null}')
        self.run_tick(data)
        self.assertIsNone(self.context()["required_message"])
        self.assertEqual(self.worker.request.call_count, 1)

    def test_new_public_message_waits_for_cooldown_without_being_lost(self):
        self.worker.next_optional = float("inf")
        data = snapshot()
        data["history"] = [message(text="can anyone bring torches?")]
        self.run_tick(data)
        self.llm.assert_not_called()
        self.worker.next_optional = 0
        self.run_tick(data)
        self.llm.assert_called_once()

    def test_idle_agent_can_initiate_and_respects_quiet(self):
        self.worker.next_initiative = 0
        self.worker.quiet_until = float("inf")
        self.run_tick(snapshot())
        self.llm.assert_not_called()
        self.worker.quiet_until = 0
        self.run_tick(snapshot())
        self.llm.assert_called_once()

    def test_ambiguous_delivery_retries_same_key_without_regenerating(self):
        data = snapshot()
        data["pending"] = [message()]
        self.worker.request = Mock(side_effect=[data, OSError("timeout")])
        with self.assertRaises(OSError):
            self.worker.tick()
        key = self.worker.outbox[0]["key"]
        self.worker.request = Mock(side_effect=[data, {"delivered": True}])
        self.worker.tick()
        self.llm.assert_called_once()
        self.assertEqual(self.worker.request.call_args.args[0]["key"], key)

    def test_new_connection_discards_stale_delivery(self):
        self.worker.outbox = ({"session": "old", "text": "stale reply"}, None)
        data = snapshot()
        data["session"] = "new"
        self.run_tick(data)
        self.assertIsNone(self.worker.outbox)
        self.assertEqual(self.worker.request.call_count, 1)

    def test_notes_persist_and_tasks_and_results_preserve_channel(self):
        incoming = message(channel="private")
        self.llm.return_value = AIMessage(content=json.dumps(dict(reply="I'll try after this task", memory=["Alice likes mining"],
                                                                 task="Bring Alice torches", quiet_seconds=60)))
        data = snapshot()
        data["pending"] = [incoming]
        self.run_tick(data)
        stored = json.loads((Path(self.directory.name) / "conversation/memory.json").read_text())
        self.assertEqual(stored, {"private:alice": ["Alice likes mining"]})
        task = self.worker.pop_task()
        self.assertEqual(task, dict(task="Bring Alice torches", recipient="Alice"))
        self.worker.report_task(task, True)
        self.run_tick(snapshot())
        result = self.worker.request.call_args.args[0]
        self.assertEqual(result["recipient"], "Alice")
        self.assertEqual(result["text"], "Finished: Bring Alice torches")

    def test_shutdown_discards_inflight_completion(self):
        self.llm.side_effect = lambda _: self.worker.stop_event.set() or AIMessage(content='{"reply":"late"}')
        data = snapshot()
        data["pending"] = [message()]
        self.run_tick(data)
        self.assertEqual(self.worker.request.call_count, 1)

    def test_private_messages_have_priority_over_public_mentions(self):
        data = snapshot()
        data["pending"] = [message(), message(2, channel="private")]
        self.run_tick(data)
        self.assertEqual(self.context()["required_message"]["id"], 2)

    def test_initiating_cannot_requeue_an_old_request(self):
        self.worker.cursor = 1
        self.worker.next_initiative = 0
        data = snapshot()
        data["history"] = [message()]
        self.llm.return_value = AIMessage(content='{"reply":"Hello again", "task":"Old request"}')
        self.run_tick(data)
        self.assertIsNone(self.worker.pop_task())


class ConversationLifecycleTests(unittest.TestCase):
    def test_soft_task_reset_preserves_connection_and_conversation(self):
        from voyager.env import VoyagerEnv
        with patch.object(VoyagerEnv, "get_mineflayer_process"):
            env = VoyagerEnv(mc_port=25565)
        env.has_reset = env.connected = True
        env.mineflayer.is_running = True
        env.conversation = Mock()
        response = Mock(status_code=200)
        response.json.return_value = json.dumps([["observe", {}]])
        with patch("voyager.env.bridge.requests.post", return_value=response) as post:
            self.assertEqual(env.reset(options={"mode": "soft"}), [["observe", {}]])
        self.assertTrue(post.call_args.args[0].endswith("/observe"))
        env.mineflayer.stop.assert_not_called()
        env.conversation.start.assert_not_called()

    def test_learning_runs_queued_request_before_curriculum_and_reports_result(self):
        from voyager import Voyager
        agent = Voyager.__new__(Voyager)
        agent.env = Mock()
        agent.env.step.return_value = [["observe", {}]]
        agent.resume = True
        agent.env_wait_ticks = 5
        agent.max_iterations = 1
        agent.action_agent_task_max_retries = 4
        agent.recorder = Mock(iteration=0)
        agent.action_agent = Mock()
        agent.skill_manager = Mock(skills={})
        agent.curriculum_agent = Mock(completed_tasks=[], failed_tasks=[])
        request = dict(task="Bring Alice torches", recipient="Alice")
        agent.conversation = Mock()
        agent.conversation.pop_task.return_value = request
        def rollout(**kwargs):
            self.assertEqual(kwargs["task"], request["task"])
            self.assertEqual(agent.env.task_recipient, "Alice")
            agent.recorder.iteration = 2
            return [], 0, True, dict(success=True)
        agent.rollout = rollout
        agent.learn()
        agent.curriculum_agent.propose_next_task.assert_not_called()
        agent.conversation.report_task.assert_called_once_with(request, True)
