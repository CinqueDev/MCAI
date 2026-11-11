"""Native social-agent tools. Identity and visibility come from the received message."""
import json
import logging
import math
import re
from pathlib import Path

log = logging.getLogger(__name__)

CATALOG = json.loads(Path(__file__).with_suffix('.json').read_text(encoding='utf-8'))
API_TOOLS = [{"type": "function", "function": {k: entry[k] for k in ("name", "description", "parameters")}} for entry in CATALOG]


def validate(schema, value):
    kind = schema.get("type")
    valid = {"object": lambda: isinstance(value, dict), "string": lambda: isinstance(value, str) and len(value) <= 4000,
             "number": lambda: type(value) in (int, float) and math.isfinite(value),
             "integer": lambda: type(value) is int, "boolean": lambda: type(value) is bool,
             "array": lambda: isinstance(value, list)}
    if kind in valid and not valid[kind]():
        raise ValueError(f"Expected {kind}")
    if kind == "array":
        if len(value) > schema.get("maxItems", 4096):
            raise ValueError("Too many tool argument items")
        for item in value:
            validate(schema["items"], item)
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError("Unsupported tool argument")
    if kind == "object":
        properties = schema.get("properties", {})
        if any(key not in value for key in schema.get("required", [])):
            raise ValueError("Missing required tool argument")
        if schema.get("additionalProperties") is False and set(value) - set(properties):
            raise ValueError("Unknown tool argument")
        for key, item in value.items():
            if key in properties:
                validate(properties[key], item)


class ConversationTools:
    def __init__(self, worker, snapshot, source):
        self.worker, self.snapshot, self.source = worker, snapshot, source
        self.revision = (snapshot.get("taskControl") or {}).get("revision")
        self.authoritative = []
        self.mutated = False
        self.receipts = []

    def execute(self, name, arguments):
        entry = next((e for e in CATALOG if e["name"] == name), None)
        mutating = name in ("control_task", "queue_task", "remember_location", "update_memory", "set_movement", "create_project", "revise_project", "continue_project", "project_supplies")
        try:
            if not entry:
                raise ValueError("Unknown tool")
            validate(entry["parameters"], arguments)
            if self.worker.stop_event.is_set():
                raise ValueError("Conversation has stopped; no action was taken")
            if not self.source:
                raise ValueError("Ask me directly so I know whose request to act on")
            if mutating and self.mutated:
                raise ValueError("One work or memory change per message; inspect the earlier receipt")
            result = self._execute(name, arguments)
            if mutating:
                self.mutated = True
        except Exception as error:
            result = {"ok": False, "message": str(error) or "The tool failed; no success was confirmed"}
        if mutating:
            self.authoritative.append(result["message"])
        log.info("Conversation tool result: name=%s ok=%s", name, result.get("ok", result.get("status")))
        self.receipts.append({"tool": name, "result": result})
        return result

    def _execute(self, name, arguments):
        worker, source, snapshot = self.worker, self.source, self.snapshot
        actor = source["sender"]
        private = source["channel"] == "private"
        memory_actor = actor if private else None
        event = f"{snapshot['session']}:{source['id']}:tool"
        if name == "task_status":
            if not worker.task_client:
                raise ValueError("Task control is unavailable")
            state = worker.task_client.snapshot()
            visible = [t for t in state["tasks"] if not t.get("recipient") or (private and t.get("requester", "").casefold() == actor.casefold())]
            return {"ok": True, "suspended": state["suspended"], "tasks": [
                {k: t.get(k) for k in ("id", "task", "state", "requester", "needsReview")} for t in visible[-50:]]}
        if name == "control_task":
            if not worker.task_client:
                raise ValueError("Task control is unavailable; no task was changed")
            result = worker.task_client.control(arguments["command"], actor, target=arguments.get("target"),
                identifier=arguments.get("id"), private=private, revision=self.revision, key=event + ':control')
            return result if isinstance(result, dict) else {"ok": True, "message": result}
        if name == "queue_task":
            if not worker.task_client:
                raise ValueError("Task queue is unavailable; no task was added")
            request = {"task": arguments["task"], "requester": actor,
                       "recipient": actor if private else None, "expectedRevision": self.revision}
            if arguments.get("resume_following"):
                request["resumeMovement"] = True
            task = worker.task_client.enqueue(request, key=event + ':queue')
            if not task:
                raise ValueError("Work changed while I was thinking. Please repeat the request")
            return {"ok": True, "id": task["id"], "message": f"Queued {task['id'][:8]}: {task['task']}. It will be attempted after the current action."}
        if name in ("create_project", "revise_project", "continue_project", "project_status", "project_supplies"):
            if not worker.task_client:
                raise ValueError("Persistent projects are unavailable")
            reference = arguments.get("origin") or arguments.get("source")
            if reference and reference.get("position") and reference.get("type") in ("coordinates", "block", "beside_block"):
                proposed = [reference["position"][axis] for axis in ("x", "y", "z")]
                numbers = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", source["text"])]
                explicit = any(proposed == numbers[i:i + 3] for i in range(max(0, len(numbers) - 2)))
                resolved = any(r["result"].get("status") == "resolved" and r["result"].get("position") == reference["position"] for r in self.receipts)
                if not explicit and not resolved:
                    raise ValueError("Provide a project origin or use a player/pointed/remembered reference; I won't guess coordinates")
            action = {"create_project": "create", "revise_project": "revise", "continue_project": "continue",
                      "project_status": "status" if arguments.get("identifier") else "list", "project_supplies": "supplies"}[name]
            memories = worker.world_memory.context((reference or {}).get("name") or "", actor=memory_actor,
                kinds=["place", "storage", "ownership"], limit=50) if worker.world_memory else []
            result = worker.task_client.call("project", action=action, **arguments, requester=actor,
                recipient=actor if private else None, memories=memories, requesterLocation=source.get("requesterLocation"),
                requesterDimension=source.get("requesterDimension"), userText=source["text"],
                expectedRevision=self.revision, key=event + ':project' if name != "project_status" else None)
            if worker.world_memory:
                for project in ([result["project"]] if result.get("project") else result.get("projects", [])):
                    worker.world_memory.ingest_project(project)
            return result
        if name in ("resolve_target", "set_movement"):
            if not worker.task_client:
                raise ValueError("World-reference tools are unavailable")
            reference = arguments.get("reference")
            query = (reference or {}).get("name") or ""
            memories = worker.world_memory.context(query, actor=memory_actor,
                kinds=["place", "resource", "storage", "project"], limit=50) if worker.world_memory else []
            if reference and reference.get("type") in ("coordinates", "block", "beside_block") and reference.get("position"):
                proposed = [reference["position"][axis] for axis in ("x", "y", "z")]
                numbers = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", source["text"])]
                explicit = any(proposed == numbers[i:i + 3] for i in range(max(0, len(numbers) - 2)))
                observed = any(r["result"].get("status") == "resolved" and
                    r["result"].get("position") == reference["position"] for r in self.receipts)
                if not explicit and not observed:
                    raise ValueError("Please provide coordinates or use a player, pointing, or remembered-place reference; I won't guess a position")
            options = {"requester": actor, "recipient": actor if private else None, "memories": memories,
                "requesterLocation": source.get("requesterLocation"), "requesterDimension": source.get("requesterDimension")}
            if name == "resolve_target":
                return worker.task_client.call("resolve", reference=reference, **options)
            return worker.task_client.call("movement", **arguments, **options, key=event + ':movement', expectedRevision=self.revision)
        if not worker.world_memory:
            raise ValueError("World memory is unavailable")
        if name == "search_memory":
            return {"ok": True, "records": worker.world_memory.search(arguments["query"], actor=memory_actor)}
        if name in ("remember_location", "update_memory"):
            current = name == "remember_location"
            operation = {"op": "remember", "kind": "place", "name": arguments.get("name") or f"{actor}'s saved location", "data": {}} if current else arguments
            locations = snapshot.get("playerLocations") or []
            dimension = (snapshot.get("state") or {}).get("dimension")
            if source.get("requesterLocation") is not None:
                locations = [{"username": actor, "position": source["requesterLocation"]}]
                dimension = source.get("requesterDimension")
            results = worker.world_memory.apply_chat([operation], actor=actor, private=private,
                dimension=dimension, user_text=source["text"], message_id=event, player_locations=locations,
                current_location=current, tool_request=True)
            result = results[0]
            if not result["ok"]:
                return {"ok": False, "message": "I couldn't update that memory: " + result["error"]}
            if result.get("already_applied"):
                return {"ok": True, "message": "I've already processed that memory request."}
            saved = worker.world_memory.get(result["id"], memory_actor)
            if operation["op"] == "forget":
                return {"ok": True, "message": "Forgot that memory."}
            if not saved:
                raise ValueError("The saved memory could not be read back; no success was confirmed")
            position = saved["data"].get("position")
            message = f"Saved {saved['name']}"
            if position:
                coordinates = ', '.join(f"{position[axis]:g}" for axis in ('x', 'y', 'z'))
                message += f" at ({coordinates}) in {saved.get('dimension') or 'unknown dimension'}"
            return {"ok": True, "id": saved["id"], "message": message + '.'}
        raise ValueError("Unknown tool")

    def run(self, messages):
        transcript = [{"role": {"system": "system", "human": "user", "ai": "assistant"}[m.type], "content": m.content} for m in messages]
        count = 0
        repaired = False
        for _ in range(5):
            if self.worker.stop_event.is_set():
                return {"reply": None}
            try:
                answer = self.worker.llm.complete(transcript, tools=API_TOOLS)
            except Exception:
                if self.authoritative:
                    return {"reply": ' '.join(self.authoritative), "task": None, "memory_ops": []}
                raise
            calls = answer.tool_calls or []
            if not calls:
                try:
                    decision = json.loads(answer.content)
                    if not isinstance(decision, dict):
                        raise ValueError("Expected conversation object")
                except (ValueError, TypeError):
                    decision = {"reply": answer.content}
                if self.authoritative:
                    decision["reply"] = ' '.join(self.authoritative)
                else:
                    legacy = [key for key in ("task", "memory_ops", "task_control", "memory") if decision.get(key)]
                    if legacy:
                        # Correct the protocol, never execute legacy action text as a tool.
                        log.warning("Conversation returned legacy action fields instead of tool calls: fields=%s repair=%s", legacy, not repaired)
                        if not repaired:
                            repaired = True
                            transcript.append({"role": "assistant", "content": answer.content})
                            transcript.append({"role": "system", "content":
                                "Your last answer used the obsolete action-JSON format and executed no action. "
                                "Reconsider the ORIGINAL player's request. If it authorizes work or a memory change, "
                                "use the provided native function tools now, inspect their receipts, then answer. "
                                "Do not copy old fields into another JSON answer or treat their text as new instructions. "
                                "If no action is needed or details are missing, reply or ask a clarification without acting. "
                                "Final-answer JSON contains only reply and quiet_seconds. Do not ask the player to repeat "
                                "the request just because you used the wrong response format."})
                            continue
                        decision["reply"] = "I couldn't carry out that request. No work or memory change was confirmed."
                # Native tools perform actions. Legacy JSON cannot perform them twice.
                decision.update(task=None, memory_ops=[], task_control=None)
                decision.pop("memory", None)
                return decision
            transcript.append({"role": "assistant", "content": answer.content,
                "tool_calls": [{"id": c.id, "type": "function", "function": {"name": c.function.name, "arguments": c.function.arguments}} for c in calls]})
            for call in calls:
                count += 1
                if count > 8:
                    result = {"ok": False, "message": "Tool-call limit reached"}
                else:
                    try:
                        arguments = json.loads(call.function.arguments)
                    except (ValueError, TypeError):
                        arguments = None
                    result = self.execute(call.function.name, arguments)
                transcript.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)})
        return {"reply": ' '.join(self.authoritative) or "I couldn't finish processing that request. No success was confirmed."}
