import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from voyager import Voyager
from voyager.env import VoyagerEnv
from voyager.tasks import TaskClient, MinecraftConnectionLost
from voyager.utils.record_utils import EventRecorder


class RuntimeRecoveryTests(unittest.TestCase):
    def test_disconnect_between_ready_and_claim_reconnects_and_retries_scheduler(self):
        agent = self.agent()
        agent.conversation = Mock()
        request = {'id':'saved','task':'Come to Alice','requester':'Alice','recipient':None}
        agent.conversation.pop_task.side_effect = [MinecraftConnectionLost('multiplayer.disconnect.chat_validation_failed'),request]
        with self.assertLogs('voyager.voyager',level='WARNING') as logs:
            selected, proposal = agent._next_work()
        self.assertEqual(selected,request)
        self.assertIsNone(proposal)
        agent.env.reconnect.assert_called_once()
        agent.env.reset.assert_not_called()
        agent.task_controller.complete.assert_not_called()
        self.assertIn('chat_validation_failed',' '.join(logs.output))
        self.assertTrue(agent._discard_curriculum)

    def test_disconnect_after_claim_before_planning_update_reclaims_after_rejoin(self):
        agent = self.agent()
        agent.conversation = Mock()
        agent.conversation.pop_task.side_effect = [
            {'id':'saved','generation':1}, {'id':'saved','generation':3}]
        agent.task_controller.set_planning.side_effect = [MinecraftConnectionLost('closed'),None]
        with self.assertLogs('voyager.voyager',level='WARNING'):
            selected,_ = agent._next_work()
        self.assertEqual(selected['generation'],3)
        agent.env.reconnect.assert_called_once()
        agent.task_controller.complete.assert_not_called()

    def test_long_house_and_unicode_descriptions_record_without_filename_failures_and_resume(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            recorder = EventRecorder(ckpt_dir=directory)
            descriptions = ['Build a 10x10 oak plank house at the player location ' * 30, '建てる 🏡/../' * 200]
            for text in descriptions:
                recorder.record([], text)
                recorder.record([], text)
            files = list((Path(directory) / 'events').iterdir())
            self.assertEqual(len(files), 4)
            self.assertTrue(all(len(file.name.encode('utf-8')) < 200 for file in files))
            resumed = EventRecorder(ckpt_dir=directory, resume=True)
            self.assertEqual(resumed.iteration, 4)

    def agent(self):
        agent = Voyager.__new__(Voyager)
        agent.active_task = {'id': 'house', 'generation': 1, 'state': 'running'}
        agent.task = 'Build a house'
        agent.task_controller = Mock()
        agent.env = Mock()
        agent.env_wait_ticks = 5
        return agent

    def test_disconnect_preserves_recoverable_work_and_never_restores_inventory_or_old_coordinates(self):
        agent = self.agent()
        result = agent._recover_rollout_error(MinecraftConnectionLost('Server closed'))
        agent.env.reconnect.assert_called_once()
        agent.task_controller.complete.assert_not_called()
        agent.env.reset.assert_called_once_with(options={'mode': 'soft', 'wait_ticks': 5})
        self.assertTrue(result['interrupted'])
        self.assertTrue(result['controlled'])
        self.assertIsNone(agent.env.execution)
        self.assertIsNone(agent.active_task)

    def test_local_error_marks_only_failed_generation_and_does_not_force_rejoin(self):
        agent = self.agent()
        original = agent.active_task
        agent._recover_rollout_error(OSError('File name too long'))
        agent.task_controller.complete.assert_called_once_with(original, False, 'File name too long')
        agent.env.reconnect.assert_not_called()
        agent.env.reset.assert_called_once_with(options={'mode': 'soft', 'wait_ticks': 5})

    def test_step_surfaces_typed_disconnect_instead_of_waiting_or_replaying_the_action(self):
        with patch.object(VoyagerEnv, 'get_mineflayer_process'):
            env = VoyagerEnv(mc_port=25565, mc_pause_mode='none')
        env.has_reset = env.connected = True
        env.check_process = Mock()
        response = Mock(status_code=409)
        response.json.return_value = {'code':'BOT_DISCONNECTED','error':'Minecraft disconnected during the action'}
        with patch('voyager.env.bridge.requests.post', return_value=response) as post:
            with self.assertRaises(MinecraftConnectionLost):
                env.step('await bot.craft(...)')
        self.assertFalse(env.connected)
        post.assert_called_once()

    def test_reconnect_marks_existing_ready_connection_as_connected(self):
        with patch.object(VoyagerEnv, 'get_mineflayer_process'):
            env = VoyagerEnv(mc_port=25565, mc_pause_mode='none')
        env.has_reset = True
        env.connected = False
        env.reset_options = {'reset': 'soft'}
        with patch('voyager.env.bridge.requests.post', return_value=Mock(status_code=200)) as post:
            env.reconnect()
        self.assertTrue(env.connected)
        post.assert_called_once()

    def test_lost_bridge_connection_uses_the_same_recovery_path_as_a_server_disconnect(self):
        import requests
        client = TaskClient(Mock(server='http://localhost:3000'))
        with patch('voyager.tasks.requests.post', side_effect=requests.ConnectionError('refused')):
            with self.assertRaises(MinecraftConnectionLost):
                client.snapshot()

    def test_later_separate_disconnects_are_recovered_while_waiting_for_a_mode(self):
        client = TaskClient(Mock())
        client.snapshot = Mock(side_effect=[MinecraftConnectionLost('first'),
            {'suspended':False,'busy':True}, MinecraftConnectionLost('second'), {'suspended':False,'busy':False}])
        with patch('voyager.tasks.time.sleep'), contextlib.redirect_stdout(io.StringIO()):
            client.wait_ready()
        self.assertEqual(client.env.reconnect.call_count,2)

    def test_connection_loss_during_step_uses_typed_recovery_without_replaying(self):
        import requests
        with patch.object(VoyagerEnv,'get_mineflayer_process'):
            env = VoyagerEnv(mc_port=25565,mc_pause_mode='none')
        env.has_reset = env.connected = True
        env.check_process = Mock()
        with patch('voyager.env.bridge.requests.post',side_effect=requests.ConnectionError('closed')) as post:
            with self.assertRaises(MinecraftConnectionLost):
                env.step('await bot.toss(...)')
        post.assert_called_once()
        self.assertFalse(env.connected)

    def test_a_superseded_generation_is_not_reported_as_a_new_failure(self):
        agent = self.agent()
        agent.task_controller.complete.return_value = False
        info = agent._recover_rollout_error(OSError('old failure'))
        self.assertTrue(info['controlled'])
        self.assertTrue(info['interrupted'])

    def test_chat_polling_can_reconnect_while_the_action_model_is_still_thinking(self):
        from voyager.conversation import ConversationWorker
        with tempfile.TemporaryDirectory() as directory:
            env = Mock(connected=True)
            worker = ConversationWorker(env,llm=Mock(),ckpt_dir=directory)
            worker.tick = Mock(side_effect=MinecraftConnectionLost('kicked'))
            env.reconnect.side_effect = worker.stop_event.set
            worker.run()
        env.reconnect.assert_called_once()

    def test_chat_rejects_a_lost_connection_as_recoverable_without_resending_the_reply(self):
        from voyager.conversation import ConversationWorker
        with tempfile.TemporaryDirectory() as directory:
            worker = ConversationWorker(Mock(server='http://localhost:3000'),llm=Mock(),ckpt_dir=directory)
            with patch('voyager.conversation.requests.post',return_value=Mock(status_code=409)) as post:
                with self.assertRaises(MinecraftConnectionLost):
                    worker.request({'text':'old reply','session':'old'})
            post.assert_called_once()

    def test_shutdown_does_not_allow_a_queued_background_reconnect_to_restart_the_bot(self):
        with patch.object(VoyagerEnv,'get_mineflayer_process'):
            env = VoyagerEnv(mc_port=25565,mc_pause_mode='none')
        env.has_reset = True
        env.reset_options = {'reset':'soft'}
        env.connected = False
        env.close()
        with patch('voyager.env.bridge.requests.post') as post:
            with self.assertRaisesRegex(RuntimeError,'closing'):
                env.reconnect()
            post.assert_not_called()
