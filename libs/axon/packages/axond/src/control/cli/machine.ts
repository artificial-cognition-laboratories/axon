import { header, rows, status } from "@arcforge/arcline"
import type { CliContext } from "./types"

/** MachineCommands owns the machine command surface. */
export function MachineCommands(opts: CliContext) {
    const r = opts.renderer
    const { size, bytes, bytesFrom } = opts.format

    return {

        /**
         * Read or declare the video-memory ceiling.
         *
         * `null` clears it and lets the measured hardware be the limit; zero is
         * a real declaration meaning nothing may load. Accepts bytes, or the
         * human forms a person actually types — a control that made someone
         * work out how many bytes are in twelve gigabytes would not be used.
         */
        budget(value?: string, json = false): string {
            if (value !== undefined) {
                opts.axond.machine.budget.set(value === "clear" ? null : bytesFrom(value))
            }

            const declared = opts.axond.machine.budget.current()
            const capacity = opts.axond.machine.hardware.current().vram
            if (json) return JSON.stringify({ budget: declared, vram: capacity })

            return declared === null
                ? status(r, "info", "no budget declared", capacity === null
                    ? "video memory is unmeasurable on this machine, so nothing bounds a load"
                    : `the card's ${size(capacity)} is the ceiling`)
                : status(r, "ok", `budget ${size(declared)}`, capacity === null ? "" : `of ${size(capacity)} installed`)
        },

        /**
         * What the daemon sees of this machine.
         *
         * Read from the LOCAL handle rather than over the socket: `axond` may
         * be run when no daemon is listening, and "what does this box have"
         * is answerable either way. A figure that needed a running daemon to
         * report the hardware would be an odd thing to refuse.
         */
        machine(json = false): string {
            const state = opts.axond.machine.state()
            if (json) return JSON.stringify(state)
            const vram = state.capacity.vram

            return [
                header(r, { title: state.identity.hostname, subtitle: state.identity.id ?? "unidentified" }),
                "",
                ...rows(r, [
                    { label: "platform", value: `${state.identity.platform}/${state.identity.arch}`, arrow: false },
                    { label: "cores", value: String(state.capacity.cores), arrow: false },
                    { label: "memory", value: `${bytes(state.usage.ramAvailable)} free of ${bytes(state.capacity.ram)}`, arrow: false },
                    { label: "gpu", value: state.capacity.gpu ?? "none detected", arrow: false },
                    {
                        label: "vram",
                        // Unmeasured is a real answer, and a different one from
                        // "zero" — a machine we cannot probe has no known
                        // ceiling rather than no memory.
                        value: vram === null
                            ? "unmeasured"
                            : `${bytes(state.usage.vramUsed ?? state.held)} used of ${bytes(vram)}`,
                        arrow: false,
                    },
                    { label: "load", value: state.usage.load.toFixed(2), arrow: false },
                    { label: "held", value: `${bytes(state.held)} across ${state.holds.length} ${state.holds.length === 1 ? "hold" : "holds"}`, arrow: false },
                ]),
            ].join("\n")
        },

        /**
         * Every agent running on this machine.
         *
         * Read from the LOCAL handle for the same reason `machine` is: the
         * registry is files on disk, so "what is running" is answerable
         * whether or not a daemon happens to be listening. That is the
         * degraded path working, not a shortcut around the socket.
         */
        agents(json = false): string {
            const running = opts.axond.agents.list()
            if (json) return JSON.stringify({ agents: running })
            if (running.length === 0) return status(r, "info", "no agents running on this machine")

            return [
                header(r, { title: "agents", subtitle: `${running.length} running` }),
                "",
                ...rows(r, running.map(agent => ({
                    label: agent.agentName,
                    value: `${agent.sessionId.slice(0, 8)}  pid ${agent.pid}`,
                    arrow: false,
                }))),
            ].join("\n")
        },

        /**
         * Stop one running agent.
         *
         * The daemon holds the registry and the process, so this reaches it
         * rather than acting locally — a one-shot process has no handle on
         * something another process started.
         */
        async stopAgent(sessionId: string, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const stopped = live.running
                ? await opts.client.agents.stop(sessionId)
                : await opts.axond.agents.stop(sessionId)
            if (json) return JSON.stringify({ stopped: stopped, sessionId })
            return stopped
                ? status(r, "ok", "stopped", sessionId)
                : status(r, "info", "was not running", sessionId)
        },
    }
}

export type MachineCommandsT = ReturnType<typeof MachineCommands>
