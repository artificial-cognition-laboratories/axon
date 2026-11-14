import { err } from "@arcforge/err"
import type { AxonBlueprint, AxonDriver, CognetUse, ProviderDefinition, RemoteEngines, ResolvedEngineFacts, ServiceGrants, ServiceProvider, ServiceRequirement } from "@arcforge/types"
import type { EnginesT } from "@arcforge/engines/catalogue"
import { granted, STANDARD, type Granted } from "./services"

type GrantsOpts = {
    blueprint: AxonBlueprint
    /** This process's resolved engines — absent for a confined agent, or one whose uses ask the engines for nothing. */
    engines?: EnginesT
    /** A confined agent's engines, on the supervisor's side; the facts of each bound role crossed on the blueprint. */
    remote?: RemoteEngines
}

/**
 * Grants — what fills each use the cognet declares, decided once, at boot,
 * on the agent's side of the boundary.
 *
 * A use is filled by what the agent's `services:` grants it: one of its own
 * providers (`./providers/features`), a route its inference sources supply,
 * or — `auto`, and absent — its own provider for that interface if it wrote
 * exactly one, else the engine resolution bound to the use. Then held to the
 * use: what it `requires` of `describe()` must be met, and a limit wraps it.
 *
 * A REQUIRED use nothing fills stops the boot here, by name — a mind that
 * started without it would reach for it mid-wake. An optional one is simply
 * unavailable, which a mind asks about.
 *
 * Async because the agent's own providers are modules, loaded before the
 * first call can reach one.
 */
export async function Grants(opts: GrantsOpts): Promise<ServiceGrants> {
    const uses = opts.blueprint.cognet.uses ?? {}
    const grants = granted(uses, opts.blueprint.config.services)
    const own = await loaded(opts.blueprint.serviceProviders)

    const filled = new Map<string, ServiceProvider>()
    /** Providers that are an engine resolution bound: the resolver has already admitted what they cannot report. */
    const engined = new Set<ServiceProvider>()
    const unfilled: string[] = []
    for (const [name, use] of Object.entries(uses)) {
        const grant = grants[name]!
        const provider = pick(name, use, grant)
        if (!provider) {
            if (!use.optional) unfilled.push(`${name} (${use.named})${grant.kind === "off" ? " — granted off" : ""}`)
            continue
        }
        const unmet = unmetBy(use, provider.describe(), engined.has(provider))
        if (unmet) {
            if (!use.optional) unfilled.push(`${name} (${use.named}) — ${provider.name} ${unmet}`)
            else err("SERVICE_UNAVAILABLE", { detail: `${name} is unavailable: ${provider.name} ${unmet}`, context: { use: name } })
            continue
        }
        filled.set(name, grant.kind !== "off" && grant.limit ? limited(provider, name, grant.limit) : provider)
    }
    if (unfilled.length > 0) {
        throw err("SERVICE_UNAVAILABLE", { detail: `this cognet requires uses nothing can fill:\n  ${unfilled.join("\n  ")}`, context: { uses: unfilled } })
    }

    return { granted: use => filled.get(use) ?? null }

    /** What a grant names, as a provider of the use's interface — or null when nothing fills it. */
    function pick(name: string, use: CognetUse, grant: Granted): ServiceProvider | null {
        if (grant.kind === "off") return null
        if (grant.kind === "own") {
            const found = own.get(grant.path)
            if (!found) throw err("SERVICE_INVALID", { detail: `services.${name}: no provider ${grant.path} — write providers/${grant.path.slice("./providers/".length)}.provider.ts`, context: { use: name } })
            return written(grant.path, found, name, use, needed(grant.path, found.needs, name))
        }
        if (grant.kind === "auto") {
            const implementing = [...own].filter(([, definition]) => definition.implements === use.named)
            if (implementing.length > 1) throw err("SERVICE_INVALID", { detail: `services.${name}: ${implementing.map(([path]) => path).join(" and ")} both implement ${use.named} — grant one`, context: { use: name } })
            if (implementing.length === 1) {
                const [path, definition] = implementing[0]!
                return written(path, definition, name, use, needed(path, definition.needs, name))
            }
        }
        return engine(name, use)
    }

    /** The drivers a provider the agent wrote asked for, each bound as `<provider>/<engine>` — or a refusal naming what is missing. */
    function needed(path: string, needs: Readonly<Record<string, unknown>>, use: string): Record<string, AxonDriver> {
        return Object.fromEntries(Object.keys(needs).map(engine => {
            const role = `${path}/${engine}`
            const driver = drive(role)
            if (!driver) throw err("SERVICE_UNAVAILABLE", { detail: `${use}: ${path} needs a ${engine} engine, and nothing this machine has can serve it`, context: { use: use, provider: path } })
            return [engine, driver]
        }))
    }

    /** The driver resolution bound to a role, here or on the supervisor's side — null when none was. */
    function drive(role: string): AxonDriver | null {
        if (opts.remote) {
            const facts = opts.blueprint.cognet.resolvedEngines?.[role]
            if (!facts) return null
            return facts.type === "transform" ? opts.remote.transform(role) : opts.remote.generate(role)
        }
        return opts.engines?.has(role) ? opts.engines.get(role).driver : null
    }

    /** The engine resolution bound to the use, served through its interface's adapter — or null when none was bound. */
    function engine(name: string, use: CognetUse): ServiceProvider | null {
        const adapter = STANDARD[use.named]
        if (!adapter) return null
        if (opts.remote) {
            const facts = opts.blueprint.cognet.resolvedEngines?.[name]
            if (!facts) return null
            const driver = facts.type === "transform" ? opts.remote.transform(name) : opts.remote.generate(name)
            // The supervisor knows which route answers; the box is told only what it can do.
            return bound(adapter.provider(driver, "supervisor", asked(use, facts)))
        }
        if (!opts.engines?.has(name)) return null
        const { driver, binding } = opts.engines.get(name)
        const facts: ResolvedEngineFacts = {
            type: binding.requirement.type,
            ...(binding.capability.context !== undefined ? { context: binding.capability.context } : {}),
            modalities: { in: [...binding.capability.in], out: [...binding.capability.out] },
            slots: binding.slots,
        }
        return bound(adapter.provider(driver, `${binding.capability.provider}:${binding.capability.id}`, asked(use, facts)))
    }

    function bound(provider: ServiceProvider): ServiceProvider {
        engined.add(provider)
        return provider
    }

    /** What resolution learned, with no more slots than the use asked for: `parallel` is the most it would use. */
    function asked(use: CognetUse, facts: ResolvedEngineFacts): ResolvedEngineFacts {
        return use.parallel !== undefined && use.parallel < facts.slots ? { ...facts, slots: use.parallel } : facts
    }
}

/** Every provider the agent wrote, loaded and checked: each a module whose default export says what it implements. */
async function loaded(providers: AxonBlueprint["serviceProviders"]): Promise<Map<string, ProviderDefinition & { needs: AxonBlueprint["serviceProviders"][number]["engines"] }>> {
    const found = new Map<string, ProviderDefinition & { needs: AxonBlueprint["serviceProviders"][number]["engines"] }>()
    for (const provider of providers) {
        const module = await import(provider.filePath) as { default?: unknown }
        const definition = module.default
        if (typeof definition !== "object" || definition === null || typeof (definition as ProviderDefinition).implements !== "string" || typeof (definition as ProviderDefinition).describe !== "function") {
            throw err("SERVICE_INVALID", { detail: `${provider.filePath}: a provider's default export is defineProvider({ implements, describe, … })`, context: { provider: provider.name } })
        }
        found.set(provider.name, Object.assign(definition as ProviderDefinition, { needs: provider.engines }))
    }
    return found
}

/**
 * A provider the agent wrote, as the kernel calls it: each method of the
 * interface taking its arguments as the interface writes them — positional,
 * in its parameters' order — from the one object a call crosses as.
 */
function written(path: string, definition: ProviderDefinition, name: string, use: CognetUse, engines: Record<string, AxonDriver>): ServiceProvider {
    if (definition.implements !== use.named) {
        throw err("SERVICE_INVALID", { detail: `services.${name}: ${path} implements ${definition.implements}, but ${name} uses ${use.named}`, context: { use: name } })
    }
    const missing = Object.entries(use.methods).filter(([method, shape]) => shape.kind !== "describe" && typeof definition[method] !== "function").map(([method]) => method)
    if (missing.length > 0) throw err("SERVICE_INVALID", { detail: `${path} implements ${use.named} but has no ${missing.join(", ")}`, context: { provider: path } })

    // What a method's `this` holds: the definition, and the machine's engines it asked for.
    const self = Object.assign(Object.create(definition) as ProviderDefinition, { engines: engines })
    const method = (named: string) => definition[named] as (...args: unknown[]) => unknown
    const positional = (named: string, args: Readonly<Record<string, unknown>>) => use.methods[named]!.params.map(param => args[param])
    return {
        name: path,
        describe: () => definition.describe.call(self),
        call: async (named, args) => method(named).apply(self, positional(named, args)),
        stream: (named, args) => method(named).apply(self, positional(named, args)) as AsyncIterable<unknown>,
        open: async named => {
            const session = await method(named).apply(self, []) as { push(value: unknown): Promise<unknown>; reset(): Promise<void> | void; close(): Promise<void> | void }
            return { push: value => session.push(value), reset: async () => session.reset(), close: async () => session.close() }
        },
        release: async handle => {
            if (!definition.release) throw err("SERVICE_INVALID", { detail: `${path} hands out handles but has no release()`, context: { provider: path } })
            await definition.release.call(self, handle)
        },
    }
}

/**
 * Why what a provider reports does not meet what the use requires of it — null when it does.
 *
 * A field it does not report refuses a provider the agent wrote. For an engine
 * the resolver bound it is UNKNOWN, as the resolver read it — a route that does
 * not publish a context window was admitted there, and refusing it here would
 * undo that decision with nothing new to go on.
 */
function unmetBy(use: CognetUse, described: Readonly<Record<string, unknown>>, resolved: boolean): string | null {
    for (const [field, required] of Object.entries(use.requires ?? {})) {
        const reported = described[field]
        if (reported === undefined && resolved) continue
        if (reported === undefined) return `does not report ${field}, which the use requires`
        if (!meets(reported, required)) return `reports ${field} ${JSON.stringify(reported)}, which does not meet ${JSON.stringify(required)}`
    }
    return null
}

function meets(reported: unknown, required: ServiceRequirement): boolean {
    if (typeof required !== "object") return reported === required
    if ("includes" in required) return Array.isArray(reported) && required.includes.every(value => reported.includes(value))
    if (typeof reported !== "number") return false
    return (required.min === undefined || reported >= required.min) && (required.max === undefined || reported <= required.max)
}

/** A provider within a limit: past it, calls are refused with SERVICE_LIMIT until the window moves on. */
function limited(provider: ServiceProvider, name: string, limit: NonNullable<Exclude<Granted, { kind: "off" }>["limit"]>): ServiceProvider {
    if (limit.usd !== undefined) throw err("SERVICE_INVALID", { detail: `services.${name}: a usd limit is not wired yet — nothing prices a call; limit calls instead`, context: { use: name } })
    if (limit.calls === undefined) return provider
    const window = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }[limit.per]
    const made: number[] = []
    const admit = () => {
        const now = Date.now()
        while (made.length > 0 && made[0]! <= now - window) made.shift()
        if (made.length >= limit.calls!) throw err("SERVICE_LIMIT", { detail: `${name} reached its limit of ${limit.calls} calls a ${limit.per}`, context: { use: name } })
        made.push(now)
    }
    return {
        name: provider.name,
        describe: () => provider.describe(),
        call: async (method, args, signal) => {
            admit()
            return provider.call(method, args, signal)
        },
        stream: (method, args, signal) => {
            admit()
            return provider.stream(method, args, signal)
        },
        open: async method => {
            admit()
            return provider.open(method)
        },
        release: handle => provider.release(handle),
    }
}
