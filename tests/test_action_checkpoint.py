import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from voyager.agents.action import ActionAgent


class ActionCheckpointTests(unittest.TestCase):
    def test_resume_without_legacy_chest_cache_preserves_other_saved_state(self):
        with tempfile.TemporaryDirectory() as directory:
            memory = Path(directory, 'memory')
            memory.mkdir()
            marker = memory / 'preserved.txt'
            marker.write_text('existing world memory')
            with patch('voyager.agents.action.DeepSeekChat'):
                agent = ActionAgent(ckpt_dir=directory, resume=True)
            self.assertEqual(agent.chest_memory, {})
            self.assertEqual(marker.read_text(), 'existing world memory')
            # WorldMemory mode deliberately never writes the legacy JSON file.
            agent.world_memory = object()
            agent.update_chest_memory({'position': {'iron': 3}})
            with patch('voyager.agents.action.DeepSeekChat'):
                again = ActionAgent(ckpt_dir=directory, resume=True)
            self.assertEqual(again.chest_memory, {})

    def test_existing_cache_is_loaded_and_corrupt_cache_is_not_silently_discarded(self):
        with tempfile.TemporaryDirectory() as directory:
            action = Path(directory, 'action')
            action.mkdir()
            cache = action / 'chest_memory.json'
            saved = {'(1, 64, 2)': {'iron_ingot': 3}}
            cache.write_text(json.dumps(saved))
            with patch('voyager.agents.action.DeepSeekChat'):
                agent = ActionAgent(ckpt_dir=directory, resume=True)
            self.assertEqual(agent.chest_memory, saved)
            cache.write_text('{broken')
            with patch('voyager.agents.action.DeepSeekChat'), self.assertRaises(json.JSONDecodeError):
                ActionAgent(ckpt_dir=directory, resume=True)
