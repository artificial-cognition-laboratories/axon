import { materializeTool } from "@arcforge/capsule/materialize"
import { err } from "@arcforge/err"
import type { AxonTool } from "@arcforge/types"
import { mediate, type MediateOpts } from "./mediate"

/** One tool module once loaded: its namespace and the mediated functions it exports. */
export type LoadedTool = {
    namespace: string
    values: Record<string, unknown>
}

/**
 * Where a tool's code comes from.
 *
 * `source` is bundled text (what a project scan produces, imports inlined);
 * `entryPath` is a real file on disk (programmatic blueprints that never went
 * through the bundler). Bundled source wins when both are present.
 *
 * ACROSS THE OLD BOUNDARY, source was the point: the capsule materialized it
 * INSIDE the sandbox so no tool file — and none of the project around it — was
 * ever mounted into the box, which is what kept the sandbox filesystem exactly
 * what the fs policy declared. In-process that reason is gone; the tool's own
 * file is part of the agent, so it can simply be imported. Materializing is
 * kept only because bundled source has no path to import.
 *
 * WHERE it materializes is `@arcforge/capsule/materialize` — shared with the
 * capsule's own loader so the two cannot drift, and rooted in the agent's own
 * frame rather than the OS temp directory. See that module for why: the agent
 * process gets an environment built from nothing, `TMPDIR` is not on the
 * pass-through list, and the resulting host/agent disagreement stopped agents
 * booting on macOS entirely.
 */
/**
 * Load one tool and mediate everything it exports.
 *
 * ── Failure is LOUD, and that is the substantive change ─────────────────────
 *
 * The capsule's loader caught every failure, emitted `process:tool:load:failed`
 * and returned normally; the host's `build/tools.ts` listened for that event
 * and rejected the build. Two halves of one decision, joined only by an event
 * name crossing a wire — nothing in the type system connected them, and the
 * catch read as correct defensive code in isolation.
 *
 * In-process there is no wire to carry the event, so that catch would become a
 * silent swallow: a tool that failed to load would leave the agent running
 * with a namespace the model has been told it can call. This throws instead.
 * A capsule missing scope the agent was promised is invalid state, not a
 * warning — which is exactly what the host half already believed.
 */
export async function loadTool(tool: AxonTool, mediation: MediateOpts, scratch: string): Promise<LoadedTool> {
    const specifier = tool.source !== undefined
        ? await materializeTool(scratch, tool.source)
        : tool.entryPath

    if (!specifier) {
        throw err("CAPSULE_TOOL_FAILED", {
            detail: `"${tool.name}" has neither bundled source nor an entry path`,
            context: { namespace: tool.name },
        })
    }

    let mod: Record<string, unknown>
    try {
        mod = (await import(specifier)) as Record<string, unknown>
    } catch (cause) {
        throw err("CAPSULE_TOOL_FAILED", {
            detail: `"${tool.name}" failed to load`,
            context: { namespace: tool.name },
            cause,
        })
    }

    // Two authoring shapes: named exports, or a default object carrying an
    // `exports` bag. Named wins when present — a tool with both is declaring
    // its surface twice and the explicit one is the honest answer.
    const fallback = mod.default as { exports?: Record<string, unknown> } | undefined
    const named = Object.fromEntries(Object.entries(mod).filter(([name]) => name !== "default"))
    const exported = Object.keys(named).length > 0 ? named : (fallback?.exports ?? {})

    const values: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(exported)) {
        // `<tool>.<export>` — the POLICY address, not the call path.
        //
        // Deliberately namespaced although the global is flat: a policy rule
        // is written against the tool the user installed (`fs: { read: ... }`),
        // and a bare export name would make one rule cover every module that
        // happens to export `read`. The caller says `read(...)`; the mediator
        // asks about `fs.read`. Must match the capsule's own path (see
        // process/scope.ts) or the two enforcement points would key policy
        // differently.
        const path = `${tool.name}.${name}`
        values[name] = mediate(mediation, value, path, tool.name)
    }

    // The scope contract: what the model was TOLD it can call must be what
    // actually loaded. A mismatch means the <scope> block and the editor's
    // .d.ts describe functions that do not exist, so the model calls one and
    // gets "not defined" — checked here rather than trusted, exactly as the
    // capsule's build handshake checked it across the wire.
    const declared = tool.fns.map(fn => fn.name).sort()
    const loaded = Object.keys(values).sort()
    if (declared.length !== loaded.length || declared.some((name, i) => name !== loaded[i])) {
        throw err("CAPSULE_TOOL_SCOPE_MISMATCH", {
            detail: `"${tool.name}" declares [${declared.join(", ")}] but exports [${loaded.join(", ")}]`,
            context: { namespace: tool.name, declared, loaded },
        })
    }

    return { namespace: tool.name, values }
}
