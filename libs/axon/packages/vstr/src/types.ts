export type RenderFormat = "markdown" | "html" | "text"

export type RenderOptions = {
    /**
     * Globally available components: { ComponentName: "/abs/path/to/file.prompt" }
     * Compiled and injected as closure variables — available in any template in the
     * component tree without explicit import.
     */
    components?: Record<string, string>

    /**
     * Host-injected globals made available both inside <script setup> (as
     * closure consts, no import) and in template expressions (via _ctx).
     * Use this to inject runtime APIs: axon, cognos, process.env, etc. Names
     * must not collide with a <script setup> binding — the closure const would
     * double-declare. Inject stable, reserved names userland won't redeclare.
     *
     * @example
     * context: { axon: axonHandle, process: { env } }
     * // In script: const prs = await axon.tools.github.openPRs()
     * // In template: {{ process.env.NAME }}
     */
    context?: Record<string, unknown>

    /**
     * Output format. Defaults to "markdown".
     * - "markdown": HTML rendered output converted to Markdown via Turndown
     * - "html": raw HTML string from Vue SSR
     * - "text": HTML with all tags stripped
     */
    format?: RenderFormat

    /**
     * Skip the compile cache and force a fresh compile.
     * Recommended in dev/watch mode or test environments needing isolation.
     */
    noCache?: boolean
}
