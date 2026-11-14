import type { Subprocess } from "bun"

/** Samples kept: comfortably longer than any reader's window. */
const KEEP_MS = 30_000
/** Unread this long, the stream stops — nothing is watching. */
const IDLE_MS = 30_000

export type AttributionOpts = {
    /** The command that streams one sample a second; injected so a test can feed it. */
    command?: string[]
}

/**
 * Attribution — what each process uses of the GPU, averaged over time.
 *
 * The driver attributes GPU work to processes only by sampling: one
 * `nvidia-smi pmon` reading is one instant, and a model that runs in bursts
 * is idle in almost every instant. Taken that way, an agent whose vision
 * models were busy a third of the time read 0% — a reading of the sampler,
 * not of the agent.
 *
 * So the stream runs continuously while anyone reads it — one sample a
 * second — and a reader gets each process's average over its OWN window
 * (since its previous read), plus the memory it held most recently. It
 * starts on the first read and stops after IDLE_MS unread, so a daemon
 * nobody is watching runs no extra process.
 *
 * Null means unmeasured: no NVIDIA driver, or no sample in the window yet —
 * never zero, which would claim an idle GPU nobody observed.
 */
export function Attribution(opts: AttributionOpts = {}) {
    const command = opts.command ?? ["nvidia-smi", "pmon", "-s", "um", "-d", "1"]
    let child: Subprocess<"ignore", "pipe", "ignore"> | null = null
    /** The driver cannot be asked at all — no binary. Settled once. */
    let unavailable = false
    let lastRead = 0
    let idle: ReturnType<typeof setInterval> | null = null
    const samples: Sample[] = []

    function start(): void {
        try {
            child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
        } catch {
            // No binary: there is no driver to ask, which is the same answer forever.
            unavailable = true
            return
        }
        child.unref()
        const running = child
        void read(running).finally(() => { if (child === running) child = null })
        idle ??= setInterval(() => {
            if (Date.now() - lastRead < IDLE_MS) return
            stop()
        }, 5_000)
        idle.unref?.()
    }

    async function read(running: Subprocess<"ignore", "pipe", "ignore">): Promise<void> {
        const decoder = new TextDecoder()
        let carry = ""
        // One sample lists each process once; a pid seen again starts the next.
        let block = 0
        let listed = new Set<number>()
        for await (const chunk of running.stdout) {
            const text = carry + decoder.decode(chunk, { stream: true })
            const lines = text.split("\n")
            carry = lines.pop() ?? ""
            const at = Date.now()
            for (const line of lines) {
                const parsed = parse(line)
                if (!parsed) continue
                if (listed.has(parsed.pid)) {
                    block += 1
                    listed = new Set()
                }
                listed.add(parsed.pid)
                samples.push({ ...parsed, at: at, block: block })
            }
            const oldest = at - KEEP_MS
            while (samples.length > 0 && samples[0]!.at < oldest) samples.shift()
        }
    }

    function stop(): void {
        child?.kill()
        child = null
        if (idle) clearInterval(idle)
        idle = null
    }

    return {
        /**
         * Each process's GPU busy (0–100, averaged over the samples since
         * `since`) and memory (bytes, latest), or null when unmeasured.
         */
        since(since: number): Map<number, { busy: number; memory: number }> | null {
            lastRead = Date.now()
            if (unavailable) return null
            if (!child) start()
            if (unavailable) return null
            const window = samples.filter(sample => sample.at > since)
            if (window.length === 0) return null
            // Every process the driver lists appears once per sample; averaging
            // over the samples in the window, not the lines, keeps a process
            // listed in half of them at half its busy.
            const blocks = new Set(window.map(sample => sample.block)).size
            const out = new Map<number, { busy: number; memory: number }>()
            for (const sample of window) {
                const entry = out.get(sample.pid) ?? { busy: 0, memory: 0 }
                entry.busy += sample.busy / blocks
                entry.memory = sample.memory
                out.set(sample.pid, entry)
            }
            return out
        },

        stop: stop,
    }
}

export type AttributionT = ReturnType<typeof Attribution>

type Sample = { at: number; block: number; pid: number; busy: number; memory: number }

/**
 * One `pmon -s um` line: gpu pid type sm mem enc dec jpg ofa fb ccpm command,
 * "-" where the driver has nothing. Headers start with "#".
 */
function parse(line: string): { pid: number; busy: number; memory: number } | null {
    if (line.startsWith("#") || !line.trim()) return null
    const cells = line.trim().split(/\s+/)
    const pid = Number(cells[1])
    if (!Number.isInteger(pid) || pid <= 0) return null
    const number = (cell: string | undefined) => (cell === undefined || cell === "-" ? 0 : Number(cell) || 0)
    return { pid: pid, busy: number(cells[3]), memory: number(cells[9]) * 1024 * 1024 }
}
