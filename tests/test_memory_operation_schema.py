import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from langchain.schema import AIMessage
from voyager.conversation import ConversationWorker, WORLD_MEMORY_PROMPT
from voyager.world_memory import WorldMemory, normalize_memory_operation


class MemoryOperationSchemaTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.memory = WorldMemory(Path(self.directory.name) / "world.sqlite3", server="local", account="bot", world_id="test")
        self.addCleanup(self.memory.close)

    def apply(self, operation, text="Remember here as home", message_id="home", locations=None):
        return self.memory.apply_chat([operation], actor="Alice", private=True, dimension="overworld",
            user_text=text, message_id=message_id, player_locations=locations if locations is not None else
            [{"username": "Alice", "position": {"x": 4, "y": 64, "z": 8}}])

    def test_common_field_and_verb_variants_save_the_same_grounded_home(self):
        for index, operation in enumerate([
            {"op": "remember"}, {"operation": "remember"}, {"action": "save"},
            {"type": "remember"}, {"op": " Remember "}, {"operation": "create"},
        ]):
            with self.subTest(operation=operation):
                result = self.apply({**operation, "kind": "place", "name": "home", "data": {}}, message_id=str(index))
                self.assertTrue(result[0]["ok"], result)
                row = self.memory.get(result[0]["id"], "Alice")
                self.assertEqual(row["data"]["position"], {"x": 4, "y": 64, "z": 8})
                self.assertEqual(row["source"], "reported")
        self.assertEqual(len(self.memory.search("home", actor="Alice")), 1)
        self.assertEqual(self.memory.search("home"), [])

    def test_missing_or_unsupported_operations_are_not_guessed(self):
        for operation in [{"kind": "place"}, {"op": "execute"}, {"type": "place"}, "remember", {"op": "remember", "data": []}]:
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                normalize_memory_operation(operation)
        self.assertEqual(self.memory.search(actor="Alice"), [])

    def test_here_without_a_visible_player_does_not_create_a_positionless_home(self):
        result = self.apply({"operation": "save", "kind": "place", "name": "home"}, locations=[])
        self.assertFalse(result[0]["ok"])
        self.assertIn("location is unknown", result[0]["error"])
        self.assertEqual(self.memory.search("home", actor="Alice"), [])

    def test_normalization_does_not_bypass_edit_or_forget_intent_checks(self):
        result = self.apply({"op": "remember", "kind": "place", "name": "home"})
        identifier = result[0]["id"]
        for index, verb in enumerate(["delete", "update"]):
            outcome = self.apply({"action": verb, "id": identifier}, text="hello", message_id=f"edit-{index}")
            self.assertFalse(outcome[0]["ok"])
        self.assertIsNotNone(self.memory.get(identifier, "Alice"))

    def test_conversation_acknowledges_only_after_home_was_saved(self):
        worker = ConversationWorker(Mock(), llm=Mock(return_value=AIMessage(content=json.dumps({
            "reply": "I'll remember this as home.", "memory_ops": [{"operation": "remember", "kind": "place", "name": "home", "data": {}}]
        }))), world_memory=self.memory, ckpt_dir=self.directory.name)
        def deliver(payload):
            self.assertEqual(self.memory.search("home", actor="Alice")[0]["data"]["position"], {"x": 4, "y": 64, "z": 8})
            return {"delivered": True}
        worker.request = Mock(side_effect=deliver)
        worker.respond({"session": "connection", "history": [], "state": {"dimension": "overworld"},
                        "players": ["Alice"], "playerLocations": [{"username": "Alice", "position": {"x": 4, "y": 64, "z": 8}}]},
                       {"id": 1, "sender": "Alice", "channel": "private", "text": "Remember here as home"})
        self.assertNotIn("couldn't", worker.request.call_args.args[0]["text"])
        self.assertIn('"op":"remember"', WORLD_MEMORY_PROMPT)

    def test_remember_here_bypasses_a_model_that_would_ask_for_coordinates(self):
        llm = Mock(return_value=AIMessage(content='{"reply":"Please provide coordinates"}'))
        worker = ConversationWorker(Mock(), llm=llm, world_memory=self.memory, ckpt_dir=self.directory.name)
        worker.request = Mock(return_value={"delivered": True})
        worker.respond({"session": "direct", "history": [], "username": "ItsDeltaBot", "state": {"dimension": "overworld"},
                        "playerLocations": [{"username": "Alice", "position": {"x": 99, "y": 64, "z": 99}}]},
                       {"id": 1, "sender": "Alice", "channel": "private", "text": "ItsDeltaBot, remember here as home",
                        "requesterLocation": {"x": 4, "y": 64, "z": 8}, "requesterDimension": "overworld"})
        llm.assert_not_called()
        self.assertEqual(self.memory.search("home", actor="Alice")[0]["data"]["position"], {"x": 4, "y": 64, "z": 8})
        self.assertNotIn("provide", worker.request.call_args.args[0]["text"])

    def test_real_missing_location_still_asks_instead_of_using_the_bots_position(self):
        worker = ConversationWorker(Mock(), llm=Mock(), world_memory=self.memory, ckpt_dir=self.directory.name)
        worker.request = Mock(return_value={"delivered": True})
        worker.respond({"session": "unknown", "history": [], "state": {"position": {"x": 123, "y": 64, "z": 123}}},
                       {"id": 1, "sender": "Alice", "channel": "private", "text": "remember here as home",
                        "requesterLocation": None, "requesterDimension": None})
        self.assertEqual(self.memory.search("home", actor="Alice"), [])
        self.assertIn("unknown", worker.request.call_args.args[0]["text"])


    def test_public_location_write_survives_a_later_private_message_and_confirms_saved_coordinates(self):
        llm = Mock()
        worker = ConversationWorker(Mock(), llm=llm, world_memory=self.memory, ckpt_dir=self.directory.name)
        worker.session = "live"
        worker.cursor = 99  # A later private message already advanced the cursor.
        incoming = {"id": 2, "sender": "Alice", "channel": "public", "outgoing": False,
                    "text": "Can you save my coords as home please?", "locationMemory": {"name": "home"},
                    "requesterLocation": {"x": -12, "y": 70, "z": 19}, "requesterDimension": "overworld"}
        snapshot = {"session": "live", "cursor": 99, "history": [], "pending": [incoming], "state": {},
                    "playerLocations": [{"username": "Alice", "position": {"x": 500, "y": 64, "z": 500}}]}
        worker.request = Mock(side_effect=lambda payload: {"delivered": True} if "text" in payload else snapshot)
        worker.tick()
        llm.assert_not_called()
        payload = worker.request.call_args.args[0]
        self.assertEqual(payload["replyTo"], 2)
        self.assertIsNone(payload["recipient"])
        self.assertIn("(-12, 70, 19)", payload["text"])
        self.assertIn("overworld", payload["text"])
        row = self.memory.search("home")[0]
        self.assertEqual(row["data"]["position"], {"x": -12, "y": 70, "z": 19})
        self.assertEqual(self.memory.search("home", actor="Bob")[0]["id"], row["id"])

    def test_location_write_without_a_label_asks_for_a_name(self):
        llm = Mock()
        worker = ConversationWorker(Mock(), llm=llm, world_memory=self.memory, ckpt_dir=self.directory.name)
        worker.request = Mock(return_value={"delivered": True})
        worker.respond({"session": "unnamed", "history": []},
                       {"id": 1, "sender": "Alice", "channel": "private", "text": "save my location",
                        "locationMemory": {"name": None}, "requesterLocation": {"x": 1, "y": 2, "z": 3}})
        llm.assert_not_called()
        self.assertIn("call this place", worker.request.call_args.args[0]["text"])
        self.assertEqual(self.memory.search(actor="Alice"), [])

    def test_failed_readback_does_not_claim_a_location_was_saved(self):
        worker = ConversationWorker(Mock(), llm=Mock(), world_memory=self.memory, ckpt_dir=self.directory.name)
        worker.request = Mock(return_value={"delivered": True})
        from unittest.mock import patch
        with patch.object(self.memory, "get", return_value=None), self.assertLogs("voyager.conversation", level="ERROR"):
            worker.respond({"session": "readback", "history": []},
                {"id": 1, "sender": "Alice", "channel": "private", "text": "remember here as home",
                 "requesterLocation": {"x": 1, "y": 2, "z": 3}})
        self.assertIn("couldn't save", worker.request.call_args.args[0]["text"])
