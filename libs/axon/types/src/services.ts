/**
 * The agent's side of a service: what fills a use a cognet declared.
 *
 * A provider is anything that implements an interface — a model on this
 * machine, a hosted API, a ROS service, another agent. The KERNEL holds it,
 * on the agent's side of the boundary; the cognet only ever sees the
 * interface (see `KernelServices`). Its `name` is recorded in the agent's
 * session with every call it answers, and never crosses to the cognet.
 *
 * Arguments arrive as one object keyed by the method's parameter names, and
 * answers leave as plain values. A handle a provider keeps crosses as
 * `{ handle, id }` with an id of the provider's own choosing; the kernel
 * gives the cognet its own id for it, so a handle can never be passed to a
 * use or a provider that did not make it.
 */
export type ServiceProvider = {
    /** Which provider this is — for the agent's record, never shown to the cognet. */
    readonly name: string
    /** What it reports of itself, as its interface defines. */
    describe(): Readonly<Record<string, unknown>>
    call(method: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>
    stream(method: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): AsyncIterable<unknown>
    open(method: string): Promise<ProviderSession>
    /** Lets go of a handle it keeps, by its own id. */
    release(handle: string): Promise<void>
}

/** One open session of a provider's. */
export type ProviderSession = {
    push(value: unknown): Promise<unknown>
    reset(): Promise<void>
    close(): Promise<void>
}

/**
 * What the agent granted, by use — a manager whose answer can change while the
 * mind runs: a provider goes down, a GPU frees up. Null is a use nothing fills.
 */
export type ServiceGrants = {
    granted(use: string): ServiceProvider | null
}

/**
 * What the agent grants one use, in `axon.config.ts`'s `services:`.
 *
 * - a provider: `"anthropic:claude-sonnet-5-5"` — a route the agent's
 *   inference sources supply — or `"./providers/features"`, one of its own;
 * - `"auto"`: the best this machine offers that implements the interface and
 *   meets the use's `requires` — what an absent grant means;
 * - `"off"`: nothing — an optional use goes unavailable, a required one
 *   stops the agent from starting;
 * - an object, to grant a provider (or `"auto"`) within a limit.
 */
export type ServiceGrant = string | { provider?: string; limit?: ServiceLimit }

/** What a use may cost, and how often — past it, calls are refused with SERVICE_LIMIT. */
export type ServiceLimit = {
    /** Calls allowed in each `per`. */
    calls?: number
    /** Money allowed in each `per`. */
    usd?: number
    per: "second" | "minute" | "hour" | "day"
}

/**
 * A provider the agent writes itself — `providers/<name>.provider.ts`, its
 * default export. It implements one interface: `describe()`, and each of the
 * interface's methods, taking their arguments as the interface writes them.
 * It runs on the agent's side of the boundary, with the machine the agent
 * owns; the cognet never sees which provider answered.
 */
export type ProviderDefinition = {
    /** The interface it implements: `depth-relative@1`, or a cognet's own — `@cody/terry/features@1`. */
    implements: string
    describe(): Readonly<Record<string, unknown>>
    /** Lets go of a handle it keeps, by its own id. Required of a provider whose interface returns handles. */
    release?(handle: string): Promise<void>
    readonly [method: string]: unknown
}
