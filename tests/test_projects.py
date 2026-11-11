import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from voyager import Voyager
from voyager.conversation import ConversationWorker
from voyager.world_memory import WorldMemory
from tests.test_conversation_tools import NativeLLM, answer


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.memory = WorldMemory(Path(self.directory.name) / 'world.sqlite3', server='local', account='bot', world_id='test')
        self.addCleanup(self.memory.close)

    def summary(self, **extra):
        return dict(id='project-1', name='Garden wall', version=1, dimension='overworld', state='queued',
                    requester='Alice', recipient='Alice', completed=0, remaining=2, unverified=0,
                    conflictCount=0, materials={'cobblestone': 2}, missing={}, lastVerified=None, **extra)

    def test_native_project_tool_binds_blueprint_origin_actor_and_private_memory_scope(self):
        cells = [{'name': 'cobblestone', 'position': {'x': 0, 'y': 0, 'z': 0}},
                 {'name': 'cobblestone', 'position': {'x': 1, 'y': 0, 'z': 0}}]
        llm = NativeLLM([answer(calls=[('create_project', {'name':'Garden wall', 'origin':{'type':'current_location'}, 'blocks':cells})]),
                         answer('{"reply":"Already finished building!"}')])
        tasks = Mock()
        tasks.queued.return_value = []
        tasks.call.return_value = {'ok':True,'message':'Saved Garden wall; construction is queued.','project':self.summary()}
        worker = ConversationWorker(Mock(), llm=llm, task_client=tasks, world_memory=self.memory, ckpt_dir=self.directory.name)
        worker.request = Mock(return_value={'delivered':True})
        worker.respond({'session':'session','history':[],'state':{},'taskControl':{'revision':3}},
            {'id':1,'sender':'Alice','channel':'private','text':'Build a two-block cobblestone garden wall here',
             'requesterLocation':{'x':4,'y':64,'z':8},'requesterDimension':'overworld'})
        payload = tasks.call.call_args.kwargs
        self.assertEqual(tasks.call.call_args.args, ('project',))
        self.assertEqual(payload['requester'], 'Alice')
        self.assertEqual(payload['recipient'], 'Alice')
        self.assertEqual(payload['blocks'], cells)
        self.assertEqual(payload['requesterLocation'], {'x':4,'y':64,'z':8})
        self.assertEqual(payload['expectedRevision'], 3)
        self.assertEqual(worker.request.call_args.args[0]['text'], tasks.call.return_value['message'])
        self.assertEqual(self.memory.search(kinds=['project']), [])
        record = self.memory.search(kinds=['project'], actor='Alice')[0]
        self.assertEqual(record['source'], 'reported')
        self.assertEqual(record['data']['completed'], 0)

    def test_project_plans_and_verified_progress_are_distinct_and_ingestion_is_idempotent(self):
        planned = self.summary()
        self.memory.ingest_project(planned)
        self.assertEqual(self.memory.search(actor='Alice')[0]['verification'], 'unverified')
        completed = {**planned, 'state':'completed','completed':2,'remaining':0,'lastVerified':1234}
        self.memory.ingest_project(completed)
        record = self.memory.search(actor='Alice')[0]
        self.assertEqual(record['source'], 'observed')
        self.assertEqual(record['data']['plan_basis'], 'player-approved blueprint')
        self.assertEqual(record['data']['progress_basis'], 'verified block states')
        count = self.memory.db.execute('SELECT COUNT(*) FROM episodes').fetchone()[0]
        self.memory.ingest_project(completed)
        self.assertEqual(self.memory.db.execute('SELECT COUNT(*) FROM episodes').fetchone()[0], count)
        changed = {**completed,'state':'conflict','conflictCount':1}
        self.memory.ingest_project(changed)
        self.assertEqual(self.memory.search(actor='Alice')[0]['source'], 'reported')

    def agent(self):
        agent = Voyager.__new__(Voyager)
        record = {'id':'build-task','task':'Build Garden wall','projectId':'project-1','generation':1,'state':'running'}
        agent.task_controller = Mock()
        agent.task_controller.begin.return_value = record
        agent.task_controller.get.return_value = record
        agent.task_controller.complete.return_value = True
        agent.active_task = record
        agent.task = 'Build Garden wall'
        agent.action_agent_rollout_num_iter = 0
        agent.action_agent_task_max_retries = 1
        agent.action_agent = Mock()
        agent.critic_agent = Mock()
        agent.skill_manager = Mock(programs='all primitives')
        agent.env = Mock(player_request=True)
        agent.recorder = Mock()
        agent.messages = []
        agent.conversations = []
        agent.reset = Mock()
        agent.conversation = Mock()
        agent.conversation.has_tasks.return_value = False
        return agent

    def batch_events(self, state, verified=False):
        return [['observe', {'status': {'actionResults':[{'type':'project_batch','project':{'id':'project-1','state':state},
            'verified':verified,'reason':state}]}}]]

    def test_project_runs_multiple_verified_batches_without_llm_or_critic_shortcut(self):
        agent = self.agent()
        agent.env.step.side_effect = [self.batch_events('building'), self.batch_events('completed', True)]
        _, _, _, info = agent.rollout(task='Build Garden wall', context='')
        self.assertTrue(info['success'])
        self.assertTrue(info['project'])
        self.assertEqual(agent.env.step.call_count, 2)
        self.assertIn('buildProjectBatch', agent.env.step.call_args.args[0])
        agent.action_agent.llm.assert_not_called()
        agent.critic_agent.check_task_success.assert_not_called()
        agent.task_controller.complete.assert_called_once()

    def test_project_conflict_cannot_be_reported_as_finished(self):
        agent = self.agent()
        agent.env.step.return_value = self.batch_events('conflict', False)
        _, _, _, info = agent.rollout(task='Build Garden wall', context='')
        self.assertFalse(info['success'])
        self.assertEqual(info['critique'], 'conflict')
        self.assertFalse(agent.task_controller.complete.call_args.args[1])
        agent.critic_agent.check_task_success.assert_not_called()

    def test_failed_supply_dependencies_do_not_force_endless_project_yielding(self):
        client = Mock()
        client.queued.return_value = [{"requester":"Alice","dependsOnTask":"supply","dependencyState":"failed"}]
        worker = ConversationWorker(Mock(), llm=Mock(), task_client=client, ckpt_dir=self.directory.name)
        self.assertFalse(worker.has_tasks())
        client.queued.return_value[0]["dependencyState"] = "completed"
        self.assertTrue(worker.has_tasks())
        client.queued.return_value = [{"requester":"Alice","priority":50,"movement":{"mode":"follow"}}]
        self.assertFalse(worker.has_tasks(minimum_priority=100))
        self.assertTrue(worker.has_tasks())

    def test_generation_change_discards_a_late_running_action_after_pause_and_resume(self):
        agent = self.agent()
        agent.active_task = {'id':'build-task','generation':1}
        agent.task_controller.get.return_value = {'id':'build-task','generation':3,'state':'running'}
        _, _, _, info = agent.step()
        self.assertTrue(info['controlled'])
        agent.env.step.assert_not_called()
