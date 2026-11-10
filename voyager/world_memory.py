"""Scoped, evidence-backed world knowledge shared by conversation and planning."""
import ast
from datetime import datetime
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
import uuid

KINDS = {"place", "resource", "storage", "experience", "project", "preference", "ownership"}
SOURCES = {"observed", "reported", "inferred", "legacy"}
TTL = {"resource": 1800, "storage": 300, "place": 86400, "experience": None,
       "project": None, "preference": None, "ownership": None}

# Shared by request parsing and coordinate grounding so accepted requests cannot
# subsequently be rejected for using a different description of the same place.
CURRENT_PLAYER_PLACE = (
    r"(?:here|this (?:location|place|spot|position)|"
    r"my (?:current )?(?:location|position|coordinates|coords)|"
    r"(?:the )?(?:location|place|spot|position) (?:where |that )?"
    r"I(?: am|'m) (?:currently )?(?:at|in|standing)|"
    r"where I(?: am|'m)(?: (?:currently )?(?:standing|located))?|"
    r"where I currently am)(?: (?:right )?now)?"
)
CURRENT_PLAYER_LOCATION = re.compile(r"\b(?:" + CURRENT_PLAYER_PLACE + r"|qui|qua)\b", re.I)


def position(value):
    if value is None:
        return None
    if not isinstance(value, dict) or any(type(value.get(k)) not in (int, float) or not math.isfinite(value[k]) for k in ("x", "y", "z")):
        raise ValueError("Position must contain finite x, y, z coordinates")
    return {k: value[k] for k in ("x", "y", "z")}


MEMORY_OPERATIONS = {"remember", "correct", "rename", "forget"}
OPERATION_ALIASES = {"save": "remember", "add": "remember", "create": "remember", "store": "remember",
                     "update": "correct", "edit": "correct", "delete": "forget", "remove": "forget"}


def normalize_memory_operation(value):
    """Normalize naming variations only; all authorization and grounding follows."""
    if not isinstance(value, dict):
        raise ValueError("Each memory operation must be a JSON object")
    operation = dict(value)
    verb = next((operation[key] for key in ("op", "operation", "action")
                 if isinstance(operation.get(key), str) and operation[key].strip()), None)
    if verb is None and isinstance(operation.get("type"), str):
        candidate = operation["type"].strip().casefold()
        if candidate in MEMORY_OPERATIONS or candidate in OPERATION_ALIASES:
            verb = candidate
    if verb is not None:
        verb = verb.strip().casefold()
        verb = OPERATION_ALIASES.get(verb, verb)
    if verb not in MEMORY_OPERATIONS:
        raise ValueError("Memory action must specify op: remember, correct, rename or forget")
    operation["op"] = verb
    data = operation.get("data", {})
    if not isinstance(data, dict):
        raise ValueError("Memory data must be a JSON object")
    operation["data"] = dict(data)
    return operation


class WorldMemory:
    def __init__(self, path, *, server, account, world_id, clock=time.time, operators=()):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(str(self.path), os.O_CREAT | os.O_RDWR, 0o600)
        os.close(descriptor)
        self.world = hashlib.sha256(json.dumps([server.casefold(), account.casefold(), world_id]).encode()).hexdigest()
        self.clock = clock
        self.operators = {name.casefold() for name in operators}
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(self.path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        if self.db.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
            self.db.close()
            raise ValueError("Unsupported world memory database version")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS records (
              id TEXT PRIMARY KEY, world TEXT NOT NULL, scope TEXT NOT NULL, dimension TEXT,
              kind TEXT NOT NULL, record_key TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL,
              source TEXT NOT NULL, source_player TEXT, evidence TEXT NOT NULL,
              observed_at REAL, verified_at REAL, updated_at REAL NOT NULL, expires_at REAL,
              validity TEXT NOT NULL DEFAULT 'unverified', deleted_at REAL);
            CREATE UNIQUE INDEX IF NOT EXISTS record_identity ON records(world,scope,COALESCE(dimension,''),kind,record_key);
            CREATE INDEX IF NOT EXISTS memory_retrieval ON records(world,scope,dimension,kind,updated_at);
            CREATE TABLE IF NOT EXISTS aliases(world TEXT, name TEXT, player_key TEXT, PRIMARY KEY(world,name));
            CREATE TABLE IF NOT EXISTS links(child TEXT, parent TEXT, PRIMARY KEY(child,parent));
            CREATE TABLE IF NOT EXISTS seen_events(world TEXT, event_id TEXT, PRIMARY KEY(world,event_id));
            CREATE TABLE IF NOT EXISTS episodes(id INTEGER PRIMARY KEY, world TEXT, record_id TEXT, scope TEXT, created REAL, payload TEXT);
            CREATE TABLE IF NOT EXISTS migrations(path TEXT PRIMARY KEY, world TEXT, imported_at REAL);
            PRAGMA user_version=1;
        """)
        self.db.commit()

    def close(self):
        with self.lock:
            self.db.close()

    def player_key(self, name):
        if not name or not isinstance(name, str):
            raise ValueError("A player identity is required")
        row = self.db.execute("SELECT player_key FROM aliases WHERE world=? AND name=?", (self.world, name.casefold())).fetchone()
        return row[0] if row else "name:" + name.casefold()

    def scope(self, actor=None):
        with self.lock:
            return "private:" + self.player_key(actor) if actor else "public"

    def register_players(self, players):
        with self.lock, self.db:
            for player in players or []:
                if not isinstance(player, dict):
                    continue
                name, identifier = player.get("username"), player.get("uuid")
                if not name or not identifier:
                    continue
                try:
                    target = "uuid:" + str(uuid.UUID(identifier))
                except (ValueError, TypeError, AttributeError):
                    continue
                old = self.player_key(name)
                if old != target and old.startswith("name:"):
                    records = self.db.execute("SELECT * FROM records WHERE world=? AND scope=?", (self.world, "private:" + old)).fetchall()
                    for record in records:
                        duplicate = self.db.execute("SELECT id,updated_at FROM records WHERE world=? AND scope=? AND dimension IS ? AND kind=? AND record_key=?", (self.world, "private:" + target, record["dimension"], record["kind"], record["record_key"])).fetchone()
                        if duplicate:
                            # The newer fact wins; do not merge private content into a public scope.
                            if record["updated_at"] > duplicate["updated_at"]:
                                self.db.execute("UPDATE records SET data=?,source=?,evidence=?,updated_at=?,deleted_at=? WHERE id=?", (record["data"], record["source"], record["evidence"], record["updated_at"], record["deleted_at"], duplicate["id"]))
                            self.db.execute("UPDATE records SET deleted_at=? WHERE id=?", (self.clock(), record["id"]))
                        else:
                            self.db.execute("UPDATE records SET scope=? WHERE id=?", ("private:" + target, record["id"]))
                    self.db.execute("UPDATE records SET source_player=? WHERE world=? AND source_player=?", (target, self.world, old))
                self.db.execute("INSERT OR REPLACE INTO aliases VALUES(?,?,?)", (self.world, name.casefold(), target))

    def _visible(self, actor):
        return ("public", self.scope(actor)) if actor else ("public",)

    def _get(self, identifier, actor=None):
        scopes = self._visible(actor)
        return self.db.execute("SELECT * FROM records WHERE world=? AND id=? AND deleted_at IS NULL AND scope IN (" + ",".join("?" for _ in scopes) + ")", (self.world, identifier, *scopes)).fetchone()

    def _decode(self, row):
        result = dict(row)
        result["data"] = json.loads(result["data"])
        result["evidence"] = json.loads(result["evidence"])
        result["related_ids"] = [item[0] for item in self.db.execute("SELECT parent FROM links WHERE child=?", (row["id"],))]
        result["stale"] = result["source"] == "legacy" or bool(result["expires_at"] is not None and result["expires_at"] <= self.clock())
        result["verification"] = "observed" if result["verified_at"] is not None else "unverified"
        result.pop("world", None)
        result.pop("deleted_at", None)
        return result

    def get(self, identifier, actor=None):
        with self.lock:
            row = self._get(identifier, actor)
            return self._decode(row) if row else None

    def put(self, *, kind, key, name, data=None, dimension=None, actor=None, source="inferred", reporter=None,
            evidence=None, observed_at=None, validity=None, related_ids=(), revive=False, quarantined=False):
        if kind not in KINDS or source not in SOURCES:
            raise ValueError("Invalid memory category or source")
        if not isinstance(name, str) or not name.strip() or len(name) > 300:
            raise ValueError("Memory name must contain 1-300 characters")
        if dimension is not None and (not isinstance(dimension, str) or not dimension):
            raise ValueError("Invalid dimension")
        data = {} if data is None else data
        if not isinstance(data, dict) or len(json.dumps(data, allow_nan=False)) > (250000 if kind == "project" else 50000):
            raise ValueError("Memory data must be a bounded JSON object")
        if "position" in data:
            data = {**data, "position": position(data["position"])}
        if source == "observed" and not evidence:
            raise ValueError("Observed memory requires evidence")
        if observed_at is not None and (type(observed_at) not in (int, float) or not math.isfinite(observed_at)):
            raise ValueError("Observation time must be a finite timestamp")
        now = self.clock()
        seen = (observed_at if observed_at is not None else now) if source != "legacy" else None
        verified = seen if source == "observed" else None
        with self.lock, self.db:
            scope = "legacy:unassigned" if quarantined else self.scope(actor)
            old = self.db.execute("SELECT * FROM records WHERE world=? AND scope=? AND dimension IS ? AND kind=? AND record_key=?", (self.world, scope, dimension, kind, str(key))).fetchone()
            if old and reporter and not self._editable(old, reporter):
                raise ValueError("Only the original player or an operator can replace that note")
            if old and old["deleted_at"] is not None and not revive:
                return None
            if old and source == "observed" and seen is not None:
                if old["verified_at"] is not None and seen < old["verified_at"]:
                    return self._decode(old)
                if old["validity"] == "invalidated" and seen <= old["updated_at"]:
                    return self._decode(old)
            # A model's rewrite of a note must not silently replace a measured fact.
            if old and old["source"] == "observed" and source == "inferred":
                return self._decode(old)
            for parent in related_ids:
                visible = self._get(parent, actor)
                if not visible or (scope == "public" and visible["scope"] != "public"):
                    raise ValueError("Memory dependency is not available in this scope")
            identifier = old["id"] if old else str(uuid.uuid4())
            expires = seen + TTL[kind] if seen is not None and TTL[kind] is not None else None
            values = (identifier, self.world, scope, dimension, kind, str(key), name.strip(), json.dumps(data), source,
                      self.player_key(reporter) if reporter else None, json.dumps(evidence or {}), seen, verified, now, expires,
                      validity or ("current" if source == "observed" else "unverified"), None)
            self.db.execute("INSERT OR REPLACE INTO records VALUES(" + ",".join("?" for _ in values) + ")", values)
            self.db.execute("DELETE FROM links WHERE child=?", (identifier,))
            self.db.executemany("INSERT INTO links VALUES(?,?)", [(identifier, parent) for parent in related_ids])
            self.db.execute("INSERT INTO episodes(world,record_id,scope,created,payload) VALUES(?,?,?,?,?)", (self.world, identifier, scope, now, json.dumps({"source": source, "evidence": evidence or {}})))
            self.db.execute("DELETE FROM episodes WHERE world=? AND id NOT IN (SELECT id FROM episodes WHERE world=? ORDER BY id DESC LIMIT 2000)", (self.world, self.world))
            return self._decode(self.db.execute("SELECT * FROM records WHERE id=?", (identifier,)).fetchone())

    def search(self, query="", *, actor=None, dimension=None, position_hint=None, kinds=None, limit=12):
        with self.lock:
            scopes = self._visible(actor)
            clauses = ["world=?", "deleted_at IS NULL", "validity != 'invalidated'", "scope IN (" + ",".join("?" for _ in scopes) + ")"]
            parameters = [self.world, *scopes]
            if dimension is not None:
                clauses.append("(dimension=? OR dimension IS NULL)")
                parameters.append(dimension)
            if kinds:
                clauses.append("kind IN (" + ",".join("?" for _ in kinds) + ")")
                parameters.extend(kinds)
            tokens = [t for t in re.findall(r"[\w-]{2,}", str(query).casefold()) if t not in {"the", "and", "to", "my", "me", "at", "get", "go", "bring", "what", "where", "remember", "about", "you", "do", "is"}][:12]
            base_clauses, base_parameters = list(clauses), list(parameters)
            if tokens:
                matches = []
                for token in tokens:
                    matches.append("(lower(name) LIKE ? ESCAPE '\\' OR lower(data) LIKE ? ESCAPE '\\')")
                    pattern = "%" + token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
                    parameters.extend([pattern, pattern])
                # Standing boundaries and preferences remain available even for a narrow task query.
                clauses.append("(" + " OR ".join(matches) + " OR kind IN ('ownership','preference'))")
            rows = self.db.execute("SELECT * FROM records WHERE " + " AND ".join(clauses) + " ORDER BY updated_at DESC LIMIT 1000", parameters).fetchall()
            hint = position(position_hint)
            if hint and dimension is not None and tokens:
                nearby = self.db.execute("SELECT * FROM records WHERE " + " AND ".join(base_clauses) + " ORDER BY updated_at DESC LIMIT 1000", base_parameters).fetchall()
                existing = {row["id"] for row in rows}
                for row in nearby:
                    pos = json.loads(row["data"]).get("position")
                    if pos and row["dimension"] == dimension and row["id"] not in existing and math.dist(tuple(hint.values()), tuple(position(pos).values())) <= 64:
                        rows.append(row)
                        existing.add(row["id"])
            def score(row):
                data = json.loads(row["data"])
                name, content = row["name"].casefold(), row["data"].casefold()
                rank = sum(4 * (t in name) + (t in content) for t in tokens)
                pos = data.get("position")
                if hint and pos and row["dimension"] == dimension:
                    rank += 2 / (1 + math.dist(tuple(hint.values()), tuple(position(pos).values())) / 32)
                if row["expires_at"] is not None and row["expires_at"] <= self.clock():
                    rank -= 1
                return rank, row["updated_at"]
            rows.sort(key=score, reverse=True)
            maximum = max(1, min(limit, 50))
            selected, seen_ids = [], set()
            # Pair aliases with their supporting observation within the context budget.
            for row in rows:
                if row["id"] not in seen_ids:
                    selected.append(row)
                    seen_ids.add(row["id"])
                if len(selected) >= maximum:
                    break
                for link in self.db.execute("SELECT parent FROM links WHERE child=?", (row["id"],)).fetchall():
                    parent = self._get(link[0], actor)
                    if parent and parent["id"] not in seen_ids and parent["validity"] != "invalidated" and (dimension is None or parent["dimension"] in (None, dimension)):
                        selected.append(parent)
                        seen_ids.add(parent["id"])
                        if len(selected) >= maximum:
                            break
                if len(selected) >= maximum:
                    break
            return [self._decode(row) for row in selected]

    def context(self, query="", **options):
        try:
            return self.search(query, **options)
        except (sqlite3.Error, OSError, ValueError):
            logging.getLogger(__name__).exception("Could not retrieve world memory context")
            return []

    def _editable(self, row, actor):
        return not row["source_player"] or row["source_player"] == self.player_key(actor) or actor.casefold() in self.operators

    def _erase(self, identifier, include_self=True):
        children = self.db.execute("SELECT child FROM links WHERE parent=?", (identifier,)).fetchall()
        # Remove links first to make accidental dependency cycles harmless.
        self.db.execute("DELETE FROM links WHERE parent=?", (identifier,))
        for child in children:
            self._erase(child[0])
        if include_self:
            self.db.execute("UPDATE records SET deleted_at=? WHERE world=? AND id=?", (self.clock(), self.world, identifier))
            self.db.execute("DELETE FROM episodes WHERE world=? AND record_id=?", (self.world, identifier))

    def forget(self, identifier, *, actor):
        with self.lock, self.db:
            row = self._get(identifier, actor)
            if not row or not self._editable(row, actor):
                raise ValueError("Memory not found or not editable in this conversation")
            self._erase(identifier)
            return True

    def _reported_dimension(self, operation, actor, current, user_text, players):
        claimed = operation.get("dimension")
        aliases = {"nether": "the_nether", "end": "the_end", "overworld": "overworld"}
        for word, canonical in aliases.items():
            pattern = r"(?:\bthe_end\b|\b(?:in|inside|dimension)\s+(?:the\s+)?end\b)" if word == "end" else r"\b" + word + r"\b"
            if re.search(pattern, user_text, re.I):
                return canonical
        if claimed and claimed.casefold() in user_text.casefold():
            return claimed
        visible = any(p.get("username", "").casefold() == actor.casefold() and p.get("position") for p in players)
        return current if visible else None

    def apply_chat(self, operations, *, actor, private, dimension, user_text, message_id, player_locations=()):
        if not isinstance(operations, list):
            raise ValueError("memory_ops must be a list")
        results = []
        for index, operation in enumerate(operations[:10]):
            event_id = f"chat-memory:{message_id}:{index}"
            with self.lock:
                if self.db.execute("SELECT 1 FROM seen_events WHERE world=? AND event_id=?", (self.world, event_id)).fetchone():
                    results.append({"ok": True, "already_applied": True})
                    continue
            try:
                operation = normalize_memory_operation(operation)
                op = operation["op"]
                here = CURRENT_PLAYER_LOCATION.search(user_text.replace("’", "'"))
                if op == "remember" and operation.get("kind") in ("place", "resource", "storage", "project", "ownership") and here:
                    # A valid "remember here" needs a location even if the model omitted data.position.
                    operation["data"].setdefault("position", None)
                if op in ("remember", "correct") and "position" in operation["data"]:
                    supplied = position(operation["data"]["position"])
                    numbers = [float(n) for n in re.findall(r"-?\d+(?:\.\d+)?", user_text)]
                    if here and (len(numbers) < 3 or supplied is None):
                        player = next((p for p in player_locations if p.get("username", "").casefold() == actor.casefold()), {})
                        supplied = position(player.get("position"))
                        if supplied is None:
                            raise ValueError("Your location is unknown; please provide x, y, z and dimension")
                        operation["data"]["position"] = supplied
                    elif supplied and not any(list(supplied.values()) == numbers[i:i + 3] for i in range(max(0, len(numbers) - 2))):
                        parents = [self.get(identifier, actor if private else None) for identifier in operation.get("related_ids", [])]
                        if not any(parent and parent["data"].get("position") == supplied for parent in parents):
                            raise ValueError("Please provide coordinates or identify an existing remembered location")
                memory_actor = actor if private else None
                if op in ("forget", "correct", "rename"):
                    if op == "forget" and not re.search(r"\b(forget|erase|delete|remove|dimentica|scorda|cancella)\b", user_text, re.I):
                        raise ValueError("Forgetting requires an explicit player request")
                    if op in ("correct", "rename") and not re.search(r"\b(actually|correct|rename|change|instead|update|edit|correggi|rinomina|anzi|realtà)\b", user_text, re.I):
                        raise ValueError("Editing memory requires an explicit correction or rename")
                    with self.lock:
                        old = self._get(operation.get("id"), actor if private else None)
                        if not old or not self._editable(old, actor) or (old["scope"] != self.scope(memory_actor) and not (op == "forget" and private and old["scope"] == "public")):
                            raise ValueError("Memory not found or not editable in this conversation")
                    if op == "forget":
                        self.forget(old["id"], actor=actor)
                        result = {"id": old["id"]}
                    elif op == "rename" and old["source"] == "observed":
                        label = operation.get("name")
                        result = self.put(kind=old["kind"], key="label:" + str(label).strip().casefold(), name=label,
                            data={"position": json.loads(old["data"]).get("position"), "alias": True},
                            dimension=old["dimension"], actor=memory_actor, source="reported", reporter=actor,
                            evidence={"message": user_text[:2000], "event": message_id}, related_ids=[old["id"]])
                    else:
                        data = {**json.loads(old["data"]), **operation.get("data", {})}
                        corrected_dimension = self._reported_dimension(operation, actor, dimension, user_text, player_locations) if operation.get("dimension") else old["dimension"]
                        result = self.put(kind=old["kind"], key=old["record_key"], name=operation.get("name", old["name"]), data=data,
                                          dimension=corrected_dimension, actor=memory_actor, source="reported", reporter=actor,
                                          evidence={"message": user_text[:2000], "event": message_id}, revive=True)
                        with self.lock, self.db:
                            self._erase(old["id"], include_self=result["id"] != old["id"])
                elif op == "remember":
                    kind, name = operation.get("kind"), operation.get("name")
                    key = "label:" + str(name).strip().casefold()
                    remembered_dimension = self._reported_dimension(operation, actor, dimension, user_text, player_locations)
                    if kind == "preference" and not operation.get("dimension"):
                        remembered_dimension = None
                    with self.lock:
                        existing = self.db.execute("SELECT * FROM records WHERE world=? AND scope=? AND kind=? AND record_key=? AND dimension IS ?", (self.world, self.scope(memory_actor), kind, key, remembered_dimension)).fetchone()
                        if existing and not self._editable(existing, actor):
                            raise ValueError("Only the original player or an operator can replace that note")
                    revive = bool(re.search(r"\b(remember|ricorda)\b", user_text, re.I) and not re.search(r"\b(do you|what|where)\b", user_text, re.I))
                    result = self.put(kind=kind, key=key, name=name, data=operation.get("data", {}),
                                      dimension=remembered_dimension, actor=memory_actor, source="inferred" if operation.get("basis") == "inferred" else "reported", reporter=actor,
                                      evidence={"message": user_text[:2000], "event": message_id}, related_ids=operation.get("related_ids", []), revive=revive)
                    if result is None:
                        raise ValueError("That fact was forgotten; explicitly ask to remember it again")
                else:
                    raise ValueError("Unknown memory operation")
                with self.lock, self.db:
                    self.db.execute("INSERT OR IGNORE INTO seen_events VALUES(?,?)", (self.world, event_id))
                results.append({"ok": True, "id": result["id"]})
            except ValueError as error:
                results.append({"ok": False, "error": str(error)})
            except (TypeError, KeyError, AttributeError):
                results.append({"ok": False, "error": "Invalid memory operation; provide a name, record ID and valid coordinates"})
        return results

    def migrate_legacy(self, checkpoint):
        checkpoint = Path(checkpoint)
        for file, category in [(checkpoint / "conversation/memory.json", "notes"), (checkpoint / "action/chest_memory.json", "chests")]:
            if not file.exists():
                continue
            original = file.read_bytes()
            source = category + ":" + hashlib.sha256(original).hexdigest()
            with self.lock:
                if self.db.execute("SELECT 1 FROM migrations WHERE path=?", (source,)).fetchone():
                    continue
            data = json.loads(original)
            if not isinstance(data, dict):
                raise ValueError(f"Legacy memory must be an object: {file.name}")
            if category == "notes":
                for scope, notes in data.items():
                    actor = scope.split(":", 1)[1] if scope.startswith("private:") else None
                    if scope != "public" and actor is None:
                        continue
                    for note in notes if isinstance(notes, list) else []:
                        if isinstance(note, str):
                            key = "legacy-note:" + hashlib.sha256(note.encode()).hexdigest()
                            self.put(kind="preference", key=key, name=note[:300] or "Legacy note", data={"note": note[:2000]}, actor=actor,
                                     reporter=actor, source="legacy", evidence={"migration": file.name, "original_time": "unknown"})
            else:
                for coordinates, contents in data.items():
                    if contents == "Invalid":
                        continue
                    try:
                        xyz = ast.literal_eval(coordinates)
                        pos = position(dict(zip(("x", "y", "z"), xyz)))
                    except (ValueError, SyntaxError, TypeError):
                        continue
                    self.put(kind="storage", key="container:" + json.dumps(pos, sort_keys=True), name="Legacy chest",
                             data={"position": pos, "contents": contents, "dimension_known": False, "visibility_known": False}, source="legacy", quarantined=True,
                             evidence={"migration": file.name, "original_time": "unknown"})
            with self.lock, self.db:
                self.db.execute("INSERT INTO migrations VALUES(?,?,?)", (source, self.world, self.clock()))

    def ingest(self, snapshot):
        self.register_players(snapshot.get("playerLocations") or snapshot.get("players") or [])
        for event in snapshot.get("worldObservations", []):
            identifier = event.get("id")
            if not identifier:
                continue
            with self.lock:
                if self.db.execute("SELECT 1 FROM seen_events WHERE world=? AND event_id=?", (self.world, identifier)).fetchone():
                    continue
            actor, dimension = event.get("recipient"), event.get("dimension")
            kind = event.get("kind")
            if kind not in KINDS:
                continue
            data = event.get("data", {})
            key = event.get("key") or identifier
            if actor is None and event.get("type") == "block_observed":
                with self.lock:
                    rows = self.db.execute("SELECT scope FROM records WHERE world=? AND dimension IS ? AND kind=? AND record_key=? AND deleted_at IS NULL", (self.world, dimension, kind, key)).fetchall()
                if rows and not any(row[0] == "public" for row in rows):
                    continue
            if event.get("invalidated"):
                with self.lock, self.db:
                    changed = event.get("time", self.clock())
                    self.db.execute("UPDATE records SET validity='invalidated', updated_at=? WHERE world=? AND scope=? AND dimension IS ? AND kind=? AND record_key=? AND COALESCE(verified_at,0)<=?", (changed, self.world, self.scope(actor), dimension, kind, key, changed))
            else:
                self.put(kind=kind, key=key, name=event.get("name", kind), data=data, dimension=dimension, actor=actor,
                         source="observed", evidence={"event": identifier, "type": event.get("type", kind)}, observed_at=event.get("time"))
            with self.lock, self.db:
                self.db.execute("INSERT OR IGNORE INTO seen_events VALUES(?,?)", (self.world, identifier))
        control = snapshot.get("taskControl") or {}
        tasks = control.get("tasks", [])
        if not tasks and control.get("active"):
            active = dict(control["active"])
            active["actions"] = active.get("actions", []) + [{"results": snapshot.get("actionResults", []), "dimension": snapshot.get("dimension")}]
            tasks = [active]
        for task in tasks:
            self._ingest_task(task, (snapshot.get("state") or {}).get("dimension") or snapshot.get("dimension"))

    def _ingest_task(self, task, dimension):
        dimensions = {a["dimension"] for a in task.get("actions", []) if a.get("dimension")}
        dimension = next(iter(dimensions)) if len(dimensions) == 1 else None
        results = [result for action in task.get("actions", []) for result in action.get("results", []) if result.get("verified")]
        builds = [result for result in results if result.get("type") in ("build", "place")]
        if not builds and task.get("state") not in ("completed", "failed"):
            return
        digest = hashlib.sha256(json.dumps([task.get("state"), results, task.get("updated")], sort_keys=True).encode()).hexdigest()
        event = "task:" + str(task["id"]) + ":" + digest
        with self.lock:
            if self.db.execute("SELECT 1 FROM seen_events WHERE world=? AND event_id=?", (self.world, event)).fetchone():
                return
        actor = task.get("recipient")
        data = {"task_id": task["id"], "state": task.get("state"), "request": task["task"], "results": results[-128:],
                "outcome_basis": "controller_state", "reason": str(task.get("reason", ""))[:2000], "reason_basis": "planner_or_critic"}
        if builds:
            cells = {}
            for result in builds:
                blueprint = result.get("blueprint", []) if result.get("type") == "build" else [{"name": result.get("block"), "position": result.get("position")}]
                for cell in blueprint:
                    if cell.get("position"):
                        cells[json.dumps(cell["position"], sort_keys=True)] = cell
            data["completed_cells"] = list(cells.values())[:1024]
        observed = self.clock()
        receipt_times = [r["observedAt"] for r in results if type(r.get("observedAt")) in (int, float)]
        action_times = [a.get("started") for a in task.get("actions", []) if a.get("started")]
        timestamp = max(action_times) if builds and action_times else task.get("updated")
        if receipt_times:
            observed = max(receipt_times)
        elif timestamp:
            try:
                observed = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
            except (ValueError, TypeError, AttributeError):
                pass
        self.put(kind="project" if builds else "experience", key="task:" + task["id"], name=task["task"][:300], data=data,
                 dimension=dimension, actor=actor, source="observed", evidence={"task_id": task["id"], "event": event}, observed_at=observed)
        with self.lock, self.db:
            self.db.execute("INSERT OR IGNORE INTO seen_events VALUES(?,?)", (self.world, event))
