import { request } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"

/** What the lab hands an agent: the body it now occupies. */
export type Embodiment = {
    lease: string
    body: string
    world: string
    /** The body's AxonT bridge. */
    bridge: string
    /** Where the body's frames land, newest last. */
    frames: string
    /** Where the body's stereo audio lands, newest last. */
    audio: string
    character: string
}

/**
 * Lab — this agent's line to the daemon that runs the Terraria world.
 *
 * The world and its warm bodies belong to the daemon, not to any agent: a body
 * outlives the brains that occupy it, which is what makes an agent's boot a
 * server join rather than a game launch. This asks for one and gives it back.
 *
 * Speaks the daemon's own protocol — one JSON POST over its unix socket —
 * rather than importing its client, because a published module must not
 * depend on daemon internals to rent a body.
 */
export function Lab() {
    const socket = join(
        process.env.AXON_DAEMON_DIR ?? join(homedir(), process.env.NODE_ENV === "production" ? ".axon" : ".axon-dev", "cache", "daemon"),
        "axond.sock",
    )

    async function call(path: string[], arg?: unknown): Promise<unknown> {
        const body = JSON.stringify({ path: path, arg: arg })
        const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
            const req = request(
                { socketPath: socket, path: "/", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
                res => {
                    let text = ""
                    res.setEncoding("utf-8")
                    res.on("data", chunk => { text += chunk })
                    res.on("end", () => resolve({ status: res.statusCode ?? 0, text: text }))
                },
            )
            req.on("error", cause => reject(new Error(`the Axon daemon is not reachable at ${socket} — start it (axon daemon up)`, { cause: cause })))
            req.end(body)
        })

        const parsed = JSON.parse(response.text) as { ok: boolean; value?: unknown; error?: string; fault?: { code?: string; detail?: string } }
        if (!parsed.ok) {
            const code = parsed.fault?.code ? `${parsed.fault.code}: ` : ""
            const detail = parsed.fault?.detail ? ` — ${parsed.fault.detail}` : ""
            throw new Error(`${code}${parsed.error ?? `daemon answered ${response.status}`}${detail}`)
        }
        return parsed.value
    }

    return {
        /** Occupy a warm body as `character`. Held until released or this process exits. */
        async embody(input: { agent: string; character: string; characterDir: string }): Promise<Embodiment> {
            return await call(["worlds", "bodies", "lease"], { ...input, pid: process.pid }) as Embodiment
        },

        async release(lease: string): Promise<void> {
            await call(["worlds", "bodies", "release"], lease)
        },
    }
}

export type LabT = ReturnType<typeof Lab>
