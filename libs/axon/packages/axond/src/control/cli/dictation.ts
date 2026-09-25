import { err } from "@arcforge/err"
import { status } from "@arcforge/arcline"
import type { CliContext } from "./types"

/** DictationCommands owns the dictation command surface. */
export function DictationCommands(opts: CliContext) {
    const r = opts.renderer

    return {

        /**
         * `dictate [start|stop|toggle|cancel|status]` — the verb a KEYBIND runs.
         *
         * Always reaches the running daemon and never falls back to an
         * in-process one, unlike every other verb here. That is the whole
         * point: a recording spans two keypresses, and the compositor launches
         * each as its own short-lived process. An in-process daemon would open
         * a microphone and take it to the grave microseconds later.
         *
         * Default is `toggle`, so the simplest possible Hyprland line —
         * `bind = SUPER ALT, D, exec, axon daemon dictate` — is a working
         * push-to-talk. Hold mode binds `start` to the press and `stop` to the
         * release instead.
         */
        async dictate(verb = "toggle", json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            if (!live.running) {
                throw err("DAEMON_NOT_RUNNING", {
                    detail: "dictation needs the resident daemon — a recording spans two keypresses, "
                        + "so nothing short-lived can hold the microphone. Start it with `axon daemon up`.",
                })
            }
            const dictation = opts.client.dictation

            if (verb === "status") {
                const state = await dictation.state()
                if (json) return JSON.stringify(state)
                if (state.blocked) return status(r, "warn", "dictation", state.blocked)
                return status(r, "info", "dictation",
                    (state.recording ? "recording" : "idle") + " · " + (state.model ?? "no model"))
            }

            if (verb === "start") {
                const state = await dictation.start()
                if (json) return JSON.stringify(state)
                return status(r, "ok", "recording", state.model ?? "")
            }

            if (verb === "cancel") {
                await dictation.cancel()
                if (json) return JSON.stringify({ recording: false, cancelled: true })
                return status(r, "ok", "cancelled", "")
            }

            if (verb === "stop") {
                const done = await dictation.stop()
                if (json) return JSON.stringify(done)
                return status(r, "ok", "typed", done.text || "(nothing was said)")
            }

            if (verb === "bind") {
                const result = await dictation.bind()
                if (json) return JSON.stringify(result)
                return result.bound
                    ? status(r, "ok", "bound", `${result.chord} (${result.mode})`)
                    : status(r, "info", "not bound", "no shortcut is set")
            }

            if (verb === "unbind") {
                await dictation.unbind()
                if (json) return JSON.stringify({ bound: false })
                return status(r, "ok", "unbound", "")
            }

            if (verb === "toggle") {
                const result = await dictation.toggle()
                if (json) return JSON.stringify(result)
                if (result.recording) return status(r, "ok", "recording", "")
                return status(r, "ok", "typed", result.dictated?.text || "(nothing was said)")
            }

            throw err("DAEMON_SETTING_INVALID", {
                detail: `dictate takes start, stop, toggle, cancel, status, bind or unbind — got ${verb}`,
                context: { key: "dictate" },
            })
        },
    }
}

export type DictationCommandsT = ReturnType<typeof DictationCommands>
