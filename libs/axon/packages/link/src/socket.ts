import { err } from "@arcforge/err"
import { mkdirSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { Channel, type ChannelHandlers, type ChannelT } from "./channel"

/**
 * A socket write that never loses bytes.
 *
 * `sock.write()` returns how many bytes the kernel ACCEPTED, which is not
 * necessarily how many were offered: once the send buffer fills (measured at
 * ~233KB on this platform) it goes short, and the remainder is the caller's
 * problem. Ignoring the return value silently truncates a frame mid-payload,
 * which desynchronises the stream — the peer then reads the next length prefix
 * at the wrong offset and every subsequent frame is garbage.
 *
 * That is not hypothetical: 500 rapid `send()`s arrived as 278 before this
 * existed, with no error anywhere.
 *
 * So unwritten bytes are queued and flushed on `drain`. The queue is also what
 * makes backpressure OBSERVABLE — `pending` is how the layer above knows the
 * consumer is behind, which a fire-and-forget write cannot express.
 */
type Drainable = {
    write(data: Uint8Array): number
    end(): void
}

function Writer(sock: Drainable) {
    let queue: Uint8Array[] = []
    let queued = 0

    function flush(): void {
        while (queue.length > 0) {
            const chunk = queue[0]!
            const written = sock.write(chunk)
            if (written < chunk.byteLength) {
                // Partial: keep exactly the unwritten tail. Re-queueing the
                // whole chunk would duplicate the accepted prefix.
                queue[0] = chunk.subarray(written)
                queued -= written
                return
            }
            queue.shift()
            queued -= chunk.byteLength
        }
    }

    // Producers parked waiting for the queue to fall below their threshold.
    const waiters: Array<{ below: number; resolve(): void }> = []

    function releaseWaiters(): void {
        for (let i = waiters.length - 1; i >= 0; i--) {
            if (queued <= waiters[i]!.below) waiters.splice(i, 1)[0]!.resolve()
        }
    }

    return {
        write(data: Uint8Array): number {
            // Anything already queued must go first, or frames reorder.
            if (queue.length > 0) {
                queue.push(data)
                queued += data.byteLength
                flush()
                return data.byteLength
            }
            const written = sock.write(data)
            if (written < data.byteLength) {
                queue.push(data.subarray(written))
                queued += data.byteLength - written
            }
            return data.byteLength
        },
        drain() { flush(); releaseWaiters() },
        get pending() { return queued },
        /**
         * Resolve once the queue has drained below `below`.
         *
         * Released from `drain` (the socket telling us it accepted more) and
         * checked immediately, so a producer that calls this when the queue is
         * already shallow never parks.
         */
        whenDrained(below: number): Promise<void> {
            if (queued <= below) return Promise.resolve()
            return new Promise<void>(resolve => { waiters.push({ below, resolve }) })
        },
        /** Nobody is coming to drain us — never leave a producer parked forever. */
        release(): void {
            for (const waiter of waiters.splice(0)) waiter.resolve()
        },
        close() { this.release(); sock.end() },
    }
}

/**
 * Unix-socket transport for a Channel.
 *
 * ── Why connect by PATH rather than inherit an fd ───────────────────────────
 *
 * The tidier design hands the agent a pre-connected socket fd at spawn, so no
 * path exists to find or race on. `Bun.spawn` exposes stdio only — no extra
 * fds — so the agent must connect by path, and that path must therefore exist
 * inside the box: the socket directory becomes a declared bind mount in the
 * confinement spec. It is the one hole punched through an otherwise
 * deny-by-default filesystem, and it is worth naming as such.
 *
 * ── Two channels, not one ───────────────────────────────────────────────────
 *
 * `interrupt` must land WHILE inference is streaming. On one socket it queues
 * behind exactly the traffic it exists to stop — the capsule worked around
 * that by killing and rebuilding its subprocess (a hard reset racing a 50ms
 * shutdown timeout) — machinery since deleted with the subprocess itself. Two sockets remove the need for the workaround
 * rather than tuning it.
 */

export type SocketPaths = {
    /** stimulus/update/interrupt/shutdown, escalate. Never blocked by inference. */
    control: string
    /** The infer stream and the commit log. */
    data: string
}

/** Both channels of one link, plus the teardown that closes them. */
export type LinkChannels = {
    control: ChannelT
    data: ChannelT
    close(): void
}

type ServeOpts = {
    paths: SocketPaths
    control: ChannelHandlers
    data: ChannelHandlers
    onError(error: Error): void
}

/**
 * Listen on both paths and resolve once a peer has connected to each.
 *
 * A stale socket file is removed first: a previous process that died without
 * unlinking leaves a path that `listen` refuses (EADDRINUSE) even though
 * nothing is behind it.
 */
export async function serve(opts: ServeOpts): Promise<LinkChannels> {
    const made: Array<{ stop(): void }> = []

    function listen(path: string, handlers: ChannelHandlers): Promise<ChannelT> {
        mkdirSync(dirname(path), { recursive: true })
        rmSync(path, { force: true })

        return new Promise<ChannelT>((resolve, reject) => {
            let channel: ChannelT | null = null
            let writer: ReturnType<typeof Writer> | null = null
            try {
                const server = Bun.listen<undefined>({
                    unix: path,
                    socket: {
                        open(sock) {
                            writer = Writer(sock)
                            channel = Channel({
                                socket: {
                                    write: d => writer!.write(d),
                                    get pending() { return writer!.pending },
                                    whenDrained: below => writer!.whenDrained(below),
                                    close: () => writer!.close(),
                                },
                                handlers,
                                onError: opts.onError,
                            })
                            resolve(channel)
                        },
                        data(_sock, chunk) { channel?.receive(chunk) },
                        drain() { writer?.drain() },
                        close() { channel?.fail(err("LINK_PEER_CLOSED")) },
                        error(_sock, error) { channel?.fail(error) },
                    },
                })
                made.push(server)
            } catch (cause) {
                reject(cause as Error)
            }
        })
    }

    const [control, data] = await Promise.all([
        listen(opts.paths.control, opts.control),
        listen(opts.paths.data, opts.data),
    ])

    return {
        control,
        data,
        close() {
            control.fail(err("LINK_CLOSED"))
            data.fail(err("LINK_CLOSED"))
            for (const server of made) server.stop()
            rmSync(opts.paths.control, { force: true })
            rmSync(opts.paths.data, { force: true })
        },
    }
}

type ConnectOpts = {
    paths: SocketPaths
    control: ChannelHandlers
    data: ChannelHandlers
    onError(error: Error): void
}

/** Dial both paths. Used by the agent, inside the box. */
export async function connect(opts: ConnectOpts): Promise<LinkChannels> {
    async function dial(path: string, handlers: ChannelHandlers): Promise<ChannelT> {
        let channel: ChannelT | null = null
        let writer: ReturnType<typeof Writer> | null = null
        const sock = await Bun.connect<undefined>({
            unix: path,
            socket: {
                data(_s, chunk) { channel?.receive(chunk) },
                drain() { writer?.drain() },
                close() { channel?.fail(err("LINK_PEER_CLOSED")) },
                error(_s, error) { channel?.fail(error) },
            },
        })
        writer = Writer(sock)
        channel = Channel({
            socket: {
                write: d => writer!.write(d),
                get pending() { return writer!.pending },
                whenDrained: below => writer!.whenDrained(below),
                close: () => writer!.close(),
            },
            handlers,
            onError: opts.onError,
        })
        return channel
    }

    const [control, data] = await Promise.all([
        dial(opts.paths.control, opts.control),
        dial(opts.paths.data, opts.data),
    ])

    return {
        control,
        data,
        close() {
            control.fail(err("LINK_CLOSED"))
            data.fail(err("LINK_CLOSED"))
        },
    }
}
