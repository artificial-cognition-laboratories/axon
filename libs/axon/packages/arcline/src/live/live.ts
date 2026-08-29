/**
 * Live — the one piece of arcline that moves.
 *
 * ── The whole idea ─────────────────────────────────────────────────────────
 *
 * Everything else in this package is a pure function of its input. That cannot
 * express a spinner, so exactly one module is allowed to own the cursor, and
 * this is it. A live surface holds STATE and a clock; on every tick it calls a
 * pure view to produce the current frame and reconciles the terminal to it.
 *
 *     frame = view(renderer, state)     ← pure, testable, in views/
 *     Live(...).set(state)              ← the only thing that erases and repaints
 *
 * So there is one cursor-manipulating implementation in the package rather than
 * one per animated thing. A new long-running surface is a new pure view plus a
 * call to this; it writes no escape sequences of its own.
 *
 * ── Non-interactive output ─────────────────────────────────────────────────
 *
 * A pipe or a CI log cannot move a cursor, so repainting there would emit a
 * frame per tick and produce hundreds of near-identical blocks. Instead the
 * surface goes quiet while running and prints the final frame once on `stop()`.
 * The log ends up with exactly what a person would have seen at the end, which
 * is the only frame that was ever meaningful there.
 */

import { CLEAR_LINE, COL_0, HIDE_CURSOR, SHOW_CURSOR, cursorUp } from "../core/index.ts"
import type { RendererHandle } from "../core/index.ts"
import { SPINNER_FRAMES } from "../components/index.ts"

const TICK_MS = 80

export type LiveHandle<TState> = {
    /**
     * Stop animating and leave the terminal usable, without painting a final
     * frame.
     *
     * For the error path: something threw, the caller is about to render a
     * failure, and the half-drawn progress above it is neither true nor worth
     * keeping. Without this a throw inside a live operation leaves the
     * interval running and the cursor hidden — the spinner spins forever over
     * work that already died, and the error never reaches the screen.
     */
    abandon(): void

    /** Replace the state and repaint. */
    set(state: TState): void
    /** Amend the state in place and repaint. */
    update(fn: (state: TState) => TState): void
    /** The state as it currently stands. */
    readonly state: TState
    /**
     * Stop animating and leave the final frame on screen.
     *
     * Idempotent, and safe to call from a `finally` — a surface that keeps
     * ticking after its work threw would spin forever over a dead operation,
     * and one that never restores the cursor leaves the terminal broken.
     */
    stop(final?: TState): void
}

export type LiveOpts<TState> = {
    renderer: RendererHandle
    /** The pure view. Receives the animation frame so a spinner can advance. */
    view: (r: RendererHandle, state: TState, frame: string) => string
    initial: TState
}

export function Live<TState>(opts: LiveOpts<TState>): LiveHandle<TState> {
    const { renderer: r, view } = opts

    let state = opts.initial
    let painted = 0          // lines currently on screen, so we know what to erase
    let tick = 0
    let stopped = false

    function frameGlyph(): string {
        return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!
    }

    /**
     * Erase what we drew and draw the new frame.
     *
     * Only OUR lines are erased — the count we last painted — so anything the
     * program wrote above the surface is untouched. A frame whose line count
     * shrinks still clears correctly because the erase happens before the
     * write, against the previous count rather than the new one.
     */
    function paint(): void {
        const text = view(r, state, frameGlyph())
        const lines = text.split("\n")

        if (painted > 0) {
            // Erase UPWARDS from the last line we wrote.
            //
            // The cursor sits one line below the frame (every paint ends with a
            // newline), so step up onto the last line, then clear-and-step-up
            // through the rest. Clearing downwards with a newline between lines
            // is what an earlier version did, and it moved the cursor down as
            // many lines as it erased — each repaint then started one line
            // lower than the last and left a blank row behind it.
            r.write(cursorUp(1) + COL_0)
            for (let i = 0; i < painted; i++) {
                r.write(CLEAR_LINE)
                if (i < painted - 1) r.write(cursorUp(1))
            }
            r.write(COL_0)
        }

        r.write(lines.join("\n") + "\n")
        painted = lines.length
    }

    // A non-interactive destination gets one frame at the end instead. Nothing
    // is painted while running, so `painted` stays 0 and the erase path above
    // is never entered.
    const interval = r.interactive
        ? setInterval(() => {
              if (stopped) return
              tick++
              paint()
          }, TICK_MS)
        : null

    if (r.interactive) {
        r.write(HIDE_CURSOR)
        paint()
    }

    return {
        get state() {
            return state
        },

        set(next) {
            state = next
            if (r.interactive && !stopped) paint()
        },

        update(fn) {
            state = fn(state)
            if (r.interactive && !stopped) paint()
        },

        abandon() {
            if (stopped) return
            stopped = true
            if (interval) clearInterval(interval)
            if (r.interactive) {
                // Erase our frame entirely — the caller owns the screen now.
                if (painted > 0) {
                    r.write(cursorUp(1) + COL_0)
                    for (let i = 0; i < painted; i++) {
                        r.write(CLEAR_LINE)
                        if (i < painted - 1) r.write(cursorUp(1))
                    }
                    r.write(COL_0)
                }
                r.write(SHOW_CURSOR)
                painted = 0
            }
        },

        stop(final) {
            if (stopped) return
            stopped = true
            if (interval) clearInterval(interval)
            if (final !== undefined) state = final

            if (r.interactive) {
                paint()
                r.write(SHOW_CURSOR)
            } else {
                // The one frame this destination ever sees.
                r.write(view(r, state, "") + "\n")
            }
        },
    }
}
