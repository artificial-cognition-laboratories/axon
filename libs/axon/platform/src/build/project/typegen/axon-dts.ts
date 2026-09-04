import { writeDts, type TypegenKind } from "./write"
import { H3_GLOBALS } from "../../blueprint/scan/h3-globals"

/**
 * `.agent/axon.d.ts` (config/src scope) and `.agent/axon-test.d.ts` (tests
 * scope) are two DELIBERATELY SEPARATE declaration files, never merged into
 * one ambient scope. Both declare a global named `Axon` — the engine
 * constructor (`Axon({ model })`, used in axon.config.ts) and the test
 * runtime spawner (`await Axon()`, used in tests/*.test.ts) are genuinely
 * different things with the same name in different runtimes. Declaring both
 * in one `declare global` block is a duplicate-identifier error that
 * degrades silently to `any` in some tooling — the actual bug this split
 * exists to prevent. tsconfig.ts gives tests/ its own nested tsconfig that
 * includes axon-test.d.ts INSTEAD of axon.d.ts, so only one `Axon` is ever
 * in scope for a given file.
 *
 * Declares exactly the globals that `inject.ts` puts on globalThis — nothing more.
 * The h3 block is GENERATED from `H3_GLOBALS`, the same list the scanners
 * install at runtime, so the declared surface and the installed surface cannot
 * drift. They previously did: this file declared ~25 helpers while routes.ts
 * installed 6, making `setHeader`/`sendStream`/`getCookie` typecheck and then
 * throw ReferenceError when the route actually ran. Nitro globals are
 * intentionally absent — Axon uses h3 directly, not Nitro.
 *
 * Tool namespace globals are generated separately into `.agent/tool-globals.d.ts`.
 * Prompt/script type overloads are generated into `.agent/prompts.d.ts` / `.agent/scripts.d.ts`.
 */

/**
 * Body shared by both scopes — everything except `Axon` itself. No
 * `declare global {`/`}` wrapper and no `export {}` here: each output file
 * below supplies its own so it can insert its own scope-specific `Axon`
 * declaration inside the same block.
 */
const SHARED_BODY = `\
    namespace NodeJS {
        // ── Axon-injected env vars ────────────────────────────────────────────
        interface ProcessEnv {
            /**
             * Absolute path to the agent's own directory — its PROJECT ROOT,
             * the folder holding axon.config.ts. Injected by the Axon runtime
             * into every capsule — always present, never undefined.
             *
             * Authored content sits directly under it; anything the runtime
             * generated or recorded is under \`.agent/\`:
             * \`\`\`ts
             * const knowledge = \`\${process.env.AXON_HOME}/data/knowledge\`
             * const state = \`\${process.env.AXON_HOME}/.agent/data/state\`
             * \`\`\`
             */
            AXON_HOME: string
        }

        // ── process.run() / process.spawn() ──────────────────────────────────
        // The capsule extends the global process object with two safe execution APIs.
        // process.exit() is blocked — the capsule manages its own lifecycle.
        interface Process {
            /**
             * Run a shell command and wait for it to complete. Never throws — errors are
             * returned in the result object.
             *
             * \`\`\`ts
             * const { ok, stdout, stderr } = await process.run("git status")
             * if (!ok) console.error(stderr)
             * \`\`\`
             *
             * @see https://axon.arclabs.it/docs/v2/api/proc/run
             */
            run(
                command: string,
                opts?: { cwd?: string; env?: Record<string, string>; input?: string }
            ): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string; err?: string }>

            /**
             * Spawn a long-running process. Returns a handle immediately — the process
             * runs in the background and is visible in the agent's process list.
             *
             * \`\`\`ts
             * const server = process.spawn("bun dev")
             * await server.waitFor("ready", { timeoutMs: 10_000 })
             * const logs = server.stdout()
             * server.kill()
             * \`\`\`
             *
             * @see https://axon.arclabs.it/docs/v2/api/proc/spawn
             */
            spawn(
                command: string,
                opts?: { cwd?: string; env?: Record<string, string> }
            ): LiveProcHandle
        }
    }

    // ── Axon runtime globals ──────────────────────────────────────────────

    /**
     * The live Axon runtime handle. Available as a global in tools, scripts,
     * hooks, and server routes — no import needed.
     *
     * Everything the agent can do is accessed through this object: sending
     * requests, calling tools, running scripts, and reacting to lifecycle
     * events.
     *
     * **One-shot request** — waits for the full cognitive loop to complete:
     * \`\`\`ts
     * const result = await axon.request("summarise the project")
     * console.log(result.text)
     * \`\`\`
     *
     * **Streaming** — receive entries as they are produced:
     * \`\`\`ts
     * const { stream } = axon.stream("explain the build system")
     * for await (const entry of stream) {
     *     if (entry.type === "engine:text") {
     *         process.stdout.write(entry.content)
     *     }
     * }
     * \`\`\`
     *
     * **One continuous conversation** — there is no thread/branch concept.
     * One Axon() instance is always exactly one continuous stream, so
     * sequential calls share context automatically:
     * \`\`\`ts
     * await axon.request("hello")
     * await axon.request("what did I just say?")
     * await axon.request("now summarise our conversation")
     * \`\`\`
     *
     * An isolated side task (that should not share context with the main
     * conversation) runs as its own Axon() instance — a host-level (TUI/CLI)
     * concern, not something this handle exposes.
     *
     * @see https://axon.arclabs.it/docs/v2/api
     * @see https://axon.arclabs.it/docs/v2/api/stream
     */
    const axon: AxonHandle

    /**
     * UI bridge. Post notifications, prompts, and content injections to the
     * connected TUI client. All methods are fire-and-forget in headless mode —
     * they never throw if no client is connected.
     *
     * @see https://axon.arclabs.it/docs/v2/api/ui
     */
    const ui: UiHandle

    /**
     * Named arguments passed to the current script invocation.
     * Typed via \`defineArgs()\` — use that for full type safety.
     *
     * \`\`\`ts
     * const { date } = defineArgs<{ date: string }>()
     * \`\`\`
     *
     * @see https://axon.arclabs.it/docs/v2/api/scripts
     */
    const args: Record<string, string>

    // ── Agent / module authoring ──────────────────────────────────────────

    /**
     * Define this agent's configuration.
     * Used as the default export in \`axon.config.ts\`.
     *
     * @see https://axon.arclabs.it/docs/v2/agent/config
     */
    const defineAgent: typeof import("@arcforge/types").defineAgent

    /**
     * Define a reusable module. Used as the default export in \`module.config.ts\`.
     *
     * @see https://axon.arclabs.it/docs/v2/modules/config
     */
    const defineModule: typeof import("@arcforge/types").defineModule

    /**
     * Declare the expected argument shape for this script. Stripped at runtime —
     * type-only. Returns the args object cast to your type.
     *
     * \`\`\`ts
     * const { userId, limit } = defineArgs<{ userId: string; limit?: number }>()
     * \`\`\`
     *
     * @see https://axon.arclabs.it/docs/v2/api/scripts
     */
    function defineArgs<T extends Record<string, unknown>>(): T

    /**
     * Declare the expected prop shape for this prompt template. Stripped at
     * runtime — type-only. Used in \`src/prompts/\` files.
     *
     * @see https://axon.arclabs.it/docs/v2/api/prompt
     */
    function defineProps<T extends Record<string, unknown>>(): void

    // ── Server plugin registration ────────────────────────────────────────

    /**
     * Register a server plugin. Extend the agent's HTTP/WebSocket server with
     * custom routes and handlers.
     *
     * @see https://axon.arclabs.it/docs/v2/agent/server
     */
    const defineAxonPlugin: typeof import("@arcforge/types").defineAxonPlugin

    /**
     * Register server middleware. Runs on every request, before any route,
     * in filename order. Return nothing to continue; return a value to end
     * the request with it; throw createError(...) to reject.
     *
     * @see https://axon.arclabs.it/docs/v2/agent/server
     */
    const defineMiddleware: typeof import("@arcforge/types").defineMiddleware

    // ── H3 auto-imports (generated from H3_GLOBALS) ───────────────────────
${H3_GLOBALS.map(name => `    const ${name}: typeof import("h3").${name}`).join("\n")}
`

const HEADER = `\
// generated by axon prepare — do not edit
// Re-run \`axon prepare\` after upgrading the axon framework.
import type { AxonHandle, UiHandle, LiveProcHandle } from "@arcforge/types"

declare global {
`

/**
 * axon.d.ts — config/src scope. Provider factories are values you call in
 * axon.config.ts (`providers: [Axon()]`) — genuinely different from the test
 * harness in axon-test.d.ts, despite the shared name.
 */
export const CONFIG_DTS = HEADER + SHARED_BODY + `
    // ── Provider factories ────────────────────────────────────────────────

    /**
     * Inference sources are declared as a POOL, not as one engine.
     *
     * Most agents declare NOTHING here. A user's providers live on their
     * profile and every agent inherits them, which is what makes installing
     * an agent a download rather than a setup:
     *
     * \`\`\`ts
     * // profile.config.ts — the inference you HAVE
     * export default defineProfile({ providers: [Axon(), Codex()] })
     *
     * // axon.config.ts — usually nothing at all
     * export default defineAgent({})
     * \`\`\`
     *
     * An agent declares \`providers:\` only for a source its user would not
     * otherwise have — a self-hosted endpoint it ships against, a local
     * daemon it assumes. The agent's entries are APPENDED to the profile's,
     * never substituted for them: an installed agent can add a source, but it
     * can never take one away from the person running it.
     *
     * To express a model PREFERENCE, use \`model:\` — a string, not a
     * factory call:
     *
     * \`\`\`ts
     * export default defineAgent({ model: "codex:gpt-5.6-terra" })
     * \`\`\`
     *
     * It is a preference and never a constraint: resolution tries the pin,
     * then falls back to ordinary ranking, so a published agent stays
     * runnable by someone whose providers cannot supply it.
     */

    /**
     * Axon Cloud inference — the managed route. Needs no connection beyond
     * being signed in, and supplies the full catalogue.
     *
     * \`\`\`ts
     * export default defineAgent({ providers: [Axon()] })
     * \`\`\`
     */
    const Axon: typeof import("@arcforge/engines").Axon

    /** Local inference on this machine, managed by Axond. It is implicit; declare it only to override options. */
    const Local: typeof import("@arcforge/engines").Local

    /** Local inference on this machine, managed by Axond. It is implicit; declare it only to override options. */
    const Local: typeof import("@arcforge/engines").Local

    /**
     * Ollama local inference.
     *
     * \`\`\`ts
     * export default defineAgent({ providers: [Ollama({ url: "http://box.local:11434" })] })
     * \`\`\`
     */
    const Ollama: typeof import("@arcforge/engines").Ollama

    /**
     * OpenAI Codex / GPT inference.
     *
     * \`\`\`ts
     * export default defineAgent({ providers: [Codex()] })
     * \`\`\`
     */
    const Codex: typeof import("@arcforge/engines").Codex

    /**
     * OpenRouter inference. Routes to any provider.
     *
     * \`\`\`ts
     * export default defineAgent({ providers: [OpenRouter()] })
     * \`\`\`
     */
    const OpenRouter: typeof import("@arcforge/engines").OpenRouter

    /**
     * HuggingFace inference.
     *
     * \`\`\`ts
     * export default defineAgent({ providers: [HuggingFace()] })
     * \`\`\`
     */
    const HuggingFace: typeof import("@arcforge/engines").HuggingFace

    /**
     * Mock inference — answers from a fixed or handler-driven script, no
     * network and no API key. A provider like any other, so an agent that
     * declares it resolves every role against it.
     *
     * \`\`\`ts
     * export default defineAgent({ providers: [Mock({ hello: "hi there" })] })
     * \`\`\`
     */
    const Mock: typeof import("@arcforge/engines").Mock
}

export {}
`

/**
 * axon-test.d.ts — tests/ scope only. \`Axon()\` here is the test runtime
 * spawner (@arcforge/types' AxonTest), NOT the engine constructor above — the
 * two are declared in separate files/tsconfigs specifically so they never
 * collide in one ambient scope (see the file-level doc comment).
 */
export const TEST_DTS = HEADER + SHARED_BODY + `
    // ── Test runtime ──────────────────────────────────────────────────────

    /**
     * Boot a full Axon runtime for integration testing. Global — no import needed.
     *
     * \`\`\`ts
     * const { axon, stop } = await Axon()
     * const result = await axon.request("hello")
     * await stop()
     * \`\`\`
     *
     * @see https://axon.arclabs.it/docs/v2/agent/testing
     */
    const Axon: import("@arcforge/types").AxonTest
}

export {}
`

/** @deprecated Use CONFIG_DTS — kept so any external import of the old name doesn't hard-crash; identical content. */
export const AXON_DTS = CONFIG_DTS

/** Write .agent/axon.d.ts (config/src scope) and .agent/axon-test.d.ts (tests/ scope). */
export function generateAxonDts(root: string, kind: TypegenKind = "agent"): void {
    writeDts(root, "axon.d.ts", CONFIG_DTS, kind)
    writeDts(root, "axon-test.d.ts", TEST_DTS, kind)
}
