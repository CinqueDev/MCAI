# Cooperative agent and world memory plan

Status: Phase 1 task control is implemented with simulated validation; live Minecraft validation remains pending. Phases 2–6 remain planned.

## Objective

Make the agent a useful Minecraft companion that can understand references to the world, carry out requests, remember discoveries, and continue shared work across sessions. Preserve the existing public/private chat rules and separate conversation from action diagnostics.

## Starting point

- Chat runs independently of actions. Public mentions and private messages require replies, with private replies routed through `/msg`.
- Helpers now cover approaching a visible player, walking to coordinates, waiting for supplies, exact item drops, giving items, verified block placement, and bounded blueprint construction.
- Requests can displace curriculum work after an action finishes. There is no general cancellation, continuous following, or durable task journal yet.
- Conversation has bounded recent history and small persistent public/private note lists. Skills and chest observations are stored separately. World knowledge is not yet shared consistently between conversation and execution.
- Chest primitives exist, but need reliable long-distance navigation, exact transfer results, and consistent window cleanup.

## Phase 1 — Task control and execution lifecycle

Introduce a task controller shared by chat, the action planner, and the Minecraft bridge.

- Give every request and action a stable ID, requester, reply channel, priority, and lifecycle state: queued, running, paused, completed, cancelled, or failed.
- Support stop, cancel, pause, resume, queue inspection, and progress questions. Explicit control requests should not wait behind an ongoing model completion or ordinary task queue.
- Define control ownership: requesters control their own work; configurable owner/operator controls can manage all work. Resolve ambiguous cancellation targets explicitly.
- Add cancellation signals to navigation, following, combat, waiting, inventory operations, and build/mining batches. Close windows and remove timers/listeners when an operation ends.
- Pause at a safe operation boundary. Cancel prevents further operations; it does not silently undo blocks already placed or items already dropped.
- Ignore late model responses and stale action results after cancellation using task/action IDs. Keep one controller responsible for bot movement and inventory mutations.
- Persist the task journal and verified progress. On restart, recheck the world before resuming. Never automatically replay an uncertain drop, transfer, or other non-idempotent operation.
- Apply the controller consistently to learning mode and explicitly assigned tasks, including inference workflows.

Acceptance: stop works during walking, waiting, following, and construction; no delayed callback restarts cancelled work; pause/resume preserves verified progress.

## Phase 2 — Shared, structured world memory

Add a local SQLite store using Python's standard library. Keep memory access behind a service used by conversation, planning, execution, and verification. Start with typed records and indexed lookup; add semantic retrieval only if real use shows it is needed.

Store these categories:

| Category | Examples |
| --- | --- |
| Places and landmarks | Home, villages, cave entrances, farms, meeting points |
| Resources and storage | Observed ore deposits, food sources, container locations and last inspected contents |
| Experiences | Failed routes, observed hazards, successful approaches, and the evidence behind them |
| Projects | Blueprint version, bounds, requested materials, completed cells, missing resources, and next steps |
| Player preferences and boundaries | Language, shared plans, named storage, ownership, and access instructions |

Each record should carry an ID, world identity, dimension, relevant coordinates or bounds, source, observation time, last verification time, and visibility/ownership scope. Separate directly observed facts from player reports and model inferences; retain evidence rather than treating confidence as proof.

- Scope data by configured world ID and server/account context. A server address alone cannot distinguish worlds or world resets reliably.
- Use player UUIDs where available, with a server-scoped username fallback for offline connections.
- Populate observations from successful actions, inspections, exploration, and failures. The bot must be able to remember facts without a chat message prompting it.
- Treat moving players, resources, and container contents as potentially stale. Preserve “last seen here” rather than claiming “still here”; invalidate contradicted facts.
- Retrieve only relevant records by scope, location, task, category, and freshness. Enforce visibility before retrieval and before producing an answer.
- Share public world knowledge across agents. Make private records available only to the appropriate private conversation or associated task; keep them out of public replies and unrelated tasks.
- Migrate existing conversation notes and chest records without deleting the originals. Import notes with unknown provenance/time explicitly marked as such, rather than inventing evidence.
- Keep learned executable skills distinct from factual memory, while allowing the planner to retrieve both.
- Support “remember this place,” naming/renaming landmarks, “what do you remember about…,” corrections, and forgetting. Forgetting must remove a fact from active retrieval and relevant summaries.
- Bound raw event retention and summarize useful episodes without fabricating facts. Keep project checkpoints and action receipts durable.

Acceptance: discoveries survive restart, private knowledge does not leak, changing chest contents replace stale observations, different worlds stay isolated, and a reported resource is distinguishable from one the bot actually saw.

## Phase 3 — World references, following, and staying

Create a common target resolver returning a concrete player, entity, block face, coordinate, landmark, or an explicit unresolved/ambiguous result.

- Resolve “me,” “here,” “behind me,” and “beside that chest” using the requester and available world observations.
- Resolve “the block I am looking at” using a loaded player entity's observed head direction and a bounded raycast. If the server does not provide enough information, ask for a coordinate or another clear reference.
- Resolve named places through memory, with dimensions and stale-location checks. Never substitute a guessed location for an unseen player.
- Implement continuous follow with a configurable distance, temporary loss-of-sight handling, a bounded search/wait period, and clear reporting when the player is lost.
- Implement stay at a specific position, stop following, and resume following. Foreground requests, emergency self-preservation, and autonomous curriculum need explicit precedence so they do not fight over movement.
- Keep cross-dimension targets unresolved in this release; report the limitation rather than claiming portal travel.

Acceptance: “follow me,” “stay here,” “come behind me,” and pointing-based targets either resolve correctly or produce a useful clarification.

## Phase 4 — Inspection, containers, and object interaction

- Add verified inspection of blocks, block states, visible entities, the bot's inventory, and supported containers.
- Make inspection results available to chat as well as the planner, preserving the requesting channel.
- Refactor container helpers to walk to known locations, validate the container, transfer exact quantities across stacks, handle insufficient supplies/capacity, and always close windows.
- Record partial transfers explicitly so retries do not duplicate them. Refresh container memory after inspections and transfers.
- Support complete workflows such as “get eight torches from the kitchen chest” and “put these supplies in our materials chest,” resolving storage aliases and respecting recorded access instructions.
- Add supported interactions for doors, trapdoors, gates, buttons, levers, and beds. Prefer desired state operations such as “open” or “turn on” over blind repeated toggles.
- Verify persistent block-state changes where observable. For momentary interactions, distinguish a confirmed activation attempt from an unobserved downstream effect.
- Handle bed occupancy, distance, and server sleep conditions as normal failures with useful explanations.

Acceptance: named-storage requests transfer the requested amounts, stale/missing containers are detected, windows close on cancellation/failure, and “open that door” does not accidentally close an already open door.

## Phase 5 — Block editing and persistent projects

- Add exact-coordinate block removal using appropriate tool and reach checks. Do not use a generic nearby-block mining search for a specific requested cell.
- Add replacement workflows with explicit target bounds, materials, and verified removal/placement results.
- Do not infer permission to clear surrounding player structures from a vague build request. Resolve conflicts or missing specifications before modifying those cells.
- Extend blueprints to supported orientation/state requirements, explicit bounds, dependencies/supports, and material totals.
- Persist named projects, their requester/channel, approved plan, blueprint versions, verified progress, and remaining work.
- Support “continue the house,” “what materials are missing,” “pause this build,” and bounded material-gathering/storage subtasks.
- Reconcile the live world with the saved plan before resuming. Preserve player edits and report conflicts rather than overwriting them automatically.
- Keep work in cancellable batches and record partial completion. Larger builds must not depend on one long generated script.

Acceptance: a build can stop halfway, survive restart, and resume without duplicating materials or destroying a player's intervening edits; a requested replacement affects only its specified cells.

## Phase 6 — Player assistance and defense

- Add an explicit protect/assist mode associated with a player or bounded area.
- Identify observable nearby threats, avoid attacking players and non-target entities, and bound pursuit by distance and time.
- Coordinate following, combat, equipment, eating, and retreat through the task controller. Do not run competing movement loops.
- Stop defense on request, return to the assigned player/position when appropriate, and explain lost targets or unavailable equipment.
- Record observed hazards and useful outcomes in world memory without turning a single uncertain event into a universal rule.

Acceptance: the bot assists against a nearby hostile mob, avoids pursuing it indefinitely, and can be stopped without leftover combat/navigation activity.

## Validation and delivery

Each phase includes simulated tests for normal operation, cancellation, partial success, stale observations, reconnects, and privacy where relevant. Add model-boundary tests to verify that task context and available capabilities reach the correct agents; helper tests alone do not establish chat-to-action behavior.

Complete a live Minecraft scenario before treating the overall feature set as verified:

1. Ask the bot to approach, wait for a pickaxe, follow, and stay.
2. Interrupt movement and construction; verify no late action continues.
3. Name and inspect a chest; retrieve/store exact quantities and report the result in the original channel.
4. Use a pointed-at door/lever, with an ambiguous target producing a clarification.
5. Build, pause, restart, reconcile a player edit, and resume a named project.
6. Discover a landmark/resource without chatting; verify later recall, provenance, and stale-data handling.
7. Repeat with private requests and a different world to verify visibility and isolation.
8. Ask for protection, exercise pursuit limits, and stop the mode.

Recommended order: task control → shared memory → target resolution/following → inspection/storage/interactions → editing/projects → defense → final combined gameplay validation. Existing in-progress helper work remains the baseline; these phases extend it rather than replacing it.
