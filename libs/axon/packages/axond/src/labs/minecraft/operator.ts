import { randomBytes } from "node:crypto"
import type { LabAction, LabActionResult, MinecraftAction, MinecraftPlayer, ScenarioProgress } from "../types"
import type { WorldsT } from "./worlds"

type Conditions = { time: number; weather: "clear" | "rain" | "thunder"; difficulty: "peaceful" | "easy" | "normal" | "hard" }
type Binding = { world: string; port: number; token: string }

/** What the operator can change in a running world — the one list of it. */
export const CONTROLS = ["world.time", "world.weather", "world.difficulty", "player.teleport", "player.gamemode"] as const satisfies readonly MinecraftAction["kind"][]

/** Whether `action` is one the operator carries out. */
export function controls(action: LabAction): action is MinecraftAction {
    return (CONTROLS as readonly string[]).includes(action.kind)
}

/** The daemon's authenticated connection to the AxonM server-side operator. */
export function Operator(opts: { worlds: WorldsT }) {
    let current: Binding | null = null

    async function request(path: string, body?: unknown): Promise<Record<string, unknown>> {
        const binding = current
        if (!binding) throw new Error("Minecraft operator is not bound to a running world")
        const response = await fetch(`http://127.0.0.1:${binding.port}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { authorization: `Bearer ${binding.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(11_000),
        })
        const answer: unknown = await response.json()
        if (typeof answer !== "object" || answer === null || Array.isArray(answer)) throw new Error("AxonM operator returned a malformed response")
        const record = answer as Record<string, unknown>
        if (!response.ok || record.ok === false) throw new Error(typeof record.error === "string" ? record.error : `AxonM operator returned HTTP ${response.status}`)
        return record
    }

    return {
        bind(world: string, serverPort: number): Record<string, string> {
            const port = serverPort + 10_000
            if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid Minecraft operator port derived from ${serverPort}`)
            current = { world: world, port: port, token: randomBytes(32).toString("hex") }
            return { AXONM_LAB_WORLD: world, AXONM_LAB_PORT: String(port), AXONM_LAB_TOKEN: current.token }
        },
        clear(): void { current = null },
        /** The scenario this server runs begins for `player`, who must be in the world. */
        async begin(player: string): Promise<void> {
            const binding = current
            if (!binding) throw new Error("Minecraft operator is not bound to a running world")
            await request("/run", { world: binding.world, kind: "begin", player: player })
        },
        async state(): Promise<{ conditions: Conditions; players: MinecraftPlayer[]; run: ScenarioProgress | null }> {
            const answer = await request("/state")
            if (answer.ready !== true || typeof answer.time !== "number" || !Number.isInteger(answer.time) || answer.time < 0 || answer.time >= 24_000
                || !["clear", "rain", "thunder"].includes(String(answer.weather))
                || !["peaceful", "easy", "normal", "hard"].includes(String(answer.difficulty))) {
                throw new Error("AxonM operator returned invalid world conditions")
            }
            if (!Array.isArray(answer.players)) throw new Error("AxonM operator returned no player state")
            const players: MinecraftPlayer[] = answer.players.map((item: unknown, index: number) => {
                if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`Malformed AxonM player ${index}`)
                const row = item as Record<string, unknown>
                if (typeof row.name !== "string" || ![row.x, row.y, row.z, row.health, row.food].every(value => typeof value === "number" && Number.isFinite(value))
                    || !["survival", "creative", "adventure", "spectator"].includes(String(row.gamemode))) {
                    throw new Error(`Malformed AxonM player ${index}`)
                }
                return { name: row.name, x: row.x as number, y: row.y as number, z: row.z as number, health: row.health as number, food: row.food as number, gamemode: row.gamemode as MinecraftPlayer["gamemode"] }
            })
            return { conditions: { time: answer.time, weather: answer.weather as Conditions["weather"], difficulty: answer.difficulty as Conditions["difficulty"] }, players: players, run: answer.run === undefined ? null : progress(answer.run) }
        },
        async act(action: LabAction): Promise<LabActionResult> {
            if (!controls(action)) throw new Error(`Minecraft does not support ${action.kind}`)
            if (action.world !== current?.world) throw new Error(`Requested ${action.world}; running world is ${current?.world ?? "none"}`)
            const answer = await request("/action", action)
            if (answer.ok !== true || typeof answer.result !== "string") throw new Error("AxonM operator did not acknowledge the action")
            if (action.kind === "world.difficulty") {
                try {
                    await opts.worlds.setDifficulty({ name: action.world, difficulty: action.value })
                } catch (cause) {
                    throw new Error(`Minecraft changed difficulty, but could not save it for the next start: ${cause instanceof Error ? cause.message : String(cause)}`, { cause: cause })
                }
            }
            return { at: Date.now(), world: action.world, action: action, result: answer.result }
        },
    }
}

export type OperatorT = ReturnType<typeof Operator>

/** A scenario's progress as the server half reported it, checked field by field. */
function progress(value: unknown): ScenarioProgress {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("AxonM operator returned a malformed run")
    const run = value as Record<string, unknown>
    if (typeof run.scenario !== "string" || !["waiting", "running", "ended"].includes(String(run.phase)) || typeof run.seconds !== "number"
        || (run.subject !== undefined && typeof run.subject !== "string") || !Array.isArray(run.events)) {
        throw new Error("AxonM operator returned a malformed run")
    }
    const events = run.events.map((item: unknown, index: number) => {
        const event = item as Record<string, unknown>
        if (typeof event !== "object" || event === null || !["began", "died", "ended"].includes(String(event.kind))
            || typeof event.at !== "number" || typeof event.tick !== "number" || typeof event.detail !== "string") {
            throw new Error(`AxonM operator returned a malformed run event ${index}`)
        }
        return { kind: event.kind as ScenarioProgress["events"][number]["kind"], at: event.at, tick: event.tick, detail: event.detail }
    })
    return { scenario: run.scenario, phase: run.phase as ScenarioProgress["phase"], seconds: run.seconds, ...(run.subject === undefined ? {} : { subject: run.subject as string }), events: events }
}
