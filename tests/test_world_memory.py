import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock

from langchain.schema import AIMessage
from voyager.world_memory import WorldMemory
from voyager.conversation import ConversationWorker
from voyager.agents.action import ActionAgent


class WorldMemoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.now = 10000
        self.path = Path(self.directory.name) / "world.sqlite3"
        self.memory = self.open()

    def open(self, world="survival", server="localhost", account="bot"):
        store = WorldMemory(self.path, server=server, account=account, world_id=world, clock=lambda: self.now)
        self.addCleanup(store.close)
        return store

    def remember(self, name="home", actor=None, **extra):
        return self.memory.put(kind="place", key=name, name=name, data={"position": {"x": 10, "y": 64, "z": 20}},
                               dimension="overworld", actor=actor, source="observed", evidence={"event": "native-event"}, **extra)

    def test_persistence_world_server_account_and_dimension_isolation(self):
        record = self.remember()
        same = self.open()
        self.assertEqual(same.get(record["id"])["name"], "home")
        for other in [self.open(world="creative"), self.open(server="other"), self.open(account="otherbot")]:
            self.assertEqual(other.search(), [])
            self.assertIsNone(other.get(record["id"]))
        self.assertEqual(self.memory.search(dimension="the_nether"), [])

    def test_scopes_are_applied_before_retrieval_and_ids_do_not_bypass_them(self):
        secret = self.remember("secret base", actor="Alice")
        public = self.remember("public base")
        self.assertEqual(self.memory.search("secret"), [])
        self.assertIsNone(self.memory.get(secret["id"], "Bob"))
        self.assertEqual({r["id"] for r in self.memory.search(actor="Alice")}, {secret["id"], public["id"]})
        with self.assertRaises(ValueError):
            self.memory.put(kind="preference", key="leak", name="derived secret", related_ids=[secret["id"]])

    def test_uuid_upgrade_and_rename_preserve_private_notes_and_authorship(self):
        original = self.memory.put(kind="preference", key="language", name="Italian", actor="Alice", reporter="Alice")
        identity = "12345678-1234-5678-1234-567812345678"
        self.memory.register_players([dict(username="Alice", uuid=identity), dict(username="Alicia", uuid=identity)])
        self.assertEqual(self.memory.get(original["id"], "Alicia")["name"], "Italian")
        self.assertIsNone(self.memory.get(original["id"], "Bob"))
        self.assertTrue(self.memory.forget(original["id"], actor="Alicia"))

    def test_freshness_source_and_changed_blocks_are_not_confused(self):
        observed = self.memory.put(kind="resource", key="coal", name="coal ore", source="observed", evidence={"event": "sight"})
        report = self.memory.put(kind="resource", key="rumor", name="diamonds", source="reported", reporter="Alice")
        self.assertEqual(observed["verification"], "observed")
        self.assertEqual(report["verification"], "unverified")
        self.now += 1801
        self.assertTrue(self.memory.get(observed["id"])["stale"])
        self.memory.ingest({"worldObservations": [dict(id="removed", kind="resource", key="coal", name="coal ore", invalidated=True)]})
        self.assertEqual(self.memory.search("coal", kinds=["resource"]), [])

    def test_forgotten_fact_and_derived_summary_stay_out_of_active_retrieval(self):
        parent = self.remember()
        child = self.memory.put(kind="preference", key="summary", name="home summary", related_ids=[parent["id"]])
        self.memory.forget(parent["id"], actor="Alice")
        self.assertIsNone(self.memory.get(parent["id"]))
        self.assertIsNone(self.memory.get(child["id"]))
        self.assertIsNone(self.remember())
        self.assertEqual(self.memory.db.execute("SELECT count(*) FROM episodes").fetchone()[0], 0)

    def test_legacy_import_preserves_originals_times_and_only_claims_one_world(self):
        root = Path(self.directory.name)
        notes = root / "conversation/memory.json"
        chests = root / "action/chest_memory.json"
        notes.parent.mkdir()
        chests.parent.mkdir()
        notes.write_text(json.dumps({"public": ["Alice builds a lighthouse"], "private:alice": ["Private project"]}))
        chests.write_text(json.dumps({"(10, 64, 20)": {"coal": 5}}))
        original = notes.read_bytes(), chests.read_bytes()
        self.memory.migrate_legacy(root)
        self.memory.migrate_legacy(root)
        records = self.memory.search(actor="Alice")
        self.assertEqual(len(records), 2)
        self.assertEqual(self.memory.db.execute("SELECT count(*) FROM records WHERE scope='legacy:unassigned'").fetchone()[0], 1)
        self.assertTrue(all(r["source"] == "legacy" and r["verified_at"] is None and r["observed_at"] is None for r in records))
        self.assertEqual((notes.read_bytes(), chests.read_bytes()), original)
        other = self.open(world="new-world")
        other.migrate_legacy(root)
        self.assertEqual(other.search(actor="Alice"), [])
        self.memory.forget(next(r["id"] for r in records if r["scope"] == "public"), actor="Alice")
        self.memory.migrate_legacy(root)
        self.assertEqual(self.memory.search(kinds=["storage"]), [])

    def test_chest_events_replace_stale_contents_and_keep_the_original_task_scope(self):
        event = dict(id="inspect-1", kind="storage", key="chest", name="Chest", recipient="Alice", time=self.now,
                     dimension="overworld", data={"contents": {"coal": 5}})
        self.memory.ingest({"worldObservations": [event]})
        self.assertEqual(self.memory.search(kinds=["storage"]), [])
        self.now += 20
        self.memory.ingest({"worldObservations": [{**event, "id": "inspect-2", "time": self.now, "data": {"contents": {"coal": 2}}}]})
        records = self.memory.search(actor="Alice", kinds=["storage"])
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["data"]["contents"], {"coal": 2})
        self.memory.ingest({"worldObservations": [event]})
        self.assertEqual(self.memory.search(actor="Alice", kinds=["storage"])[0]["data"]["contents"], {"coal": 2})

    def test_passive_scans_after_restart_do_not_publish_private_discoveries(self):
        event = dict(id="private", kind="resource", key="coal", name="coal", type="block_observed", recipient="Alice")
        self.memory.ingest({"worldObservations": [event]})
        self.memory.ingest({"worldObservations": [{**event, "id": "public", "recipient": None}]})
        self.assertEqual(self.memory.search(), [])
        self.assertEqual(len(self.memory.search(actor="Alice")), 1)

    def test_chat_memories_are_reported_and_here_uses_the_requesters_coordinates(self):
        operations = [dict(op="remember", kind="place", name="home", source="observed", data={"position": {"x": 999, "y": 1, "z": 999}})]
        result = self.memory.apply_chat(operations, actor="Alice", private=False, dimension="overworld", user_text="remember here as home", message_id="msg1",
                                        player_locations=[dict(username="Alice", position={"x": 4, "y": 64, "z": 8})])
        self.assertTrue(result[0]["ok"])
        record = self.memory.get(result[0]["id"])
        self.assertEqual(record["data"]["position"], {"x": 4, "y": 64, "z": 8})
        self.assertEqual(record["source"], "reported")
        self.assertIsNone(record["verified_at"])
        failed = self.memory.apply_chat(operations, actor="Bob", private=True, dimension="overworld", user_text="remember here", message_id="msg2")
        self.assertFalse(failed[0]["ok"])

    def test_correction_rename_forget_require_intent_and_cannot_edit_another_scope(self):
        row = self.remember(actor="Alice")
        for text, actor in [("hello", "Alice"), ("forget this", "Bob")]:
            result = self.memory.apply_chat([dict(op="forget", id=row["id"])], actor=actor, private=True, dimension="overworld", user_text=text, message_id=text)
            self.assertFalse(result[0]["ok"])
        renamed = self.memory.apply_chat([dict(op="rename", id=row["id"], name="cottage")], actor="Alice", private=True,
                                         dimension="overworld", user_text="rename home to cottage", message_id="rename")
        self.assertTrue(renamed[0]["ok"])
        self.assertEqual(self.memory.get(renamed[0]["id"], "Alice")["name"], "cottage")
        self.assertEqual(self.memory.get(row["id"], "Alice")["source"], "observed")
        deleted = self.memory.apply_chat([dict(op="forget", id=row["id"])], actor="Alice", private=True,
                                         dimension="overworld", user_text="forget cottage", message_id="forget")
        self.assertTrue(deleted[0]["ok"])
        self.assertIsNone(self.memory.get(row["id"], "Alice"))

    def test_task_receipts_become_private_project_progress_and_verified_experience(self):
        task = dict(id="task1", task="Build Alice wall", state="paused", recipient="Alice", actions=[{"results": [
            dict(type="place", block="stone", position={"x": 1, "y": 64, "z": 2}, verified=True)]}])
        self.memory.ingest({"taskControl": {"tasks": [task]}, "dimension": "overworld"})
        self.assertEqual(self.memory.search(), [])
        project = self.memory.search(actor="Alice", kinds=["project"])[0]
        self.assertEqual(project["data"]["completed_cells"][0]["name"], "stone")
        self.assertEqual(project["data"]["state"], "paused")
        self.memory.ingest({"taskControl": {"tasks": [dict(id="task2", task="Explore safely", state="failed", recipient=None, actions=[])]}})
        self.assertEqual(self.memory.search(kinds=["experience"])[0]["data"]["state"], "failed")

    def test_threaded_ingestion_and_retrieval_share_a_consistent_store(self):
        failures = []
        def update():
            try:
                for i in range(30):
                    self.remember(f"landmark{i}")
                    self.memory.search("landmark")
            except Exception as error:
                failures.append(error)
        threads = [threading.Thread(target=update) for _ in range(3)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(failures, [])
        self.assertEqual(len(self.memory.search("landmark", limit=50)), 30)

    def test_late_observation_cannot_overwrite_fresher_or_invalidated_evidence(self):
        fresh = self.memory.put(kind="storage", key="box", name="Chest", source="observed", evidence={"event": "new"},
                                 observed_at=10000, data={"contents": {"coal": 2}})
        self.memory.put(kind="storage", key="box", name="Chest", source="observed", evidence={"event": "old"},
                        observed_at=9000, data={"contents": {"coal": 9}})
        self.assertEqual(self.memory.get(fresh["id"])["data"]["contents"], {"coal": 2})
        self.now = 11000
        self.memory.ingest({"worldObservations": [dict(id="remove", time=11000, kind="storage", key="box", invalidated=True)]})
        self.memory.put(kind="storage", key="box", name="Chest", source="observed", evidence={"event": "delayed"}, observed_at=10000)
        self.assertEqual(self.memory.search(kinds=["storage"]), [])

    def test_search_retrieves_a_named_alias_with_its_supporting_container_observation(self):
        chest = self.memory.put(kind="storage", key="box", name="Chest", source="observed", evidence={"event": "inspect"}, data={"contents": {"coal": 2}})
        self.memory.put(kind="place", key="label:kitchen", name="kitchen", related_ids=[chest["id"]])
        found = self.memory.search("kitchen")
        self.assertEqual({r["kind"] for r in found}, {"place", "storage"})

    def test_nearby_observations_can_help_a_task_without_matching_its_exact_words(self):
        self.memory.put(kind="resource", key="coal", name="coal_ore", data={"position": {"x": 4, "y": 64, "z": 8}},
                        dimension="overworld", source="observed", evidence={"event": "sighting"})
        result = self.memory.search("find some fuel", dimension="overworld", position_hint={"x": 0, "y": 64, "z": 0})
        self.assertEqual(result[0]["name"], "coal_ore")


class WorldMemoryIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.memory = WorldMemory(Path(self.directory.name) / "memory.sqlite3", server="local", account="bot", world_id="world")
        self.addCleanup(self.memory.close)

    def worker(self, content):
        worker = ConversationWorker(Mock(), llm=Mock(return_value=AIMessage(content=json.dumps(content))),
                                    ckpt_dir=self.directory.name, world_memory=self.memory)
        worker.request = Mock(return_value={"delivered": True})
        return worker

    def snapshot(self):
        return {"session": "connection", "history": [], "players": ["Alice", "Bob"],
                "state": {"dimension": "overworld", "position": {"x": 0, "y": 64, "z": 0}},
                "playerLocations": [{"username": "Alice", "position": {"x": 4, "y": 64, "z": 8}}]}

    def test_social_private_and_public_prompts_receive_only_authorized_memory(self):
        secret = self.memory.put(kind="preference", key="secret", name="Alice private project", actor="Alice")
        self.memory.put(kind="preference", key="other", name="Bob private project", actor="Bob")
        worker = self.worker({"reply": "Hello"})
        worker.respond(self.snapshot(), dict(id=1, sender="Alice", text="project", channel="private"))
        context = json.loads(worker.llm.call_args.args[0][1].content)
        self.assertEqual([m["id"] for m in context["memory"]], [secret["id"]])
        worker.respond(self.snapshot(), dict(id=2, sender="Alice", text="project", channel="public"))
        context = json.loads(worker.llm.call_args.args[0][1].content)
        self.assertEqual(context["memory"], [])

    def test_memory_only_chat_updates_the_store_without_queuing_game_work(self):
        worker = self.worker({"reply": "I'll remember home", "memory_ops": [dict(op="remember", kind="place", name="home",
                                     data={"position": {"x": 0, "y": 0, "z": 0}})]})
        worker.respond(self.snapshot(), dict(id=1, sender="Alice", text="remember here as home", channel="private"))
        self.assertTrue(worker.tasks.empty())
        stored = self.memory.search(actor="Alice")[0]
        self.assertEqual(stored["data"]["position"], {"x": 4, "y": 64, "z": 8})
        self.assertEqual(stored["source"], "reported")
        self.assertFalse((Path(self.directory.name) / "conversation/memory.json").exists())

    def test_action_planner_uses_scoped_memory_and_ignores_legacy_chest_caches(self):
        from tests.test_player_actions import events
        self.memory.put(kind="preference", key="private", name="Alice secret plan", actor="Alice")
        action = ActionAgent.__new__(ActionAgent)
        action.chat_log = action.execution_error = False
        action.world_memory = self.memory
        action.memory_actor = "Alice"
        action.memory_dimension = "overworld"
        action.chest_memory = {"(10, 64, 20)": {"diamonds": 99}}
        private = action.render_human_message(events=events(), task="plan", context="").content
        self.assertIn("Alice secret plan", private)
        self.assertNotIn("diamonds", private)
        action.memory_actor = None
        public = action.render_human_message(events=events(), task="plan", context="").content
        self.assertNotIn("Alice secret plan", public)

    def test_public_fact_can_be_forgotten_privately_without_publishing_the_request(self):
        record = self.memory.put(kind="place", key="home", name="home", reporter="Alice", source="reported")
        result = self.memory.apply_chat([dict(op="forget", id=record["id"])], actor="Alice", private=True,
                                       dimension="overworld", user_text="forget home", message_id="private-forget")
        self.assertTrue(result[0]["ok"])
        self.assertIsNone(self.memory.get(record["id"]))

    def test_unavailable_memory_does_not_suppress_a_required_chat_reply(self):
        import sqlite3
        from unittest.mock import patch
        worker = self.worker({"reply": "I can't look up my notes right now"})
        with patch.object(self.memory, "search", side_effect=sqlite3.OperationalError("database unavailable")):
            with self.assertLogs("voyager.conversation", level="ERROR"):
                worker.respond(self.snapshot(), dict(id=1, sender="Alice", text="where is home?", channel="private"))
        self.assertTrue(json.loads(worker.llm.call_args.args[0][1].content)["memory_unavailable"])
        self.assertIn("look up", worker.request.call_args.args[0]["text"])

    def test_an_unseen_player_coordinate_report_has_no_guessed_dimension(self):
        result = self.memory.apply_chat([dict(op="remember", kind="place", name="outpost", data={"position": {"x": 100, "y": 64, "z": 20}})],
            actor="Alice", private=False, dimension="overworld", user_text="remember outpost at 100,64,20", message_id="remote")
        self.assertTrue(result[0]["ok"])
        self.assertIsNone(self.memory.get(result[0]["id"])["dimension"])
        corrected = self.memory.apply_chat([dict(op="correct", id=result[0]["id"], dimension="the_nether")], actor="Alice", private=False,
            dimension="overworld", user_text="actually that outpost is in the nether", message_id="correct-world")
        self.assertTrue(corrected[0]["ok"])
        self.assertEqual(self.memory.get(corrected[0]["id"])["dimension"], "the_nether")
        self.assertIsNone(self.memory.get(result[0]["id"]))

    def test_reused_username_does_not_transfer_an_established_uuids_private_memory(self):
        first = "12345678-1234-5678-1234-567812345678"
        second = "22345678-1234-5678-1234-567812345678"
        self.memory.register_players([dict(username="Alice", uuid=first)])
        record = self.memory.put(kind="preference", key="secret", name="secret plan", actor="Alice", reporter="Alice")
        self.memory.register_players([dict(username="Alice", uuid=second), dict(username="Alicia", uuid=first)])
        self.assertIsNone(self.memory.get(record["id"], "Alice"))
        self.assertEqual(self.memory.get(record["id"], "Alicia")["name"], "secret plan")

    def test_a_model_cannot_reorder_a_players_explicit_coordinates(self):
        result = self.memory.apply_chat([dict(op="remember", kind="place", name="home", data={"position": {"x": 64, "y": 100, "z": -20}})],
            actor="Alice", private=False, dimension="overworld", user_text="remember home at 100,64,-20", message_id="swapped")
        self.assertFalse(result[0]["ok"])
        self.assertEqual(self.memory.search("home"), [])
