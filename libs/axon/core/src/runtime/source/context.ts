/**
 * The scope a `.vue` / `.prompt` template renders in. Agent-authored
 * templates are treated with the same scope as the rest of the agent's
 * code — `axon` (the live runtime handle), the agent's tools, and
 * `process.env` (the agent's resolved environment) are all in scope,
 * exactly as they are in a tool or script.
 *
 * TOOLS ARE IN SCOPE, and the reason is worth stating because it used to be
 * a boundary rather than a choice: cognet, kernel, tools, scripts and
 * templates now share one heap, so a tool is a function call from here. A
 * template composing real content — a board, a file, a search — should read
 * it the same way every other piece of agent code does.
 *
 * The constraint is Vue's, not ours: a template interpolates VALUES, so
 * async work belongs in `<script setup>`, which may use top-level `await`.
 *
 * ```vue
 * <script setup lang="ts">
 * const board = await fs.read("kanban/index.md")
 * </script>
 * <template><pre>{{ board }}</pre></template>
 * ```
 *
 * `{{ fs.read("x") }}` in a template interpolates a Promise — which reaches
 * the model as `[object Promise]`. See typegen's template lint, which is
 * what catches that before a render ever happens.
 *
 * `process` is NOT shimmed. It is the agent's own process — the one the
 * runtime already overlays the agent's declared `.env` onto (see the
 * capsule's env application), so `process.env.MY_KEY` reads the keys given
 * to this agent explicitly, alongside the ambient environment it needs.
 * `process.run()` and `process.spawn()` are there too, exactly as they are
 * in a script or a tool.
 *
 * It used to be a minimal `{ env }` shim here, defended as a confidentiality
 * boundary: a template's output reaches the model, so it should not see the
 * shell that launched the TUI. That framing is wrong, and the shim was the
 * last thing making a prompt's scope differ from every other context's.
 *
 * In-process is IN SCOPE. Prompt rendering happens inside the agent, in the
 * same heap as the cognet, the scripts and the tools — none of which are
 * narrowed. The user put the `.env` on this agent deliberately, and the
 * declared vars are overlaid onto the ambient environment rather than
 * replacing it precisely so an agent keeps PATH, HOME and the provider vars
 * the runtime resolved. Anything on `process.env` here is something the agent
 * is meant to have; the wall that separates agents from each other is the
 * OS's, not a shim in one rendering context.
 *
 * The rest is read lazily off globalThis: the runtime handle is wired
 * after the constructs that render templates exist, so it can't be captured
 * by reference — by the time a template actually renders, inject.runtime()
 * has fired and the global is live. Tools follow the same rule for a second
 * reason: a reload rebuilds the handle and RETRACTS the previous namespaces
 * (see installToolGlobals), so a context that captured them by value would
 * hand templates namespaces that no longer exist.
 */
export function promptContext(): Record<string, unknown> {
    const axon = (globalThis as { axon?: { tools?: Record<string, unknown> } }).axon

    // Namespaces only, never flattened members. A template's scope is built
    // from the DECLARED tool surface, so a name here always says which
    // module it came from — and cannot collide with a `<script setup>`
    // binding the way a bare `read` would.
    const tools: Record<string, unknown> = {}
    for (const [namespace, members] of Object.entries(axon?.tools ?? {})) {
        if (members && typeof members === "object") tools[namespace] = members
    }

    return {
        ...tools,
        axon: axon,
        // After the spread: a tool namespace must not shadow the handle or
        // the process, which every context is entitled to reach.
        process: process,
    }
}
