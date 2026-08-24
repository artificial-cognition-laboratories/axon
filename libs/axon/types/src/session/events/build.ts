import type { AxonError } from "../../error"
import type { AxonSpan } from "./span"

/**
 * BuildEventMap — everything that happens BEFORE a runtime exists.
 *
 * The `build:` namespace is the boundary marker. Every other family in
 * this registry (`axon:`, `kernel:`, `cognet:`, `capsule:`) is emitted BY
 * a running Axon; these are emitted while one is being made. Reading a
 * log, the first `axon:boot:start` is exactly where the build ended and
 * the runtime began — no other signal is needed to place that line.
 *
 * WHY THIS EXISTS. The build phase was the largest untraced path in the
 * system, and the one that fails most often while you are actively
 * changing things. A cognet ABI mismatch, an unresolvable module, a failed
 * `bun install` — all threw straight to the terminal and left nothing on
 * disk, because the session was opened by `Axon()` and `Axon()` had not
 * run yet. The debugger was blind precisely when it was needed most: the
 * agent that failed to boot produced no instance, no session, and no
 * trace of why.
 *
 * The fix is ordering, not a new artifact: the session opens first, the
 * build reports into it, and a failed build leaves a readable session
 * instead of nothing. Every existing surface — the Events pane, the flame
 * graph, Fleet's Sessions group — reads it unchanged, because it is the
 * same log with the same span convention.
 *
 * THREE STAGES, IN ORDER. `build:open` finds and opens the project;
 * `build:prepare` installs, compiles and reconciles it; `build:load` scans
 * it into a blueprint. They are siblings under `build` rather than one
 * flat sequence because each can fail on its own terms, and knowing WHICH
 * failed is most of the diagnosis.
 *
 * Durability: every event here is committed. There are no transient build
 * events — the phase is seconds long and low-volume, and its whole purpose
 * is to be readable after the fact.
 */

/** Which sub-stage of prepare a unit belongs to — the flame graph groups on it. */
export type BuildStage =
    | "framework"
    | "modules"
    | "cognet"
    | "tree"
    | "scan"
    | "typegen"

export type BuildEventMap =
    // ── The whole pre-runtime phase ─────────────────────────────────────────
    //    One span around everything below, so a reader sees the total cost of
    //    "getting to a runtime" without summing its parts.
    & AxonSpan<
        "build",
        { root: string; agent?: string },
        { root: string },
        { root: string; stage: BuildStage | "open" | "prepare" | "load"; error: AxonError }
    >

    // ── Stage 1: open ───────────────────────────────────────────────────────
    //    Find the project from a cwd and open it. Fails when there is no
    //    project at or above the path, or when it is the wrong kind.
    & AxonSpan<
        "build:open",
        { cwd: string },
        { root: string; kind: string; name: string }
    >

    // ── Stage 2: prepare ────────────────────────────────────────────────────
    //    Everything that makes the project runnable. The expensive stage —
    //    a cold `bun install` dominates it — and the one with the most ways
    //    to fail, which is why its interior is broken out below.
    & AxonSpan<"build:prepare", { root: string }, { warnings: number }>

    // ── Prepare's units ─────────────────────────────────────────────────────
    //    One span each, at the granularity where a failure is actionable:
    //    knowing the cognet's ABI gate rejected the build tells you what to
    //    fix, and knowing which line of it did would not.
    & AxonSpan<
        "build:framework",
        { version: string },
        { version: string; changed: boolean }
    >
    & AxonSpan<
        "build:modules",
        { specifiers: string[] },
        { installed: string[]; alreadyPresent: string[] }
    >
    & AxonSpan<
        "build:cognet",
        { specifier: string | null },
        { name: string; version: string; abi: string; compiled: boolean }
    >
    /** `bun install` in the project. Usually the slowest span in the phase. */
    & AxonSpan<
        "build:tree",
        { reason: "framework" | "modules" | "reconcile" },
        { durationMs: number }
    >
    & AxonSpan<"build:typegen", {}, { files: string[] }>

    // ── Stage 3: load ───────────────────────────────────────────────────────
    //    Scan the prepared project into a blueprint. The last thing before
    //    `Axon()`, and the point at which the agent's shape is known.
    & AxonSpan<
        "build:load",
        { root: string },
        { agent: string; tools: number; prompts: number; modules: number; warnings: number }
    >
    /**
     * One scanned domain — tools, prompts, routes, components, plugins,
     * middleware. Nested inside build:load, so the flame graph shows which
     * part of a slow scan is slow.
     */
    & AxonSpan<
        "build:scan",
        { domain: string },
        { domain: string; found: number },
        { domain: string; error: AxonError }
    >

    & {
        /**
         * A recoverable defect found during the build — a tool shadowed by
         * one of the same name, a component that will not resolve.
         *
         * Deliberately NOT a `:failed`: the build continues and produces a
         * working agent, but something the author declared is not in it.
         * These were previously committed as `axon:scan:warning` from
         * inside the runtime, which meant they arrived AFTER boot and only
         * for builds that got that far.
         */
        "build:warning": { domain: string; message: string; stage?: BuildStage }
    }

export type BuildEventName = keyof BuildEventMap

/** One build event as it travels the bus: { type } + payload, flat. */
export type AnyBuildEvent = {
    [K in BuildEventName]: { type: K } & BuildEventMap[K]
}[BuildEventName]

/**
 * True for anything emitted before the runtime existed.
 *
 * The one place a reader should decide "is this a build event" — the
 * prefix is the contract, and a consumer sniffing for individual names
 * breaks the moment a stage is added.
 */
export function isBuildEvent(type: string): boolean {
    return type === "build" || type.startsWith("build:")
}
