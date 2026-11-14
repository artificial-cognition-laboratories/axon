import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { manifest as manifests, wire, type Channels } from "@arcforge/body"
import type { body } from "@arcforge/types"
import { Screen, type ScreenT } from "./screen"

export type EndpointOpts = {
    /** The body's own bridge — `ws://127.0.0.1:<port>/bridge` — speaking the body contract. */
    bridge: string
    /** Where the endpoint keeps the pictures and sounds its readings refer to. */
    dir: string
    /** The body's screen in shared memory, read for its `vision` sense. */
    screen: string
    /** Where the lab's capture writes the body's sound, in 100 ms chunks. */
    audio: string
    /** What the lab declares beside the body's own senses: the sound it captures. */
    hearing: { channel: string; sampleRate: number; channels: number }
    vision: { channel: string }
}

/** How a kept frame is encoded. 80 is about what frames were before the lab read the screen itself (70 KB each). */
const QUALITY = 80
/** How many of each sense's pictures or sounds are kept for readers to fetch: a few seconds of the busiest. */
const KEPT = 96
/** How often the sound folder is looked at; chunks are 100 ms. */
const LISTEN_MS = 50
/** What a depth grid's bytes are: metres along the eye's forward axis, as 32-bit little-endian floats, row-major. */
const DEPTH_MIME = "application/vnd.axon.depth+f32le"
const WAV_HEADER_BYTES = 44
/** The body's messages that are the lab's own, for its Control to read: bridge-ready, session, command-result, camera. */
const LAB = new Set(["bridge-ready", "session", "command-result", "camera"])

/**
 * Endpoint — one leased body, as a mind meets it: a single socket speaking
 * the body contract (axon.body/1).
 *
 * The body's own bridge says what the body is and senses (its manifest,
 * readings, truth); the lab adds what only the lab has — what the body's
 * screen shows and what its sound device plays — as readings that refer to
 * files kept here. What the mind says back is checked against the manifest
 * and passed to the body's controls.
 *
 * One mind at a time, admitted by the lease's token. Every message is checked
 * where it crosses: a body that breaks the contract, or a mind that sends a
 * command the body never declared, is refused by name and its socket closed —
 * nothing is passed on half-understood.
 */
export function Endpoint(opts: EndpointOpts) {
    const token = randomBytes(24).toString("base64url")
    let server: ReturnType<typeof Bun.serve> | null = null
    let upstream: WebSocket | null = null
    let mind: { send(text: string): unknown; close(code?: number, reason?: string): void } | null = null
    /** The manifest as the mind is told it: the body's own, and the lab's senses beside its. */
    let described: body.Manifest | null = null
    let channels: Channels | null = null
    /** Whether the body senses: in a world, whether or not the mind may move it (presence other than detached). */
    let sensing = false
    /** What the body last said of its presence, for a mind that connects after it did. */
    let presence: body.Presence | null = null
    /** The newest stamp the body sent: what a picture or a sound taken now is stamped with. */
    let sensed = 0
    let screen: ScreenT | null = null
    let looking: ReturnType<typeof setInterval> | null = null
    let listening: ReturnType<typeof setInterval> | null = null
    const counts = new Map<string, number>()
    let closed = false

    function tell(message: body.FromBody): void {
        mind?.send(wire.encode(message))
    }

    function refuse(reason: string): void {
        console.error(`[body:endpoint] ${reason}`)
        mind?.close(1008, reason.slice(0, 120))
        mind = null
    }

    /** The body's manifest, with what the lab senses for it, checked as one. */
    function merge(own: unknown): body.Manifest {
        const checked = manifests.check(own)
        const hearing: body.AudioSense = { channel: opts.hearing.channel, kind: "audio", sampleRate: opts.hearing.sampleRate, channels: opts.hearing.channels }
        return manifests.check({ ...checked, senses: [...checked.senses.filter(sense => sense.channel !== opts.hearing.channel), hearing] })
    }

    /** Keeps `bytes` as the next of `channel`'s files, dropping the oldest past KEPT; answers the reading's ref. */
    async function keep(channel: string, extension: string, bytes: Uint8Array | null, from: string | null, mime: string): Promise<{ seq: number; ref: body.Ref }> {
        const seq = (counts.get(channel) ?? 0) + 1
        counts.set(channel, seq)
        const folder = join(opts.dir, channel.replace(/^\//, "").replace(/\//g, "_"))
        await mkdir(folder, { recursive: true })
        const file = join(folder, `${String(seq).padStart(10, "0")}.${extension}`)
        if (from) await rename(from, file)
        else if (bytes) await writeFile(file, bytes)
        if (seq > KEPT) await rm(join(folder, `${String(seq - KEPT).padStart(10, "0")}.${extension}`), { force: true })
        return { seq: seq, ref: { uri: pathToFileURL(file).href, mime: mime, ...(bytes ? { bytes: bytes.byteLength } : {}) } }
    }

    /**
     * One message from the body, checked, and passed on — or turned into a
     * reading the mind can fetch. The lab's own vocabulary is its Control's to
     * read; anything else is the contract's, and is checked as it — a body
     * that says something before its manifest, or something the contract has
     * no word for, is refused.
     */
    async function heard(text: string): Promise<void> {
        const type = (JSON.parse(text) as { type?: unknown }).type
        if (typeof type === "string" && LAB.has(type)) return
        if (type === "depth") return await depth(text)
        const checked = wire.fromBody(text, channels)
        switch (checked.type) {
            case "manifest":
                described = merge(checked.manifest)
                channels = wire.channels(described)
                return tell({ type: "manifest", manifest: described })
            case "presence":
                presence = checked
                sensing = checked.state !== "detached"
                return tell(checked)
            case "reading":
            case "truth":
                sensed = Math.max(sensed, checked.sensed)
                return tell(checked)
            case "applied":
            case "skill":
            case "waiting":
                return tell(checked)
        }
    }

    /** A depth grid from the body's bridge — the lab's vocabulary, as Minecraft sends it — kept, and told as a reading on `/depth`. */
    async function depth(text: string): Promise<void> {
        if (!channels) throw new Error("a depth grid arrived before the body described itself")
        const grid = JSON.parse(text) as Record<string, unknown>
        const [seq, at, cols, rows] = [grid.seq, grid.sensed, grid.cols, grid.rows].map(value => typeof value === "number" && Number.isFinite(value) ? value : NaN)
        if ([seq, at, cols, rows].some(Number.isNaN) || typeof grid.data !== "string") throw new Error("a depth grid without its seq, stamp, shape or data")
        const bytes = Buffer.from(grid.data, "base64")
        if (bytes.byteLength !== cols! * rows! * 4) throw new Error(`a depth grid of ${cols}×${rows} carried ${bytes.byteLength} bytes`)
        sensed = Math.max(sensed, at!)
        const kept = await keep("/depth", "f32", bytes, null, DEPTH_MIME)
        tell(wire.fromBody(wire.encode({ type: "reading", channel: "/depth", seq: kept.seq, sensed: at!, ref: kept.ref }), channels))
    }

    /** What the body's screen shows now, kept and told — skipped when the screen did not hold still to be read whole. */
    async function look(): Promise<void> {
        if (!mind || !sensing || !channels) return
        screen ??= Screen({ path: opts.screen })
        const seen = screen.look()
        if (!seen.settled) return
        // Loaded when a frame is first encoded, not on import: it is native, and every bundle of this package — Fleet's
        // among them — would otherwise load it, and fail to start where its binary was not shipped.
        const { default: sharp } = await import("sharp")
        const jpeg = await sharp(seen.rgbx, { raw: { width: seen.width, height: seen.height, channels: 4 } }).removeAlpha().jpeg({ quality: QUALITY }).toBuffer()
        const kept = await keep(opts.vision.channel, "jpg", jpeg, null, "image/jpeg")
        tell({ type: "reading", channel: opts.vision.channel, seq: kept.seq, sensed: sensed, ref: kept.ref })
    }

    /** Every finished chunk of the body's sound, kept and told in order; the newest is still being written. */
    async function listen(): Promise<void> {
        if (!existsSync(opts.audio)) return
        const chunks = (await readdir(opts.audio)).filter(name => /^chunk_\d+\.wav$/.test(name)).sort().slice(0, -1)
        for (const name of chunks) {
            const from = join(opts.audio, name)
            if (!mind || !sensing || !channels || Bun.file(from).size <= WAV_HEADER_BYTES) {
                await rm(from, { force: true })
                continue
            }
            const kept = await keep(opts.hearing.channel, "wav", null, from, "audio/wav")
            tell({ type: "reading", channel: opts.hearing.channel, seq: kept.seq, sensed: sensed, ref: kept.ref })
        }
    }

    /** A loop step that fails is said, and stops the endpoint: a sense that quietly stopped is worse than none. */
    function guarded(step: () => Promise<void>, name: string): () => void {
        let busy = false
        return () => {
            if (busy || closed) return
            busy = true
            step().catch(cause => refuse(`the body's ${name} failed: ${cause instanceof Error ? cause.message : String(cause)}`)).finally(() => { busy = false })
        }
    }

    function connectUpstream(): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(opts.bridge)
            upstream = socket
            socket.addEventListener("open", () => resolve(), { once: true })
            socket.addEventListener("error", () => reject(new Error(`could not reach the body's bridge at ${opts.bridge}`)), { once: true })
            socket.addEventListener("message", event => {
                heard(String(event.data)).catch(cause => refuse(`the body broke the contract: ${cause instanceof Error ? cause.message : String(cause)}`))
            })
            socket.addEventListener("close", () => {
                if (upstream === socket) upstream = null
                if (closed) return
                presence = { type: "presence", state: "detached", why: "the body's bridge closed" }
                tell(presence)
                sensing = false
            })
        })
    }

    return {
        /** Where a mind connects, and the token it presents. Opens the body's bridge first: an endpoint with no body is not one. */
        async open(): Promise<{ url: string; token: string }> {
            if (server) throw new Error("the body's endpoint is already open")
            await mkdir(opts.dir, { recursive: true })
            await connectUpstream()
            server = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch(request, srv) {
                    const url = new URL(request.url)
                    if (url.pathname !== "/body") return new Response("not found", { status: 404 })
                    if (url.searchParams.get("token") !== token) return new Response("this body is leased to someone else", { status: 401 })
                    if (mind) return new Response("a mind already wears this body", { status: 409 })
                    if (srv.upgrade(request, { data: undefined })) return undefined
                    return new Response("a body is spoken to over a WebSocket", { status: 426 })
                },
                websocket: {
                    open(socket) {
                        mind = socket
                        if (described) socket.send(wire.encode({ type: "manifest", manifest: described }))
                        socket.send(wire.encode(presence ?? { type: "presence", state: "detached", why: "the body is not in a world yet" }))
                    },
                    message(socket, data) {
                        if (!channels) return refuse("the mind spoke before the body described itself")
                        let said: body.ToBody
                        try {
                            said = wire.toBody(String(data), channels)
                        } catch (cause) {
                            return refuse(`the mind broke the contract: ${cause instanceof Error ? cause.message : String(cause)}`)
                        }
                        if (!upstream) return refuse("the body's bridge is gone; there is nothing to say this to")
                        // The lab's bridges take a command as `act` — their `command` is the lab's own — and only of values.
                        if (said.type === "command" && !said.values) return refuse(`a command on ${said.channel} of other than values, which this lab's bodies are not wired to take`)
                        if (said.type === "command") upstream.send(JSON.stringify({ type: "act", channel: said.channel, seq: said.seq, values: said.values }))
                        else upstream.send(wire.encode(said))
                    },
                    close(socket) {
                        if (mind === socket) mind = null
                    },
                },
            })
            looking = setInterval(guarded(look, "vision"), 1000 / 24)
            listening = setInterval(guarded(listen, "hearing"), LISTEN_MS)
            return { url: `ws://127.0.0.1:${server.port}/body`, token: token }
        },

        /** The body as it last described itself, with the lab's senses; null before it has. */
        manifest(): body.Manifest | null {
            return described
        },

        async close(): Promise<void> {
            closed = true
            if (looking) clearInterval(looking)
            if (listening) clearInterval(listening)
            mind?.close(1001, "the body was released")
            mind = null
            upstream?.close()
            upstream = null
            screen?.close()
            screen = null
            server?.stop(true)
            server = null
            await rm(opts.dir, { recursive: true, force: true })
        },
    }
}

export type EndpointT = ReturnType<typeof Endpoint>
