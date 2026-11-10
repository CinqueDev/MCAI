import json
import unittest
from unittest.mock import Mock

from langchain.schema import HumanMessage
from voyager import Voyager
from voyager.agents.action import ActionAgent
from voyager.agents.critic import CriticAgent
from voyager.control_primitives import load_control_primitives


def events():
    return [["observe", {"status": {
        "biome": "plains", "timeOfDay": "day", "entities": {}, "health": 20, "food": 20,
        "position": {"x": 10, "y": 64, "z": 20}, "equipment": [], "inventoryUsed": 1,
        "dimension": "overworld", "players": [{"username": "Alice", "visible": True,
            "position": {"x": 11, "y": 64, "z": 20}}],
        "actionResults": [{"type": "approach_player", "player": "Alice", "verified": True}],
    }, "voxels": [], "inventory": {"stone_pickaxe": 1}}]]


class PlayerActionIntegrationTests(unittest.TestCase):
    def test_action_and_critic_receive_actual_player_coordinates_and_results(self):
        action = ActionAgent.__new__(ActionAgent)
        action.chat_log = action.execution_error = True
        action.chest_memory = {}
        critic = CriticAgent.__new__(CriticAgent)
        for agent, kwargs in [(action, {}), (critic, {"chest_observation": ""})]:
            rendered = agent.render_human_message(events=events(), task="Go to Alice", context="", **kwargs)
            self.assertIn('"username": "Alice"', rendered.content)
            self.assertIn('"type": "approach_player"', rendered.content)
            self.assertIn("overworld", rendered.content)

    def test_helpers_are_exposed_to_the_action_model_and_loaded_for_execution(self):
        action = ActionAgent.__new__(ActionAgent)
        action.llm = Mock(model_name="deepseek-flash")
        system = action.render_system_message().content
        runtime = "\n".join(load_control_primitives())
        for name in ["moveToPlayer", "moveToPosition", "dropItem", "giveItemToPlayer", "placeItem", "buildStructure", "waitForItem"]:
            self.assertIn(f"async function {name}(", system)
            self.assertIn(f"async function {name}(", runtime)

    def test_curriculum_yields_after_an_action_when_chat_work_is_queued(self):
        voyager = Voyager.__new__(Voyager)
        voyager.env = Mock(player_request=False)
        voyager.conversation = Mock()
        voyager.conversation.has_tasks.return_value = True
        voyager.reset = Mock()
        voyager.step = Mock(return_value=([HumanMessage(content="done mining this batch")], 0, False,
                                         {"success": False, "task": "Mine coal"}))
        _, _, _, info = voyager.rollout(task="Mine coal", context="", reset_env=False)
        self.assertTrue(info["interrupted"])
        voyager.step.assert_called_once()

    def test_chat_work_is_not_interrupted_by_another_queued_request(self):
        voyager = Voyager.__new__(Voyager)
        voyager.env = Mock(player_request=True)
        voyager.conversation = Mock()
        voyager.reset = Mock()
        voyager.step = Mock(side_effect=[([], 0, False, {"success": False}),
                                       ([], 0, True, {"success": True})])
        voyager.rollout(task="Bring Alice a pickaxe", context="")
        self.assertEqual(voyager.step.call_count, 2)
        voyager.conversation.has_tasks.assert_not_called()

    def test_player_request_setup_uses_observation_without_time_or_difficulty_commands(self):
        voyager = Voyager.__new__(Voyager)
        voyager.env = Mock(player_request=True)
        voyager.env.step.return_value = events()
        voyager.env_wait_ticks = 5
        voyager.skill_manager = Mock()
        voyager.skill_manager.retrieve_skills.return_value = []
        voyager.action_agent = Mock()
        voyager.action_agent.render_human_message.return_value = HumanMessage(content="observation")
        voyager.curriculum_agent = Mock(completed_tasks=[])
        voyager.reset(task="Go to Alice")
        voyager.env.step.assert_called_once_with("")
