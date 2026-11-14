import { err } from "@arcforge/err"
import type { ServiceProvider } from "@arcforge/types"

/** One handle, as the kernel holds it: the use that made it, the provider that keeps it, and that provider's own id. */
type Held = { use: string; provider: ServiceProvider; id: string }

/**
 * Handles — every handle a provider keeps for the cognet, behind an id of the
 * kernel's own.
 *
 * A provider names what it keeps however it likes; the cognet is given a
 * kernel id for it instead. That id is valid only for the use that made it
 * and only while that use's provider is the one that made it — so a handle
 * passed to another use, or used after its provider changed, ends loudly
 * rather than quietly reaching something else.
 */
export function Handles() {
    const held = new Map<string, Held>()

    return {
        /** `value` as the cognet is given it: every handle in it renamed to a kernel id. */
        given(use: string, provider: ServiceProvider, value: unknown): unknown {
            return walk(value, handle => {
                const id = `${use}:${Bun.randomUUIDv7()}`
                held.set(id, { use: use, provider: provider, id: handle.id })
                return { handle: handle.handle, id: id }
            })
        },

        /** `value` as the provider is handed it: every handle in it back to the provider's own id. */
        taken(use: string, provider: ServiceProvider, value: unknown): unknown {
            return walk(value, handle => ({ handle: handle.handle, id: holding(handle.id, use, provider).id }))
        },

        /** Lets one go: told to the provider that keeps it, and forgotten. */
        async release(id: string, current: (use: string) => ServiceProvider | null): Promise<void> {
            const handle = held.get(id)
            if (!handle) throw ended(id, "it was released, or never made")
            held.delete(id)
            // Its provider has changed: what it kept went with it, and there is nothing left to tell.
            if (current(handle.use) !== handle.provider) return
            await handle.provider.release(handle.id)
        },
    }

    function holding(id: string, use: string, provider: ServiceProvider): Held {
        const handle = held.get(id)
        if (!handle) throw ended(id, "it was released, or never made")
        if (handle.use !== use) throw ended(id, `it was made by ${handle.use}, not ${use}`)
        if (handle.provider !== provider) throw ended(id, `the provider behind ${use} has changed since it was made`)
        return handle
    }
}

export type HandlesT = ReturnType<typeof Handles>

/** Every `{ handle, id }` in a value, replaced; typed arrays and other memory pass through untouched. */
function walk(value: unknown, replace: (handle: { handle: string; id: string }) => unknown): unknown {
    if (value === null || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value
    if (Array.isArray(value)) return value.map(item => walk(item, replace))
    const entries = Object.entries(value)
    if (entries.length === 2 && typeof (value as { handle?: unknown }).handle === "string" && typeof (value as { id?: unknown }).id === "string") {
        return replace(value as { handle: string; id: string })
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, walk(item, replace)]))
}

function ended(id: string, why: string) {
    return err("SERVICE_HANDLE_ENDED", { detail: `handle ${id} has ended: ${why}`, context: { handle: id } })
}
