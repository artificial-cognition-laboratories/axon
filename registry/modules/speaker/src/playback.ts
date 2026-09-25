import type { PcmFormat } from "./formats"

export type Playback = {
    readonly process: ReturnType<typeof Bun.spawn>
    readonly done: Promise<{ ok: boolean; exitCode: number }>
    stop(): void
}

function argsFor(format: PcmFormat, device: string): string[] | null {
    const rate = String(format.rate)
    const channels = String(format.channels)

    if (process.platform === "linux" && Bun.which("aplay")) {
        return ["-t", "raw", "-f", "S16_LE", "-r", rate, "-c", channels, ...(device !== "default" ? ["-D", device] : []), "-q", "-"]
    }

    if (Bun.which("ffplay")) {
        return ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "s16le", "-ar", rate, "-ac", channels, "-i", "pipe:0"]
    }

    return null
}

export function play(pcm: Uint8Array, format: PcmFormat, device: string): Playback {
    const args = argsFor(format, device)
    if (!args) {
        throw new Error("no audio playback backend found — install aplay (Linux) or ffplay")
    }

    const command = process.platform === "linux" && Bun.which("aplay") ? "aplay" : "ffplay"
    const child = Bun.spawn([command, ...args], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
    })

    // Always drain diagnostics; a backend that fills stderr can otherwise
    // block while appearing to be playing.
    void (async () => {
        for await (const _ of child.stderr as ReadableStream<Uint8Array>) {}
    })().catch(() => {})

    const done = child.exited.then(exitCode => ({ ok: exitCode === 0, exitCode }))
    child.stdin.write(pcm)
    child.stdin.end()

    return {
        process: child,
        done,
        stop() {
            try { child.kill("SIGTERM") } catch {}
            const escalate = setTimeout(() => {
                try { child.kill("SIGKILL") } catch {}
            }, 300)
            void child.exited.then(() => clearTimeout(escalate))
        },
    }
}
