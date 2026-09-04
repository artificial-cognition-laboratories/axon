import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { err } from "@arcforge/err"

export type PreferencesOpts = {
    /** Where the file lives. Defaults beside the other daemon state. */
    path?: string
}

/**
 * The daemon's named preferences — one file, one shape.
 *
 * ── Why not a leaf per setting ──────────────────────────────────────────────
 *
 * `Budget` is its own module because a VRAM ceiling is a domain concept with
 * validation, a unit and a meaning to the admission check. A boolean is not.
 * Giving the second one its own file, its own path and its own `current()`
 * would have started a ladder where every preference costs a module, and the
 * third and fourth would have been written by copying the second.
 *
 * So flags live here together. Anything that needs interpreting rather than
 * storing still earns its own noun — the test is whether the daemon does
 * something with the VALUE beyond reading it back.
 *
 * ── Why a fallback is passed in, not stored ─────────────────────────────────
 *
 * A default recorded in this file would be a second place the answer lives,
 * and the two would drift. The caller owns what "unset" means, because the
 * caller is the only one that knows.
 */
export function Preferences(opts: PreferencesOpts = {}) {
    const path = opts.path ?? join(homedir(), ".axon", "preferences.json")

    function read(): Record<string, unknown> {
        if (!existsSync(path)) return {}
        try {
            const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown
            return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
        } catch {
            // A corrupt file is not a preference. Every caller supplies a
            // default, so falling back to it is defined behaviour rather than
            // a guess — and refusing to boot over a malformed flag would be
            // the wrong trade for something nobody edits by hand.
            return {}
        }
    }

    return {
        /** Where the flags are written. Diagnostics. */
        get path(): string {
            return path
        },

        /** Every flag currently set. */
        all(): Record<string, unknown> {
            return read()
        },

        /** One flag, or `fallback` when it has never been set. */
        flag(key: string, fallback: boolean): boolean {
            const value = read()[key]
            return typeof value === "boolean" ? value : fallback
        },

        /**
         * One string preference, or `fallback` when it has never been set.
         *
         * Beside `flag` rather than replacing it, because the two answer
         * different questions and a caller that wants a boolean must not be
         * handed `"false"`. Dictation is what needed this: a hotkey, a
         * capture mode and an engine name are all choices with more than two
         * values, and every one of them would otherwise have become a leaf
         * module — the ladder this file's own comment exists to refuse.
         */
        text(key: string, fallback: string): string {
            const value = read()[key]
            return typeof value === "string" ? value : fallback
        },

        /**
         * Declare one. Writes the whole file, because it is a handful of keys.
         *
         * ONE object in, because this crosses the socket — dispatch carries a
         * single argument, so a second positional parameter would arrive
         * `undefined` and every set would be rejected as a non-boolean.
         */
        set(input: { key: string; value: boolean | string }): boolean | string {
            const { key, value } = input
            if (typeof value !== "boolean" && typeof value !== "string") {
                throw err("DAEMON_SETTING_INVALID", {
                    detail: `${key} takes true, false or a string — got ${String(value)}`,
                    context: { key: key },
                })
            }
            const next = { ...read(), [key]: value }
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, JSON.stringify(next, null, 4) + "\n", "utf-8")
            return value
        },
    }
}

export type PreferencesT = ReturnType<typeof Preferences>
