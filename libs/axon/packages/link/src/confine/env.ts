import { err } from "@arcforge/err"
import type { CapsulePolicy } from "@arcforge/types"

/**
 * The environment an agent's process receives.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 *
 * `{ ...process.env }`. Every variable in the invoking shell — every provider
 * key, every database URL, every token the developer happened to have exported
 * — handed to the agent, and through it to any line the model emitted. The `fs`
 * policy would deny reading `.env` off disk while the same secrets arrived as
 * environment, which made the filesystem grant theatre for anything that
 * mattered. It was live under `isolation: "none"` too, so no policy setting
 * escaped it.
 *
 * ── The three sources, in precedence order ──────────────────────────────────
 *
 *   1. THE FLOOR — HOME, PATH, and the runtime's own plumbing. Added by the
 *      builder, not here. Not a grant: the box cannot start without it, and it
 *      is deliberately kept out of `axon policy` output so a reader is never
 *      shown wiring as though they had asked for it.
 *
 *   2. THE AGENT'S OWN `.env` — beside its code, already gitignored, already
 *      the file a developer puts credentials in. This is why deny-by-default
 *      costs nothing in practice: the common case needs no policy at all, and
 *      it makes local behaviour match deployed, where `.env` is uploaded and
 *      there is no shell to inherit from in the first place.
 *
 *   3. `policy.env.allow` — the escape hatch, for a variable that genuinely
 *      belongs to the host rather than the agent: something CI injects, a token
 *      shared across several agents. Rare by design.
 *
 * INFERENCE CREDENTIALS ARE IN NONE OF THESE, deliberately. The provider key is
 * held by the supervisor and the agent asks for a ROLE over the link, so there
 * is no engine key inside the box to leak. See `engine.ts`'s `remote` driver.
 */

/**
 * Framework-owned names an agent's own `.env` must not set.
 *
 * Mirrors the deploy path's `RESERVED` list, which guarded this at upload time
 * only — so a LOCAL `.env` could set `AGENT_ID` and quietly reidentify the
 * agent to itself. The same guard belongs on both paths or it guards the
 * inconvenient one and not the reachable one.
 */
const RESERVED = new Set([
    "AGENT_ID",
    "DEPLOYMENT_ID",
    "OWNER_USER_ID",
    "AXON_TIER",
    "AXON_WARMTH",
    "GCP_PROJECT_ID",
    "GCP_REGION",
    "AXON_SOURCE",
    "AGENT_ROOT",
    "AXON_API_BASE",
    "AXON_JWT_PUBLIC_KEY",
    "PORT",
])

export type EnvOpts = {
    /** The agent's own `.env`, already parsed. */
    agentEnv: Record<string, string>
    /** The resolved `env` policy — which host variables may cross. */
    policy: CapsulePolicy["env"]
    /** The host environment to draw granted variables from. */
    host: NodeJS.ProcessEnv
}

export type ResolvedEnv = {
    /** What the box receives, beyond the runtime floor. */
    env: Record<string, string>
    /**
     * Host variables that are SET but were not granted.
     *
     * Carried so a denial can name the variable and the fix. A missing
     * credential that surfaces as a downstream 401 is the failure mode that
     * makes people switch policy off, and the difference between this feature
     * being adopted and being disabled is whether the error says which line to
     * write.
     */
    withheld: string[]
}

/**
 * Build the box's environment from the three sources above.
 *
 * Deny-by-default: a name that appears in none of them is simply absent. There
 * is no wildcard and no "pass everything" switch, because the one thing this
 * function exists to prevent is exactly what such a switch would restore.
 */
export function resolveEnv(opts: EnvOpts): ResolvedEnv {
    const env: Record<string, string> = {}

    // The agent's own file first.
    for (const [key, value] of Object.entries(opts.agentEnv)) {
        if (RESERVED.has(key)) {
            throw err("AGENT_ENV_RESERVED", {
                detail: `.env cannot set framework-owned variable "${key}"`,
                context: { key },
            })
        }
        env[key] = value
    }

    // Then explicitly granted host variables. These OVERLAY the agent's file:
    // a grant is a deliberate statement that the host's value is the one that
    // should win, which is what makes CI injection work without editing `.env`.
    const granted = new Set(opts.policy?.allow ?? [])
    for (const key of granted) {
        const value = opts.host[key]
        // A granted name that is unset on the host is not an error — the grant
        // says "may cross", not "must exist".
        if (value !== undefined) env[key] = value
    }

    // Anything set on the host, not granted, and not supplied by the agent's
    // own file. These are what a denial message can point at.
    const withheld = Object.keys(opts.host)
        .filter(key => !granted.has(key) && !(key in env) && !isFloor(key))
        .sort()

    return { env, withheld }
}

/**
 * Names that are wiring rather than data, and are never reported as withheld.
 *
 * Listing PATH or HOME as "a variable your policy withheld" would bury the
 * three names that actually matter under forty that never do.
 */
function isFloor(key: string): boolean {
    return key === "HOME" || key === "PATH" || key === "PWD" || key === "SHELL"
        || key === "TERM" || key === "USER" || key === "LOGNAME" || key === "LANG"
        || key === "TZ" || key.startsWith("LC_") || key.startsWith("XDG_")
        || key.startsWith("AXON_") || key.startsWith("_")
}

/**
 * The message shown when a tool reads a variable the policy withheld.
 *
 * Names the variable AND the line that fixes it. This is the whole reason
 * `withheld` is tracked: deny-by-default is only adoptable if its denials are
 * legible, and "undefined" is not.
 */
export function withheldMessage(key: string): string {
    return [
        `POLICY_ENV_DENIED: ${key} is set on your machine but was not granted to this agent.`,
        `  Grant it:  env: { allow: ["${key}"] }   in axon.config.ts`,
        `  Or set it in the agent's own .env, which needs no policy.`,
    ].join("\n")
}
