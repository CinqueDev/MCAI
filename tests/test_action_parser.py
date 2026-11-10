import tempfile
import unittest
from unittest.mock import Mock

from langchain.schema import AIMessage, HumanMessage, SystemMessage

from voyager import Voyager
from voyager.agents.action import ActionAgent
from voyager.utils import EventRecorder


class ActionParserTests(unittest.TestCase):
    def test_real_babel_bridge_parses_async_function(self):
        # Exercise the installed Babel version, including Babel 8's sync API.
        agent = ActionAgent.__new__(ActionAgent)
        result = agent.process_ai_message(AIMessage(content='''
```javascript
function helper(bot) { return bot.inventory.items(); }
async function mineOneWoodLog(bot) {
    const logs = helper(bot);
    bot.chat(`Found ${logs.length} items`);
}
```
'''))
        self.assertIsInstance(result, dict, result)
        self.assertEqual(result["program_name"], "mineOneWoodLog")
        self.assertEqual(result["exec_code"], "await mineOneWoodLog(bot);")
        self.assertIn("function helper(bot)", result["program_code"])

    def test_parse_failure_retries_with_feedback_without_resetting_minecraft(self):
        with tempfile.TemporaryDirectory() as directory:
            voyager = Voyager.__new__(Voyager)
            voyager.action_agent_rollout_num_iter = 0
            voyager.action_agent_task_max_retries = 4
            voyager.task = "Mine 1 wood log"
            voyager.messages = [SystemMessage(content="Write code"), HumanMessage(content="Mine wood")]
            voyager.conversations = []
            voyager.action_agent = Mock()
            voyager.action_agent.llm.return_value = AIMessage(content="Invalid code")
            voyager.action_agent.process_ai_message.return_value = "Error parsing action response: invalid syntax"
            voyager.env = Mock()
            voyager.recorder = EventRecorder(ckpt_dir=directory)

            _, _, done, info = voyager.step()

            self.assertFalse(done)
            self.assertFalse(info["success"])
            self.assertIn("invalid syntax", voyager.messages[-1].content)
            voyager.env.reset.assert_not_called()
            voyager.env.step.assert_not_called()
            self.assertIsNone(voyager.recorder.init_position)
            resumed = EventRecorder(ckpt_dir=directory, resume=True)
            self.assertEqual(resumed.iteration, 1)
            # A valid subsequent observation must initialize the position normally.
            event = {"status": {"position": {"x": 2, "z": 3},
                                "elapsedTime": 20, "biome": "plains"}, "inventory": {}}
            voyager.recorder.record([["observe", event]], "Observe")
            self.assertEqual(voyager.recorder.init_position, [2, 3])


if __name__ == "__main__":
    unittest.main()
