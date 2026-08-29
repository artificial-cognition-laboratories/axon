import { readFileSync } from "fs"
import { resolve, dirname } from "path"
import { parse, compileScript, compileTemplate, type SFCDescriptor } from "@vue/compiler-sfc"
import * as vueRuntimeCore from "@vue/runtime-core"
import * as vue from "vue"
import * as serverRenderer from "@vue/server-renderer"
import ts from "typescript"

/** Cache compiled component definitions by absolute file path + context fingerprint */
const componentCache = new Map<string, any>()

export function clearCache(): void {
    componentCache.clear()
}

/**
 * Compile a .vue / .prompt SFC from disk and evaluate it in-memory.
 * Returns a Vue component definition — no filesystem writes.
 * Accepts any file extension; the parser reads the SFC format regardless.
 */
export async function compileFile(
    absPath: string,
    useCache: boolean,
    context: Record<string, unknown>,
    globalComponents: Record<string, any> = {}
): Promise<any> {
    const cacheKey = useCache ? `${absPath}::${contextFingerprint(context)}` : null
    if (cacheKey && componentCache.has(cacheKey)) {
        return componentCache.get(cacheKey)!
    }

    const source = readFileSync(absPath, "utf-8")
    const component = await compileSource(source, absPath, useCache, context, globalComponents)

    if (cacheKey) componentCache.set(cacheKey, component)
    return component
}

/**
 * Compile an SFC from a source string.
 * `filename` is used for error messages and relative import resolution.
 * `globalComponents` maps component name → compiled component def, injected
 * as closure variables to bypass resolveComponent() context requirements.
 */
export async function compileSource(
    source: string,
    filename: string,
    useCache: boolean,
    context: Record<string, unknown>,
    globalComponents: Record<string, any> = {}
): Promise<any> {
    const { descriptor, errors } = parse(source, { filename })

    if (errors.length) {
        throw new Error(
            `@arcforge/vstr: parse errors in ${filename}:\n${errors.map(e => e.message).join("\n")}`
        )
    }

    if (!descriptor.template) {
        throw new Error(`@arcforge/vstr: ${filename} has no <template> block`)
    }

    assertNoStrayContent(source, descriptor, filename)

    const id = filename.replace(/[^a-zA-Z0-9]/g, "_")

    // Resolve sub-component imports before compilation so we can inject them via closure
    const rawScriptCode = descriptor.scriptSetup?.content ?? descriptor.script?.content ?? ""
    const subComponents = await resolveImports(rawScriptCode, filename, useCache, context, globalComponents)
    const subComponentNames = Object.keys(subComponents)
    const subComponentValues = Object.values(subComponents)

    let scriptCode: string
    if (descriptor.scriptSetup || descriptor.script) {
        // SSR-mode compile: generates ssrRender using @vue/server-renderer primitives
        // (ssrRenderSlot, ssrRenderAttrs, etc.) from the same module instance as the
        // renderer — no cross-instance currentRenderingInstance issues.
        const result = compileScript(descriptor, {
            id,
            inlineTemplate: true,
            templateOptions: {
                ssr: true,
                compilerOptions: { runtimeModuleName: "@vue/runtime-core" },
            },
        })
        scriptCode = result.content
    } else {
        // Template-only SFC — compile template directly in SSR mode
        const result = compileTemplate({
            source: descriptor.template.content,
            filename,
            id,
            scoped: false,
            ssr: true,
            ssrCssVars: [],
            compilerOptions: { runtimeModuleName: "@vue/runtime-core" },
        })
        if (result.errors.length) {
            throw new Error(
                `@arcforge/vstr: template compile errors in ${filename}:\n${result.errors
                    .map(e => (typeof e === "string" ? e : e.message))
                    .join("\n")}`
            )
        }
        const renderBody = stripImports(await stripTypes(result.code))
            .replace(/^export\s+function\s+ssrRender/, "function ssrRender")
            .replace(/^export\s+/gm, "")
        scriptCode = `export default { ssrRender }\n${renderBody}`
    }

    const cleanScript = await stripTypes(scriptCode)

    // Build injected scope: Vue runtime exports + server-renderer SSR helpers + context globals.
    // Under Node's ESM-to-CJS interop, `import * as ns from "..."` namespace objects carry an
    // enumerable `__esModule` marker alongside the package's real exports — present on all three
    // of vueRuntimeCore/vue/serverRenderer, so destructuring every key as-is produces `const
    // {__esModule} = ...` more than once in the same generated function body (a real crash, not
    // a style nit: "Identifier '__esModule' has already been declared"). Filtered out here,
    // alongside "default", for the same reason "default" already was.
    const INTEROP_KEYS = new Set(["default", "__esModule"])
    const vueExports = Object.keys(vueRuntimeCore).filter(k => !INTEROP_KEYS.has(k))
    const vueNamedExports = Object.keys(vue).filter(
        k => !INTEROP_KEYS.has(k) && k !== "render" && k !== "ssrRender" && !vueExports.includes(k)
    )
    const ssrExports = Object.keys(serverRenderer).filter(k => !INTEROP_KEYS.has(k))

    const contextNames = Object.keys(context)
    const contextValues = Object.values(context)

    // Global components injected as closure vars — replaces resolveComponent() lookups.
    // Vue's SSR compiler generates _component_name (lowercase tag name) while the manifest
    // uses PascalCase. Build a case-insensitive lookup so both forms resolve correctly.
    const globalNames = Object.keys(globalComponents)
    const globalValues = Object.values(globalComponents)
    // Build all variant forms for case-insensitive + kebab matching
    const globalVariants = new Set<string>()
    for (const name of globalNames) {
        globalVariants.add(name.toLowerCase())
        globalVariants.add(name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase())
    }

    const scriptBody = stripImports(stripSfcImports(cleanScript))
        // Strip resolveComponent() calls for globally injected components — we inject
        // _component_X directly as closure vars, so these calls are both redundant and
        // broken (resolveComponent requires a Vue rendering context).
        .replace(
            /const\s+(_component_\w+)\s*=\s*_resolveComponent\([^)]+\);?/g,
            (_, varName) => {
                const stripped = varName.replace(/^_component_/, "").toLowerCase()
                return globalVariants.has(stripped) ? "" : `const ${varName} = _resolveComponent;`
            }
        )
        .replace(/export\s+default\s+/, "const __scriptDef = ")
        .replace(/export\s*\{([^}]+)\}/g, "")

    const body = `
"use strict";

// @vue/runtime-core exports
const {${vueExports.join(",")}} = __vueRuntimeCore;
// vue additional exports (e.g. defineComponent)
const {${vueNamedExports.join(",")}} = __vue;
// @vue/server-renderer SSR helpers (ssrRenderSlot, ssrRenderAttrs, etc.)
const {${ssrExports.join(",")}} = __serverRenderer;

// Sub-components — injected via closure, available inside setup()
${subComponentNames.map((name, i) => `const ${name} = __subComponents[${i}];`).join("\n")}

// Global components — bypass resolveComponent() by injecting as closure vars.
// Vue SSR generates different var names depending on tag casing:
//   <Name/>          → _component_Name
//   <name/>          → _component_name
//   <scouting-basics/> → _component_scouting_basics
// Manifest uses PascalCase (e.g. "ScoutingBasics"). Inject all forms.
${globalNames.map((name, i) => {
    const variants = new Set([name])
    variants.add(name.toLowerCase())
    // PascalCase → kebab-case with underscores (how Vue transforms kebab tags)
    const kebab = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
    variants.add(kebab)
    return [...variants].map(v => `const _component_${v} = __globals[${i}];`).join("\n")
}).join("\n")}

// Context — host-injected globals (axon, cognos, etc.)
${contextNames.map((name, i) => `const ${name} = __context[${i}];`).join("\n")}

${scriptBody}

// Context globals are injected as closure consts above (reachable from
// <script setup> code). Template expressions, though, compile to _ctx.<name>
// lookups — a free identifier the SSR compiler doesn't know is a local. To
// make {{ process.env.NAME }} / {{ axon.id }} resolve in the template too,
// expose the same context on the instance via data(), which Vue surfaces on
// _ctx. Context names must not collide with a <script setup> binding — the
// closure consts injected above would double-declare the identifier. Callers
// inject stable, reserved names (axon, process) that userland won't redeclare.
const __contextBag = {};
${contextNames.map((name, i) => `__contextBag[${JSON.stringify(name)}] = __context[${i}];`).join("\n")}

const __scriptComponent = (typeof __scriptDef !== "undefined" ? __scriptDef : {});
const __userData = __scriptComponent.data;
const __component = {
    ...__scriptComponent,
    data(...__args) {
        const __base = typeof __userData === "function" ? __userData.apply(this, __args) : (__userData ?? {});
        return { ...__contextBag, ...__base };
    },
}

return __component;
`

    const factory = new Function(
        "__vueRuntimeCore",
        "__vue",
        "__serverRenderer",
        "__subComponents",
        "__globals",
        "__context",
        body
    )

    const component = factory(vueRuntimeCore, vue, serverRenderer, subComponentValues, globalValues, contextValues)
    if (!component) {
        throw new Error(`@arcforge/vstr: compiled component is null for ${filename}`)
    }

    return component
}

/**
 * `parse()` only reports errors for malformed markup inside recognized
 * blocks — content sitting outside every <template>/<script>/<style>/custom
 * block (a stray line, a typo'd tag) is silently dropped from the
 * descriptor rather than flagged. That silently discards real author
 * mistakes, so walk every block's tag-to-tag span, blank it out, and
 * require whatever's left to be pure whitespace.
 */
function assertNoStrayContent(source: string, descriptor: SFCDescriptor, filename: string): void {
    const blocks = [descriptor.template, descriptor.script, descriptor.scriptSetup, ...descriptor.styles, ...descriptor.customBlocks].filter(
        (b): b is NonNullable<typeof b> => b !== null
    )

    let remainder = source
    for (const block of blocks) {
        const tagOpenStart = source.lastIndexOf(`<${block.type}`, block.loc.start.offset)
        const closeTag = `</${block.type}>`
        const tagCloseEnd = source.indexOf(closeTag, block.loc.end.offset) + closeTag.length
        if (tagOpenStart === -1 || tagCloseEnd === closeTag.length - 1) continue
        remainder = remainder.slice(0, tagOpenStart) + " ".repeat(tagCloseEnd - tagOpenStart) + remainder.slice(tagCloseEnd)
    }

    // @vue/compiler-sfc drops EMPTY recognized blocks from the descriptor
    // (an empty `<script setup></script>` yields descriptor.scriptSetup ===
    // null), so the loop above never blanks their tags. A blank-but-valid
    // block is not stray content — strip any leftover well-formed
    // template/script/style block that carries no inner content before the
    // whitespace check, so scaffolding's empty `<script setup>` doesn't
    // falsely trip this.
    remainder = remainder.replace(/<(template|script|style)(\s[^>]*)?>\s*<\/\1>/g, "")

    if (remainder.trim().length > 0) {
        throw new Error(`@arcforge/vstr: ${filename} has content outside its <template>/<script>/<style> blocks — this is likely a typo`)
    }
}

/**
 * Resolve all relative .vd / .vue / .prompt imports in script code to compiled component definitions.
 */
async function resolveImports(
    code: string,
    fromFile: string,
    useCache: boolean,
    context: Record<string, unknown>,
    globalComponents: Record<string, any>
): Promise<Record<string, any>> {
    const dir = dirname(fromFile)
    const result: Record<string, any> = {}
    const importRe = /import\s+(\w+)\s+from\s+["'](\.{1,2}\/[^"']+\.(vd|vue|prompt))["']/g
    let match: RegExpExecArray | null

    while ((match = importRe.exec(code)) !== null) {
        const [, localName, specifier] = match
        // Both groups are mandatory in importRe, so a match guarantees them.
        // The guard is what tells the compiler that, and costs nothing.
        if (localName === undefined || specifier === undefined) continue
        result[localName] = await compileFile(resolve(dir, specifier), useCache, context, globalComponents)
    }

    return result
}

/**
 * Strip all ESM import statements, preserving aliased names as const declarations.
 * All Vue/SSR runtime values are already available via injected params.
 */
function stripImports(code: string): string {
    return code.replace(/^import\s[\s\S]*?from\s+["'][^"']+["'];?/gm, importStmt => {
        const flat = importStmt.replace(/\s+/g, " ").trim()

        if (/^import\s+\*\s+as\s+/.test(flat)) return ""

        const namedMatch = flat.match(/^import\s*\{([^}]+)\}\s*from/)
        if (namedMatch?.[1] !== undefined) {
            return namedMatch[1]
                .split(",")
                .map(s => {
                    const [orig, alias] = s.split(" as ").map(x => x.trim())
                    if (!orig) return ""
                    if (alias && alias !== orig) return `const ${alias} = ${orig};`
                    return ""
                })
                .filter(Boolean)
                .join("\n")
        }

        return ""
    })
}

/** Strip relative .vd / .vue / .prompt imports — sub-components are injected via __subComponents */
function stripSfcImports(code: string): string {
    return code.replace(
        /^import\s+\w+\s+from\s+["']\.{1,2}\/[^"']+\.(vd|vue|prompt)["'];?\n?/gm,
        ""
    )
}

/**
 * Strip TypeScript syntax down to plain JS. Under bun, Bun.Transpiler is
 * used (fast, no extra dependency). Off bun, typescript's own
 * transpileModule() — not esbuild — because esbuild's Node API spawns its
 * own native binary via a require.resolve("esbuild") lookup at transform
 * time, which cannot survive being bundled into a single extension.js:
 * once bundled, there is no node_modules/esbuild on disk for that lookup
 * to find. typescript is pure JS, needs no subprocess, and bundles
 * cleanly — see debt.md if this ever needs revisiting.
 *
 * No fallback to returning `code` unchanged on failure — the caller
 * splices this output into a `new Function()` body; untransformed TS
 * syntax there is a hard SyntaxError, not a degraded-but-working result,
 * so a real transpile failure must propagate, never hide behind a catch.
 */
async function stripTypes(code: string): Promise<string> {
    if (typeof Bun !== "undefined") {
        return new Bun.Transpiler({ loader: "ts" }).transformSync(code)
    }
    return ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    }).outputText
}

/** Fingerprint context by key names + value types — sufficient for cache isolation */
function contextFingerprint(context: Record<string, unknown>): string {
    return Object.keys(context)
        .sort()
        .map(k => `${k}:${typeof context[k]}`)
        .join(",")
}
