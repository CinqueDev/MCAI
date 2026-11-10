import json
import tempfile
import unittest
from unittest.mock import Mock, patch

from langchain.schema import AIMessage, HumanMessage, SystemMessage
from voyager import Voyager
from voyager.tasks import TaskClient


class TaskControlTests(unittest.TestCase):
    def test_late_action_completion_is_discarded_without_executing_code(self):
        voyager = Voyager.__new__(Voyager)
        voyager.task = "Bring Alice supplies"
        voyager.active_task = dict(id="task-1", generation=1)
        voyager.task_controller = Mock()
        voyager.task_controller.get.side_effect = [dict(id="task-1", generation=1, state="running"),
                                                   dict(id="task-1", generation=2, state="cancelled")]
        voyager.action_agent_rollout_num_iter = 0
        voyager.messages = [SystemMessage(content="system"), HumanMessage(content="task")]
        voyager.action_agent = Mock()
        voyager.action_agent.llm.return_value = AIMessage(content="late code")
        voyager.env = Mock()
        _, _, _, info = voyager.step()
        self.assertTrue(info["controlled"])
        self.assertEqual(info["state"], "cancelled")
        voyager.env.step.assert_not_called()
        voyager.action_agent.process_ai_message.assert_not_called()

    def test_rollout_refreshes_observations_and_generation_after_resume(self):
        voyager = Voyager.__new__(Voyager)
        voyager.task_controller = Mock()
        voyager.task_controller.begin.return_value = dict(id="task-1", generation=1, state="running")
        voyager.task_controller.wait_running.return_value = dict(id="task-1", generation=3, state="running")
        voyager.task_controller.complete.return_value = True
        voyager.env = Mock(player_request=True)
        voyager.reset = Mock()
        voyager.step = Mock(side_effect=[([], 0, False, dict(controlled=True, state="paused", success=False)),
                                        ([], 0, True, dict(success=True))])
        voyager.rollout(task="Build a wall", context="original")
        self.assertEqual(voyager.reset.call_count, 2)
        self.assertIn("Recheck prior action receipts", voyager.reset.call_args.kwargs["context"])
        self.assertEqual(voyager.task_controller.complete.call_args.args[0]["generation"], 3)
        self.assertIsNone(voyager.env.execution)

    def test_cancelled_rollout_does_not_report_completion_or_resume(self):
        voyager = Voyager.__new__(Voyager)
        voyager.task_controller = Mock()
        voyager.task_controller.begin.return_value = dict(id="task-1", generation=1)
        voyager.task_controller.wait_running.return_value = dict(id="task-1", generation=2, state="cancelled")
        voyager.env = Mock(player_request=True)
        voyager.reset = Mock()
        voyager.step = Mock(return_value=([], 0, False, dict(controlled=True, state="cancelled", success=False)))
        _, _, _, info = voyager.rollout(task="Bring supplies", context="")
        self.assertTrue(info["controlled"])
        voyager.task_controller.complete.assert_not_called()
        voyager.reset.assert_called_once()

    def test_task_client_claims_recovered_active_work_instead_of_starting_curriculum(self):
        client = TaskClient(Mock())
        active = dict(id="task-1", task="Previous work", state="running")
        client.snapshot = Mock(return_value={"active": active})
        client.call = Mock()
        self.assertEqual(client.claim(), active)
        client.call.assert_not_called()

    def test_persistent_movement_is_not_claimed_by_the_action_planner(self):
        client = TaskClient(Mock())
        client.snapshot = Mock(return_value={"active": {"state": "running", "movement": {"mode": "follow"}}})
        client.call = Mock()
        self.assertIsNone(client.claim())
        client.call.assert_not_called()

    def test_persistent_movement_handoff_does_not_wait_for_completion_or_run_the_critic(self):
        voyager = Voyager.__new__(Voyager)
        voyager.task = "Follow Alice"
        voyager.task_controller = Mock()
        record = {"id": "follow", "state": "running", "generation": 2, "movement": {"mode": "follow"}}
        voyager.task_controller.begin.return_value = record
        voyager.task_controller.get.return_value = record
        voyager.env = Mock(player_request=True)
        voyager.reset = Mock()
        voyager.step = Mock(return_value=([], 0, False, {"task": "Follow Alice", "success": False,
            "controlled": True, "persistent": True, "interrupted": True}))
        _, _, _, info = voyager.rollout(task="Follow Alice", context="")
        self.assertTrue(info['persistent'])
        voyager.task_controller.wait_running.assert_not_called()
        voyager.task_controller.complete.assert_not_called()
        voyager.step.assert_called_once()

    def test_client_forwards_action_generation_for_completion(self):
        env = Mock(server="http://127.0.0.1:3000")
        client = TaskClient(env)
        response = Mock()
        response.json.return_value = False
        with patch("voyager.tasks.requests.post", return_value=response) as post:
            self.assertFalse(client.complete(dict(id="task-1", generation=2), True))
        self.assertEqual(post.call_args.kwargs["json"]["generation"], 2)
        self.assertEqual(post.call_args.kwargs["json"]["operation"], "complete")


class SocialTaskHandoffTests(unittest.TestCase):
    def worker(self, directory, revision):
        from voyager.conversation import ConversationWorker
        client = Mock()
        client.queued.return_value = []
        client.snapshot.return_value = {"revision": revision}
        llm = Mock(return_value=AIMessage(content=json.dumps({"reply": "I'll bring supplies", "task": "Bring Alice supplies"})))
        worker = ConversationWorker(Mock(), llm=llm, ckpt_dir=directory, task_client=client)
        worker.request = Mock(return_value={"delivered": True})
        return worker, client

    def snapshot(self):
        return dict(session="connection", history=[], players=["Alice"], taskControl={"revision": 3})

    def test_social_requests_go_to_the_durable_controller_with_the_original_requester(self):
        with tempfile.TemporaryDirectory() as directory:
            worker, client = self.worker(directory, 3)
            worker.respond(self.snapshot(), dict(id=1, sender="Alice", text="Bring supplies", channel="private"))
            request = client.enqueue.call_args.args[0]
            self.assertEqual(request["requester"], "Alice")
            self.assertEqual(request["recipient"], "Alice")
            self.assertEqual(request["expectedRevision"], 3)
            self.assertTrue(worker.tasks.empty())

    def test_a_control_change_discards_a_late_social_task_decision(self):
        with tempfile.TemporaryDirectory() as directory:
            worker, client = self.worker(directory, 4)
            worker.respond(self.snapshot(), dict(id=1, sender="Alice", text="Bring supplies", channel="private"))
            client.enqueue.assert_not_called()
            self.assertIn("Work state changed", worker.request.call_args.args[0]["text"])
