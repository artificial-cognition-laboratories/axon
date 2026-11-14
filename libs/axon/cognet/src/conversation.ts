import { err } from "@arcforge/err"
import type { Session } from "./native"
import { streamed } from "./verbs"
import { wire } from "./wire"

/**
 * What a running Rust or Python system says, one JSON object at a time. A run
 * ends in `done`, `error` or `cancelled`; while it is going it may `call` the
 * kernel — answered with `answer` — and send `effect`s, made in the order they
 * came. The same messages over either transport: a process's stdout, or a
 * native thread's callback.
 */
export type Said =
    | { kind: "done"; job: number; ran: string; kinds: string[]; arrays: string[] }
    | { kind: "error"; job: number; error: string }
    | { kind: "cancelled"; job: number }
    | { kind: "call"; job: number; call: number; op: string; args: string; kinds: string[]; arrays: string[] }
    | { kind: "effect"; job: number; effect: string; kinds: string[]; arrays: string[] }
    | { kind: "stop"; job: number; call: number }

/**
 * What the host says back: a run to start, a call's answer, or that the run is
 * cancelled. A streamed call is answered with `event`s, then an `end` — or an
 * `answer` carrying the error that stopped it.
 */
export type Told =
    | { kind: "job"; job: number; system: string; snapshot: string; kinds: string[]; arrays: string[] }
    | { kind: "answer"; job: number; call: number; value: string; kinds: string[]; arrays: string[] }
    | { kind: "answer"; job: number; call: number; error: { code: string; message: string } }
    | { kind: "event"; job: number; call: number; value: string; kinds: string[]; arrays: string[] }
    | { kind: "end"; job: number; call: number }
    | { kind: "cancel"; job: number }

/** A run in flight: how it ends, what it may reach, its effects so far — each made after the one before — and the streams it has open. */
type Job = { system: string; resolve(value: unknown): void; reject(cause: Error): void; session: Session; effects: Promise<void>; streams: Map<number, AbortController> }

/**
 * Conversation — the host's side of every run a Rust or Python system has in
 * flight. `begin` starts one and resolves with what it returned; `heard`
 * routes each message it says; `send` is how this side speaks, whatever the
 * transport. `failing` names what to blame when the transport itself breaks.
 */
export function Conversation(opts: { send(told: Told): void; failing: "COGNET_PYTHON_FAILED" | "COGNET_SYSTEM_FAULT" }) {
    const jobs = new Map<number, Job>()
    let next = 0

    return {
        /** Start `system` on this snapshot. Resolves with `{ ran, arrays }` once everything it sent as it went is made. */
        begin(system: string, snapshot: string, kinds: string[], arrays: Uint8Array[], session: Session): Promise<unknown> {
            const job = ++next
            return new Promise((resolve, reject) => {
                jobs.set(job, { system: system, resolve: resolve, reject: reject, session: session, effects: Promise.resolve(), streams: new Map() })
                // The wake that started it was cancelled: the run is told, and says so.
                session.signal.addEventListener("abort", () => {
                    if (jobs.has(job)) opts.send({ kind: "cancel", job: job })
                }, { once: true })
                opts.send({ kind: "job", job: job, system: system, snapshot: snapshot, kinds: kinds, arrays: wire.encoded(arrays) })
            })
        },

        /** One message a run said, as text. A message that is not the protocol fails every run — the transport is broken. */
        heard(text: string): void {
            let said: Said
            try {
                said = parsed(text)
            } catch (cause) {
                throw err(opts.failing, { detail: `a running system wrote an invalid protocol message: ${text}`, cause: cause })
            }
            const job = jobs.get(said.job)
            if (!job) throw err(opts.failing, { detail: `a running system spoke of unknown job ${said.job}` })
            route(said, job)
        },

        /** The transport broke: every run in flight fails with it. */
        fail(cause: Error): void {
            for (const job of jobs.values()) {
                stopAll(job)
                job.reject(cause)
            }
            jobs.clear()
        },
    }

    function route(said: Said, job: Job): void {
        if (said.kind === "call") {
            void (streamed(said.op) ? relay(said, job) : answer(said, job))
            return
        }
        if (said.kind === "stop") {
            job.streams.get(said.call)?.abort()
            return
        }
        if (said.kind === "effect") {
            const value = wire.unpack(said.effect, wire.decoded(said.kinds, said.arrays, `${job.system}'s effect`), `${job.system}'s effect`)
            job.effects = job.effects.then(() => job.session.effect(value))
            // Observed here so a failure waits for `done` to deliver it, rather than surfacing as unhandled meanwhile.
            job.effects.catch(() => {})
            return
        }
        jobs.delete(said.job)
        // A stream outlives nothing: the run that opened it is over.
        stopAll(job)
        if (said.kind === "error") return job.reject(err(opts.failing, { detail: `${job.system} failed:\n${said.error}` }))
        if (said.kind === "cancelled") return job.reject(new DOMException(`${job.system} was cancelled with the wake that started it`, "AbortError"))
        let arrays: ArrayBufferView[]
        try {
            arrays = wire.decoded(said.kinds, said.arrays, job.system)
        } catch (cause) {
            return job.reject(err(opts.failing, { detail: `${job.system} returned invalid arrays`, cause: cause }))
        }
        // Everything it sent as it went is made before the run is done.
        job.effects.then(() => job.resolve({ ran: said.ran, arrays: arrays }), job.reject)
    }

    /** A call answered through the session, its value — or its refusal, by code — sent back to the run that asked. */
    async function answer(said: Extract<Said, { kind: "call" }>, job: Job): Promise<void> {
        try {
            const args = wire.unpack(said.args, wire.decoded(said.kinds, said.arrays, `${job.system}'s ${said.op}`), `${job.system}'s ${said.op}`)
            const value = await job.session.call(said.op, args)
            const packed = wire.pack(value === undefined ? null : value, `the answer to ${said.op}`)
            opts.send({ kind: "answer", job: said.job, call: said.call, value: packed.json, kinds: packed.kinds, arrays: wire.encoded(packed.arrays) })
        } catch (cause) {
            opts.send({ kind: "answer", job: said.job, call: said.call, error: refusal(cause) })
        }
    }

    /** A streamed call: each answer sent as an event, then the end — or the error that stopped it. */
    async function relay(said: Extract<Said, { kind: "call" }>, job: Job): Promise<void> {
        const stopping = new AbortController()
        job.streams.set(said.call, stopping)
        try {
            const args = wire.unpack(said.args, wire.decoded(said.kinds, said.arrays, `${job.system}'s ${said.op}`), `${job.system}'s ${said.op}`)
            for await (const value of job.session.stream(said.op, args, AbortSignal.any([stopping.signal, job.session.signal]))) {
                if (stopping.signal.aborted) break
                const packed = wire.pack(value === undefined ? null : value, `an event of ${said.op}`)
                opts.send({ kind: "event", job: said.job, call: said.call, value: packed.json, kinds: packed.kinds, arrays: wire.encoded(packed.arrays) })
            }
            // Stopped by the run, or by its end: it is no longer listening, and is told nothing.
            if (!stopping.signal.aborted) opts.send({ kind: "end", job: said.job, call: said.call })
        } catch (cause) {
            if (!stopping.signal.aborted) opts.send({ kind: "answer", job: said.job, call: said.call, error: refusal(cause) })
        } finally {
            job.streams.delete(said.call)
        }
    }

    function stopAll(job: Job): void {
        for (const stopping of job.streams.values()) stopping.abort()
        job.streams.clear()
    }
}

/** A failure as it crosses back: its code, when it has one, and what it says. */
function refusal(cause: unknown): { code: string; message: string } {
    const code = typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : "AX-UNKNOWN-001"
    return { code: code, message: cause instanceof Error ? cause.message : String(cause) }
}

export type ConversationT = ReturnType<typeof Conversation>

/** One message, checked: every message names its job, and carries what its kind carries. */
function parsed(text: string): Said {
    const value: unknown = JSON.parse(text)
    if (typeof value !== "object" || value === null || !("kind" in value) || !("job" in value) || !Number.isSafeInteger(value.job)) throw new Error("a message names its kind and its job")
    const texts = (field: unknown) => Array.isArray(field) && field.every(one => typeof one === "string")
    const string = (field: unknown) => typeof field === "string"
    const integer = (field: unknown) => Number.isSafeInteger(field)
    const carries = (keys: Record<string, (field: unknown) => boolean>) => Object.entries(keys).every(([key, ok]) => key in value && ok(Reflect.get(value, key)))
    const SHAPES: Record<string, Record<string, (field: unknown) => boolean>> = {
        done: { ran: string, kinds: texts, arrays: texts },
        error: { error: string },
        cancelled: {},
        call: { call: integer, op: string, args: string, kinds: texts, arrays: texts },
        effect: { effect: string, kinds: texts, arrays: texts },
        stop: { call: integer },
    }
    const shape = SHAPES[String(value.kind)]
    if (!shape || !carries(shape)) throw new Error(`a ${String(value.kind)} message is missing what it carries`)
    return value as Said
}
