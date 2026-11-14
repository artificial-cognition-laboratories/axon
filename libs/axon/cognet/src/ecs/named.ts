import { definitions } from "./handle"
import type { Surface } from "./isolation"
import type { Entry, Meta } from "./state"
import type { EntityId } from "./types"

/** A component's export name — the last part of its full name, and its key in a row. */
export type Short<N extends string> = N extends `${string}/${infer Rest}` ? Short<Rest> : N

/**
 * One entity as a query returns it: its id, each named component's value
 * under its export name, and under `meta` when each was written and which
 * change it is. An optional component the entity does not hold is
 * undefined, and so is its meta. Never written to — a change is an `ecs.set`.
 */
export type Row<C, N extends keyof C & string, O extends keyof C & string = never> =
    & { readonly id: EntityId; readonly meta: { readonly [K in N as Short<K>]: Meta } & { readonly [K in O as Short<K>]: Meta | undefined } }
    & { readonly [K in N as Short<K>]: C[K] }
    & { readonly [K in O as Short<K>]: C[K] | undefined }

/**
 * What to write on one entity, by component name: a value is written,
 * `null` takes the component off, and a component left out or `undefined`
 * is not touched — so what source had nothing to say about needs no `if`.
 */
export type Writing<C> = { id: EntityId; components: { readonly [K in keyof C & string]?: C[K] | null } }

/** What a value must equal: the whole of it, or for a record, the fields given. */
export type Match<T> = T extends readonly unknown[] | ArrayBufferView ? T : T extends object ? { readonly [K in keyof T]?: Match<T[K]> } : T

/** Values a row's components must equal, by export name. An optional component the entity does not hold equals nothing. */
export type Where<C, N extends keyof C & string> = { readonly [K in N as Short<K>]?: Match<C[K]> }

/** One query, said whole: which components an entity must hold, which it may, what they must equal, and anything else a row must pass. */
export type Select<C, N extends keyof C & string, O extends keyof C & string = never> = {
    /** Every one of these must be held: they decide which entities are rows. */
    components: readonly N[]
    /** Read from the same entity when it holds them — undefined in the row when it does not. */
    optional?: readonly O[]
    /** Equality only, as data — what a debugger can show and a store could index. */
    where?: Where<C, N | O>
    /** Anything `where` cannot say. */
    filter?: (row: Row<C, N, O>) => boolean
}

export type NamedOpts = {
    /** The world as the caller sees it now: live, or the snapshot and buffer of an isolated run. */
    surface(): Surface
}

/**
 * Named — the world by component NAME, which is how a system reads and
 * writes it.
 *
 * `C` maps every component's name to its type; the compile step generates it
 * from the cognet's definitions, so a misspelt name or a wrong value is a
 * type error. A name is resolved to its handle here and nowhere else, and
 * everything below this takes handles.
 */
export function Named<C extends object = Record<string, unknown>>(opts: NamedOpts) {
    return {
        /** Every entity holding all of `components` and passing `where` and `filter`, in entity order. */
        query<const N extends keyof C & string, const O extends keyof C & string = never>(select: Select<C, N, O>): Row<C, N, O>[] {
            const surface = opts.surface()
            const required = select.components.map(name => definitions.find(name))
            const optional = (select.optional ?? []).map(name => definitions.find(name))
            const rows = surface.rows(
                required,
                optional,
            )
            // The generated map is what says a name has this type; the store holds values untyped.
            const typed = rows as unknown as Row<C, N, O>[]
            const where = select.where
            const filter = select.filter
            const matched = typed.filter((row, index) => (!where || matches(rows[index]!, where)) && (!filter || filter(row)))
            surface.query({ required: required.map(handle => handle.name), optional: optional.map(handle => handle.name), where: where, filtered: filter !== undefined, candidates: rows.length, rows: matched })
            return matched
        },

        /** Write one entity's components, or several entities', in the order given. */
        set(write: Writing<C> | readonly Writing<C>[]): void {
            const surface = opts.surface()
            for (const one of Array.isArray(write) ? write as readonly Writing<C>[] : [write as Writing<C>]) {
                for (const [name, value] of Object.entries(one.components)) {
                    if (value === undefined) continue
                    if (value === null) surface.component.remove(one.id, definitions.find(name))
                    else surface.component.set(one.id, definitions.find(name), value)
                }
            }
        },
    }
}

export type NamedT<C extends object = Record<string, unknown>> = ReturnType<typeof Named<C>>

/** Whether `value` equals `pattern`: a record on the fields the pattern gives, a list element for element, anything else exactly. */
function matches(value: unknown, pattern: unknown): boolean {
    if (Object.is(value, pattern)) return true
    if (typeof pattern !== "object" || pattern === null || typeof value !== "object" || value === null) return false
    if (Array.isArray(pattern) || ArrayBuffer.isView(pattern)) {
        const wanted = pattern as unknown as ArrayLike<unknown>
        const held = value as ArrayLike<unknown>
        if (held.length !== wanted.length) return false
        for (let index = 0; index < wanted.length; index++) if (!matches(held[index], wanted[index])) return false
        return true
    }
    return Object.entries(pattern).every(([key, wanted]) => matches((value as Entry)[key], wanted))
}
