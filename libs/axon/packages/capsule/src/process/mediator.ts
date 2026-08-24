import { randomUUID } from "node:crypto"
import type { CapsulePolicy, PolicyRule } from "../../types"
import { globMatch } from "./glob"

/**
 * The key a blanket rule normalises to — see `PolicyBucket` and `Blueprint`.
 *
 * Declared here rather than imported: this file is GUEST code, which may
 * import node builtins and type-only declarations and nothing else (the
 * workspace symlink points outside the confined filesystem, so a runtime
 * import kills the subprocess at startup). Kept in step with the host's
 * `POLICY_WILDCARD` by `tests/policy-wildcard.test.ts`, which asserts the two
 * literals match — the same "duplicated across the boundary, guarded by a
 * test" shape the error codes already use.
 */
const POLICY_WILDCARD = "*"
import type { SandboxWireT } from "./wire"

type MediatorOpts = {
    policy: CapsulePolicy
    wire: SandboxWireT
}

export type MediatorT = {
    /**
     * Check one call against policy. `fn` is fully qualified ("process.spawn",
     * "network.api.github.com", "math.add"); `subject` is the string the rule
     * matches against (a command, host, or tool-specific value). Resolves once
     * allow/deny is known — escalation is a round trip to the host, awaited here.
     */
    check(fn: string, subject: string, args: unknown[], owner?: string): Promise<boolean>
    update(policy: CapsulePolicy): void
}

const MODULE_RULES: Record<string, (policy: CapsulePolicy) => PolicyRule | undefined> = {
    "process.spawn": p => p.process.spawn,
    "process.run": p => p.process.run,
}

/**
 * Mediator — the sandbox's policy enforcement point. Every tool call and
 * proc:spawn routes through check() before it runs. Default is deny: an
 * fn with no matching rule, or a rule that gives no verdict, is denied —
 * a capsule must never grant capability by omission.
 */
export function Mediator(opts: MediatorOpts): MediatorT {
    let policy = opts.policy
    const { wire } = opts

    const pending = new Map<string, (allow: boolean) => void>()

    wire.onCommand(cmd => {
        if (cmd.type !== "policy:response") return
        const resolve = pending.get(cmd.id)
        if (!resolve) return
        pending.delete(cmd.id)
        resolve(cmd.allow)
    })

    function evaluate(rule: PolicyRule | undefined, subject: string): "allow" | "deny" | "escalate" {
        if (rule === undefined) return "deny"
        if (rule === true) return "allow"
        if (rule === false) return "deny"
        if (rule === "escalate") return "escalate"

        if (rule.deny?.some(pattern => globMatch(pattern, subject))) return "deny"
        if (rule.escalate?.some(pattern => globMatch(pattern, subject))) return "escalate"
        if (rule.allow?.some(pattern => globMatch(pattern, subject))) return "allow"
        return "deny"
    }

    /**
     * process.spawn/process.run resolve by exact fn via MODULE_RULES — the
     * only two built-in verbs the capsule mediates directly. Everything else
     * is either a network destination (policy.network, keyed by host) or a
     * custom tool (policy.tools, keyed by namespace) — both resolve by the
     * fn's namespace (the part before the first ".") since neither can be
     * enumerated in a static table. One rule covers every fn in that
     * namespace/host bucket.
     */
    function resolveRule(fn: string, owner?: string): PolicyRule | undefined {
        const builtin = MODULE_RULES[fn]?.(policy)
        if (builtin !== undefined) return builtin

        // An exact key wins; a `*` entry catches everything else.
        //
        // The wildcard is what a bare `tools: "escalate"` normalises to (see
        // Blueprint), and it is also authorable directly alongside named keys.
        // Specific-beats-wildcard is ordinary glob precedence, and it is what
        // makes `{ "*": "escalate", fs: true }` mean what it reads as.
        const namespace = owner ?? fn.split(".")[0]!
        if (namespace === "network") {
            const host = fn.slice("network.".length)
            return policy.network?.[host] ?? policy.network?.[POLICY_WILDCARD]
        }
        return policy.tools?.[namespace] ?? policy.tools?.[POLICY_WILDCARD]
    }

    async function check(fn: string, subject: string, args: unknown[], owner?: string): Promise<boolean> {
        const module = owner ?? fn.split(".")[0]!
        const rule = resolveRule(fn, owner)
        const verdict = evaluate(rule, subject)

        if (verdict === "allow") return true
        if (verdict === "deny") {
            wire.emit("capsule:policy:denied", { id: randomUUID(), module, fn, args, rule: String(rule) })
            return false
        }

        // Escalate — round trip to the host, default deny on timeout.
        const id = randomUUID()
        wire.emit("capsule:policy:escalation", { id, module, fn, args, rule: String(rule) })

        return new Promise<boolean>(resolve => {
            const timeoutMs = 30_000
            const timer = setTimeout(() => {
                pending.delete(id)
                resolve(false)
            }, timeoutMs)

            pending.set(id, allow => {
                clearTimeout(timer)
                resolve(allow)
            })
        })
    }

    return {
        check,
        update(next: CapsulePolicy) {
            policy = next
        },
    }
}
