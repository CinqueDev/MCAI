"""DeepSeek chat adapter for Voyager's existing LangChain messages."""

import os

from langchain.schema import AIMessage
from openai import OpenAI


DEFAULT_MODEL = "deepseek-flash"
DEFAULT_BASE_URL = "https://api.deepseek.com"


def resolve_api_key(api_key=None):
    key = api_key or os.environ.get("DEEPSEEK_API_KEY")
    if not key or not key.strip():
        raise ValueError(
            "Set DEEPSEEK_API_KEY or pass deepseek_api_key to Voyager. "
            "A DeepSeek API key is required."
        )
    return key


class DeepSeekChat:
    def __init__(
        self,
        model_name=DEFAULT_MODEL,
        temperature=0,
        request_timeout=240,
        api_key=None,
        base_url=None,
    ):
        self.model_name = model_name
        self.temperature = temperature
        self.client = OpenAI(
            api_key=resolve_api_key(api_key),
            base_url=base_url or os.environ.get("DEEPSEEK_BASE_URL") or DEFAULT_BASE_URL,
            timeout=request_timeout,
            max_retries=3,
        )

    def __call__(self, messages):
        roles = {"system": "system", "human": "user", "ai": "assistant"}
        response = self.client.chat.completions.create(
            model=self.model_name,
            messages=[
                {"role": roles[message.type], "content": message.content}
                for message in messages
            ],
            temperature=self.temperature,
            # Keep Voyager's temperature controls and avoid reasoning-only output.
            extra_body={"thinking": {"type": "disabled"}},
        )
        if not response.choices:
            raise ValueError("DeepSeek returned no completion choices.")
        choice = response.choices[0]
        if choice.finish_reason != "stop":
            raise ValueError(
                f"DeepSeek completion did not finish normally: {choice.finish_reason}"
            )
        if not choice.message.content or not choice.message.content.strip():
            raise ValueError("DeepSeek returned an empty answer.")
        return AIMessage(content=choice.message.content)
