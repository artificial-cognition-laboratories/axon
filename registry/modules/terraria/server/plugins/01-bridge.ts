/**
 * AxonT transport attachment.
 *
 * The WebSocket is the body cable, not cognition:
 *   /body    → measured internal / proprioceptive vectors — minus position
 *   /session → where the client is: detached, menu, joining, in-world
 *
 * Each packet family maps directly to an Axon stimulus kind; this layer never
 * turns measurements into semantic events or combines the senses.
 *
 * The body itself is RENTED from the lab — the Axon daemon keeps a Terraria
 * world running with warm clients in it, and this agent leases one as its own
 * character. The lab joins the world; this cable only carries senses and
 * muscles. A brain reload keeps the lease and the socket (the store outlives
 * the plugin), and a process exit releases the body back to the pool.
 */
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { randomUUID } from "node:crypto"
import type { AxonHandle } from "@arcforge/types"
import { publishBridge, type BridgeHandle, type CommandResult, type Session, type SessionState } from "../../src/bridge"
import { Lab, type Embodiment, type LabT } from "../../src/lab"


type BodyPacket = {
    type: "body"
    sequence: number
    observedAt: number
    profile: "terraria.body.v0"
    values: number[]
    labels: string[]
    units: string[]
}
type SessionPacket = { type: "session"; observedAt: number; state: string; endpoint: string | null }
type CommandResultPacket = {
    type: "command-result"
    id: string
    command: string
    ok: boolean
    error?: string
    state: string
    endpoint: string | null
}

type Pending = {
    resolve: (result: CommandResult) => void
    reject: (cause: Error) => void
    timer: ReturnType<typeof setTimeout>
}

type BridgeStore = {
    target: AxonHandle | null
    socket: WebSocket | null
    retry: ReturnType<typeof setTimeout> | null
    stopped: boolean
    inputSequence: number
    unlisten: (() => void) | null
    session: Session
    pending: Map<string, Pending>
    watchers: Set<(session: Session) => void>
    listeners: Set<(session: Session) => void>
    lab: LabT
    /** The body this agent occupies. Null until the lab grants one, and after it is lost. */
    embodiment: Embodiment | null
    /** A lease request is in flight — one at a time. */
    embodying: boolean
    /** Backoff between failed lease attempts; reset once embodied. */
    backoffMs: number
}

const STORE = Symbol.for("axon.terraria.bridge.store")
const globalStore = globalThis as typeof globalThis & { [STORE]?: BridgeStore }
const RETRY_MS = 1_000
const MAX_BACKOFF_MS = 30_000
const INPUT_CHANNEL = "/input"
const BODY_CHANNEL = "/body"
/**
 * What the organism senses of the body, as the profile it is sent under.
 *
 * THE ONE DOOR between body and mind, and what it drops is the whole design.
 *
 * The mod measures absolute world position and true velocity. No organism has
 * either: position would be a GPS, and velocity would be a speedometer wired
 * to the world's own physics. Both are dropped here so a mind cannot come to
 * depend on them by accident, and the lab keeps them as the ANSWER KEY for
 * scoring what dead reckoning made of the honest signal.
 *
 * What crosses is the inertial reading — noisy, biased, saturating, gravity
 * included — and foot contact. Velocity comes back only by integrating it,
 * which drifts, which is why vision exists.
 *
 * `facing` is gone entirely and has no replacement here: you do not know which
 * way you are facing from an inner ear, you know because you commanded it.
 * That is efference, and the motor system already writes it.
 */
const SENSED_PROFILE = "terraria.body.v2"
const NOT_SENSED = new Set([
    "position.x", "position.y",
    "velocity.horizontal", "velocity.vertical",
])
const SESSION_CHANNEL = "/session"
const LEASE_MS = 150
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000

const DETACHED: Session = { state: "detached", endpoint: null }

function scheduleConnect(store: BridgeStore, delayMs = RETRY_MS): void {
    if (store.stopped || store.retry || store.socket) return
    store.retry = setTimeout(() => {
        store.retry = null
        void connect(store)
    }, delayMs)
}

/**
 * Who this agent is to the lab, and which character it plays.
 *
 * The agent runs with its own root as its working directory — the runtime's
 * contract — so identity and the character's home are read from there rather
 * than configured twice. TERRARIA_CHARACTER names a character explicitly; by
 * default it is the agent's own name, capitalised.
 */
function identity(): { agent: string; character: string; characterDir: string } {
    const root = process.cwd()
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { name?: string }
    const agent = pkg.name ?? basename(root)
    const short = agent.split("/").pop()!
    const character = process.env.TERRARIA_CHARACTER?.trim() || short.charAt(0).toUpperCase() + short.slice(1)
    return { agent: agent, character: character, characterDir: join(root, ".agent", "data", "terraria") }
}

/** Ask the lab for a body. Loud on failure — the reason is the lab's, verbatim — and retried with backoff. */
async function embody(store: BridgeStore): Promise<boolean> {
    if (store.embodying) return false
    store.embodying = true
    try {
        const who = identity()
        console.log(`[terraria:bridge] asking the lab for a body as ${who.character}`)
        store.embodiment = await store.lab.embody(who)
        store.backoffMs = RETRY_MS
        console.log(`[terraria:bridge] embodied in ${store.embodiment.body} (${store.embodiment.world}) as ${store.embodiment.character}`)
        return true
    } catch (cause) {
        const wait = store.backoffMs
        store.backoffMs = Math.min(store.backoffMs * 2, MAX_BACKOFF_MS)
        console.error(`[terraria:bridge] no body: ${cause instanceof Error ? cause.message : String(cause)} — retrying in ${wait / 1000}s`)
        scheduleConnect(store, wait)
        return false
    } finally {
        store.embodying = false
    }
}

function isSessionState(value: string): value is SessionState {
    return value === "detached" || value === "menu" || value === "joining" || value === "in-world"
}

/**
 * Session is a sense, not bookkeeping: "I am at the menu" is something Terry
 * must be able to perceive, rather than infer from an absence of body samples.
 */
function setSession(store: BridgeStore, next: Session): void {
    if (store.session.state === next.state && store.session.endpoint === next.endpoint) return
    store.session = next
    console.log(`[terraria:bridge] session: ${next.state}${next.endpoint ? ` (${next.endpoint})` : ""}`)

    // Waiters first. Reporting the state is the cable's job; turning it into a
    // stimulus is telemetry, and telemetry must never be able to strand a join.
    for (const observer of [...store.watchers, ...store.listeners]) {
        try {
            observer(next)
        } catch (cause) {
            console.error("[terraria:bridge] a session observer failed:", cause)
        }
    }

    try {
        const committed = store.target?.stim("cognet:stimulus:vector", {
            channel: SESSION_CHANNEL,
            values: [next.state === "in-world" ? 1 : 0, next.state === "joining" ? 1 : 0],
            labels: ["embodied", "joining"],
            units: ["bool", "bool"],
            profile: "terraria.session.v0",
        })
        void Promise.resolve(committed).catch(cause =>
            console.error("[terraria:bridge] could not commit session change:", cause))
    } catch (cause) {
        console.error("[terraria:bridge] could not commit session change:", cause)
    }
}

function decodeMotorVector(data: { channel: string; values: number[]; profile?: string }) {
    if (data.channel !== INPUT_CHANNEL || data.profile !== "terraria.input.v0") return null
    const [left, right, up, down, jump, useItem, useTile] = data.values
    if (data.values.length !== 7 || !data.values.every(value => value === 0 || value === 1)) {
        console.warn("[terraria:bridge] rejected malformed motor vector")
        return null
    }
    return {
        sequence: 0,
        leaseMs: LEASE_MS,
        keys: {
            left: left === 1, right: right === 1, up: up === 1, down: down === 1,
            jump: jump === 1, useItem: useItem === 1, useTile: useTile === 1,
        },
    }
}

function sendMotor(store: BridgeStore, data: { channel: string; values: number[]; profile?: string }): void {
    // Controls are meaningless outside a world: at the menu there is no player
    // to press keys for. Dropping them here keeps the lease honest.
    if (store.session.state !== "in-world") return

    const state = decodeMotorVector(data)
    const socket = store.socket
    if (!state || !socket || socket.readyState !== WebSocket.OPEN) return
    state.sequence = ++store.inputSequence
    socket.send(JSON.stringify({ type: "input-state", ...state }))
}

function bindOutput(store: BridgeStore, axon: AxonHandle): void {
    store.unlisten?.()
    store.unlisten = axon.on("cognet:output:vector", data => sendMotor(store, data))
}

function record(packet: unknown): Record<string, unknown> | null {
    return packet && typeof packet === "object" ? packet as Record<string, unknown> : null
}

function isBody(packet: unknown): packet is BodyPacket {
    const value = record(packet)
    return value?.type === "body" &&
        value.profile === "terraria.body.v0" &&
        typeof value.observedAt === "number" &&
        Array.isArray(value.values) &&
        Array.isArray(value.labels) &&
        Array.isArray(value.units)
}


function settle(store: BridgeStore, packet: CommandResultPacket): void {
    const pending = store.pending.get(packet.id)
    if (!pending) return
    store.pending.delete(packet.id)
    clearTimeout(pending.timer)
    pending.resolve({
        ok: packet.ok,
        error: packet.error,
        state: isSessionState(packet.state) ? packet.state : "menu",
        endpoint: packet.endpoint,
    })
}

function routePacket(store: BridgeStore, packet: unknown): void {
    const value = record(packet)
    if (!value) return

    if (value.type === "bridge-ready") {
        console.log(`[terraria:bridge] AxonT ${value.instanceId} is reachable`)
        return
    }

    if (value.type === "session" && typeof value.state === "string") {
        const session = value as SessionPacket
        setSession(store, {
            state: isSessionState(session.state) ? session.state : "menu",
            endpoint: session.endpoint,
        })
        return
    }

    if (value.type === "command-result" && typeof value.id === "string") {
        settle(store, value as CommandResultPacket)
        return
    }

    const target = store.target
    if (!target) return

    if (isBody(packet)) {
        if (packet.values.length !== packet.labels.length || packet.values.length !== packet.units.length) {
            console.warn("[terraria:bridge] rejected incoherent body sample")
            return
        }
        const kept = packet.labels.flatMap((label, index) => (NOT_SENSED.has(label) ? [] : [index]))
        void target.stim("cognet:stimulus:vector", {
            channel: BODY_CHANNEL,
            values: kept.map(index => packet.values[index]!),
            labels: kept.map(index => packet.labels[index]!),
            units: kept.map(index => packet.units[index]!),
            profile: SENSED_PROFILE,
        }).catch(cause => console.error("[terraria:bridge] could not commit body sample:", cause))
        return
    }


    console.warn("[terraria:bridge] unexpected AxonT packet", packet)
}

/** A dropped cable fails every command in flight; silence would strand callers. */
function abandon(store: BridgeStore, reason: string): void {
    for (const [id, pending] of store.pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error(reason))
        store.pending.delete(id)
    }
    setSession(store, DETACHED)
}

async function connect(store: BridgeStore): Promise<void> {
    if (store.stopped || store.socket) return
    if (!store.embodiment && !(await embody(store))) return
    const embodiment = store.embodiment!

    const socket = new WebSocket(embodiment.bridge)
    store.socket = socket
    socket.addEventListener("open", () => {
        console.log(`[terraria:bridge] attached to ${embodiment.body}`)
    }, { once: true })
    socket.addEventListener("message", event => {
        let packet: unknown
        try {
            packet = JSON.parse(String(event.data))
        } catch {
            console.warn("[terraria:bridge] AxonT sent non-JSON data")
            return
        }
        try {
            routePacket(store, packet)
        } catch (cause) {
            console.error("[terraria:bridge] failed to route an AxonT packet:", cause)
        }
    })
    socket.addEventListener("close", event => {
        if (store.socket === socket) store.socket = null
        abandon(store, "The Terraria bridge disconnected before the command completed.")
        if (!store.stopped) {
            // The cable to a body only closes when the body is gone — the lab
            // replaces failed bodies, and this lease went with it. Hand it back
            // and ask for another rather than redialling a dead port.
            console.error(`[terraria:bridge] lost ${embodiment.body} (${event.code}); asking the lab for another body`)
            const lost = store.embodiment
            store.embodiment = null
            if (lost) void store.lab.release(lost.lease).catch(cause =>
                console.error(`[terraria:bridge] the lab no longer holds ${lost.lease}: ${cause instanceof Error ? cause.message : String(cause)}`))
            scheduleConnect(store)
        }
    }, { once: true })
}

function handle(store: BridgeStore): BridgeHandle {
    return {
        session: () => ({ ...store.session }),

        command(command, params = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
            const socket = store.socket
            if (!socket || socket.readyState !== WebSocket.OPEN)
                return Promise.reject(new Error("The Terraria client is not attached; it may still be starting."))

            const id = randomUUID()
            return new Promise<CommandResult>((resolve, reject) => {
                const timer = setTimeout(() => {
                    store.pending.delete(id)
                    reject(new Error(`Terraria did not answer '${command}' within ${timeoutMs}ms.`))
                }, timeoutMs)
                store.pending.set(id, { resolve, reject, timer })
                socket.send(JSON.stringify({ type: "command", id, command, ...params }))
            })
        },

        onSession(listener) {
            store.listeners.add(listener)
            return () => store.listeners.delete(listener)
        },

        embodiment: () => store.embodiment,

        awaitState(state, timeoutMs) {
            if (store.session.state === state) return Promise.resolve({ ...store.session })
            return new Promise((resolve, reject) => {
                const watcher = (session: Session) => {
                    if (session.state !== state) return
                    clearTimeout(timer)
                    store.watchers.delete(watcher)
                    resolve({ ...session })
                }
                const timer = setTimeout(() => {
                    store.watchers.delete(watcher)
                    reject(new Error(`Terraria stayed '${store.session.state}' instead of reaching '${state}' within ${timeoutMs}ms.`))
                }, timeoutMs)
                store.watchers.add(watcher)
            })
        },
    }
}

export default defineAxonPlugin(axon => {
    const running = globalStore[STORE]
    if (running) {
        running.target = axon
        running.stopped = false
        bindOutput(running, axon)
        publishBridge(handle(running))
        scheduleConnect(running)
        return
    }

    const store: BridgeStore = {
        target: axon,
        socket: null,
        retry: null,
        stopped: false,
        inputSequence: 0,
        unlisten: null,
        session: DETACHED,
        pending: new Map(),
        watchers: new Set(),
        listeners: new Set(),
        lab: Lab(),
        embodiment: null,
        embodying: false,
        backoffMs: RETRY_MS,
    }
    globalStore[STORE] = store
    bindOutput(store, axon)
    publishBridge(handle(store))
    void connect(store)

    axon.hooks.hook("shutdown:before", () => {
        if (store.target === axon) store.target = null
        store.unlisten?.()
        store.unlisten = null
        store.stopped = true
        if (store.retry) clearTimeout(store.retry)
        store.retry = null
        abandon(store, "The Terry runtime is stopping.")
        store.socket?.close(1000, "Terry runtime stopping")
        store.socket = null
        // Given back on a clean stop; a crash is caught by the lab noticing
        // this process is gone.
        const held = store.embodiment
        store.embodiment = null
        if (held) return store.lab.release(held.lease).catch(cause =>
            console.error(`[terraria:bridge] could not return ${held.body} to the lab: ${cause instanceof Error ? cause.message : String(cause)}`))
    })
})
