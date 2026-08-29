import { randomUUID } from "node:crypto"
import { decideShell, evaluateRule, isMemberBag, POLICY_WILDCARD } from "@arcforge/types"
import type { EffectiveRule, ResolvedCapsulePolicy, ShellDecision } from "@arcforge/types"

import type { InProcWireT as SandboxWireT } from "../inproc/emitter"

type MediatorOpts = {
    policy: ResolvedCapsulePolicy
    wire: SandboxWireT
}

export type MediatorT = {
    /**
     * Decide one program execution.
     *
     * Distinct from `check` because the question is different: this resolves an
     * argv to the program it ACTUALLY runs — through `env`, `nice`, an absolute
     * path, or a shell — and decides on that. The rule it replaced glob-matched
     * a command string, which `git  push`, `env git push` and `sh -c "git
     * push"` each defeated while naming the same binary.
     */
    shell(argv: string[]): Promise<ShellDecision>
    /**
     * Check one call against policy. `fn` is fully qualified ("process.spawn",
     * "network.api.github.com", "math.add"); `subject` is the string the rule
     * matches against (a command, host, or tool-specific value). Resolves once
     * allow/deny is known — escalation is a round trip to the host, awaited here.
     */
    check(fn: string, subject: string, args: unknown[], owner?: string): Promise<boolean>
    update(policy: ResolvedCapsulePolicy): void
}

/**
 * The built-in verbs the mediator resolves by exact name.
 *
 * `shell.spawn` is the only one left. `process.run` is gone: execution is now
 * decided by `decideShell`, which reasons about the PROGRAM rather than
 * matching a glob against a command string — see policy-shell.ts for the four
 * spellings that defeated the old form.
 */
const MODULE_RULES: Record<string, (policy: ResolvedCapsulePolicy) => EffectiveRule | undefined> = {
    "shell.spawn": p => spawnRule(p.shell),
}

/** The spawn verdict, whichever of its two authored shapes was used. */
function spawnRule(shell: ResolvedCapsulePolicy["shell"]): EffectiveRule | undefined {
    const spawn = shell?.spawn
    if (spawn !== null && typeof spawn === "object" && "rule" in spawn) return spawn.rule
    return spawn as EffectiveRule | undefined
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

    /**
     * One rule against one subject.
     *
     * Delegates to `evaluateRule` in @arcforge/types rather than reimplementing
     * the precedence. This file used to carry its own copy — along with its own
     * glob matcher, its own `isMemberBag`, and its own POLICY_WILDCARD literal
     * — because it was GUEST code that could not import across the subprocess
     * boundary, and a test asserted the two copies agreed.
     *
     * That boundary is gone: the capsule is a scope inside the agent's own
     * process, not a process of its own. Two implementations of one precedence
     * rule is how a call gets permitted on one path and denied on the other,
     * with nothing to say which is right.
     *
     * Deny-by-omission is preserved: `evaluateRule` returns undefined for a
     * rule that was never declared, and a mediator must never grant capability
     * by omission.
     */
    function evaluate(rule: EffectiveRule | undefined, subject: string): "allow" | "deny" | "escalate" {
        return evaluateRule(rule, subject, "agent")?.verdict ?? "deny"
    }

    /**
     * `shell.spawn` resolves by exact fn via MODULE_RULES — the one built-in
     * verb still decided by a rule. Everything else is a custom tool
     * (policy.tools, keyed by namespace), resolved by walking the fn's address
     * from most specific to least since tools cannot be enumerated in a static
     * table.
     *
     * Program execution is NOT here: `decideShell` answers it, because the
     * question is which binary a command actually runs rather than which rule
     * an address maps to.
     */
    function resolveRule(fn: string, owner?: string): EffectiveRule | undefined {
        const builtin = MODULE_RULES[fn]?.(policy)
        if (builtin !== undefined) return builtin

        // An exact key wins; a `*` entry catches everything else.
        //
        // The wildcard is what a bare `tools: "escalate"` normalises to (see
        // Blueprint), and it is also authorable directly alongside named keys.
        // Specific-beats-wildcard is ordinary glob precedence, and it is what
        // makes `{ "*": "escalate", fs: true }` mean what it reads as.
        const head = fn.split(".")[0]!

        // The ADDRESS walk, most specific first — `fs.read` → `fs` → `*`.
        // The policy map mirrors the agent's global scope one-for-one, so a
        // rule and a call site are the same string. Resolved off `fn`, never
        // `owner`: owner is the module an export came from, which is a fact
        // for the audit record and not an address anyone writes a rule
        // against.
        const dot = fn.indexOf(".")
        const member = dot === -1 ? undefined : fn.slice(dot + 1)
        const entry = policy.tools?.[head]

        if (isMemberBag(entry)) {
            // A bag with no rule for this member falls through to `*`; the
            // bag itself says nothing about members it does not name.
            if (member !== undefined && member in entry) return entry[member]
            return policy.tools?.[POLICY_WILDCARD] as EffectiveRule | undefined
        }

        return (entry as EffectiveRule | undefined) ?? policy.tools?.[POLICY_WILDCARD] as EffectiveRule | undefined
    }

    async function check(fn: string, subject: string, args: unknown[], owner?: string): Promise<boolean> {
        const module = owner ?? fn.split(".")[0]!
        const rule = resolveRule(fn, owner)
        const verdict = evaluate(rule, subject)

        if (verdict === "allow") return true
        if (verdict === "deny") {
            wire.emit("process:policy:denied", { id: randomUUID(), module, fn, args, rule: String(rule) })
            return false
        }

        // Escalate — round trip to the host, default deny on timeout.
        const id = randomUUID()

        return new Promise<boolean>(resolve => {
            const timeoutMs = 30_000
            const timer = setTimeout(() => {
                pending.delete(id)
                resolve(false)
            }, timeoutMs)

            /**
             * REGISTER BEFORE ANNOUNCING.
             *
             * Across a wire the order did not matter: the escalation went out
             * over stdout and any answer came back on a later tick, by which
             * time this resolver was long since in place.
             *
             * In one heap `emit` is synchronous all the way through — the
             * decider is called and its answer delivered inside this very
             * call. Announcing first meant the response arrived before there
             * was anything to receive it, the resolver was registered into a
             * conversation that had already finished, and the call sat until
             * the 30s timeout denied it. A policy answered instantly still
             * took half a minute to be refused.
             */
            pending.set(id, allow => {
                clearTimeout(timer)
                resolve(allow)
            })

            wire.emit("process:policy:escalation", { id, module, fn, args, rule: String(rule) })
        })
    }

    /**
     * Program execution. Denials are reported with the REASON — `raw-shell` and
     * `not-allowed` are different mistakes and the model can act on the
     * difference; "denied by policy" tells it nothing it can fix.
     */
    async function shell(argv: string[]): Promise<ShellDecision> {
        const decision = decideShell(policy.shell, argv)
        if (decision.verdict === "allow") return decision

        if (decision.verdict === "deny") {
            wire.emit("process:policy:denied", {
                id: randomUUID(), module: "shell", fn: `shell.run:${decision.program}`,
                args: argv, rule: decision.reason,
            })
            return decision
        }

        const allowed = await check(`shell.run:${decision.program}`, argv.join(" "), argv, "shell")
        return { ...decision, verdict: allowed ? "allow" : "deny" }
    }

    return {
        check,
        shell,
        update(next: ResolvedCapsulePolicy) {
            policy = next
        },
    }
}
