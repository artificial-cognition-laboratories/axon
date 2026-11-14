import { component, definitions, Ecs, frame, query, type Component, type ComponentOpts, type Frame, type FrameDescriptor, type Query, type QueryOpts, type QueryShape } from "../../../src/ecs"

/**
 * Test support: a world that records what it emits, and handles named the way
 * the compile step would name them.
 */

export function world<C extends object = Record<string, unknown>>(opts: { now?: () => number } = {}) {
    const emitted: Array<{ type: string; data: any }> = []
    const emit = ((type: string, data: unknown) => { emitted.push({ type: type, data: data }) }) as never
    const ecs = Ecs<C>({ emit: emit, stamp: () => ({ tick: 0, phase: null, system: null }), now: opts.now })
    return {
        ecs: ecs,
        emit: emit,
        emitted: emitted,
        /** Emitted events of one type, payloads only. */
        of(type: string): any[] {
            return emitted.filter(event => event.type === type).map(event => event.data)
        },
    }
}

/** A component named as if defined at `<scope>/<name>`. `path` is `scope/name` or a bare name at the root. */
export function named<T>(path: string, opts: ComponentOpts = {}): Component<T> {
    const handle = component<T>(opts)
    definitions.name(handle, identity(path))
    return handle
}

export function namedQuery<const S extends QueryShape>(path: string, shape: S, opts: QueryOpts = {}): Query<S> {
    const handle = query(shape, opts)
    definitions.name(handle, identity(path))
    return handle
}

/** A frame named as if defined at `<scope>/<name>`. */
export function namedFrame(path: string, opts: FrameDescriptor): Frame {
    const handle = frame(opts)
    definitions.name(handle, identity(path))
    return handle
}

function identity(path: string) {
    const index = path.lastIndexOf("/")
    return { name: path, scope: index === -1 ? "" : path.slice(0, index) }
}
