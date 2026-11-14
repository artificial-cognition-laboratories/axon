import { err } from "@arcforge/err"
import type { CognetUse, EngineRequirement, EngineRequirements, ServiceGrant } from "@arcforge/types"
import { STANDARD } from "./standard"

/** A grant, read: off, auto, one of the agent's own providers, or a route its inference sources supply — and its limit. */
export type Granted =
    | { kind: "off" }
    | { kind: "auto"; limit?: Limit }
    | { kind: "own"; path: string; limit?: Limit }
    | { kind: "route"; pin: string; limit?: Limit }

type Limit = Exclude<ServiceGrant, string>["limit"]

/**
 * What the agent granted each use — read once, the same way wherever a use is
 * resolved: in this process, or on the supervisor's side of a confined one.
 * Absent is `auto`. A grant for a use the cognet does not declare is a
 * mistake, not something to ignore.
 */
export function granted(uses: Readonly<Record<string, CognetUse>>, grants: Readonly<Record<string, ServiceGrant>> | undefined): Record<string, Granted> {
    for (const name of Object.keys(grants ?? {})) {
        if (!uses[name]) throw err("SERVICE_INVALID", { detail: `services.${name}: the cognet declares no use "${name}" — it uses ${Object.keys(uses).join(", ") || "nothing"}`, context: { use: name } })
    }
    return Object.fromEntries(Object.keys(uses).map(name => [name, read(name, grants?.[name])]))
}

/** One grant, its shape checked: axon.config.ts is evaluated as written, so nothing has checked it before here. */
function read(name: string, grant: unknown): Granted {
    if (grant === undefined || grant === "auto") return { kind: "auto" }
    if (grant === "off") return { kind: "off" }
    if (typeof grant === "string") return named(grant, undefined)
    if (typeof grant !== "object" || grant === null) throw invalid(name, `a provider, "auto", "off", or { provider?, limit? } — not ${JSON.stringify(grant)}`)
    const { provider, limit } = grant as { provider?: unknown; limit?: unknown }
    if (provider !== undefined && typeof provider !== "string") throw invalid(name, "a provider named as text")
    if (limit !== undefined) {
        const { calls, usd, per } = limit as { calls?: unknown; usd?: unknown; per?: unknown }
        if (typeof limit !== "object" || limit === null || !["second", "minute", "hour", "day"].includes(per as string)) throw invalid(name, `a limit { calls?, usd?, per: "second" | "minute" | "hour" | "day" }`)
        if ((calls !== undefined && !(Number.isInteger(calls) && (calls as number) > 0)) || (usd !== undefined && !(typeof usd === "number" && usd > 0))) throw invalid(name, "a limit of a whole number of calls, or an amount of money, above 0")
    }
    return object(grant as Exclude<ServiceGrant, string>)
}

function invalid(name: string, must: string) {
    return err("SERVICE_INVALID", { detail: `services.${name} must be ${must}`, context: { use: name } })
}

function object(grant: Exclude<ServiceGrant, string>): Granted {
    const limit = grant.limit
    if (grant.provider === undefined || grant.provider === "auto") return { kind: "auto", ...(limit ? { limit: limit } : {}) }
    return named(grant.provider, limit)
}

function named(provider: string, limit: Limit): Granted {
    return provider.startsWith("./")
        ? { kind: "own", path: provider, ...(limit ? { limit: limit } : {}) }
        : { kind: "route", pin: provider, ...(limit ? { limit: limit } : {}) }
}

/**
 * The engine roles the machine's own engines are asked to fill — one per use
 * of a standard interface that a route may serve — and the routes granted by
 * name. A use granted off, or to one of the agent's own providers, asks the
 * engines for nothing.
 */
export function engineRoles(uses: Readonly<Record<string, CognetUse>>, grants: Readonly<Record<string, Granted>>): { requirements: EngineRequirements; pins: Record<string, string> } {
    const requirements: EngineRequirements = {}
    const pins: Record<string, string> = {}
    for (const [name, use] of Object.entries(uses)) {
        const grant = grants[name]!
        const adapter = STANDARD[use.named]
        if (!adapter && use.model !== undefined) throw err("SERVICE_INVALID", { detail: `${name} names a model, but ${use.named} is not served by any engine — only a provider the agent writes can serve it`, context: { use: name } })
        if (grant.kind === "off" || grant.kind === "own") continue
        if (!adapter) {
            if (grant.kind === "route") throw err("SERVICE_INVALID", { detail: `services.${name}: granted "${grant.pin}", but ${use.named} is not served by any engine — only a provider the agent writes can serve it`, context: { use: name } })
            continue
        }
        requirements[name] = { ...adapter.requirement(use), ...shared(use) }
        if (grant.kind === "route") pins[name] = grant.pin
    }
    return { requirements: requirements, pins: pins }
}

/**
 * What a use decides of its requirement whatever its interface. A `slots`
 * minimum in `requires` asks for that many at once as surely as `parallel`
 * does — it is then also held against what binds.
 */
function shared(use: CognetUse): Partial<EngineRequirement> {
    const slots = use.requires?.slots
    const least = typeof slots === "number" ? slots : typeof slots === "object" && slots !== null && "min" in slots ? slots.min ?? 1 : 1
    return {
        ...(use.optional ? { optional: true } : {}),
        ...(use.primary ? { primary: true } : {}),
        ...(use.model !== undefined ? { model: typeof use.model === "string" ? [use.model] : use.model } : {}),
        ...((use.parallel ?? 1) > 1 || least > 1 ? { parallel: true } : {}),
    }
}

/**
 * What can be known about the grants before anything runs — at prepare: each
 * names a use the cognet declares, a provider of the agent's own that exists,
 * and no route for an interface no engine serves. Throws on the first that
 * does not. Whether a route can actually be reached is the boot's to find.
 */
export function checked(uses: Readonly<Record<string, CognetUse>>, grants: Readonly<Record<string, ServiceGrant>> | undefined, providers: ReadonlyArray<{ name: string; implements: string }>): void {
    const read = granted(uses, grants)
    engineRoles(uses, read)
    for (const [name, grant] of Object.entries(read)) {
        if (grant.kind !== "own") continue
        const provider = providers.find(one => one.name === grant.path)
        if (!provider) throw err("SERVICE_INVALID", { detail: `services.${name}: no provider ${grant.path} — write providers/${grant.path.slice("./providers/".length)}.provider.ts`, context: { use: name } })
        if (provider.implements !== uses[name]!.named) throw err("SERVICE_INVALID", { detail: `services.${name}: ${grant.path} implements ${provider.implements}, but ${name} uses ${uses[name]!.named}`, context: { use: name } })
    }
}
