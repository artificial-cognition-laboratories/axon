import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { DirectHandle } from "./handle"
import { Instance, type InstanceT } from "./instance"
import { Registry } from "./registry"
import type { Supervised, SuperviseT } from "./supervise"
import type { AxonBlueprint } from "@arcforge/types"
import type { AgentRecord, AgentsState, DefinitionFile, InstalledAgent } from "./types"

/**
 * What booting one agent needs.
 *
 * The identity fields (`parentSessionId`, `rootSessionId`, `depth`) describe
 * the OWNERSHIP GRAPH, not the process — an agent spawned by another agent is
 * a child, and readers nest on it. They travel with the spawn because the
 * daemon is the only thing that sees every one, and therefore the only thing
 * that can record the tree without gaps.
 */
export type SuperviseInput = {
    sessionId: string
    /** Already normalised and prepared — the platform's work, not the daemon's. */
    blueprint: AxonBlueprint
    /** The agent's name. Grants and records are written against it. */
    agent: string
    projectRoot: string
    dataRoot: string
    /** Null for a root agent; the spawner's session for a subagent. */
    parentSessionId?: string | null
    /** The top of this agent's tree. Defaults to its own session. */
    rootSessionId?: string
    /** How deep in that tree. Defaults to 0. */
    depth?: number
    /** The work item this run answers, when one asked. Correlation only. */
    job?: string
    /**
     * A control channel the SPAWNER is serving, published so a reader can find
     * it. Stored verbatim — the daemon never speaks this protocol.
     */
    control?: { port: number; token: string }
}

export type AgentsOpts = {
    /**
     * Holds the provider credential, for supervising agents.
     *
     * Optional: a daemon reading the registry needs none, and requiring one
     * would make `axond agents` fail on a machine nobody has logged into.
     * `spawn` is what refuses when it is absent.
     */
    supervise?: SuperviseT
    /**
     * This machine's id, read fresh per call.
     *
     * A THUNK because identity is the machine domain's to own, and the agents
     * domain should not probe a second time — nor cache an answer taken before
     * that domain was ready. Null travels through: a machine that cannot be
     * identified says so rather than inventing one.
     */
    machineId?: () => string | null
    /** Where records are written. Tests point this at a scratch dir. */
    root?: string
    /** Read only `root`, ignoring the machine's real stores. Tests only — see Registry. */
    isolated?: boolean
}

/**
 * Agents — every agent running on this machine.
 *
 * ── Observing, not yet owning ───────────────────────────────────────────────
 *
 * The daemon reads the records agents publish for themselves; the platform
 * still spawns and supervises them. That order is deliberate — moving
 * observation first means Fleet and the TUI can ask the daemon "what is
 * running" against a real answer, while the far riskier move (who holds
 * provider credentials, who owns the process) lands separately with something
 * working to compare against.
 *
 * `at(id)` already returns a HANDLE rather than a record, and the verbs
 * supervision will fill throw meanwhile. That is what stops the SDK needing a
 * translation layer once they work.
 *
 * ── Why the daemon is the right owner ───────────────────────────────────────
 *
 * The platform answers "is this running" from an in-process Map — which is
 * per-process state describing a machine-wide fact. Every surface that did not
 * spawn the agent (the Fleet extension host, a second terminal) reads that map
 * as empty and reports a live agent as stopped. A single long-lived process
 * reading one registry is the answer that is true for everyone.
 */
/**
 * What one agent may create. Depth caps recursion, children caps one agent's
 * fan-out, descendants caps the whole tree beneath one root.
 *
 * Moved here from the platform's `Requests`, which guarded a single route.
 */
const MAX_DEPTH = 4
const MAX_LIVE_CHILDREN = 4
const MAX_LIVE_DESCENDANTS = 12

/**
 * Where agent projects live, for both distributions.
 *
 * BOTH, deliberately, and for the same reason the running registry scans both:
 * a developer has an installed CLI and a source build side by side, and a
 * fleet view that showed one of them would be describing half the machine.
 */
function storeRoots(): string[] {
    return [join(homedir(), ".axon"), join(homedir(), ".axon-dev")]
}

/**
 * The scoped name an agent declares for itself, e.g. `@axon/zeno`.
 *
 * From its `package.json`, which is where the name that `axon <ref>` resolves
 * actually lives. The DIRECTORY name is not it: `zeno` on its own is rejected
 * as an unknown command, because a bare word could be anything and the scope
 * belongs to whoever published it rather than to the folder someone cloned it
 * into.
 *
 * Null when unreadable, so the caller falls back to the directory rather than
 * this inventing a scope.
 */
function manifest(root: string): { name: string | null; version: string | null } {
    try {
        const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { name?: unknown; version?: unknown }
        return {
            name: typeof parsed.name === "string" && parsed.name !== "" ? parsed.name : null,
            version: typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : null,
        }
    } catch {
        return { name: null, version: null }
    }
}

/**
 * The source files that define this agent, and ONLY the ones that are there.
 *
 * A detail view offers these as editor links, so a conventional path that
 * happens not to exist is a link that opens an empty buffer — the panel
 * claiming the agent has a `src/tools` it does not have. Existence is checked
 * here, where the directory is already being walked, rather than trusted from
 * the convention.
 *
 * `axon.config.ts` is always present: `installed()` uses it as the test for
 * whether a directory is an agent at all.
 */
function definition(root: string): DefinitionFile[] {
    const candidates: DefinitionFile[] = [
        { label: "Configuration", path: join(root, "axon.config.ts") },
        { label: "Boot", path: join(root, "src", "boot.vue") },
        { label: "Tools", path: join(root, "src", "tools") },
    ]
    return candidates.filter(entry => existsSync(entry.path))
}

/**
 * When an agent was last used, as far as the filesystem can say.
 *
 * Its session store, which is written on every exchange, falling back to the
 * project itself for one that has never run. Read from mtime rather than by
 * opening session files: recency is the only thing wanted here, and a
 * directory stat answers it without parsing anything.
 *
 * Null when neither can be read — absent is honest where a zero would sort a
 * working agent to the bottom.
 */
function usedAt(root: string): number | null {
    for (const path of [join(root, ".agent", "data"), root]) {
        try {
            return statSync(path).mtimeMs
        } catch { /* try the next */ }
    }
    return null
}

/** Subdirectories of a path, or nothing when it does not exist. */
function readDirs(path: string): string[] {
    try {
        return readdirSync(path, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
    } catch {
        // Absent is the ordinary case — a machine with no profile has no
        // agents, which is a real answer and not a failure.
        return []
    }
}

export function Agents(opts: AgentsOpts = {}) {
    /**
     * The agents this daemon is supervising, by session id.
     *
     * Held for the AGENT'S lifetime, not the caller's — which is the whole
     * point: a link owned by the terminal that asked for the spawn dies with
     * that terminal, and an agent that cannot outlive its launcher can never
     * be a boot-time agent or a scheduled one.
     */
    const supervised = new Map<string, Supervised>()

    const registry = Registry({
        ...(opts.root !== undefined ? { root: opts.root } : {}),
        ...(opts.isolated !== undefined ? { isolated: opts.isolated } : {}),
    })

    /** Stamp the machine onto a record — see AgentRecord for why it is explicit. */
    function decorate(instance: AgentRecord | { sessionId: string }): AgentRecord {
        return { ...(instance as AgentRecord), machineId: opts.machineId?.() ?? null }
    }

    /**
     * Signal one agent's process.
     *
     * Owned here rather than by the registry: the registry's concern is the
     * RECORD, and a leaf that both tracked processes and killed them would be
     * two responsibilities behind one name.
     */
    function signal(sessionId: string, sig: NodeJS.Signals): boolean {
        // An agent THIS daemon supervises is shut down through its link, not
        // signalled: the link drains the wake and closes the session log,
        // where a signal leaves both hanging.
        const live = supervised.get(sessionId)
        if (live) {
            supervised.delete(sessionId)
            registry.stop(sessionId)
            void live.stop()
            return true
        }

        const record = registry.get(sessionId)
        if (!record) return false

        try {
            // The process GROUP, not the pid: an agent is a launcher plus the
            // runtime it spawned, and signalling the launcher alone leaves the
            // runtime orphaned and still holding the GPU.
            process.kill(-record.pid, sig)
            return true
        } catch {
            // A pid that vanished between the read and the signal is a race
            // with normal shutdown, not a fault — the caller asked for it to
            // stop and it has.
            return false
        }
    }

    /**
     * Refuse a spawn that would exceed what one agent may create.
     *
     * Depth caps recursion, children caps one agent's fan-out, descendants
     * caps the whole tree beneath one root. They exist because the caller here
     * is CODE rather than a person: a runaway loop that spawns on every tick
     * costs real money and real memory, and nothing else in the system is
     * counting.
     *
     * Enforced in the DAEMON rather than in the platform's `Requests`, which
     * is where they used to live. That guarded only the in-process host bridge,
     * and an agent shelling out to `axon <ref> --parent <id>` bypassed all
     * three — a route that did not exist when the limits were written. The
     * daemon is the only thing every spawn passes through, and the only thing
     * that sees the whole graph, so it is the only place a limit can be
     * enforced once rather than per-route.
     *
     * Checked BEFORE booting anything: a limit applied after the spawn has
     * already paid for the spawn.
     */
    function checkSubagentLimits(parentSessionId: string): void {
        const records = registry.list()
        const parent = records.find(record => record.sessionId === parentSessionId)
        // An unknown parent is not this function's error to raise — the spawn
        // path itself refuses it, and reporting a limit for an agent nobody
        // has heard of would name the wrong problem.
        if (!parent) return

        const depth = parent.depth ?? 0
        if (depth >= MAX_DEPTH) {
            throw err("SUBAGENT_DEPTH_EXCEEDED", {
                detail: `maximum depth is ${MAX_DEPTH}`,
                context: { sessionId: parentSessionId, depth, limit: MAX_DEPTH },
            })
        }

        const children = records.filter(record => record.parentSessionId === parentSessionId).length
        if (children >= MAX_LIVE_CHILDREN) {
            throw err("SUBAGENT_CHILD_LIMIT_EXCEEDED", {
                detail: `maximum live children is ${MAX_LIVE_CHILDREN}`,
                context: { sessionId: parentSessionId, limit: MAX_LIVE_CHILDREN },
            })
        }

        const root = parent.rootSessionId ?? parentSessionId
        const descendants = records.filter(
            record => record.rootSessionId === root && record.sessionId !== root,
        ).length
        if (descendants >= MAX_LIVE_DESCENDANTS) {
            throw err("SUBAGENT_DESCENDANT_LIMIT_EXCEEDED", {
                detail: `maximum live descendants is ${MAX_LIVE_DESCENDANTS}`,
                context: { rootSessionId: root, limit: MAX_LIVE_DESCENDANTS },
            })
        }
    }

    return {
        registry: registry,

        /** Every agent running on this machine, newest first. */
        list(): AgentRecord[] {
            return registry.list().map(decorate)
        },

        /** One agent, as a handle. Null when nothing by that id is running. */
        at(sessionId: string): InstanceT | null {
            const record = registry.get(sessionId)
            if (!record) return null

            // A handle only when THIS daemon supervises it. An agent booted
            // by a terminal that still holds its own link is observable and
            // not reachable — see Instance.contract().
            const live = supervised.get(sessionId)

            return Instance({
                record: decorate(record),
                refresh: id => {
                    const found = registry.get(id)
                    return found ? decorate(found) : null
                },
                signal: signal,
                ...(live ? { handle: DirectHandle(live) } : {}),
            })
        },

        /**
         * Every agent PROJECT on this machine, running or not.
         *
         * ── Why the daemon owns this ────────────────────────────────────────
         *
         * "What is on this box" is the daemon's whole remit, and an agent that
         * is not running is exactly as much a fact about the box as one that
         * is. The running registry could only ever answer the second half, so
         * a surface listing agents had a list that emptied when you stopped
         * them.
         *
         * ── Read from disk on every call ────────────────────────────────────
         *
         * No cache. A project appears when someone runs `axon init` in another
         * terminal, and there is no event for that — a cached answer would be
         * stale exactly when a new user is looking for the agent they just
         * made. It is one directory listing.
         */
        installed(): InstalledAgent[] {
            const found: InstalledAgent[] = []
            for (const store of storeRoots()) {
                const profiles = join(store, "profiles")
                for (const profile of readDirs(profiles)) {
                    const agents = join(profiles, profile, "agents")
                    for (const name of readDirs(agents)) {
                        const root = join(agents, name)
                        // A directory is an agent when it declares itself one.
                        // Anything else under `agents/` is somebody's stray
                        // folder, and listing it would offer a Run button for
                        // something that cannot run.
                        if (!existsSync(join(root, "axon.config.ts"))) continue
                        const declared = manifest(root)
                        found.push({
                            name: name,
                            // What the agent CALLS itself, which is what the CLI
                            // takes and what a person recognises.
                            ref: declared.name ?? name,
                            version: declared.version,
                            profile: profile,
                            root: root,
                            usedAt: usedAt(root),
                            definition: definition(root),
                        })
                    }
                }
            }
            // Most recently used first. A fleet list is a list of things you
            // might open again, and alphabetical order buries the one you
            // were just in behind nine you have never run.
            return found.sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0) || a.name.localeCompare(b.name))
        },

        /** Everything the domain reports in one read — what a client's `state()` calls. */
        state(): AgentsState {
            return { agents: this.list(), roots: registry.roots, installed: this.installed() }
        },

        /**
         * Stop one agent. False when nothing by that id was running.
         *
         * A verb on the domain as well as on the handle, because a caller with
         * an id and no handle should not have to build one to act.
         */
        stop(sessionId: string): boolean {
            return signal(sessionId, "SIGTERM")
        },

        /** Subscribe to the live list. Returns an unsubscribe. */
        /**
         * Where one agent sits in the ownership graph.
         *
         * Exists so a spawn can name a parent this PROCESS cannot see. Agent
         * code that shells out (`axon @x -p "…" --parent <id>`) runs in a
         * fresh CLI process whose instance registry is empty, while the parent
         * is alive somewhere else entirely. The daemon sees every spawn and
         * writes every record, so it is the only thing that can answer.
         *
         * Returns the root and depth rather than the whole record: those are
         * what a child inherits, and handing back a record would invite a
         * caller to read liveness from it and act on a snapshot.
         *
         * Null for an unknown id — a caller passing a stale or invented parent
         * gets a refusal rather than a child silently rooted at itself.
         */
        lineage(sessionId: string): { rootSessionId: string; depth: number } | null {
            const record = registry.get(sessionId)
            if (!record) return null
            // A record written before these were carried has neither. It IS
            // the root of whatever tree it heads, at depth 0 — which is true
            // of any agent nothing spawned, and the honest reading of a record
            // that never named a parent.
            return {
                rootSessionId: record.rootSessionId ?? sessionId,
                depth: record.depth ?? 0,
            }
        },

        watch(listener: (agents: AgentRecord[]) => void): () => void {
            return registry.watch(instances => listener(instances.map(decorate)))
        },

        /**
         * Boot an agent, supervised by this daemon.
         *
         * Takes a PREPARED blueprint, never an agent reference. Resolving a
         * reference means opening a project and preparing it, which is the
         * platform's whole build stack — a daemon that did that would be the
         * platform with a socket attached. The platform resolves and prepares;
         * the daemon hosts.
         *
         * The record is published AFTER the agent is up, so a reader never
         * sees "running" for a process that failed to boot. The supervisor is
         * held for the agent's lifetime — that is what lets it outlive the
         * terminal that asked for it.
         */
        /**
         * Boot an agent and return the SUPERVISOR's handle on it.
         *
         * Distinct from `at(id)`, which returns the consumer-facing
         * `Instance`. This is what the platform's `confined` seam consumes: it
         * needs the link, the session and the bus to assemble the runtime its
         * own surfaces expect, and those are supervisor-side objects rather
         * than anything a client should hold.
         *
         * Named `supervise` for that reason — "spawn" would suggest the
         * caller gets an agent to talk to, and what it gets is the machinery
         * behind one.
         */
        async supervise(input: SuperviseInput): Promise<Supervised> {
            /**
             * Limits FIRST, before asking whether this daemon can spawn at all.
             *
             * A spawn that exceeds what an agent may create is refused whether
             * or not a supervisor exists, and the limit is the more specific
             * answer: "you have four children already" tells the caller what
             * to change, while "this daemon has no credential" describes a
             * different machine entirely. Checking capability first also made
             * the limits unreachable in any daemon built without one, which is
             * exactly how a test proves they fire.
             */
            if (input.parentSessionId) checkSubagentLimits(input.parentSessionId)

            if (!opts.supervise) {
                throw err("DAEMON_NOT_WIRED", {
                    detail: "this daemon has no credential and cannot supervise — it was built without one",
                })
            }

            const live = await opts.supervise.spawn({
                sessionId: input.sessionId,
                blueprint: input.blueprint,
                agent: input.agent,
            })
            supervised.set(input.sessionId, live)

            registry.start({
                // The AGENT's pid, not this process's: a reader probes it to
                // decide whether the session is alive, and reporting the
                // daemon's would keep a dead agent looking healthy for as long
                // as the daemon ran.
                pid: live.pid,
                sessionId: input.sessionId,
                agentName: input.agent,
                projectRoot: input.projectRoot,
                dataRoot: input.dataRoot,
                // The ownership graph. Carried rather than derived: an agent
                // spawned by another agent is a child, readers nest on it, and
                // the runtime enforces depth limits against it. The daemon is
                // the only thing that sees every spawn, so it is the only
                // thing that can record the tree correctly.
                parentSessionId: input.parentSessionId ?? null,
                rootSessionId: input.rootSessionId ?? input.sessionId,
                depth: input.depth ?? 0,
                ...(input.job ? { job: input.job } : {}),
                // Passed THROUGH, never interpreted: a control channel belongs
                // to the surface serving it, and the daemon's part is only to
                // publish where it is so a reader can find it.
                ...(input.control ? { control: input.control } : {}),
                startedAt: new Date().toISOString(),
            })

            return live
        },

        /**
         * Boot an agent and return a handle to TALK to it.
         *
         * The consumer-facing counterpart of `supervise`. Same boot, different
         * return: this is what an SDK caller wants, and what a socket client
         * can serve.
         */
        async spawn(input: SuperviseInput): Promise<InstanceT> {
            await this.supervise(input)
            return this.at(input.sessionId)!
        },

        /**
         * Shut down every supervised agent, then release the watchers.
         *
         * Agents first: a daemon that exits leaving them running orphans every
         * one — no supervisor means no inference, so they would be alive and
         * unable to think.
         */
        async dispose(): Promise<void> {
            await Promise.all([...supervised.values()].map(async live => {
                registry.stop(live.sessionId)
                await live.stop()
            }))
            supervised.clear()
            registry.dispose()
        },
    }
}

export type AgentsT = ReturnType<typeof Agents>
