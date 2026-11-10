import copy
import hashlib
import logging
from pathlib import Path
import json
import time
from typing import Dict

import voyager.utils as U
from .env import VoyagerEnv
from .conversation import ConversationWorker
from .llm import DEFAULT_MODEL, resolve_api_key

from .agents import ActionAgent
from .agents import CriticAgent
from .agents import CurriculumAgent
from .agents import SkillManager


# TODO: remove event memory
class Voyager:
    def __init__(
        self,
        mc_port: int = None,
        azure_login: Dict[str, str] = None,
        server_port: int = 3000,
        openai_api_key: str = None,
        env_wait_ticks: int = 20,
        env_request_timeout: int = 600,
        max_iterations: int = 160,
        reset_placed_if_failed: bool = False,
        action_agent_model_name: str = DEFAULT_MODEL,
        action_agent_temperature: float = 0,
        action_agent_task_max_retries: int = 4,
        action_agent_show_chat_log: bool = True,
        action_agent_show_execution_error: bool = True,
        curriculum_agent_model_name: str = DEFAULT_MODEL,
        curriculum_agent_temperature: float = 0,
        curriculum_agent_qa_model_name: str = DEFAULT_MODEL,
        curriculum_agent_qa_temperature: float = 0,
        curriculum_agent_warm_up: Dict[str, int] = None,
        curriculum_agent_core_inventory_items: str = r".*_log|.*_planks|stick|crafting_table|furnace"
        r"|cobblestone|dirt|coal|.*_pickaxe|.*_sword|.*_axe",
        curriculum_agent_mode: str = "auto",
        critic_agent_model_name: str = DEFAULT_MODEL,
        critic_agent_temperature: float = 0,
        critic_agent_mode: str = "auto",
        skill_manager_model_name: str = DEFAULT_MODEL,
        skill_manager_temperature: float = 0,
        skill_manager_retrieval_top_k: int = 5,
        openai_api_request_timeout: int = 240,
        ckpt_dir: str = "ckpt",
        skill_library_dir: str = None,
        resume: bool = False,
        deepseek_api_key: str = None,
        deepseek_base_url: str = None,
        api_request_timeout: int = None,
        mc_host: str = "localhost",
        mc_auth: str = "offline",
        mc_username: str = None,
        mc_version: str = None,
        mc_profiles_folder: str = ".minecraft-auth",
        mc_pause_mode: str = "auto",
        chat_enabled: bool = True,
        task_operators=None,
    ):
        """
        The main class for Voyager.
        Action agent is the iterative prompting mechanism in paper.
        Curriculum agent is the automatic curriculum in paper.
        Critic agent is the self-verification in paper.
        Skill manager is the skill library in paper.
        :param mc_port: minecraft in-game port
        :param mc_host: Minecraft server hostname or IP (default localhost)
        :param mc_auth: offline or microsoft (device-code login)
        :param mc_username: offline player name or Microsoft account/cache identifier
        :param mc_version: protocol version, or None for automatic detection
        :param mc_profiles_folder: local Microsoft token cache directory
        :param mc_pause_mode: auto, none, mod (/pause), or tick (/tick freeze and unfreeze)
        :param chat_enabled: enable background player conversation and queued requests
        :param azure_login: legacy local Minecraft launcher config
        :param server_port: mineflayer port
        :param openai_api_key: deprecated alias for deepseek_api_key (must be a DeepSeek key)
        :param env_wait_ticks: how many ticks at the end each step will wait, if you found some chat log missing,
        you should increase this value
        :param env_request_timeout: how many seconds to wait for each step, if the code execution exceeds this time,
        python side will terminate the connection and need to be resumed
        :param reset_placed_if_failed: whether to reset placed blocks if failed, useful for building task
        :param action_agent_model_name: action agent model name
        :param action_agent_temperature: action agent temperature
        :param action_agent_task_max_retries: how many times to retry if failed
        :param curriculum_agent_model_name: curriculum agent model name
        :param curriculum_agent_temperature: curriculum agent temperature
        :param curriculum_agent_qa_model_name: curriculum agent qa model name
        :param curriculum_agent_qa_temperature: curriculum agent qa temperature
        :param curriculum_agent_warm_up: info will show in curriculum human message
        if completed task larger than the value in dict, available keys are:
        {
            "context": int,
            "biome": int,
            "time": int,
            "other_blocks": int,
            "nearby_entities": int,
            "health": int,
            "hunger": int,
            "position": int,
            "equipment": int,
            "chests": int,
            "optional_inventory_items": int,
        }
        :param curriculum_agent_core_inventory_items: only show these items in inventory before optional_inventory_items
        reached in warm up
        :param curriculum_agent_mode: "auto" for automatic curriculum, "manual" for human curriculum
        :param critic_agent_model_name: critic agent model name
        :param critic_agent_temperature: critic agent temperature
        :param critic_agent_mode: "auto" for automatic critic ,"manual" for human critic
        :param skill_manager_model_name: skill manager model name
        :param skill_manager_temperature: skill manager temperature
        :param skill_manager_retrieval_top_k: how many skills to retrieve for each task
        :param openai_api_request_timeout: legacy alias for api_request_timeout
        :param ckpt_dir: checkpoint dir
        :param skill_library_dir: skill library dir
        :param resume: whether to resume from checkpoint
        :param deepseek_api_key: DeepSeek key, defaults to DEEPSEEK_API_KEY
        :param deepseek_base_url: defaults to DEEPSEEK_BASE_URL or https://api.deepseek.com
        :param api_request_timeout: DeepSeek request timeout in seconds (default 240)
        """
        # Validate credentials before starting Minecraft or creating checkpoint files.
        api_key = resolve_api_key(deepseek_api_key or openai_api_key)
        request_timeout = (
            api_request_timeout
            if api_request_timeout is not None
            else openai_api_request_timeout
        )

        # init env
        self.env = VoyagerEnv(
            mc_port=mc_port,
            mc_host=mc_host,
            mc_auth=mc_auth,
            mc_username=mc_username,
            mc_version=mc_version,
            mc_profiles_folder=mc_profiles_folder,
            mc_pause_mode=mc_pause_mode,
            azure_login=azure_login,
            server_port=server_port,
            request_timeout=env_request_timeout,
        )
        identity = f"{self.env.mc_host}:{self.env.mc_port}:{self.env.mc_auth}:{self.env.mc_username}"
        journal_key = hashlib.sha256(identity.encode()).hexdigest()[:16]
        self.env.task_journal_path = str(Path(ckpt_dir).resolve() / "tasks" / f"{journal_key}.json")
        self.env.task_operators = task_operators or []
        self.task_controller = self.env.tasks
        self.active_task = None
        self.env_wait_ticks = env_wait_ticks
        self.reset_placed_if_failed = reset_placed_if_failed
        self.max_iterations = max_iterations

        # init agents
        self.action_agent = ActionAgent(
            model_name=action_agent_model_name,
            temperature=action_agent_temperature,
            request_timout=request_timeout,
            api_key=api_key,
            base_url=deepseek_base_url,
            ckpt_dir=ckpt_dir,
            resume=resume,
            chat_log=action_agent_show_chat_log,
            execution_error=action_agent_show_execution_error,
        )
        self.conversation = ConversationWorker(
            self.env, ckpt_dir=ckpt_dir, task_client=self.task_controller, model_name=action_agent_model_name,
            temperature=0.7, request_timeout=min(request_timeout, 30),
            api_key=api_key, base_url=deepseek_base_url,
        )
        # A stalled social request must not hold up every following private reply.
        self.conversation.llm.client.max_retries = 0
        self.env.conversation = self.conversation if chat_enabled else None
        self.action_agent_task_max_retries = action_agent_task_max_retries
        self.curriculum_agent = CurriculumAgent(
            model_name=curriculum_agent_model_name,
            temperature=curriculum_agent_temperature,
            qa_model_name=curriculum_agent_qa_model_name,
            qa_temperature=curriculum_agent_qa_temperature,
            request_timout=request_timeout,
            api_key=api_key,
            base_url=deepseek_base_url,
            ckpt_dir=ckpt_dir,
            resume=resume,
            mode=curriculum_agent_mode,
            warm_up=curriculum_agent_warm_up,
            core_inventory_items=curriculum_agent_core_inventory_items,
        )
        self.critic_agent = CriticAgent(
            model_name=critic_agent_model_name,
            temperature=critic_agent_temperature,
            request_timout=request_timeout,
            api_key=api_key,
            base_url=deepseek_base_url,
            mode=critic_agent_mode,
        )
        self.skill_manager = SkillManager(
            model_name=skill_manager_model_name,
            temperature=skill_manager_temperature,
            retrieval_top_k=skill_manager_retrieval_top_k,
            request_timout=request_timeout,
            api_key=api_key,
            base_url=deepseek_base_url,
            ckpt_dir=skill_library_dir if skill_library_dir else ckpt_dir,
            resume=True if resume or skill_library_dir else False,
        )
        self.recorder = U.EventRecorder(ckpt_dir=ckpt_dir, resume=resume)
        self.resume = resume

        # init variables for rollout
        self.action_agent_rollout_num_iter = -1
        self.task = None
        self.context = ""
        self.messages = None
        self.conversations = []
        self.last_events = None

    def reset(self, task, context="", reset_env=True):
        self.action_agent_rollout_num_iter = 0
        self.task = task
        self.env.current_task = task
        self.context = context
        if reset_env:
            self.env.reset(
                options={
                    "mode": "soft",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        difficulty = (
            "easy" if len(self.curriculum_agent.completed_tasks) > 15 else "peaceful"
        )
        # step to peek an observation
        setup = "" if self.env.player_request else (
            "bot.chat(`/time set ${getNextTime()}`);\n"
            + f"bot.chat('/difficulty {difficulty}');"
        )
        events = self.env.step(setup)
        skills = self.skill_manager.retrieve_skills(query=self.context)
        print(
            f"\033[33mRender Action Agent system message with {len(skills)} skills\033[0m"
        )
        system_message = self.action_agent.render_system_message(skills=skills)
        human_message = self.action_agent.render_human_message(
            events=events, code="", task=self.task, context=context, critique=""
        )
        self.messages = [system_message, human_message]
        print(
            f"\033[32m****Action Agent human message****\n{human_message.content}\033[0m"
        )
        assert len(self.messages) == 2
        self.conversations = []
        return self.messages

    def close(self):
        self.env.close()

    def _control_result(self):
        controller = getattr(self, "task_controller", None)
        active = getattr(self, "active_task", None)
        if not controller or not active:
            return None
        record = controller.get(active["id"])
        if not record or record["state"] != "running" or record.get("needsReview"):
            return {"task": self.task, "success": False, "controlled": True,
                    "state": record["state"] if record else "cancelled", "interrupted": True}
        self.active_task = record
        self.env.execution = {"id": record["id"], "generation": record["generation"]}
        return None

    def step(self):
        if self.action_agent_rollout_num_iter < 0:
            raise ValueError("Agent must be reset before stepping")
        controlled = self._control_result()
        if controlled:
            return self.messages, 0, False, controlled
        ai_message = self.action_agent.llm(self.messages)
        controlled = self._control_result()
        if controlled:
            return self.messages, 0, False, controlled
        print(f"\033[34m****Action Agent ai message****\n{ai_message.content}\033[0m")
        self.conversations.append(
            (self.messages[0].content, self.messages[1].content, ai_message.content)
        )
        parsed_result = self.action_agent.process_ai_message(message=ai_message)
        success = False
        critique = ""
        if isinstance(parsed_result, dict):
            code = parsed_result["program_code"] + "\n" + parsed_result["exec_code"]
            events = self.env.step(
                code,
                programs=self.skill_manager.programs,
            )
            self.recorder.record(events, self.task)
            self.last_events = copy.deepcopy(events)
            controlled = self._control_result()
            if controlled:
                return self.messages, 0, False, controlled
            self.action_agent.update_chest_memory(events[-1][1]["nearbyChests"])
            success, critique = self.critic_agent.check_task_success(
                events=events,
                task=self.task,
                context=self.context,
                chest_observation=self.action_agent.render_chest_observation(),
                max_retries=5,
            )

            controlled = self._control_result()
            if controlled:
                return self.messages, 0, False, controlled

            if not critique:
                critique = "; ".join(str(event["onError"]) for kind, event in events if kind == "onError")

            if self.reset_placed_if_failed and not success and not self.env.player_request:
                # revert all the placing event in the last step
                blocks = []
                positions = []
                for event_type, event in events:
                    if event_type == "onSave" and event["onSave"].endswith("_placed"):
                        block = event["onSave"].split("_placed")[0]
                        position = event["status"]["position"]
                        blocks.append(block)
                        positions.append(position)
                new_events = self.env.step(
                    f"await givePlacedItemBack(bot, {U.json_dumps(blocks)}, {U.json_dumps(positions)})",
                    programs=self.skill_manager.programs,
                )
                events[-1][1]["inventory"] = new_events[-1][1]["inventory"]
                events[-1][1]["voxels"] = new_events[-1][1]["voxels"]
            new_skills = self.skill_manager.retrieve_skills(
                query=self.context
                + "\n\n"
                + self.action_agent.summarize_chatlog(events)
            )
            system_message = self.action_agent.render_system_message(skills=new_skills)
            human_message = self.action_agent.render_human_message(
                events=events,
                code=parsed_result["program_code"],
                task=self.task,
                context=self.context,
                critique=critique,
            )
            self.last_events = copy.deepcopy(events)
            self.messages = [system_message, human_message]
        else:
            assert isinstance(parsed_result, str)
            self.recorder.record([], self.task)
            self.messages[-1].content += f"\n\n{parsed_result}\nPlease correct the code and try again."
            print(f"\033[34m{parsed_result} Trying again!\033[0m")
        assert len(self.messages) == 2
        self.action_agent_rollout_num_iter += 1
        done = (
            self.action_agent_rollout_num_iter >= self.action_agent_task_max_retries
            or success
        )
        info = {
            "task": self.task,
            "success": success,
            "critique": critique,
            "conversations": self.conversations,
        }
        if success:
            assert (
                "program_code" in parsed_result and "program_name" in parsed_result
            ), "program and program_name must be returned when success"
            info["program_code"] = parsed_result["program_code"]
            info["program_name"] = parsed_result["program_name"]
        else:
            print(
                f"\033[32m****Action Agent human message****\n{self.messages[-1].content}\033[0m"
            )
        return self.messages, 0, done, info

    def rollout(self, *, task, context, reset_env=True):
        controller = getattr(self, "task_controller", None)
        if controller:
            record = controller.begin(task, context, getattr(self, "requested_task_id", None))
            if not record:
                return self.messages, 0, False, {"task": task, "success": False, "interrupted": True}
            self.active_task = record
            self.env.execution = {"id": record["id"], "generation": record["generation"]}
        self.reset(task=task, context=context, reset_env=reset_env)
        while True:
            messages, reward, done, info = self.step()
            if info.get("controlled"):
                record = controller.wait_running(self.active_task["id"])
                if not record or record["state"] != "running":
                    info["state"] = record["state"] if record else "cancelled"
                    break
                self.active_task = record
                self.env.execution = {"id": record["id"], "generation": record["generation"]}
                self.reset(task=task, context=context + " Recheck prior action receipts and the live world before continuing. Never repeat an uncertain item operation.", reset_env=False)
                continue
            if done:
                break
            if not self.env.player_request and self.conversation.has_tasks():
                info["interrupted"] = True
                break
        if controller:
            record = self.active_task
            if info.get("interrupted") and not info.get("controlled"):
                controller.yield_task(record)
            elif not info.get("controlled"):
                if not controller.complete(record, info["success"], info.get("critique", "Yielded to player request")):
                    info.update(controlled=True, interrupted=True, success=False)
            self.env.execution = None
            self.active_task = None
        return messages, reward, done, info

    def learn(self, reset_env=True):
        if self.resume:
            # keep the inventory
            self.env.reset(
                options={
                    "mode": "soft",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        else:
            # clear the inventory
            self.env.reset(
                options={
                    "mode": "hard",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
            self.resume = True
        self.last_events = self.env.step("")

        while True:
            if self.recorder.iteration > self.max_iterations:
                print("Iteration limit reached")
                break
            if getattr(self, "task_controller", None):
                self.task_controller.wait_ready()
            request = self.conversation.pop_task()
            self.requested_task_id = request.get("id") if request else None
            self.env.player_request = bool(request and (request.get("requester") or "id" not in request))
            self.env.task_recipient = request["recipient"] if request else None
            if request:
                task = request["task"]
                requester = request.get("requester", "the player identified in the task")
                context = (f"Explicit request from {requester}: {task}. Resolve me/my/here relative to this requester. Respect player property and storage."
                           if self.env.player_request else request.get("context", ""))
            else:
                task, context = self.curriculum_agent.propose_next_task(
                    events=self.last_events,
                    chest_observation=self.action_agent.render_chest_observation(),
                    max_retries=5,
                )
            print(
                f"\033[35mStarting task {task} for at most {self.action_agent_task_max_retries} times\033[0m"
            )
            try:
                messages, reward, done, info = self.rollout(
                    task=task,
                    context=context,
                    reset_env=reset_env,
                )
            except Exception as e:
                time.sleep(3)  # wait for mineflayer to exit
                info = {
                    "task": task,
                    "success": False,
                }
                if self.active_task:
                    try:
                        self.task_controller.complete(self.active_task, False, str(e))
                    except Exception:
                        logging.getLogger(__name__).warning("Could not finalize task after bridge failure; journal recovery will pause it")
                    self.active_task = None
                    self.env.execution = None
                # reset bot status here
                self.last_events = self.env.reset(
                    options={
                        "mode": "hard",
                        "wait_ticks": self.env_wait_ticks,
                        "inventory": self.last_events[-1][1]["inventory"],
                        "equipment": self.last_events[-1][1]["status"]["equipment"],
                        "position": self.last_events[-1][1]["status"]["position"],
                    }
                )
                # use red color background to print the error
                print("Your last round rollout terminated due to error:")
                print(f"\033[41m{e}\033[0m")

            if request and self.env.player_request and not info.get("controlled"):
                if info.get("critique"):
                    self.conversation.report_task(request, info["success"], info["critique"])
                else:
                    self.conversation.report_task(request, info["success"])
            if info["success"]:
                self.skill_manager.add_new_skill(info)

            if not info.get("interrupted"):
                self.curriculum_agent.update_exploration_progress(info)
            print(
                f"\033[35mCompleted tasks: {', '.join(self.curriculum_agent.completed_tasks)}\033[0m"
            )
            print(
                f"\033[35mFailed tasks: {', '.join(self.curriculum_agent.failed_tasks)}\033[0m"
            )

        return {
            "completed_tasks": self.curriculum_agent.completed_tasks,
            "failed_tasks": self.curriculum_agent.failed_tasks,
            "skills": self.skill_manager.skills,
        }

    def decompose_task(self, task):
        if not self.last_events:
            self.last_events = self.env.reset(
                options={
                    "mode": "hard",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        return self.curriculum_agent.decompose_task(task, self.last_events)

    def inference(self, task=None, sub_goals=[], reset_mode="hard", reset_env=True):
        if not task and not sub_goals:
            raise ValueError("Either task or sub_goals must be provided")
        if not sub_goals:
            sub_goals = self.decompose_task(task)
        self.env.reset(
            options={
                "mode": reset_mode,
                "wait_ticks": self.env_wait_ticks,
            }
        )
        self.curriculum_agent.completed_tasks = []
        self.curriculum_agent.failed_tasks = []
        self.last_events = self.env.step("")
        while self.curriculum_agent.progress < len(sub_goals):
            if getattr(self, "task_controller", None):
                self.task_controller.wait_ready()
            request = self.conversation.pop_task()
            self.requested_task_id = request.get("id") if request else None
            self.env.player_request = bool(request and request.get("requester"))
            self.env.task_recipient = request.get("recipient") if request else None
            expected_task = sub_goals[self.curriculum_agent.progress]
            next_task = request["task"] if request else expected_task
            context = request.get("context", "") if request else self.curriculum_agent.get_task_context(next_task)
            if self.env.player_request:
                context = f"Explicit request from {request['requester']}: {next_task}. Respect player property and storage."
            messages, reward, done, info = self.rollout(
                task=next_task, context=context, reset_env=reset_env,
            )
            if info.get("controlled"):
                return info
            if info.get("interrupted"):
                continue
            if request and self.env.player_request:
                self.conversation.report_task(request, info["success"], info.get("critique", ""))
            # Incidental chat work must not advance the specified subgoal list.
            if not request or (not request.get("requester") and next_task == expected_task):
                self.curriculum_agent.update_exploration_progress(info)
            print(f"Completed tasks: {', '.join(self.curriculum_agent.completed_tasks)}")
            print(f"Failed tasks: {', '.join(self.curriculum_agent.failed_tasks)}")
