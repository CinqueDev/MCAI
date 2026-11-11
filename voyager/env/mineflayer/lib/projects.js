const { randomUUID } = require('node:crypto');
const { Vec3 } = require('vec3');
const S = require('./blockStates');
const { dimension, resolveWorldTarget } = require('./targetResolver');
const key = p => `${p.x},${p.y},${p.z}`;
const stamp = () => new Date().toISOString();

class Projects {
    constructor(controller) { this.controller = controller; this.bot = controller.bot; this.session = randomUUID(); }
    visible(project, actor, privateChat) { return !project.recipient || (privateChat && project.requester.toLowerCase() === actor.toLowerCase()); }
    find(identifier, actor, privateChat, edit = false) {
        const matches = this.controller.projects.filter(p => this.visible(p, actor, privateChat) &&
            (p.id === identifier || p.name.toLowerCase() === String(identifier).toLowerCase()));
        if (matches.length !== 1) throw new Error('Project not found or name is ambiguous in this chat; use its project ID.');
        const project = matches[0];
        if (edit && !this.controller.owns(project, actor)) throw new Error('Only the project requester or a configured operator can change it.');
        return project;
    }
    cells(project) { return project.versions.at(-1).cells; }
    normalize(blocks, origin) {
        if (!Array.isArray(blocks) || !blocks.length || blocks.length > 4096) throw new Error('A project blueprint needs 1-4096 explicit cells.');
        const cells = blocks.map(cell => {
            S.position(cell.position);
            const position = S.position({ x: origin.x + cell.position.x, y: origin.y + cell.position.y, z: origin.z + cell.position.z }, this.bot.game);
            const action = cell.action || 'place', name = action === 'remove' ? 'air' : cell.name;
            if (!['place', 'remove', 'replace'].includes(action) || !this.bot.registry.blocksByName[name] || (action !== 'remove' && !this.bot.registry.itemsByName[name])) throw new Error('Blueprint needs valid block/item names and place/remove/replace actions.');
            if (action !== 'place' && (!this.bot.registry.blocksByName[cell.expected] || S.AIR.has(cell.expected))) throw new Error('Removal/replacement requires the explicitly expected original block name.');
            if (S.multipart(this.bot.registry, name) || S.multipart(this.bot.registry, cell.expected)) throw new Error('Multi-cell doors, beds and tall plants require a dedicated blueprint implementation; this project supports single-cell edits.');
            S.validate(this.bot.registry, name, cell.state || {});
            const dependencies = (cell.dependsOn || []).map(p => { S.position(p); return key({ x: origin.x + p.x, y: origin.y + p.y, z: origin.z + p.z }); });
            return { action, name, expected: cell.expected || null, state: { ...(cell.state || {}) }, position, dependencies };
        });
        const keys = new Set(cells.map(c => key(c.position)));
        if (keys.size !== cells.length) throw new Error('Blueprint cells must be unique.');
        if (cells.some(c => c.dependencies.some(d => !keys.has(d)))) throw new Error('A dependency must name another blueprint cell.');
        const sorted = [], done = new Set(), pending = cells.sort((a, b) => a.position.y - b.position.y);
        while (pending.length) {
            const index = pending.findIndex(c => c.dependencies.every(d => done.has(d)));
            if (index < 0) throw new Error('Blueprint dependencies contain a cycle.');
            const cell = pending.splice(index, 1)[0]; sorted.push(cell); done.add(key(cell.position));
        }
        return sorted;
    }
    define(request, existing = null) {
        const { requester, recipient = null, name, origin, blocks } = request;
        if (!/^[A-Za-z0-9_]{1,16}$/.test(requester || '') || (recipient !== null && recipient !== requester)) throw new Error('Invalid project requester/channel.');
        if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('Give the project a name of 1-100 characters.');
        const target = resolveWorldTarget(this.bot, origin, request);
        if (target.status !== 'resolved') throw new Error(target.reason);
        const anchor = { x: Math.floor(target.position.x), y: Math.floor(target.position.y), z: Math.floor(target.position.z) };
        const cells = this.normalize(blocks, anchor);
        const bounds = { min: {}, max: {} };
        for (const axis of ['x', 'y', 'z']) { bounds.min[axis] = Math.min(...cells.map(c => c.position[axis])); bounds.max[axis] = Math.max(...cells.map(c => c.position[axis])); }
        if (bounds.max.x - bounds.min.x > 63 || bounds.max.z - bounds.min.z > 63) throw new Error('Split projects larger than 64 blocks across into separate named projects.');
        if (existing && dimension(existing.dimension) !== dimension(target.dimension)) throw new Error('A project cannot be revised into another dimension. Create a separate project.');
        if (existing && existing.recipient !== recipient) throw new Error('Revise a public project in public chat; private changes must stay in a private project.');
        if (existing && this.controller.lease?.taskId && this.controller.get(this.controller.lease.taskId)?.projectId === existing.id)
            throw new Error('Pause the active build before revising its blueprint so its current block operation can settle.');
        if (this.controller.projects.length >= 100 && !existing) throw new Error('Project limit reached (100 per world).');
        const project = existing || { id: randomUUID(), name: name.trim(), requester, recipient, created: stamp(), versions: [], progress: {}, status: 'planned' };
        if (existing) {
            const old = new Map(this.cells(existing).map(c => [key(c.position), JSON.stringify(c)]));
            for (const c of cells) if (old.get(key(c.position)) !== JSON.stringify(c)) delete project.progress[key(c.position)];
        }
        const version = (project.versions.at(-1)?.version || 0) + 1;
        project.versions.push({ version, cells, bounds, origin: anchor, dimension: target.dimension, approvedBy: requester,
            approvedRequest: String(request.userText || '').slice(0, 2000), created: stamp() });
        if (project.versions.length > 8) project.versions.shift();
        project.dimension = target.dimension; project.bounds = bounds; project.status = 'planned'; project.updated = stamp();
        if (existing) for (const task of this.controller.records.filter(t => t.projectId === project.id && ['queued', 'running', 'paused'].includes(t.state))) {
            task.projectVersion = version; task.generation++;
            task.task = `Build project ${project.name} [${project.id.slice(0, 8)}] (version ${version})`;
            if (request.execute === false) { task.state = 'cancelled'; task.reason = 'A revised plan was saved without execution.'; }
        }
        if (existing) this.controller.revision++;
        if (!existing) this.controller.projects.push(project);
        this.controller.save();
        return project;
    }
    inspect(project, cell, run = null) {
        const current = this.bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z));
        const saved = project.progress[key(cell.position)];
        if (!current) return { state: saved?.status === 'done' ? 'unverified' : 'unloaded' };
        if (cell.action === 'remove' ? S.AIR.has(current.name) : S.matches(current, cell.name, cell.state)) return { state: 'done', current };
        if (saved?.status === 'done') return { state: 'conflict', current, reason: 'A previously verified cell was changed; the player edit is preserved.' };
        if (saved?.status === 'intent' || saved?.status === 'uncertain') {
            if (cell.action === 'replace' && saved.phase !== 'placing' && S.AIR.has(current.name)) return { state: 'removed', current };
            return { state: 'conflict', current, reason: 'An interrupted cell operation needs review; it will not be replayed blindly.' };
        }
        if (saved?.phase === 'removed' && S.AIR.has(current.name)) return { state: 'removed', current };
        if (cell.action === 'place' ? !S.AIR.has(current.name) : current.name !== cell.expected)
            return { state: 'conflict', current, reason: `Expected ${cell.action === 'place' ? 'empty space' : cell.expected}, found ${current.name}.` };
        if (saved?.before && !S.same(current, saved.before)) return { state: 'conflict', current, reason: 'The target changed since the operation was planned.' };
        return { state: 'pending', current };
    }
    summary(project) {
        const sameDimension = dimension(project.dimension) === dimension(this.bot.game?.dimension);
        const totals = {}, required = {}, conflicts = [];
        let completed = 0, unverified = 0;
        for (const cell of this.cells(project)) {
            if (cell.action !== 'remove') totals[cell.name] = (totals[cell.name] || 0) + 1;
            const observation = sameDimension ? this.inspect(project, cell) : { state: 'unloaded' };
            if (observation.state === 'done') completed++;
            else if (observation.state === 'unverified') { completed++; unverified++; }
            else if (cell.action !== 'remove') required[cell.name] = (required[cell.name] || 0) + 1;
            if (observation.state === 'conflict') conflicts.push({ position: cell.position, reason: observation.reason });
        }
        const missing = {};
        for (const [name, count] of Object.entries(required)) {
            const available = this.bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
            if (count > available) missing[name] = count - available;
        }
        const currentTask = this.controller.get(project.currentTaskId);
        let state = project.status;
        if (state !== 'completed' && currentTask?.state === 'paused') state = 'paused';
        else if (['queued', 'building'].includes(state) && currentTask?.state === 'cancelled') state = 'stopped';
        else if (['queued', 'building'].includes(state) && currentTask?.state === 'queued')
            state = currentTask.dependsOnTask && this.controller.get(currentTask.dependsOnTask)?.state !== 'completed' ? 'waiting_for_supplies' : 'queued';
        else if (state === 'queued' && currentTask?.state === 'running') state = 'building';
        return { id: project.id, name: project.name, requester: project.requester, recipient: project.recipient,
            task_id: project.currentTaskId || null, task_state: this.controller.get(project.currentTaskId)?.state || null, version: project.versions.at(-1).version, bounds: project.bounds,
            dimension: project.dimension, state: conflicts.length ? 'conflict' : state, total: this.cells(project).length,
            completed, unverified, remaining: this.cells(project).length - completed, materials: totals, missing,
            conflicts: conflicts.slice(0, 20), conflictCount: conflicts.length, lastVerified: project.lastVerified || null };
    }
    enqueue(project, requester, recipient, requestKey = null, dependency = null) {
        const version = project.versions.at(-1).version;
        const existing = this.controller.records.find(t => t.projectId === project.id && ['queued', 'running', 'paused'].includes(t.state));
        if (existing) { project.currentTaskId = existing.id; return existing; }
        const task = this.controller.enqueue({ task: `Build project ${project.name} [${project.id.slice(0, 8)}] (version ${version})`, requester, recipient,
            key: requestKey, context: `Execute only the approved blueprint via buildProjectBatch(bot, "${project.id}"). Never mine or clear unspecified cells.` });
        task.projectId = project.id; task.projectVersion = version;
        project.currentTaskId = task.id; task.dependsOnTask = dependency;
        project.status = 'queued'; project.updated = stamp(); this.sync(project);
        this.controller.save();
        return task;
    }
    sync(project) {
        const summary = this.summary(project);
        for (const task of this.controller.records.filter(t => t.projectId === project.id)) task.projectProgress = summary;
    }
    request(request) {
        const { action, requester, recipient = null, identifier, key: receiptKey } = request;
        const privateChat = recipient === requester;
        if (!/^[A-Za-z0-9_]{1,16}$/.test(requester || '') || (recipient !== null && recipient !== requester)) throw new Error('Invalid project requester/channel.');
        const signature = JSON.stringify({ action, requester, recipient, identifier, name: request.name,
            origin: request.origin, blocks: request.blocks, execute: request.execute, source: request.source });
        if (receiptKey && Object.hasOwn(this.controller.controlReceipts, receiptKey)) {
            const receipt = this.controller.controlReceipts[receiptKey];
            if (receipt.signature !== signature) throw new Error('Project request key reused with different content.');
            return receipt.result;
        }
        let project, result;
        const queued = this.controller.records.filter(t => t.state === 'queued').length;
        if (action === 'create' && request.execute !== false && queued >= 20) throw new Error('Task queue is full; no project was created.');
        if (action === 'list') return { ok: true, projects: this.controller.projects.filter(p => this.visible(p, requester, privateChat)).map(p => this.summary(p)) };
        if (action === 'create') {
            if (this.controller.projects.some(p => p.requester.toLowerCase() === requester.toLowerCase() && p.recipient === recipient && p.name.toLowerCase() === request.name?.toLowerCase())) throw new Error('That project already exists; continue it or revise its blueprint.');
            project = this.define(request);
        } else project = this.find(identifier, requester, privateChat, !['status'].includes(action));
        if (action === 'status') return { ok: true, project: this.summary(project) };
        if (action === 'supplies' && !Object.keys(this.summary(project).missing).length)
            return { ok: true, message: 'No missing project materials are currently recorded.', project: this.summary(project) };
        const existingBuild = this.controller.records.some(t => t.projectId === project.id && ['queued', 'running', 'paused'].includes(t.state));
        const slots = action === 'supplies' ? (existingBuild ? 1 : 2) : (!existingBuild && request.execute !== false ? 1 : 0);
        if (queued + slots > 20) throw new Error('Task queue is full; the project was not changed.');
        if (action === 'revise') project = this.define({ ...request, name: project.name }, project);
        if (!['create', 'revise', 'continue', 'supplies'].includes(action)) throw new Error('Unknown project action.');
        if (action === 'supplies') {
            const missing = this.summary(project).missing, bounded = {};
            let budget = 128;
            for (const [name, count] of Object.entries(missing)) { const amount = Math.min(count, 64, budget); if (amount) bounded[name] = amount; budget -= amount; }
            if (!Object.keys(bounded).length) return { ok: true, message: 'No missing project materials are currently recorded.', project: this.summary(project) };
            const source = request.source ? resolveWorldTarget(this.bot, request.source, request) : null;
            if (source && source.status !== 'resolved') throw new Error(source.reason);
            const description = `Obtain ${Object.entries(bounded).map(([n, count]) => `${count} ${n}`).join(', ')} for project ${project.name}. ` +
                (source ? `Use only the authorized storage at ${JSON.stringify(source.position)} in ${source.dimension}; respect recorded access instructions.` : 'Gather/craft only these bounded amounts. Do not clear player structures or take from unspecified storage.');
            const supply = this.controller.enqueue({ task: description, requester, recipient, priority: 110, key: receiptKey ? receiptKey + ':supply' : null });
            supply.projectSupplyFor = project.id;
            const build = this.enqueue(project, requester, recipient, receiptKey ? receiptKey + ':build' : null, supply.id);
            build.dependsOnTask = supply.id;
            result = { ok: true, message: `Queued bounded supplies ${supply.id.slice(0, 8)}, then project ${project.name}.`, project: this.summary(project) };
        } else if (request.execute !== false) {
            const task = this.enqueue(project, requester, recipient, receiptKey ? receiptKey + ':build' : null);
            task.projectVersion = project.versions.at(-1).version;
            if (action === 'continue') task.dependsOnTask = null;
            result = { ok: true, message: `Saved project ${project.name}, version ${task.projectVersion}; task ${task.id.slice(0, 8)} is ${task.state}.`, project: this.summary(project) };
        } else result = { ok: true, message: `Saved project ${project.name}, version ${project.versions.at(-1).version}; no building was queued.`, project: this.summary(project) };
        if (receiptKey) {
            this.controller.controlReceipts[receiptKey] = { signature, result };
            const keys = Object.keys(this.controller.controlReceipts);
            for (const old of keys.slice(0, Math.max(0, keys.length - 1000))) delete this.controller.controlReceipts[old];
        }
        this.sync(project); this.controller.save();
        return result;
    }
    async runBatch(id, helpers, limit = 128) {
        const controller = this.controller, lease = controller.context.getStore(), task = lease?.taskId && controller.get(lease.taskId);
        controller.check();
        const project = controller.projects.find(p => p.id === id);
        if (!project || task?.projectId !== id || task.projectVersion !== project.versions.at(-1).version) throw new Error('Project execution requires its current task/version lease.');
        if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error('Project batches must contain 1-128 cells.');
        if (dimension(project.dimension) !== dimension(this.bot.game?.dimension)) throw new Error('Project is in a different dimension; portal travel is unsupported.');
        const run = `${this.session}:${task.id}:${task.generation}:${task.projectVersion}`, cells = this.cells(project);
        const preflight = this.summary(project);
        if (preflight.conflictCount) return this.finish(project, 'conflict', 0, preflight.conflicts[0].reason);
        let inspected = 0;
        project.status = 'building';
        for (const cell of cells) {
            controller.check();
            if (inspected >= limit) break;
            const cellKey = key(cell.position), previous = project.progress[cellKey];
            if (previous?.status === 'done' && previous.verifiedRun === run) continue;
            if (cell.dependencies.some(d => project.progress[d]?.status !== 'done' || project.progress[d]?.verifiedRun !== run)) continue;
            try { await helpers.move(cell.position); }
            catch (error) {
                if (lease.abort.signal.aborted) throw error;
                return this.finish(project, 'blocked', inspected, error.message);
            }
            controller.check();
            let current = this.inspect(project, cell, run);
            if (current.state === 'unloaded' || current.state === 'unverified') return this.finish(project, 'blocked', inspected, 'A target chunk remains unloaded.');
            if (current.state === 'conflict') return this.finish(project, 'conflict', inspected, current.reason);
            if (current.state !== 'done' && cell.action !== 'remove' && !this.bot.inventory.items().some(i => i.name === cell.name && i.count > 0))
                return this.finish(project, 'needs_materials', inspected, `Missing ${cell.name}; ask for missing materials or a bounded supplies subtask.`);
            try {
                if (current.state !== 'done') {
                    const progress = project.progress[cellKey] = { status: 'intent', before: S.fingerprint(current.current), version: task.projectVersion };
                    if (current.state === 'removed') progress.phase = 'removed';
                    controller.save();
                    if (cell.action !== 'place' && current.state !== 'removed') {
                        progress.phase = 'digging'; controller.save();
                        await helpers.remove(cell.position, cell.expected);
                        controller.check();
                        progress.phase = 'removed'; progress.status = 'pending'; progress.before = S.fingerprint(this.bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z)));
                        controller.save();
                    }
                    if (cell.action !== 'remove') {
                        progress.status = 'intent'; progress.phase = 'placing'; controller.save();
                        await helpers.place(cell.name, cell.position, cell.state);
                    }
                }
                controller.check();
                const block = this.bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z));
                if (!(cell.action === 'remove' ? block && S.AIR.has(block.name) : S.matches(block, cell.name, cell.state))) throw new Error('The requested cell/state was not verified.');
                project.progress[cellKey] = { status: 'done', observed: S.fingerprint(block), version: task.projectVersion, verifiedRun: run, verifiedAt: Date.now() / 1000 };
                project.lastVerified = Date.now() / 1000; inspected++; this.sync(project); controller.save();
            } catch (error) {
                if (project.progress[cellKey]?.status === 'intent') project.progress[cellKey].status = 'uncertain';
                controller.save();
                if (lease.abort.signal.aborted) throw error;
                return this.finish(project, 'blocked', inspected, error.message);
            }
        }
        const complete = cells.every(c => project.progress[key(c.position)]?.status === 'done' && project.progress[key(c.position)]?.verifiedRun === run);
        return this.finish(project, complete ? 'completed' : 'building', inspected, complete ? 'All blueprint cells were verified.' : 'Batch verified; more project work remains.');
    }
    finish(project, state, inspected, reason) {
        project.status = state; project.updated = stamp(); this.sync(project); this.controller.save();
        const result = { type: 'project_batch', project: this.summary(project), inspected, reason,
            observedAt: Date.now() / 1000, verified: state === 'completed', blocked: !['completed', 'building'].includes(state) };
        (this.bot.actionResults ||= []).push(result);
        return result;
    }
}
module.exports = { Projects };
