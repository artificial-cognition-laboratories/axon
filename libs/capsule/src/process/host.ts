import type { AxonCapsuleHandle, AxonRequestInput, AxonResult } from "@arcforge/types"
import type { ExecutionT } from "./execution"
import type { SandboxWireT } from "./wire"

type HostOpts = {
    wire: SandboxWireT
    execution: ExecutionT
}

/** Capsule-side correlated client for trusted host services. */
export function Host(opts: HostOpts) {
    const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }>()

    function call<T>(method: string, input: unknown): Promise<T> {
        const execution = opts.execution.current
        if (!execution) return Promise.reject(new Error("CAPSULE_HOST_UNAVAILABLE: host calls require an active capsule command"))
        if (execution.signal.aborted) return Promise.reject(abortError())

        const id = crypto.randomUUID()
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => settle(id, () => reject(abortError()))
            execution.signal.addEventListener("abort", onAbort, { once: true })
            pending.set(id, {
                resolve,
                reject,
                cleanup: () => execution.signal.removeEventListener("abort", onAbort),
            })
            opts.wire.emit("capsule:host:request", { id, commandId: execution.id, method, input })
        })
    }

    function settle(id: string, fn: (entry: NonNullable<ReturnType<typeof pending.get>>) => void): void {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        entry.cleanup()
        fn(entry)
    }

    opts.wire.onCommand(command => {
        if (command.type !== "host:response") return
        if ("error" in command) settle(command.id, entry => entry.reject(new Error(command.error)))
        else settle(command.id, entry => entry.resolve(command.result))
    })

    function rejectAll(error: Error): void {
        for (const id of [...pending.keys()]) settle(id, entry => entry.reject(error))
    }

    const ambient: AxonCapsuleHandle = {
        activity: (() => { throw new Error("CAPSULE_HOST_UNAVAILABLE: activity() called with no attached host activity") }) as AxonCapsuleHandle["activity"],
        request(input: AxonRequestInput | string): Promise<AxonResult> {
            const normalized = typeof input === "string" ? { prompt: input } : input
            return call<AxonResult>("request", normalized)
        },
    }

    return { call, ambient, rejectAll }
}

function abortError(): Error {
    const error = new Error("host call aborted")
    error.name = "AbortError"
    return error
}

export type HostT = ReturnType<typeof Host>
