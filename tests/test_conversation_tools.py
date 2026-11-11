import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from openai.types.chat import ChatCompletionMessage
from voyager.conversation import ConversationWorker
from voyager.conversation_tools import API_TOOLS, CATALOG
from voyager.world_memory import WorldMemory, MEMORY_OPERATIONS


def answer(content=None, calls=()):
    return ChatCompletionMessage(role="assistant", content=content, tool_calls=[
        {"id": f"call-{i}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
        for i, (name, args) in enumerate(calls)] or None)


class NativeLLM:
    def __init__(self, answers):
        self.answers = iter(answers)
        self.requests = []

    def complete(self, messages, tools=None):
        self.requests.append((copy.deepcopy(messages), tools))
        return next(self.answers)


class ConversationToolTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.memory = WorldMemory(Path(self.directory.name) / 'world.sqlite3', server='local', account='bot', world_id='test')
        self.addCleanup(self.memory.close)
        self.tasks = Mock()
        self.tasks.queued.return_value = []
        self.tasks.snapshot.return_value = {"revision": 7, "suspended": False, "tasks": [], "active": None}
        self.snapshot = {"session": "session", "history": [], "taskControl": self.tasks.snapshot(),
            "state": {"dimension": "the_nether"}, "playerLocations": [{"username": "Alice", "position": {"x": 100, "y": 65, "z": 100}}]}

    def worker(self, llm):
        worker = ConversationWorker(Mock(), llm=llm, task_client=self.tasks, world_memory=self.memory, ckpt_dir=self.directory.name)
        worker.request = Mock(return_value={"delivered": True})
        return worker

    def source(self, text, **extra):
        return {"id": 1, "sender": "Alice", "channel": "private", "text": text,
                "requesterLocation": {"x": 4, "y": 64, "z": 8}, "requesterDimension": "overworld", **extra}

    def test_native_prompt_has_one_action_protocol_and_a_chat_only_final_schema(self):
        llm = NativeLLM([answer('{"reply":"Hello","quiet_seconds":0}')])
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source('hello'))
        prompt = llm.requests[0][0][0]['content']
        self.assertNotIn('you may return a task', prompt)
        self.assertNotIn('memory_ops', prompt)
        self.assertNotIn('task_control', prompt)
        self.assertNotIn('memory (list of strings)', prompt)
        self.assertIn('native function calls', prompt)
        self.assertIn('reply (string or null)', prompt)
        self.tasks.enqueue.assert_not_called()
        self.assertEqual(len(llm.requests), 1)

    def test_legacy_task_response_is_repaired_into_a_real_tool_without_user_retry(self):
        llm = NativeLLM([answer('{"reply":"I will bring it","task":"Bring Alice a pickaxe"}'),
            answer(calls=[('queue_task', {'task':'Bring Alice a pickaxe'})]),
            answer('{"reply":"Queued"}')])
        self.tasks.enqueue.return_value = {'id':'abcdefgh-1','task':'Bring Alice a pickaxe'}
        worker = self.worker(llm)
        with self.assertLogs('voyager.conversation_tools', level='WARNING'):
            worker.respond(self.snapshot, self.source('bring me a pickaxe'))
        self.tasks.enqueue.assert_called_once()
        self.assertIn('Queued abcdefgh', worker.request.call_args.args[0]['text'])
        repair = llm.requests[1][0][-1]
        self.assertEqual(repair['role'], 'system')
        self.assertIn('ORIGINAL', repair['content'])
        self.assertEqual(self.tasks.enqueue.call_args.kwargs['key'], 'session:1:tool:queue')

    def test_legacy_memory_response_is_repaired_and_saves_real_requester_coordinates(self):
        llm = NativeLLM([answer('{"reply":"Saved home","memory_ops":[{"op":"remember","kind":"place","name":"home"}]}'),
            answer(calls=[('remember_location', {'name':'home'})]), answer('{"reply":"Saved"}')])
        worker = self.worker(llm)
        with self.assertLogs('voyager.conversation_tools', level='WARNING'):
            worker.respond(self.snapshot, self.source('remember this spot as home'))
        self.assertEqual(self.memory.search('home', actor='Alice')[0]['data']['position'], {'x':4,'y':64,'z':8})
        self.assertIn('Saved home at (4, 64, 8)', worker.request.call_args.args[0]['text'])
        self.assertEqual(self.memory.search('home'), [])

    def test_repair_is_bounded_and_never_executes_legacy_fields_directly(self):
        llm = NativeLLM([answer('{"reply":"Cancelled","task_control":{"command":"cancel"}}'),
                         answer('{"reply":"Cancelled","task_control":{"command":"cancel"}}')])
        worker = self.worker(llm)
        with self.assertLogs('voyager.conversation_tools', level='WARNING'):
            worker.respond(self.snapshot, self.source('cancel the beehive task'))
        self.tasks.control.assert_not_called()
        self.assertEqual(len(llm.requests), 2)
        self.assertIn('No work or memory change was confirmed', worker.request.call_args.args[0]['text'])

    def test_repair_does_not_repeat_a_mutation_already_confirmed_by_a_tool(self):
        llm = NativeLLM([answer(calls=[('control_task', {'command':'cancel','target':'beehive'})]),
                         answer('{"reply":"Cancelled","task_control":{"command":"cancel"}}')])
        self.tasks.control.return_value = {'ok':True,'message':'Cancelled abcdefgh.'}
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source('cancel the beehive task'))
        self.tasks.control.assert_called_once()
        self.assertEqual(len(llm.requests), 2)
        self.assertEqual(worker.request.call_args.args[0]['text'], 'Cancelled abcdefgh.')

    def test_repair_never_promotes_legacy_notes_into_implicit_memory_writes(self):
        llm = NativeLLM([answer('{"reply":"Hello","memory":["Invented fact"]}'), answer('{"reply":"Hello"}')])
        worker = self.worker(llm)
        with self.assertLogs('voyager.conversation_tools', level='WARNING'):
            worker.respond(self.snapshot, self.source('hello'))
        self.assertEqual(self.memory.search(actor='Alice'), [])
        self.tasks.enqueue.assert_not_called()

    def test_natural_cancellation_executes_tool_and_uses_real_receipt(self):
        llm = NativeLLM([answer(calls=[('control_task', {"command": "cancel", "target": "beehive"})]),
                         answer('{"reply":"Cancelled everything!"}')])
        self.tasks.control.return_value = {"ok": False, "message": "More than one task matches. Use a task ID."}
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source("I've changed my mind about that beehive job, please abandon it."))
        self.tasks.control.assert_called_once_with('cancel', 'Alice', target='beehive', identifier=None,
                                                  private=True, revision=7, key='session:1:tool:control')
        self.assertEqual(worker.request.call_args.args[0]['text'], self.tasks.control.return_value['message'])
        self.assertEqual(worker.request.call_args.args[0]['recipient'], 'Alice')
        self.assertEqual(llm.requests[0][1], API_TOOLS)
        receipt = llm.requests[1][0][-1]
        self.assertEqual(receipt['role'], 'tool')
        self.assertFalse(json.loads(receipt['content'])['ok'])
        self.tasks.enqueue.assert_not_called()

    def test_explicit_resume_following_option_is_forwarded_with_foreground_work(self):
        self.tasks.enqueue.return_value = {"id":"abcdefgh1234","task":"Bring Alice supplies"}
        llm = NativeLLM([answer(calls=[('queue_task', {"task":"Bring Alice supplies","resume_following":True})]), answer('{"reply":"Queued"}')])
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source('bring supplies, then follow me again'))
        self.assertTrue(self.tasks.enqueue.call_args.args[0]['resumeMovement'])

    def test_work_clarification_reaches_the_controller_instead_of_leaving_following_running(self):
        question = 'What size and materials should I use?'
        self.tasks.call.return_value = {'ok':True,'message':'Stopped your previous follow/stay request. ' + question}
        llm = NativeLLM([answer(calls=[('set_movement', {'mode':'prepare_work','question':question})]), answer('{"reply":"I am already building"}')])
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source('build a house where I am'))
        self.assertEqual(self.tasks.call.call_args.args, ('movement',))
        self.assertEqual(self.tasks.call.call_args.kwargs['mode'],'prepare_work')
        self.assertEqual(self.tasks.call.call_args.kwargs['requester'],'Alice')
        self.assertIn(question, worker.request.call_args.args[0]['text'])
        self.tasks.enqueue.assert_not_called()

    def test_current_location_tool_needs_no_predefined_wording_and_reads_back_real_coordinates(self):
        llm = NativeLLM([answer(calls=[('remember_location', {"name": "meeting point"})]), answer('{"reply":"saved"}')])
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source("Keep this spot for our next trip."))
        row = self.memory.search('meeting point', actor='Alice')[0]
        self.assertEqual(row['data']['position'], {"x": 4, "y": 64, "z": 8})
        self.assertEqual(row['dimension'], 'overworld')
        self.assertIn('(4, 64, 8) in overworld', worker.request.call_args.args[0]['text'])
        self.assertEqual(self.memory.search('meeting point'), [])

    def test_tool_identity_and_arguments_are_not_controlled_by_the_model(self):
        llm = NativeLLM([answer(calls=[('control_task', {"command": "cancel", "sender": "Owner"})]),
                         answer('{"reply":"Cancelled"}')])
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source('cancel it'))
        self.tasks.control.assert_not_called()
        self.assertIn('Unknown tool argument', worker.request.call_args.args[0]['text'])

    def test_tool_queue_is_bound_to_received_request_and_legacy_fields_do_not_duplicate_it(self):
        self.tasks.enqueue.return_value = {"id": "abcdefgh1234", "task": "Bring Alice a pickaxe"}
        llm = NativeLLM([answer(calls=[('queue_task', {"task": "Bring Alice a pickaxe"})]),
                         answer('{"reply":"Done", "task":"Do it again", "memory_ops":[{"op":"forget"}]}')])
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source('could you bring me a pickaxe?'))
        self.tasks.enqueue.assert_called_once_with({"task": "Bring Alice a pickaxe", "requester": "Alice",
            "recipient": "Alice", "expectedRevision": 7}, key='session:1:tool:queue')
        self.assertIn('Queued abcdefgh', worker.request.call_args.args[0]['text'])

    def test_explicit_semantic_memory_tool_requests_need_no_magic_edit_verb(self):
        own = self.memory.put(kind="place", key="label:old", name="Old meeting point", actor="Alice", data={"note": "obsolete"})
        llm = NativeLLM([answer(calls=[('update_memory', {"op": "forget", "id": own['id']})]),
                         answer('{"reply":"Removed it"}')])
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source('That meeting point is obsolete; take it out of your notes.'))
        self.assertIsNone(self.memory.get(own['id'], 'Alice'))
        self.assertEqual(worker.request.call_args.args[0]['text'], 'Forgot that memory.')
        other = self.memory.put(kind="place", key="label:bob", name="Bob note", actor="Bob", data={})
        llm = NativeLLM([answer(calls=[('update_memory', {"op": "forget", "id": other['id']})]),
                         answer('{"reply":"Removed Bob note"}')])
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source('take that note out', id=2))
        self.assertIsNotNone(self.memory.get(other['id'], 'Bob'))
        self.assertIn("couldn't update", worker.request.call_args.args[0]['text'])

    def test_missing_player_location_cannot_be_replaced_by_a_model_guess(self):
        llm = NativeLLM([answer(calls=[('remember_location', {})]), answer('{"reply":"Saved at my location"}')])
        worker = self.worker(llm)
        self.snapshot['playerLocations'] = []
        worker.respond(self.snapshot, self.source('keep this spot for later', requesterLocation=None))
        self.assertIn('Your location is unknown', worker.request.call_args.args[0]['text'])
        self.assertEqual(self.memory.search(actor='Alice'), [])

    def test_world_reference_and_movement_tools_bind_private_scope_and_actor(self):
        llm = NativeLLM([answer(calls=[('resolve_target', {"reference": {"type": "landmark", "name": "home"}})]),
                         answer(calls=[('set_movement', {"mode": "stay", "reference": {"type": "landmark", "name": "home"}})]),
                         answer('{"reply":"I arrived!"}')])
        private_home = self.memory.put(kind="place", key="label:home", name="home", actor="Alice", source="reported", dimension="overworld", data={"position": {"x": 4, "y": 64, "z": 8}})
        self.memory.put(kind="place", key="label:bob", name="Bob secret", actor="Bob", data={"position": {"x": 50, "y": 64, "z": 50}})
        self.tasks.call.side_effect = [{"status": "resolved", "position": {"x": 4, "y": 64, "z": 8}},
                                       {"ok": True, "message": "Queued: Stay at home."}]
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source('wait at home until I return'))
        calls = self.tasks.call.call_args_list
        self.assertEqual(calls[0].args, ('resolve',))
        self.assertEqual(calls[1].args, ('movement',))
        self.assertEqual(calls[1].kwargs['requester'], 'Alice')
        self.assertEqual(calls[1].kwargs['recipient'], 'Alice')
        self.assertIn(private_home['id'], [m['id'] for m in calls[1].kwargs['memories']])
        self.assertNotIn('Bob secret', json.dumps(calls[1].kwargs['memories']))
        self.assertEqual(worker.request.call_args.args[0]['text'], 'Queued: Stay at home.')

    def test_public_tools_never_receive_the_requesters_private_memories(self):
        llm = NativeLLM([answer(calls=[('resolve_target', {"reference": {"type": "landmark", "name": "secret"}})]),
                         answer('{"reply":"Which place do you mean?"}')])
        self.memory.put(kind="place", key="label:secret", name="secret", actor="Alice", data={"position": {"x": 1, "y": 64, "z": 1}})
        self.tasks.call.return_value = {"status": "unresolved", "reason": "Name a remembered place"}
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source('go to secret', channel='public'))
        self.assertEqual(self.tasks.call.call_args.kwargs['memories'], [])

    def test_model_cannot_invent_coordinates_for_staying_with_an_unseen_player(self):
        llm = NativeLLM([answer(calls=[('set_movement', {"mode": "stay", "reference": {
            "type": "coordinates", "position": {"x": 12345, "y": 77, "z": 12345}}})]),
            answer('{"reply":"I will stay at your location"}')])
        worker = self.worker(llm)
        worker.respond(self.snapshot, self.source('wait near Bob'))
        self.tasks.call.assert_not_called()
        self.assertIn("I won't guess a position", worker.request.call_args.args[0]['text'])

    def test_memory_tool_schema_covers_all_supported_operations_and_categories(self):
        schema = next(t['parameters'] for t in CATALOG if t['name'] == 'update_memory')
        from voyager.world_memory import KINDS
        self.assertEqual(set(schema['properties']['op']['enum']), MEMORY_OPERATIONS)
        self.assertEqual(set(schema['properties']['kind']['enum']), KINDS)

    def test_shutdown_prevents_tool_side_effects(self):
        llm = NativeLLM([answer(calls=[('control_task', {"command": "cancel"})]), answer('{"reply":"ok"}')])
        worker = self.worker(llm)
        original = llm.complete
        def shutdown(*args, **kwargs):
            result = original(*args, **kwargs)
            worker.stop_event.set()
            return result
        llm.complete = shutdown
        worker.respond(self.snapshot, self.source('cancel'))
        self.tasks.control.assert_not_called()
        worker.request.assert_not_called()
