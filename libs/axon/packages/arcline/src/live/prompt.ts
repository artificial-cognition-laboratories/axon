/**
 * prompt — asking the user something.
 *
 * ── Why this lives in live/ ────────────────────────────────────────────────
 *
 * A prompt is the same kind of thing as a spinner: it owns the cursor, it has
 * a lifecycle, and it repaints as state changes. So it follows the same rule —
 * a pure view renders each frame, and one impure handle drives it. The only
 * addition is that this one also READS, which means raw mode, which means the
 * terminal must be restored no matter how the process ends.
 *
 * Restoration is the load-bearing part. A CLI that leaves raw mode on after a
 * Ctrl-C hands the user a shell with no echo and no line editing, which looks
 * like it crashed their terminal. Every exit path here — accept, cancel,
 * throw, signal — goes through one `restore()`.
 */

import { HIDE_CURSOR, SHOW_CURSOR, CLEAR_LINE, COL_0, cursorUp, icons } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"

/** Raised when the user cancels — Esc or Ctrl-C. */
export class PromptCancelled extends Error {
    constructor() {
        super("cancelled")
        this.name = "PromptCancelled"
    }
}

export type TextPromptOpts = {
    /** The question, e.g. "Name". */
    label: string
    /**
     * Value used when the user just hits enter. Shown dimmed as the current
     * text, so accepting it is one keystroke and editing it is obvious.
     */
    defaultValue?: string
    /** Longer context under the question, e.g. what the name will be used for. */
    hint?: string
    /**
     * Reject a value with a reason. Returning a string keeps the prompt open
     * and shows it — a name that fails validation should be corrected in
     * place, not reported after the command has already exited.
     */
    validate?: (value: string) => string | undefined
}

/**
 * Ask for a line of text.
 *
 * Resolves with the answer, or rejects with `PromptCancelled`. A non-interactive
 * stdin (a pipe, CI) has no user to ask, so it takes `defaultValue` if there is
 * one and throws if there is not — hanging forever waiting on a tty that will
 * never answer is the one behaviour that must never happen.
 */
export async function text(r: RendererHandle, opts: TextPromptOpts): Promise<string> {
    const input = process.stdin

    if (!input.isTTY || !r.interactive) {
        if (opts.defaultValue !== undefined) return opts.defaultValue
        throw new Error(`${opts.label} is required (no interactive terminal to ask)`)
    }

    let value = opts.defaultValue ?? ""
    let error: string | undefined
    let painted = 0

    /**
     * One line, plus a second only when there is something to say.
     *
     * The keybinding legend is deliberately absent: "↵ accept · esc cancel" is
     * true of every prompt in the product, so printing it under each one is a
     * line of chrome that teaches nothing after the first time. What earns the
     * second line is information specific to THIS question — a validation
     * error, or a hint about what the answer is for.
     *
     * An empty value shows the caret against nothing rather than a placeholder
     * glyph: the cursor is the affordance, and a "…" reads like text the user
     * has to delete.
     */
    function frame(): string[] {
        const typed = value === ""
            ? r.c.dim("▏")
            : r.c.text(value) + r.c.dim("▏")

        const lines = [`${r.c.primary("?")}  ${r.c.text(opts.label)}  ${r.c.dim("›")}  ${typed}`]

        if (error) lines.push(`   ${r.c.error(icons.fail)}  ${r.c.error(error)}`)
        else if (opts.hint) lines.push(`   ${r.c.dim(opts.hint)}`)

        return lines
    }

    function paint(): void {
        if (painted > 0) {
            r.write(cursorUp(1) + COL_0)
            for (let i = 0; i < painted; i++) {
                r.write(CLEAR_LINE)
                if (i < painted - 1) r.write(cursorUp(1))
            }
            r.write(COL_0)
        }
        const lines = frame()
        r.write(lines.join("\n") + "\n")
        painted = lines.length
    }

    const wasRaw = input.isRaw
    function restore(): void {
        input.setRawMode(wasRaw ?? false)
        input.pause()
        r.write(SHOW_CURSOR)
    }

    r.write(HIDE_CURSOR)
    paint()

    input.setRawMode(true)
    input.resume()

    return new Promise<string>((resolve, reject) => {
        function finish(fn: () => void): void {
            input.off("data", onData)
            restore()
            fn()
        }

        /**
         * Replace the live prompt with a settled record of the answer.
         *
         * The transcript should read as a history of what happened, not leave
         * a dead input caret and a hint for a question that is already
         * answered. Same erase-upwards reconciliation as Live.
         */
        function settle(answer: string): void {
            if (painted > 0) {
                r.write(cursorUp(1) + COL_0)
                for (let i = 0; i < painted; i++) {
                    r.write(CLEAR_LINE)
                    if (i < painted - 1) r.write(cursorUp(1))
                }
                r.write(COL_0)
            }
            r.write(`${r.c.primary(icons.ok)}  ${r.c.dim(opts.label)}  ${r.c.text(answer)}\n`)
            painted = 0
        }

        function onData(chunk: Buffer): void {
            const key = chunk.toString("utf8")

            // Ctrl-C must behave like Ctrl-C: raw mode means the signal is not
            // delivered, so it is handled here or not at all.
            if (key === "\u0003" || key === "\u001b") {
                finish(() => reject(new PromptCancelled()))
                return
            }

            if (key === "\r" || key === "\n") {
                const reason = opts.validate?.(value)
                if (reason) {
                    error = reason
                    paint()
                    return
                }
                settle(value)
                finish(() => resolve(value))
                return
            }

            if (key === "\u007f" || key === "\b") {
                value = value.slice(0, -1)
                error = undefined
                paint()
                return
            }

            // Ignore every other control sequence — arrow keys and friends
            // arrive as escape sequences and would otherwise be typed in as
            // literal garbage.
            if (key < " " || key.startsWith("\u001b")) return

            value += key
            error = undefined
            paint()
        }

        input.on("data", onData)
    })
}

export type ConfirmOpts = {
    label: string
    /** What enter alone means. Default true. */
    defaultValue?: boolean
    hint?: string
}

/** Ask a yes/no question. Same contract as `text`. */
export async function confirm(r: RendererHandle, opts: ConfirmOpts): Promise<boolean> {
    const fallback = opts.defaultValue ?? true
    const answer = await text(r, {
        label: opts.label,
        defaultValue: fallback ? "y" : "n",
        hint: opts.hint ?? `y / n`,
        validate: value =>
            ["y", "yes", "n", "no"].includes(value.trim().toLowerCase())
                ? undefined
                : "answer y or n",
    })
    return answer.trim().toLowerCase().startsWith("y")
}
