import { resolve } from "path"
import { createSSRApp, defineComponent } from "vue"
import { renderToString } from "@vue/server-renderer"
import { compileFile, compileSource, clearCache as clearCompileCache } from "./compile"
import { introspect, introspectSource } from "./introspect"
import { htmlToMarkdown } from "./markdown"
import type { RenderOptions, RenderFormat } from "./types"
import type { PropInfo } from "./introspect"

export interface VstrTemplate {
    render(props?: Record<string, unknown>): Promise<string>
    introspect(): PropInfo[]
}

function makeTemplate(
    getComponentDef: (options: RenderOptions) => Promise<any>,
    getProps: () => PropInfo[],
    options: RenderOptions = {}
): VstrTemplate {
    return {
        async render(props: Record<string, unknown> = {}): Promise<string> {
            const componentDef = await getComponentDef(options)
            const component = defineComponent({ ...(componentDef as any) })
            const app = createSSRApp(component, props)
            const html = await renderToString(app)
            return formatOutput(html, options.format ?? "markdown")
        },

        introspect(): PropInfo[] {
            return getProps()
        },
    }
}

/**
 * Create a template from a .vue / .prompt file path.
 * Construction is synchronous and lazy — compilation happens on first render().
 *
 * @example
 * const tpl = vstr("./system.prompt", { context: { axon } })
 * const md = await tpl.render({ messages, cwd })
 * const props = tpl.introspect()
 */
function vstr(filePath: string, options: RenderOptions = {}): VstrTemplate {
    const absPath = resolve(filePath)

    return makeTemplate(
        async (opts) => {
            const useCache = !opts.noCache
            const context = opts.context ?? {}
            const globalComponents = await resolveGlobalComponents(opts.components, useCache, context)
            return compileFile(absPath, useCache, context, globalComponents)
        },
        () => introspect(absPath),
        options
    )
}

/**
 * Create a template from a raw SFC source string.
 * Primarily useful for testing.
 *
 * @example
 * const tpl = vstr.source(`<template><h1>Hello {{ name }}</h1></template>...`)
 * const md = await tpl.render({ name: "world" })
 */
vstr.source = function (source: string, options: RenderOptions & { filename?: string } = {}): VstrTemplate {
    const filename = options.filename ?? "<source>"

    return makeTemplate(
        async (opts) => {
            const useCache = !opts.noCache
            const context = opts.context ?? {}
            const globalComponents = await resolveGlobalComponents(opts.components, useCache, context)
            return compileSource(source, filename, useCache, context, globalComponents)
        },
        () => introspectSource(source, filename),
        options
    )
}

/**
 * Clear the global compile cache.
 */
vstr.clearCache = function (): void {
    clearCompileCache()
}

async function resolveGlobalComponents(
    components: Record<string, string> | undefined,
    useCache: boolean,
    context: Record<string, unknown>
): Promise<Record<string, any>> {
    if (!components) return {}
    const result: Record<string, any> = {}
    for (const [name, filePath] of Object.entries(components)) {
        result[name] = await compileFile(resolve(filePath), useCache, context)
    }
    return result
}

function formatOutput(html: string, format: RenderFormat): string {
    switch (format) {
        case "html":
            return html
        case "text":
            return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
        case "markdown":
        default:
            return htmlToMarkdown(html)
    }
}

export { vstr }
