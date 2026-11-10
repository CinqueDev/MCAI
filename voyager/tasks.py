"""Client for the Minecraft bridge's durable execution/task controller."""
import time

import requests


class TaskClient:
    def __init__(self, env):
        self.env = env

    def call(self, operation="snapshot", **values):
        response = requests.post(f"{self.env.server}/tasks", json={"operation": operation, **values}, timeout=10)
        response.raise_for_status()
        return response.json()

    def snapshot(self):
        return self.call()

    def enqueue(self, request, key=None):
        return self.call("enqueue", request={**request, "key": key})

    def claim(self):
        active = self.snapshot()["active"]
        if active and active["state"] == "running":
            return active
        return self.call("claim")

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

    def get(self, identifier):
        return self.call("get", id=identifier)

    def complete(self, record, success, reason=""):
        return self.call("complete", id=record["id"], generation=record["generation"], success=success, reason=reason)

    def yield_task(self, record):
        return self.call("yield", id=record["id"], generation=record["generation"])

    def queued(self):
        return [t for t in self.snapshot()["tasks"] if t["state"] == "queued"]

    def wait_ready(self):
        while True:
            state = self.snapshot()
            if not state["suspended"] and not state.get("busy"):
                return
            time.sleep(0.2)

    def wait_running(self, identifier):
        while True:
            record = self.get(identifier)
            if not record or record["state"] != "paused":
                return record
            time.sleep(0.2)
