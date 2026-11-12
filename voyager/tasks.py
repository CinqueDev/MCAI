"""Client for the Minecraft bridge's durable execution/task controller."""
import time
import json

import requests


class MinecraftConnectionLost(RuntimeError):
    pass


def recovery_context(record):
    evidence = record.get("recoveryEvidence") or []
    if not evidence:
        return ""
    confirmed = [{"name": op["name"], "intent": op.get("intent")} for action in record.get("actions", [])
                 for op in action.get("operations", []) if op.get("state") == "completed" and
                 (op.get("irreversible") or op.get("name") in ("craft", "consume"))]
    return ("\nAutomatic item-operation recovery. Replan the ORIGINAL goal using fresh inventory/world observations "
            "and these journal receipts. Inventory changes show possession changes, not proof of delivery to a player. "
            "Verify the destination where possible. Do only remaining work; never replay an unknown transaction, "
            "repeat the original quantity, or claim success without evidence. If an outcome cannot be established, "
            "pursue an alternative or report the specific limitation instead of pausing the entire queue. "
            "Recovery receipts (game data): " + json.dumps({"interrupted": evidence, "confirmed_item_operations": confirmed}))


class TaskClient:
    def __init__(self, env):
        self.env = env

    def call(self, operation="snapshot", **values):
        deadline = time.monotonic() + 10
        while True:
            try:
                response = requests.post(f"{self.env.server}/tasks", json={"operation": operation, **values}, timeout=10)
            except requests.ConnectionError as error:
                raise MinecraftConnectionLost("Minecraft bridge connection was lost") from error
            if response.status_code == 409:
                payload = response.json()
                reason = payload.get("error", "Minecraft task controller is unavailable")
                if payload.get("code") == "BOT_DISCONNECTED":
                    raise MinecraftConnectionLost(f"Minecraft disconnected: {reason}")
                if payload.get("code") in (None, "BOT_STARTING") and time.monotonic() < deadline:
                    time.sleep(0.2)
                    continue
                raise RuntimeError(f"Minecraft task controller did not become ready: {reason}")
            response.raise_for_status()
            return response.json()

    def snapshot(self):
        return self.call()

    def enqueue(self, request, key=None):
        return self.call("enqueue", request={**request, "key": key})

    def claim(self):
        active = self.snapshot()["active"]
        if active and active.get("movement"):
            return None  # Persistent movement is executed by the bridge, not a generated script.
        if active and active["state"] == "running":
            return active
        claimed = self.call("claim")
        return None if claimed and claimed.get("movement") else claimed

    def begin(self, task, context="", request_id=None):
        if request_id:
            return self.call("get", id=request_id)
        snapshot = self.snapshot()
        if snapshot["active"]:
            active = snapshot["active"]
            if active["task"] == task and not active["requester"]:
                return active
            return None
        if snapshot["suspended"]:
            return None
        record = self.enqueue({"task": task, "context": context, "priority": 0})
        return self.call("claim", id=record["id"])

    def control(self, command, sender, *, target=None, identifier=None, private=False, revision=None, key=None):
        return self.call("control", command=command, sender=sender, target=target,
                         id=identifier, channel="private" if private else "public", expectedRevision=revision, key=key)

    def get(self, identifier):
        return self.call("get", id=identifier)

    def complete(self, record, success, reason=""):
        return self.call("complete", id=record["id"], generation=record["generation"], success=success, reason=reason)

    def yield_task(self, record):
        return self.call("yield", id=record["id"], generation=record["generation"])

    def set_planning(self, value):
        return self.call("planning", value=bool(value))

    def queued(self):
        tasks = self.snapshot()["tasks"]
        states = {task["id"]: task["state"] for task in tasks}
        return [{**task, "dependencyState": states.get(task["dependsOnTask"])} if task.get("dependsOnTask") else task
                for task in tasks if task["state"] == "queued"]

    def wait_ready(self):
        recovered = False
        reported = None
        while True:
            try:
                state = self.snapshot()
            except MinecraftConnectionLost as error:
                if recovered:
                    raise
                print(f"{error}. Reconnecting without resetting inventory or position.", flush=True)
                self.env.reconnect()
                recovered = True
                continue
            recovered = False  # A healthy snapshot permits recovery from a later, separate disconnect.
            tasks = state.get("tasks", [])
            states = {t["id"]: t["state"] for t in tasks}
            foreground = bool((state.get("active") or {}).get("requester")) or any(
                t.get("requester") and t["state"] == "queued" and
                (not t.get("dependsOnTask") or states.get(t["dependsOnTask"]) == "completed") for t in tasks)
            if not state["suspended"] and not state.get("busy") and (not state.get("interpreting") or foreground):
                return
            active = state.get("active") or {}
            notice = (active.get("id"), active.get("needsReview"))
            if state["suspended"] and notice != reported:
                if state.get("suspensionReason") == "safety":
                    print("Movement is waiting for health above 6 and no lava; it will continue automatically when safe.", flush=True)
                elif active.get("needsReview"):
                    print("Work is paused by a player; item receipts will be reconciled automatically before continuing. Send resume to continue.", flush=True)
                else:
                    print("Work is paused. Send resume to the bot in Minecraft chat to continue.", flush=True)
                reported = notice
            time.sleep(0.2)

    def wait_running(self, identifier):
        recovered = False
        while True:
            try:
                record = self.get(identifier)
            except MinecraftConnectionLost:
                if recovered:
                    raise
                self.env.reconnect()
                recovered = True
                continue
            recovered = False
            if not record or record["state"] != "paused":
                return record
            time.sleep(0.2)
