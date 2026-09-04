import { spawn } from "node:child_process"
import { err } from "@arcforge/err"

export type InjectOpts = {
    /**
     * Milliseconds between keystrokes.
     *
     * `wtype` defaults to ZERO, which is the bug it looks like: the whole
     * string is pushed at the compositor as fast as it will take it, and any
     * window doing work per keystroke — a terminal, an editor, anything with
     * input handling — drops and reorders them. Observed output for
     * "Hello. Can you hear me?" was "Yllo.Cnor?".
     *
     * Small enough to still read as instant, large enough that a receiver gets
     * a scheduling slice between events. A pacing fix, not a throttle: the
     * failure is a race, and this is the only knob wtype offers for it.
     */
    keyDelayMs?: number
    /** Injectable, so a test never types into a real desktop. */
    run?: (argv: string[], input?: string) => Promise<{ status: number | null; stderr: string }>
}

/**
 * Typing text where the cursor already is.
 *
 * ── Why this is not the clipboard ───────────────────────────────────────────
 *
 * Pasting would be easier and is wrong: it destroys whatever the person had
 * copied, and "dictation ate my clipboard" is the kind of side effect that
 * makes someone turn a feature off and not come back. `wtype` drives the
 * Wayland virtual-keyboard protocol, so the text arrives exactly as if it had
 * been typed — no clipboard, no focus change, no paste shortcut that means
 * something different in the app you happen to be in.
 *
 * ── Why there is no X11 fallback ────────────────────────────────────────────
 *
 * There is no `xdotool` branch because this ships on Omarchy, which is
 * Wayland. A fallback for a display server the product does not target is
 * untested code on a path nobody runs, and the honest failure — "install
 * wtype" — is more useful than a second mechanism that might also not work.
 */
export function Inject(opts: InjectOpts = {}) {
    const keyDelayMs = opts.keyDelayMs ?? 6

    /**
     * Spawned, never spawnSync.
     *
     * Typing is paced now — 6ms a key — so a sixty-character phrase holds the
     * process for a third of a second. The daemon is single-threaded and at
     * that moment is also serving the level meter at 16Hz, so a synchronous
     * spawn would freeze the visualiser every time a phrase landed: precisely
     * the moment someone is watching it.
     */
    const run = opts.run ?? (async (argv: string[], input?: string) => {
        const [command, ...args] = argv
        const child = spawn(command!, args, { stdio: ["pipe", "ignore", "pipe"] })
        let stderr = ""
        child.stderr?.on("data", chunk => { stderr += String(chunk) })
        if (input !== undefined) child.stdin?.end(input)
        const status = await new Promise<number | null>(resolve => {
            child.once("error", () => resolve(null))
            child.once("close", code => resolve(code))
        })
        return { status: status, stderr: stderr }
    })

    return {
        /** True when this machine can type at all. */
        get available(): boolean {
            return Bun.which("wtype") !== null
        },

        /**
         * Type `text` into whatever holds focus.
         *
         * Through STDIN (`wtype -`) rather than as an argument. A transcript is
         * arbitrary text of unbounded length: as an operand it has to dodge
         * option parsing (recognisers emit leading dashes routinely) and it
         * competes for the argument-length limit. On stdin it is just bytes.
         */
        async type(text: string): Promise<void> {
            const body = String(text)
            if (body === "") return

            if (!this.available) {
                throw err("DICTATION_NO_TYPIST", {
                    detail: "wtype is not installed — it is what types the transcript into the focused window (pacman -S wtype)",
                })
            }

            const result = await run(["wtype", "-d", String(keyDelayMs), "-"], body)
            if (result.status !== 0) {
                throw err("DICTATION_TYPE_FAILED", {
                    detail: `wtype exited ${result.status}: ${result.stderr.trim() || "no output"}`
                        + " — the compositor may not support the virtual-keyboard protocol",
                    context: { status: result.status },
                })
            }
        },
    }
}

export type InjectT = ReturnType<typeof Inject>
