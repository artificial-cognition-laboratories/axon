import { err } from "@arcforge/err"
import type { ComponentDescriptor, FrameDescriptor } from "./schema"

/**
 * Handles — the objects a cognet refers to its components, queries and frames by.
 *
 * A component is a NAME plus a TYPE. Referring to one by object rather than by
 * string is what makes `reads: [flow]` something an editor can follow: hover
 * shows the type, go-to-definition lands on the declaration, find-references
 * is the lineage graph.
 *
 * Handles are born NAMELESS. Their name and scope come from where they are
 * defined — the compile step reads `export const flow = component<Flow>()` in
 * `L0/vision/components.ts` and names it `L0/vision/flow`, scoped to
 * `L0/vision`. Authors never write a name, so a name cannot drift from the
 * file that owns it. A handle the compile step never saw throws on first use.
 */

export type ComponentOpts = {
    /** How a reader should render the value. Absent: the debugger shows it raw. */
    display?: ComponentDescriptor
}

export type QueryOpts = {
    /** Entities holding any of these are excluded. */
    without?: readonly Component<any>[]
}

/** Where a definition lives: its full name, and the folder whose systems may see it. */
export type Identity = {
    /** `L0/vision/flow` — the defining folder, then the export name. */
    name: string
    /** `L0/vision` — the defining folder, relative to the cognet root. `""` at the root. */
    scope: string
}

export type Component<T = unknown> = {
    readonly kind: "component"
    readonly opts: ComponentOpts
    readonly name: string
    readonly scope: string
    /** Phantom: carries `T` so reads and writes are typed without a registry. */
    readonly type?: T
}

export type QueryShape = Record<string, Component<any>>

export type Query<S extends QueryShape = QueryShape> = {
    readonly kind: "query"
    readonly shape: S
    readonly opts: QueryOpts
    readonly name: string
    readonly scope: string
}

export type Definition = Component<any> | Query<any>

/**
 * A space beliefs can be positioned in — the camera's pixels, the body, the
 * map. A declaration for readers only: no system reads or writes a frame, a
 * component's `display` points at one, and the schedule declares every frame
 * on its first run. Named like a component, from where it is defined.
 */
export type Frame = {
    readonly kind: "frame"
    readonly opts: FrameDescriptor
    readonly name: string
    readonly scope: string
}

/** Anything the compile step names. */
export type Named = Definition | Frame

/**
 * The definition registry: which objects are real handles, and what each is
 * called. Module state because handles are created at import time, before any
 * world exists, and named once by the generated entry — one cognet per bundle,
 * so one registry per bundle.
 */
/** What a row holds of its own, so no component may be exported under these names. */
const RESERVED = ["id", "meta", "clock", "stimuli"]
const identities = new WeakMap<object, Identity | null>()
/** Every named component, by full name — what a query's strings are looked up in. */
const components = new Map<string, Component<any>>()
const queries = new Map<string, Query<any>>()
/** Every named frame — what the schedule declares on its first run. */
const frames = new Set<Frame>()
/** What each string a system has written resolved to, so a query at the tick rate does not search twice. */
const resolved = new Map<string, Component<any>>()

function identityOf(handle: object, kind: string): Identity {
    const identity = identities.get(handle)
    if (!identity) {
        throw err("COGNET_UNNAMED_DEFINITION", {
            detail: `a ${kind} was used before the compile step named it — define it as \`export const name = ${kind}(...)\` in a file under the cognet`,
        })
    }
    return identity
}

/** Declare a component: a typed claim an entity can hold. */
export function component<T>(opts: ComponentOpts = {}): Component<T> {
    const handle: Component<T> = {
        kind: "component",
        opts: opts,
        get name() { return identityOf(handle, "component").name },
        get scope() { return identityOf(handle, "component").scope },
    }
    identities.set(handle, null)
    return handle
}

/**
 * Declare a named group of components — "a tracked thing", "homeostasis" —
 * that a system lists in `reads` as one, with a visibility of its own. A
 * declaration only: the world is read with `ecs.query({ components: [...] })`.
 */
export function query<const S extends QueryShape>(shape: S, opts: QueryOpts = {}): Query<S> {
    const handle: Query<S> = {
        kind: "query",
        shape: shape,
        opts: opts,
        get name() { return identityOf(handle, "query").name },
        get scope() { return identityOf(handle, "query").scope },
    }
    identities.set(handle, null)
    return handle
}

/** Declare a frame: a space a component's `display` can place its value in. */
export function frame(opts: FrameDescriptor): Frame {
    const handle: Frame = {
        kind: "frame",
        opts: opts,
        get name() { return identityOf(handle, "frame").name },
        get scope() { return identityOf(handle, "frame").scope },
    }
    identities.set(handle, null)
    return handle
}

/** Operations on handles that only the runtime performs. */
export const definitions = {
    /** Whether `value` is a handle made by component(), query() or frame(). */
    is(value: unknown): value is Named {
        return typeof value === "object" && value !== null && identities.has(value)
    },

    /** Whether the handle has been named. */
    named(handle: Named): boolean {
        return identities.get(handle) !== null
    },

    /**
     * Give a handle its identity. Naming the same handle twice with the same
     * identity is a no-op; with a different one it throws — one definition,
     * one name.
     */
    name(handle: Named, identity: Identity): void {
        const existing = identities.get(handle)
        if (existing === undefined) throw new Error("definitions.name: not a component, query or frame handle")
        if (existing && existing.name !== identity.name) {
            throw err("COGNET_DISCOVERY_INVALID", {
                detail: `one handle is defined as both "${existing.name}" and "${identity.name}" — define it once and import it`,
            })
        }
        if ((handle.kind === "component" || handle.kind === "query") && RESERVED.includes(identity.name.slice(identity.name.lastIndexOf("/") + 1))) {
            throw err("COGNET_DISCOVERY_INVALID", {
                detail: `"${identity.name}" — a component or query cannot be called ${RESERVED.join(" or ")}: these names belong to rows or system inputs`,
            })
        }
        identities.set(handle, identity)
        if (handle.kind === "component") {
            components.set(identity.name, handle)
            resolved.clear()
        }
        if (handle.kind === "query") queries.set(identity.name, handle)
        if (handle.kind === "frame") frames.add(handle)
    },

    /** Every named frame. */
    frames(): Frame[] {
        return [...frames]
    },

    /**
     * The component a name refers to: its full name (`L0/world/map/usual`),
     * or its export name alone (`velocity`) when only one component is
     * called that. Throws on a name nothing has, and on a short name two
     * components share — which one was meant is not guessable.
     */
    find(name: string): Component<any> {
        const known = resolved.get(name)
        if (known) return known
        const found = components.get(name) ?? short(name)
        resolved.set(name, found)
        return found
    },

    /** Resolve a declaration's component or named query; ambiguous short names fail before scheduling. */
    resolve(name: string): Definition {
        const exact = components.get(name) ?? queries.get(name)
        if (exact) return exact
        const matches: Definition[] = [...components, ...queries]
            .filter(([full]) => full.slice(full.lastIndexOf("/") + 1) === name)
            .map(([, handle]) => handle)
        if (matches.length === 1) return matches[0]!
        throw err("COGNET_UNKNOWN_COMPONENT", {
            detail: matches.length === 0
                ? `no component or query is named "${name}"`
                : `"${name}" is ${matches.map(handle => handle.name).join(" and ")} — write the full name`,
        })
    },

    /** The key a component's value sits under in a row: its export name, the last part of its full name. */
    key(handle: Component<any>): string {
        return handle.name.slice(handle.name.lastIndexOf("/") + 1)
    },

    /** The components a read of this definition touches. */
    members(handle: Definition): Component<any>[] {
        return handle.kind === "component" ? [handle] : Object.values(handle.shape)
    },
}

/** The one component whose export name is `name`. */
function short(name: string): Component<any> {
    const matches = [...components.entries()].filter(([full]) => full.slice(full.lastIndexOf("/") + 1) === name)
    if (matches.length === 1) return matches[0]![1]
    throw err("COGNET_UNKNOWN_COMPONENT", {
        detail: matches.length === 0
            ? `no component is named "${name}"`
            : `"${name}" is ${matches.map(([full]) => full).join(" and ")} — write the full name`,
    })
}
