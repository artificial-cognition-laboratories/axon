import { spawnSync } from "node:child_process"
import { err } from "@arcforge/err"

export type KeybindOpts = {
    /**
     * Builds the shell line a keypress runs, given the dictate verb.
     *
     * A builder rather than a string because the command needs the CLI
     * resolved AND `PATH` exported for its interpreter — the compositor's
     * environment supplies neither, and assembling that here would be a
     * fourth copy of a fix this codebase has already got wrong four ways.
     * `desktopCommand()` owns it.
     */
    command: (verb: string) => string
    /** Injectable, so a test never talks to a compositor. */
    run?: (argv: string[]) => { status: number | null; stdout: string; stderr: string }
}

/**
 * The chord, registered with the compositor.
 *
 * ── Why nothing is written to a config file ─────────────────────────────────
 *
 * The obvious implementation edits `~/.config/hypr/bindings.lua`. It is also
 * the wrong one: that file is hand-maintained, it is where someone's own
 * bindings live, and a plugin that rewrites it owns a merge problem forever —
 * plus an uninstall that leaves a keybind behind pointing at a binary that is
 * gone.
 *
 * `hyprctl eval` registers a binding on the LIVE compositor instead. Nothing
 * on disk changes, nothing needs cleaning up, and the binding vanishes with
 * the session. The daemon re-applies it at every start, which is what makes
 * that survivable — and the daemon starting at login is already how this
 * product expects to run.
 *
 * ── Lua, not `hyprctl keyword` ──────────────────────────────────────────────
 *
 * Hyprland 0.56 answers `hyprctl keyword bind` with "keyword can't work with
 * non-legacy parsers. Use eval." The config is Lua now, so a binding is a
 * `hl.bind` call and the chord is spelled with spaces around the plus, which
 * is how Omarchy's own bindings are written.
 */
export function Keybind(opts: KeybindOpts) {
    const run = opts.run ?? ((argv: string[]) => {
        const [command, ...args] = argv
        const probed = spawnSync(command!, args, { encoding: "utf-8" })
        return {
            status: probed.status,
            stdout: String(probed.stdout ?? ""),
            stderr: String(probed.stderr ?? ""),
        }
    })

    /** Hyprland spells a chord with spaces around the plus; the panel stores it without. */
    function spelled(chord: string): string {
        return chord.split("+").map(part => part.trim()).filter(part => part !== "").join(" + ")
    }

    /** A Lua string literal. The chord is ours, but the command carries a path. */
    function quoted(text: string): string {
        return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
    }

    function evaluate(lua: string): void {
        const result = run(["hyprctl", "eval", lua])
        // Hyprland answers "ok" on success and prints a Lua error otherwise,
        // with an exit code of 0 either way — so the OUTPUT is the only signal
        // there is, and trusting the status would report every failure as a
        // success.
        const output = `${result.stdout}${result.stderr}`.trim()
        if (result.status !== 0 || output.toLowerCase().startsWith("error")) {
            throw err("DICTATION_BIND_FAILED", {
                detail: `hyprctl refused the binding: ${output || "no output"}`,
                context: { lua: lua },
            })
        }
    }

    return {
        /** True when there is a compositor here to bind against. */
        get available(): boolean {
            return Bun.which("hyprctl") !== null
        },

        /**
         * Make `chord` run dictation, in the given mode.
         *
         * Toggle is one binding onto `dictate` — press once to start, once to
         * stop. Hold is TWO: the press starts and the release stops, which is
         * only expressible because the daemon holds the recording between two
         * separate processes.
         *
         * Any previous binding on the same chord is removed first, so changing
         * the mode does not leave the old shape behind — two bindings on one
         * chord would start a recording and immediately stop it.
         */
        apply(input: { chord: string; mode: string }): void {
            if (!this.available) {
                throw err("DICTATION_BIND_FAILED", {
                    detail: "hyprctl is not available — this machine is not running Hyprland",
                })
            }

            const chord = spelled(input.chord)
            if (chord === "") return
            this.clear(input.chord)

            const line = opts.command

            if (input.mode === "toggle") {
                evaluate(`hl.bind(${quoted(chord)}, hl.dsp.exec_cmd(${quoted(line("toggle"))}), `
                    + `{ description = "Axon dictation" })`)
                return
            }

            // Two bindings, which is only expressible because the daemon holds
            // the recording between two separate processes.
            evaluate(`hl.bind(${quoted(chord)}, hl.dsp.exec_cmd(${quoted(line("start"))}), `
                + `{ description = "Axon dictation (hold)" })`)
            evaluate(`hl.bind(${quoted(chord)}, hl.dsp.exec_cmd(${quoted(line("stop"))}), `
                + `{ description = "Axon dictation (release)", release = true })`)
        },

        /** Remove whatever is bound to this chord. Safe when nothing is. */
        clear(chord: string): void {
            if (!this.available) return
            const spell = spelled(chord)
            if (spell === "") return
            // Unbinding something that was never bound is not an error worth
            // reporting — it is the normal state on the first apply.
            try {
                evaluate(`hl.unbind(${quoted(spell)})`)
            } catch { /* nothing was bound */ }
        },
    }
}

export type KeybindT = ReturnType<typeof Keybind>
