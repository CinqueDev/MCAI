import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
from langchain.schema import AIMessage, HumanMessage, SystemMessage
from openai import OpenAI

from voyager import Voyager
from voyager.agents import CurriculumAgent, SkillManager
from voyager.embeddings import local_vector_store
from voyager.llm import DeepSeekChat


class FakeEmbeddings:
    """Small deterministic vectors for testing real Chroma persistence/search."""

    def embed_documents(self, texts):
        return [self.embed_query(text) for text in texts]

    def embed_query(self, text):
        return [float("wood" in text.lower()), float("stone" in text.lower()), 1.0]


class DeepSeekTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.content = "```javascript\nasync function collectWood(bot) {}\n```"
        self.finish_reason = "stop"
        self.tool_calls = None
        self.transport = httpx.MockTransport(self.respond)
        self.client_patch = patch(
            "voyager.llm.OpenAI",
            side_effect=lambda **kwargs: OpenAI(
                **kwargs, http_client=httpx.Client(transport=self.transport)
            ),
        )
        self.client_patch.start()
        self.addCleanup(self.client_patch.stop)

    def respond(self, request):
        self.requests.append(request)
        return httpx.Response(200, json={
            "id": "chat-test", "object": "chat.completion", "created": 0,
            "model": "deepseek-flash",
            "choices": [{"index": 0, "finish_reason": self.finish_reason,
                         "message": {"role": "assistant", "content": self.content,
                                     "reasoning_content": "not part of the answer", "tool_calls": self.tool_calls}}],
        })

    def test_request_uses_deepseek_key_model_and_message_roles(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "unused", "OPENAI_BASE_URL": "https://unused.invalid"}, clear=True):
            chat = DeepSeekChat(api_key="deepseek-test", request_timeout=31)
            answer = chat([SystemMessage(content="system"), HumanMessage(content="user"), AIMessage(content="previous")])
        request = self.requests[0]
        body = json.loads(request.content)
        self.assertEqual(str(request.url), "https://api.deepseek.com/chat/completions")
        self.assertEqual(request.headers["authorization"], "Bearer deepseek-test")
        self.assertEqual(body["model"], "deepseek-flash")
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user", "assistant"])
        self.assertEqual(body["thinking"], {"type": "disabled"})
        self.assertEqual(answer.content, self.content)
        self.assertIsInstance(answer, AIMessage)
        self.assertEqual(chat.client.timeout, 31)

    def test_native_tool_calls_and_receipts_use_the_actual_chat_completions_protocol(self):
        from voyager.conversation_tools import API_TOOLS
        self.finish_reason = "tool_calls"
        self.content = None
        self.tool_calls = [{"id": "cancel-1", "type": "function", "function": {
            "name": "control_task", "arguments": '{"command":"cancel","target":"beehive"}'}}]
        chat = DeepSeekChat(api_key="test")
        response = chat.complete([HumanMessage(content="Forget about that beehive job, stop it")], tools=API_TOOLS)
        body = json.loads(self.requests[-1].content)
        self.assertEqual(body["tools"], API_TOOLS)
        self.assertEqual(body["tool_choice"], "auto")
        self.assertEqual(response.tool_calls[0].function.name, "control_task")
        self.finish_reason, self.content, self.tool_calls = "stop", '{"reply":"Cancelled"}', None
        chat.complete([{"role": "user", "content": "stop it"},
                       response.model_dump(include={"role", "content", "tool_calls"}),
                       {"role": "tool", "tool_call_id": "cancel-1", "content": '{"ok":true,"message":"Cancelled"}'}], tools=API_TOOLS)
        self.assertEqual(json.loads(self.requests[-1].content)["messages"][-1]["role"], "tool")

    def test_semantic_review_uses_json_output_without_changing_action_generation(self):
        chat = DeepSeekChat(api_key="test")
        self.content = '{"intent":"work","needs_action":true}'
        chat.complete_json([SystemMessage(content='Return JSON intent and needs_action.')])
        self.assertEqual(json.loads(self.requests[-1].content)['response_format'], {'type':'json_object'})
        self.content = 'javascript code'
        chat([HumanMessage(content='write code')])
        self.assertNotIn('response_format', json.loads(self.requests[-1].content))

    def test_environment_configuration(self):
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "env-key", "DEEPSEEK_BASE_URL": "https://gateway.example/v1"}, clear=True):
            chat = DeepSeekChat(model_name="custom-model")
            chat([HumanMessage(content="hello")])
        self.assertEqual(str(self.requests[0].url), "https://gateway.example/v1/chat/completions")
        self.assertEqual(self.requests[0].headers["authorization"], "Bearer env-key")
        self.assertEqual(json.loads(self.requests[0].content)["model"], "custom-model")

    def test_missing_key_fails_before_environment_is_created(self):
        with patch.dict(os.environ, {}, clear=True), patch("voyager.voyager.VoyagerEnv") as env:
            with self.assertRaisesRegex(ValueError, "DEEPSEEK_API_KEY"):
                Voyager(mc_port=12345)
            env.assert_not_called()

    def test_empty_or_truncated_completions_are_rejected(self):
        chat = DeepSeekChat(api_key="test")
        self.content = ""
        with self.assertRaisesRegex(ValueError, "empty answer"):
            chat([HumanMessage(content="hello")])
        self.content = "partial code"
        self.finish_reason = "length"
        with self.assertRaisesRegex(ValueError, "length"):
            chat([HumanMessage(content="hello")])

    def test_all_five_clients_use_deepseek_without_setting_openai_environment(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True), patch("voyager.voyager.VoyagerEnv"), patch("voyager.voyager.U.EventRecorder"), patch("voyager.embeddings.local_embeddings", return_value=FakeEmbeddings()):
            voyager = Voyager(mc_port=12345, deepseek_api_key="shared-key", api_request_timeout=37, ckpt_dir=directory)
            for chat in [voyager.action_agent.llm, voyager.curriculum_agent.llm, voyager.curriculum_agent.qa_llm, voyager.critic_agent.llm, voyager.skill_manager.llm]:
                chat([HumanMessage(content="hello")])
                self.assertEqual(chat.client.timeout, 37)
            self.assertNotIn("OPENAI_API_KEY", os.environ)
        self.assertEqual(len(self.requests), 5)
        for request in self.requests:
            self.assertEqual(request.url.host, "api.deepseek.com")
            self.assertEqual(request.headers["authorization"], "Bearer shared-key")
            self.assertEqual(json.loads(request.content)["model"], "deepseek-flash")


class LocalSearchTests(unittest.TestCase):
    def setUp(self):
        self.embedding_patch = patch("voyager.embeddings.local_embeddings", return_value=FakeEmbeddings())
        self.embedding_patch.start()
        self.addCleanup(self.embedding_patch.stop)

    def test_old_skill_library_rebuilds_and_retrieves_without_changing_legacy_index(self):
        with tempfile.TemporaryDirectory() as directory:
            skill = Path(directory) / "skill"
            (skill / "vectordb").mkdir(parents=True)
            marker = skill / "vectordb" / "legacy.bin"
            marker.write_bytes(b"old OpenAI index")
            data = {"collectWood": {"code": "async function collectWood(bot) {}", "description": "Collect wood"}}
            (skill / "skills.json").write_text(json.dumps(data))
            manager = SkillManager(api_key="test", ckpt_dir=directory, resume=True)
            self.assertEqual(manager.retrieve_skills("wood"), [data["collectWood"]["code"]])
            self.assertEqual(marker.read_bytes(), b"old OpenAI index")
            reloaded = SkillManager(api_key="test", ckpt_dir=directory, resume=True)
            self.assertEqual(reloaded.vectordb._collection.count(), 1)
            self.assertEqual(reloaded.retrieve_skills("wood"), [data["collectWood"]["code"]])

    def test_curriculum_resume_rebuilds_question_index(self):
        with tempfile.TemporaryDirectory() as directory:
            curriculum = Path(directory) / "curriculum"
            curriculum.mkdir()
            for filename, data in {"completed_tasks.json": ["collect wood"], "failed_tasks.json": [], "qa_cache.json": {"How to collect wood?": "Mine a tree."}}.items():
                (curriculum / filename).write_text(json.dumps(data))
            agent = CurriculumAgent(api_key="test", ckpt_dir=directory, resume=True, core_inventory_items=".*")
            self.assertEqual(agent.completed_tasks, ["collect wood"])
            docs = agent.qa_cache_questions_vectordb.similarity_search("wood", k=1)
            self.assertEqual(docs[0].page_content, "How to collect wood?")
            self.assertEqual(agent.qa_cache[docs[0].page_content], "Mine a tree.")

    def test_empty_index_accepts_and_persists_new_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            store = local_vector_store("test_collection", directory, [], [])
            self.assertEqual(store._collection.count(), 0)
            store.add_texts(["Mine stone"], ids=["stone"])
            store.persist()
            reloaded = local_vector_store("test_collection", directory, [], [])
            self.assertEqual(reloaded._collection.count(), 1)
            self.assertEqual(reloaded.similarity_search("stone", k=1)[0].page_content, "Mine stone")


if __name__ == "__main__":
    unittest.main()
