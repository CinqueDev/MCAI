# Voyager with DeepSeek

This fork of [MineDojo/Voyager](https://github.com/MineDojo/Voyager) uses
DeepSeek for Minecraft action generation, curriculum planning, question answering,
task verification, and skill descriptions. All five chat clients default to
`deepseek-flash`, the current Flash API alias documented by
[DeepSeek](https://api-docs.deepseek.com/).

Skill and question retrieval use the local
`sentence-transformers/all-MiniLM-L6-v2` embedding model. No OpenAI account or
embedding API key is needed. The `openai` Python package is used only as the
OpenAI-compatible HTTP client for DeepSeek.

## Installation

Use Python **3.10 or 3.11** for Voyager's legacy Chroma/LangChain dependencies,
and Node.js 18 or newer. From the repository root:

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
cd voyager/env/mineflayer
npm install
cd ../../..
```

Set up Minecraft Java Edition 1.19 using the existing guides:
[Minecraft instance](installation/minecraft_instance_install.md) and
[Fabric mods](installation/fabric_mods_install.md). For a manual launcher session,
open a world to LAN with cheats enabled and note its port.

## Run with DeepSeek

Create a key in the [DeepSeek API platform](https://platform.deepseek.com/), then
set it in the same terminal used to run Voyager:

```bash
export DEEPSEEK_API_KEY='your-deepseek-api-key'
python run.py --mc-port 12345
```

Replace `12345` with the LAN port shown by Minecraft. The first run downloads the
embedding model from Hugging Face; later searches run locally on the CPU.
DeepSeek chat requests still require internet access and a funded API account.
An `.env` file is not loaded automatically; export the variable in your shell.

You can also use the Python interface:

```python
from voyager import Voyager

voyager = Voyager(mc_port=12345)
voyager.learn()
```

Pass `deepseek_api_key="..."` to supply a key explicitly. The optional
`deepseek_base_url` (or `DEEPSEEK_BASE_URL` environment variable) defaults to
`https://api.deepseek.com`. `api_request_timeout` defaults to 240 seconds.
Each agent's existing `*_model_name` parameter remains configurable.
Thinking mode is explicitly disabled to preserve temperature controls and use
the final-answer format expected by Voyager's code and JSON parsers.

The old `openai_api_key` argument remains a compatibility alias for a **DeepSeek**
key. The old `openai_api_request_timeout` argument also remains supported.
`OPENAI_API_KEY` and `OPENAI_API_BASE` are not used.

## Saved skills and checkpoints

```bash
python run.py --mc-port 12345 --resume --ckpt-dir ckpt
```

For an existing skill library, use
`Voyager(mc_port=12345, skill_library_dir="skill_library/trial1")`.
On first load, local search indexes are rebuilt from `skill/skills.json` and
`curriculum/qa_cache.json` when applicable. They are saved in separate
`vectordb-local-minilm` directories, preserving the old OpenAI `vectordb`
directories. Code, descriptions, completed tasks, and cached answers are retained.
Retrieval rankings can differ because the embedding model has changed.

## Tests

```bash
python -m unittest discover -s tests -v
```

Tests use a mocked HTTP transport and local synthetic embeddings; they do not
spend API credits, download embedding weights, or start Minecraft.
