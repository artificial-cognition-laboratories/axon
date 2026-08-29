/**
 * Renderer — the output handle every component and view draws against.
 *
 * ── Why a handle rather than reaching for process.stdout ────────────────────
 *
 * Three things vary between the terminal a developer is watching and the log a
 * CI job produces: whether colour is meaningful, how wide a line may be, and
 * whether the cursor can be moved. Components must not each rediscover those.
 * They take a Renderer, ask it, and are correct in both places.
 *
 * It is also what makes this package testable. `Renderer.capture()` returns a
 * handle backed by a string buffer with a fixed width and colour off, so a
 * view's output is an assertable string rather than something that has to be
 * eyeballed in a terminal.
 */

import { Palette } from "./color.ts"
import type { Theme } from "@arcforge/types"

export type RendererOpts = {
    /** Where output goes. Defaults to process.stdout. */
    stream?: NodeJS.WriteStream
    /** Theme to draw from. Defaults to arcnight. */
    theme?: Theme
    /**
     * Force colour on or off. Defaults to auto-detection: on for a TTY unless
     * NO_COLOR is set, off otherwise.
     */
    color?: boolean
    /** Force a column count. Defaults to the stream's width, or 80. */
    columns?: number
}

export type RendererHandle = {
    /** The paint functions, already resolved for this output's colour support. */
    readonly c: Palette
    /**
     * May OSC 8 hyperlinks be emitted?
     *
     * Tracks colour support: a destination that cannot interpret an escape
     * sequence renders the raw `ESC]8;;` bytes as garbage, which is strictly
     * worse than printing the URL plainly. Components ask this rather than
     * emitting a link unconditionally.
     */
    readonly links: boolean
    /** Printable columns available. */
    readonly columns: number
    /**
     * Can the cursor be moved — i.e. may a live surface repaint in place?
     *
     * False for pipes and CI logs, where a live surface must degrade to
     * plain sequential lines instead of emitting cursor escapes nobody will
     * interpret.
     */
    readonly interactive: boolean
    /** Write a string verbatim — no trailing newline added. */
    write(text: string): void
    /** Write a string followed by a newline. */
    line(text?: string): void
}

/**
 * Colour is on for a TTY unless the user opted out.
 *
 * NO_COLOR is honoured as an explicit user preference (no-color.org); a
 * non-TTY is off because escape codes in a piped log are noise, not colour.
 */
function detectColor(stream: NodeJS.WriteStream): boolean {
    if (process.env.NO_COLOR) return false
    if (process.env.FORCE_COLOR) return true
    return Boolean(stream.isTTY)
}

export function Renderer(opts: RendererOpts = {}): RendererHandle {
    const stream = opts.stream ?? process.stdout
    const color = opts.color ?? detectColor(stream)
    const c = Palette({ theme: opts.theme, enabled: color })

    return {
        c,
        links: color,
        // Read through a getter, not captured once: a terminal can be resized
        // while a long-running dev server is up, and a layout computed against
        // a stale width wraps for the rest of the session.
        get columns() {
            return opts.columns ?? stream.columns ?? 80
        },
        get interactive() {
            return Boolean(stream.isTTY)
        },
        write(text) {
            stream.write(text)
        },
        line(text = "") {
            stream.write(text + "\n")
        },
    }
}

export type CaptureHandle = RendererHandle & {
    /** Everything written so far. */
    output(): string
}

/**
 * A Renderer backed by a string buffer — for tests and for composing a frame
 * before writing it. Colour off and width fixed by default so assertions are
 * stable regardless of the terminal the test runs in.
 */
Renderer.capture = function capture(opts: { columns?: number; color?: boolean; theme?: Theme } = {}): CaptureHandle {
    let buffer = ""
    const c = Palette({ theme: opts.theme, enabled: opts.color ?? false })

    return {
        c,
        links: opts.color ?? false,
        columns: opts.columns ?? 80,
        interactive: false,
        write(text) { buffer += text },
        line(text = "") { buffer += text + "\n" },
        output() { return buffer },
    }
}
