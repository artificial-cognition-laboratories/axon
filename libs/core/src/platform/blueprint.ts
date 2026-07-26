import { resolve } from "node:path"
import { err } from "@axon/err"
import type { AxonBlueprint as AxonBlueprintT, AxonPartialBlueprint } from "@arcforge/types"
import { defaultAxonConfig } from "./default"

/**
 * Normalizes a partial blueprint from the CLI into the strict AxonBlueprint
 * shape everything downstream trusts. This is the one seam where every field
 * gets a default — nothing past this point should ever check `?? fallback`
 * on a blueprint field. Agent identity (name/version/hash) defaults to an
 * unnamed dev identity when the CLI hasn't resolved one yet (e.g. tests,
 * ad-hoc `Axon()` calls) — it is not load-bearing for the runtime itself.
 */
export function AxonBlueprint(input?: AxonPartialBlueprint): AxonBlueprintT {
    const partial = input ?? {}

    // Hard invariant: an agent without a brain does not work. The CLI (or
    // test) must construct and pass the cognet definition — the runtime
    // ships none and never defaults one.
    if (!partial.cognet) {
        throw err("NO_COGNET")
    }

    // NO process-global session handle: a process may host several Axon()
    // runtimes at once, and any env var naming "the" session is clobbered
    // by whichever booted last. Error attribution flows through err()'s
    // AsyncLocalStorage scope (session.scope, established at the runtime's
    // entry points); a failed boot's thrown error carries its own
    // sessionId/sessionFile in context (see Axon.ts).
    const sessionId = partial.session?.id ?? crypto.randomUUID()

    const blueprint: AxonBlueprintT = {
        session: {
            id: sessionId,
        },

        agent: {
            name: partial.agent?.name ?? "unnamed-agent",
            version: partial.agent?.version ?? "0.0.0",
            hash: partial.agent?.hash ?? { type: "sha256", value: "" },
        },

        config: {
            ...defaultAxonConfig,
            ...partial.config,
        },

        env: partial.env ?? {},

        // the brain, constructed by the CLI (or a test) and carried in live.
        // REQUIRED: an agent without a brain is not an agent — checked below.
        cognet: partial.cognet,

        tools: partial.tools ?? [],
        prompts: partial.prompts ?? [],
        scripts: partial.scripts ?? [],

        server: {
            middleware: partial.server?.middleware ?? [],
            routes: partial.server?.routes ?? [],
            plugins: partial.server?.plugins ?? [],
        },

        modules: partial.modules ?? [],

        paths: {
            root: partial.paths?.root ?? process.cwd(),
            data: partial.paths?.data ?? "data",
        },
    }

    if (partial.boot !== undefined) blueprint.boot = partial.boot
    if (partial.bootFilePath !== undefined) blueprint.bootFilePath = partial.bootFilePath

    // AXON_HOME is the agent's data root, inherited by the capsule — the
    // agent's own private subprocess reads it to reach its data/ directory.
    // It survives the multi-instance model only because each capsule gets
    // its own env at spawn; nothing in THIS process should read it back to
    // locate a session (that's what error context / blueprint.paths are for).
    process.env.AXON_HOME = resolve(blueprint.paths.root, blueprint.paths.data)

    return blueprint
}

/**
 * Overlays an update onto the current blueprint and re-normalizes through
 * AxonBlueprint(), so an updated blueprint obeys the exact same contract as a
 * boot-time one. Session and agent IDENTITY always come from the current
 * blueprint — an update can never change who the agent is.
 *
 * Two update semantics, chosen by `mode`:
 *
 *   - "merge" (default) — a partial programmatic update. Fields absent from the
 *     partial keep their current value (`update({ config: { policy } })` changes
 *     only the policy, the engine set at boot survives).
 *
 *   - "replace" — a hot reload from the config file. The file IS the complete,
 *     authoritative declaration, so `config` (env/tools/etc.) is taken wholesale
 *     and a field the author DELETED (commenting out `policy`) actually
 *     disappears. Deep-merging a file reload silently kept a removed policy
 *     alive — a confined sandbox never relaxed until a full restart. Identity
 *     and runtime-owned paths still come from current.
 *
 * Normalization backfills defaults either way, so replace never leaves a
 * required field unset.
 */
export function mergeBlueprint(
    current: AxonBlueprintT,
    partial: AxonPartialBlueprint,
    mode: "merge" | "replace" = "merge",
): AxonBlueprintT {
    if (mode === "replace") {
        // Identity and runtime-owned fields never come from the config file, so
        // they survive a replace regardless of the partial: session/agent (who
        // the agent is), paths (where it lives), and cognet (the resolved brain,
        // bundled separately from axon.config.ts). Everything the file DOES own
        // — config, env, tools, prompts, scripts, modules, server — is taken
        // from the partial as-is, so a deleted field is genuinely gone.
        return AxonBlueprint({
            ...partial,
            session: current.session,
            agent: current.agent,
            paths: current.paths,
            cognet: partial.cognet ?? current.cognet,
        })
    }

    const merged: AxonPartialBlueprint = {
        session: current.session,
        agent: current.agent,
        config: { ...current.config, ...partial.config },
        env: partial.env ?? current.env,
        tools: partial.tools ?? current.tools,
        prompts: partial.prompts ?? current.prompts,
        scripts: partial.scripts ?? current.scripts,
        server: { ...current.server, ...partial.server },
        modules: partial.modules ?? current.modules,
        cognet: partial.cognet ?? current.cognet,
        paths: { ...current.paths, ...partial.paths },
    }

    const boot = partial.boot ?? current.boot
    if (boot !== undefined) merged.boot = boot

    const bootFilePath = partial.bootFilePath ?? current.bootFilePath
    if (bootFilePath !== undefined) merged.bootFilePath = bootFilePath

    return AxonBlueprint(merged)
}
