import { afterAll, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { examples } from "@arcforge/body"
import { Endpoint } from "../../src/labs/body"

const root = await mkdtemp(join(tmpdir(), "axon-body-endpoint-"))
afterAll(() => rm(root, { recursive: true, force: true }))

/** A screen as the lab's display keeps one: an X window dump, 4×2, blue-green-red words. */
async function screen(path: string): Promise<void> {
    const header = Buffer.alloc(100)
    const fields: Record<number, number> = { 0: 100, 1: 7, 2: 2, 4: 4, 5: 2, 7: 0, 11: 32, 12: 16, 14: 0xff0000, 15: 0x00ff00, 16: 0x0000ff, 19: 0 }
    for (const [index, value] of Object.entries(fields)) header.writeUInt32BE(value, Number(index) * 4)
    await writeFile(path, Buffer.concat([header, Buffer.alloc(4 * 2 * 4, 0x80)]))
}

/** A body's bridge that speaks the contract, and remembers what it is told. */
function bridge() {
    const told: unknown[] = []
    const sockets = new Set<{ send(text: string): void }>()
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request, srv) { return srv.upgrade(request, { data: undefined }) ? undefined : new Response("no", { status: 400 }) },
        websocket: {
            open(socket) { sockets.add(socket) },
            message(_socket, data) { told.push(JSON.parse(String(data))) },
            close(socket) { sockets.delete(socket) },
        },
    })
    return {
        url: `ws://127.0.0.1:${server.port}/bridge`,
        told: told,
        say(message: unknown) { for (const socket of sockets) socket.send(JSON.stringify(message)) },
        stop() { server.stop(true) },
    }
}

/** A mind's side of the socket: everything heard, in order. */
async function mind(url: string, token: string) {
    const heard: any[] = []
    const socket = new WebSocket(`${url}?token=${token}`)
    const closed = new Promise<{ code: number; reason: string }>(resolve => socket.addEventListener("close", event => resolve({ code: event.code, reason: event.reason })))
    socket.addEventListener("message", event => heard.push(JSON.parse(String(event.data))))
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("could not connect"))) })
    return { heard: heard, socket: socket, closed: closed }
}

async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (check()) return
        await Bun.sleep(10)
    }
    throw new Error(`never: ${what}`)
}

test("a body, as a mind meets it: its manifest with the lab's senses, its readings, its screen and sound, and commands to it", async () => {
    const body = bridge()
    const audio = join(root, "audio")
    await mkdir(audio, { recursive: true })
    const frame = join(root, "screen.xwd")
    await screen(frame)
    const endpoint = Endpoint({ bridge: body.url, dir: join(root, "senses"), screen: frame, audio: audio, hearing: { channel: "/hearing", sampleRate: 44_100, channels: 2 }, vision: { channel: "/vision" } })
    const opened = await endpoint.open()
    await until(() => true, "")
    body.say({ type: "manifest", manifest: examples.MINECRAFT })
    body.say({ type: "presence", state: "embodied" })
    await until(() => endpoint.manifest() !== null, "the manifest arrived")

    const worn = await mind(opened.url, opened.token)
    await until(() => worn.heard.some(message => message.type === "manifest"), "the mind was told the body")
    const told = worn.heard.find(message => message.type === "manifest")
    expect(told.manifest.senses.map((sense: { channel: string }) => sense.channel)).toContain("/hearing")

    body.say({ type: "reading", channel: "/imu", seq: 1, sensed: 50, values: [0, 0, 32, 0, 0, 0] })
    body.say({ type: "truth", sensed: 50, values: [1, 2, 3], components: [{ name: "x", unit: "m" }, { name: "y", unit: "m" }, { name: "z", unit: "m" }] })
    const grid = Buffer.alloc(160 * 90 * 4)
    grid.writeFloatLE(2.5, 0)
    body.say({ type: "depth", channel: "/depth", seq: 1, sensed: 100, cols: 160, rows: 90, data: grid.toString("base64") })
    await until(() => worn.heard.some(message => message.channel === "/depth"), "the depth grid became a reading")
    const depth = worn.heard.find(message => message.channel === "/depth")
    expect(readFileSync(fileURLToPath(depth.ref.uri)).readFloatLE(0)).toBe(2.5)
    expect(worn.heard.some(message => message.type === "truth")).toBe(true)

    // A frame taken now is stamped with the newest stamp the body sent: the depth grid's.
    await until(() => worn.heard.some(message => message.channel === "/vision" && message.sensed === 100), "the screen was seen, stamped")
    const seen = worn.heard.findLast(message => message.channel === "/vision")
    expect(seen.ref.mime).toBe("image/jpeg")
    expect(existsSync(fileURLToPath(seen.ref.uri))).toBe(true)

    // Two chunks: the first is finished, the second still being written.
    const wav = Buffer.concat([Buffer.alloc(44), Buffer.alloc(400, 1)])
    await writeFile(join(audio, "chunk_000001.wav"), wav)
    await writeFile(join(audio, "chunk_000002.wav"), wav)
    await until(() => worn.heard.some(message => message.channel === "/hearing"), "the sound was heard")
    expect(worn.heard.filter(message => message.channel === "/hearing")).toHaveLength(1)

    worn.socket.send(JSON.stringify({ type: "command", channel: "/look", seq: 7, values: [0.5, -0.25], basis: 100 }))
    await until(() => body.told.length > 0, "the command reached the body")
    expect(body.told[0]).toEqual({ type: "act", channel: "/look", seq: 7, values: [0.5, -0.25] })

    worn.socket.send(JSON.stringify({ type: "command", channel: "/wings", seq: 8, values: [1] }))
    const ended = await worn.closed
    expect(ended.code).toBe(1008)
    expect(ended.reason).toContain("declared no control on")

    await endpoint.close()
    body.stop()
})

test("a body is worn only with its lease's token", async () => {
    const body = bridge()
    const frame = join(root, "screen2.xwd")
    await screen(frame)
    const endpoint = Endpoint({ bridge: body.url, dir: join(root, "senses2"), screen: frame, audio: join(root, "audio2"), hearing: { channel: "/hearing", sampleRate: 44_100, channels: 2 }, vision: { channel: "/vision" } })
    const opened = await endpoint.open()
    const refused = await fetch(opened.url.replace("ws://", "http://") + "?token=someone-else")
    expect(refused.status).toBe(401)
    await endpoint.close()
    body.stop()
})

test("a skill the body declared is passed to it, and its answer back; one it did not is refused", async () => {
    const body = bridge()
    const frame = join(root, "screen3.xwd")
    await screen(frame)
    const endpoint = Endpoint({ bridge: body.url, dir: join(root, "senses3"), screen: frame, audio: join(root, "audio3"), hearing: { channel: "/hearing", sampleRate: 22_050, channels: 2 }, vision: { channel: "/vision" } })
    const opened = await endpoint.open()
    body.say({ type: "manifest", manifest: examples.TERRARIA })
    await until(() => endpoint.manifest() !== null, "the manifest arrived")
    const worn = await mind(opened.url, opened.token)

    worn.socket.send(JSON.stringify({ type: "skill", id: "s1", name: "say", args: { text: "hello" } }))
    await until(() => body.told.length > 0, "the skill reached the body")
    expect(body.told[0]).toEqual({ type: "skill", id: "s1", name: "say", args: { text: "hello" } })
    body.say({ type: "skill", id: "s1", state: "succeeded", result: { said: "hello" } })
    await until(() => worn.heard.some(message => message.type === "skill"), "the answer reached the mind")
    expect(worn.heard.find(message => message.type === "skill")).toEqual({ type: "skill", id: "s1", state: "succeeded", result: { said: "hello" } })

    worn.socket.send(JSON.stringify({ type: "skill", id: "s2", name: "fly", args: {} }))
    const ended = await worn.closed
    expect(ended.reason).toContain("declared no skill of")

    await endpoint.close()
    body.stop()
})

test("a body that is held still senses — the mind sees what holds it — and says why", async () => {
    const body = bridge()
    const frame = join(root, "screen4.xwd")
    await screen(frame)
    const endpoint = Endpoint({ bridge: body.url, dir: join(root, "senses4"), screen: frame, audio: join(root, "audio4"), hearing: { channel: "/hearing", sampleRate: 22_050, channels: 2 }, vision: { channel: "/vision" } })
    const opened = await endpoint.open()
    body.say({ type: "manifest", manifest: examples.TERRARIA })
    body.say({ type: "presence", state: "held", why: "a person paused the game" })
    await until(() => endpoint.manifest() !== null, "the manifest arrived")
    const worn = await mind(opened.url, opened.token)
    await until(() => worn.heard.some(message => message.channel === "/vision"), "the held body was still seen")
    expect(worn.heard.find(message => message.type === "presence")).toEqual({ type: "presence", state: "held", why: "a person paused the game" })
    await endpoint.close()
    body.stop()
})

test("a body that speaks before it says what it is, is refused", async () => {
    const body = bridge()
    const frame = join(root, "screen5.xwd")
    await screen(frame)
    const endpoint = Endpoint({ bridge: body.url, dir: join(root, "senses5"), screen: frame, audio: join(root, "audio5"), hearing: { channel: "/hearing", sampleRate: 22_050, channels: 2 }, vision: { channel: "/vision" } })
    const opened = await endpoint.open()
    const worn = await mind(opened.url, opened.token)
    body.say({ type: "reading", channel: "/imu", seq: 1, sensed: 50, values: [0, 0] })
    const ended = await worn.closed
    expect(ended.reason).toContain("before the body's manifest")
    await endpoint.close()
    body.stop()
})
