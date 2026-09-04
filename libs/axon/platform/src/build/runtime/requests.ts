import { err } from "@arcforge/err"
import type { AxonRequestInput, AxonResult } from "@arcforge/types"
import type { InstancesT } from "./instances"

/**
 * The in-process door for agent-initiated spawning.
 *
 * The LIMITS on it (depth, fan-out, descendants) are enforced by the daemon —
 * see its `checkSubagentLimits`. They lived here while this was the only route
 * an agent could spawn through; it no longer is, and a rule implemented per
 * route is a rule that eventually differs by route.
 */

type RequestsOpts = {
    instances: InstancesT
}

/**
 * Requests — the host surface a running agent calls into.
 *
 * A capsule reaches the platform through exactly one method (`request`), which
 * runs a prompt on a fresh instance of the caller's own project and returns its
 * result. The instance is spawned unfocused, torn down in a finally, and
 * abort-linked to the caller's signal, so a cancelled request never strands a
 * runtime.
 *
 * This is the ONLY caller-initiated spawn path with limits attached, because it
 * is the only one where the caller is code rather than a person.
 */
export function Requests(opts: RequestsOpts) {
    const instances = opts.instances

    function abortError(): Error {
        const error = new Error("agent request aborted")
        error.name = "AbortError"
        return error
    }

    function parse(input: unknown): AxonRequestInput {
        if (!input || typeof input !== "object") {
            throw err("SUBAGENT_REQUEST_INVALID", { detail: "expected { prompt }" })
        }
        const prompt = (input as { prompt?: unknown }).prompt
        if (typeof prompt !== "string" && !(Array.isArray(prompt) && prompt.every(value => typeof value === "string"))) {
            throw err("SUBAGENT_REQUEST_INVALID", { detail: "prompt must be a string or string[]" })
        }
        return { prompt: prompt }
    }

    /**
     * Resolve the parent. The LIMITS are the daemon's.
     *
     * Depth, fan-out and descendant caps used to be enforced here, and this
     * was described as "the ONLY caller-initiated spawn path with limits
     * attached". That stopped being true: an agent shelling out to
     * `axon <ref> --parent <id>` spawns through the daemon and never touches
     * this function, so the limits guarded one of two routes.
     *
     * They live in the daemon now — the one place every spawn passes through,
     * and the only one that sees the whole ownership graph. Two
     * implementations of one rule is how they come to disagree about what a
     * limit means, which is worse than either answer.
     */
    function checkLimits(parentSessionId: string) {
        const parent = instances.get(parentSessionId)
        if (!parent) throw err("PARENT_INSTANCE_NOT_RUNNING", { context: { sessionId: parentSessionId } })
        return parent
    }

    async function request(input: {
        parentSessionId: string
        input: unknown
        signal: AbortSignal
    }): Promise<AxonResult> {
        const parent = checkLimits(input.parentSessionId)
        if (input.signal.aborted) throw abortError()

        const parsed = parse(input.input)
        // A deployed agent runs its own agents inside its own capsule — a remote
        // parent has no local project to fork. A LINKED parent has one: it runs
        // in its own process from a project on this disk, which is exactly what
        // a subagent spawn needs.
        if (parent.source.kind === "remote") {
            throw err("SUBAGENT_REMOTE_PARENT", { context: { sessionId: parent.sessionId } })
        }

        const child = await instances.spawn(parent.source.project, {
            parentSessionId: parent.sessionId,
            focus: false,
        })
        if (child.source.kind === "remote") {
            throw err("INSTANCE_NOT_LOCAL", {
                detail: "spawn() must produce an instance on this machine",
                context: { sessionId: child.sessionId, kind: child.source.kind },
            })
        }

        // Routed through the SUPERVISOR either way, never by handing the
        // parent a handle to its child.
        //
        // That distinction matters once children are real processes: giving a
        // boxed agent a direct reference to another boxed agent would reopen
        // the boundary this whole design closed, and it would put the depth
        // and fan-out limits enforced above on the honour system. The parent
        // asks this layer for work; this layer addresses the child.
        const agent = child.source.agent
        const interrupt = () => agent.link.interrupt("user")
        input.signal.addEventListener("abort", interrupt, { once: true })

        try {
            // NOT WIRED — deliberately loud rather than approximated.
            //
            // The link carries `request`, which resolves when the wake
            // SETTLES and reports `{ ok, interrupted }`. A parent needs the
            // wake's CONTENT, and no verb returns that. This used to work
            // only because the in-process path handed the parent its child's
            // in-heap handle — which is precisely the boundary that could
            // not be allowed to stay open, so its removal takes this with it.
            //
            // Not bridged with a collector here, because the destination is
            // different: a subagent should be a subprocess the agent itself
            // spawns, inheriting the same OS permissions, rather than a
            // second runtime the supervisor brokers entries between. Building
            // the collector would be building the wrong thing well.
            throw err("SUBAGENT_LINK_UNSUPPORTED", {
                detail: "subagent requests are being rebuilt on agent-spawned subprocesses — a confined agent cannot serve one today",
                context: { sessionId: child.sessionId },
            })
        } finally {
            input.signal.removeEventListener("abort", interrupt)
            await instances.stop(child.sessionId)
        }
    }

    return {
        request: request,

        /** The AxonHost surface handed to every spawned capsule. */
        async call(input: {
            callerSessionId: string
            method: string
            input: unknown
            signal: AbortSignal
        }): Promise<unknown> {
            if (input.method !== "request") {
                throw err("HOST_METHOD_UNKNOWN", { context: { method: input.method } })
            }
            return request({
                parentSessionId: input.callerSessionId,
                input: input.input,
                signal: input.signal,
            })
        },
    }
}

export type RequestsT = ReturnType<typeof Requests>
