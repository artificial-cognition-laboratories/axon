import { status } from "@arcforge/arcline"
import type { CliContext } from "./types"

/** PreferenceCommands owns the preferences command surface. */
export function PreferenceCommands(opts: CliContext) {
    const r = opts.renderer

    return {

        /**
         * Any named preference, read or written — `preference <key> [value]`.
         *
         * `autoload` above is a verb of its own because it takes on/off rather
         * than a raw value and is documented in the help. Dictation adds a
         * hotkey, a capture mode and an engine name, and giving each of those
         * its own verb here — plus its own line in the CLI group, plus its own
         * setter in the panel — is the ladder `Preferences` was written to
         * refuse. One generic verb, and the panel names the key.
         *
         * ONE object in: this crosses the socket, where dispatch carries a
         * single argument, so a second positional would arrive `undefined`.
         */
        async preference(input: { key: string; value?: string }, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const prefs = live.running ? opts.client.preferences : opts.axond.preferences
            const key = input.key

            if (input.value === undefined) {
                const all = await prefs.all()
                const current = all[key]
                if (json) return JSON.stringify({ key: key, value: current ?? null })
                return status(r, "info", key, current === undefined ? "unset" : String(current))
            }

            // "true"/"false" become booleans so a switch written through this
            // verb reads back as one — `flag()` must never see the string.
            const value: string | boolean = input.value === "true" ? true
                : input.value === "false" ? false
                : input.value
            const set = await prefs.set({ key: key, value: value })
            if (json) return JSON.stringify({ key: key, value: set })
            return status(r, "ok", key, String(set))
        },
    }
}

export type PreferenceCommandsT = ReturnType<typeof PreferenceCommands>
