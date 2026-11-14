import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { getOption, type DescFile, type DescMessage } from "@bufbuild/protobuf"
import { err } from "@arcforge/err"
import type { ServiceUse } from "@arcforge/types"
import { fsx } from "../../../../utils/fs"
import { writeIfChanged } from "../../../project/typegen/write"
import { compile, type Source } from "./compile"
import { Authored } from "./authored"
import { Components } from "./components"
import { Interfaces } from "./interfaces"
import { rust } from "./rust"
import { python } from "./python"
import { HEADER, typescript, type Context } from "./typescript"

export type SchemaOpts = {
    /** The cognet's source directory. */
    sourceDir: string
    /** The agent compiling it: whose installed `@arcforge/cognet` the runtime's schema comes from. */
    agentRoot: string
    /** The cognet's package name — the scope its own interfaces are named in. */
    cognet: string
    /** What the cognet uses: the interfaces it needs compiled. */
    uses: Readonly<Record<string, ServiceUse>>
    /** Where the generated modules go — the agent frame's `cognet/schema/`, which `#schema/` imports resolve to. */
    out: string
    /** Where the schemas' Rust goes — the native crate's `src/schema.rs` — when the cognet has Rust systems; null when it has none. */
    rust: string | null
    /** Python's generated dataclasses and editor accessors, when Python systems exist. */
    python?: string | null
    /** Scratch the schemas are staged and compiled in. */
    stage: string
}

/** Directories no schema lives under: installed code and build output. */
const SKIP_DIRS = ["node_modules", ".git", ".cognet", ".agent", "target", ".venv", "__pycache__"]

/** `export const world = frame({...})` — a frame an author still writes by hand. */
const HANDWRITTEN_FRAME = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*frame\s*\(/gm

/** Modules an older build generated beside their schemas, which the move to the frame leaves behind. */
const BESIDE = /\.pb(\.handles)?\.ts$/

/**
 * Schema — a cognet's native component sources and older schemas compiled through protobuf.
 *
 * The `types/` declarations are the source of truth for the cognet's world:
 * its types, components and frames. Protobuf is an intermediate. Existing
 * annotated TypeScript and `.proto` files remain readable during migration.
 * Each language's form is
 * generated into the AGENT'S frame, never into the source — `types/control/control.ts`
 * → `<frame>/cognet/schema/control/control.ts` (the handles) and
 * `control.types.ts` (the types, plain data) — and imported as
 * `#schema/control/control`, which the agent's tsconfig and the bundler both
 * resolve. Discovery, naming and typegen read the generated handles as if
 * they sat at the schema's path. So nothing generated is ever committed or
 * published: an installed cognet's schemas are compiled into the agent that
 * installs it, like any other. Run before the brain is bundled; a schema that
 * does not compile, or says something no language can be generated from,
 * fails the build here.
 */
export function Schema(opts: SchemaOpts) {
    return {
        /** Every schema compiled and its modules written; anything else under `out` removed. The modules, by path, and every interface compiled. */
        async generate(): Promise<{ written: string[]; interfaces: Described[] }> {
            const walked = await fsx.walk(opts.sourceDir, { skipDirs: SKIP_DIRS })
            // Left by a build that generated beside the schemas: never imported again, and read as a duplicate if kept.
            for (const old of walked.filter(file => BESIDE.test(file.relPath))) {
                if (readFileSync(old.absPath, "utf8").startsWith(HEADER)) rmSync(old.absPath)
            }
            const named = naming(opts.sourceDir)
            const proto: Source[] = walked.filter(file => file.relPath.endsWith(".proto")).map(file => ({ absPath: file.absPath, named: named(file.relPath) }))
            // Design examples are source sketches, not schemas for this cognet.
            const declarations = walked.filter(file => file.relPath.startsWith("types/") && !file.relPath.startsWith("types/examples/"))
            // Component files are found anywhere in the cognet — in types/, or beside the systems that use them.
            const anywhere = walked.filter(file => !file.relPath.startsWith("types/examples/"))
            const oldComponent = anywhere.find(file => /\.component\.(ts|rs|py)$/.test(file.relPath))
            if (oldComponent) throw err("COGNET_SCHEMA_INVALID", { detail: `${oldComponent.relPath}: rename this file to *.components.${oldComponent.relPath.split(".").at(-1)}; component sources use the plural suffix` })
            const isComponents = (path: string): boolean => /\.components\.(ts|rs|py)$/.test(path)
            const legacyComponents = (file: { absPath: string; relPath: string }): boolean => file.relPath.endsWith(".components.ts") && /@package\s+[^\s*]+/.test(readFileSync(file.absPath, "utf8"))
            const authored = Authored({ root: opts.sourceDir, files: declarations.filter(file => file.relPath.endsWith(".ts") && (!isComponents(file.relPath) || legacyComponents(file)) && !file.relPath.endsWith(".d.ts") && !file.relPath.endsWith(".test.ts")) }).sources()
            const components = Components({ root: opts.sourceDir, files: anywhere.filter(file => isComponents(file.relPath) && !legacyComponents(file)), legacy: [...proto, ...authored] })
            const { sources: native, files: componentFiles } = components.sources()
            const interfaces = Interfaces({ root: opts.sourceDir, cognet: opts.cognet, uses: opts.uses, standard: name => standard(name, opts.agentRoot), components: componentFiles }).sources()
            const sources = [...proto, ...authored, ...native, ...interfaces.sources]
            const seen = new Set<string>()
            for (const source of sources) {
                if (source.named === "cognet/cognet.proto") throw err("COGNET_SCHEMA_INVALID", { detail: "cognet/cognet.proto belongs to the runtime and cannot be replaced by a cognet" })
                if (seen.has(source.named)) throw err("COGNET_SCHEMA_INVALID", { detail: `${source.named} is defined in both types/ and .proto — remove the .proto when moving its schema to TypeScript` })
                seen.add(source.named)
            }
            const written: string[] = []
            const described: Described[] = []
            if (opts.python) rmSync(opts.python, { recursive: true, force: true })
            if (opts.rust) {
                mkdirSync(dirname(opts.rust), { recursive: true })
                if (sources.length === 0) writeIfChanged(opts.rust, rust.module([], null))
            }
            if (sources.length > 0) {
                compile.stage(opts.stage, sources, opts.agentRoot)
                const registry = compile.image(opts.stage)
                const componentMarker = registry.getExtension("cognet.components")
                if (!componentMarker) throw err("COGNET_SCHEMA_INVALID", { detail: "the runtime's schema defines no cognet.components" })
                const newSources = new Set(native.map(source => source.named))
                const componentNames = new Map<string, { source: string; full: string }>()
                for (const source of sources) {
                    const file = registry.getFile(source.named)
                    if (!file) continue
                    const folder = dirname(file.name)
                    for (const message of file.messages) {
                        if (getOption(message, componentMarker) !== true) continue
                        for (const field of message.fields) {
                            const full = folder === "." ? field.jsonName : `${folder}/${field.jsonName}`
                            const prior = componentNames.get(full)
                            if (prior && (newSources.has(source.named) || newSources.has(prior.source))) throw err("COGNET_SCHEMA_INVALID", { detail: `${full} overlaps ${prior.full}; ${field.jsonName} is already a component in ${prior.source}` })
                            componentNames.set(full, { source: source.named, full: full })
                        }
                    }
                }
                const ours = new Set(sources.map(source => source.named.slice(0, -".proto".length)))
                const base = (file: DescFile): string => {
                    if (!ours.has(file.name)) throw err("COGNET_SCHEMA_INVALID", { detail: `${file.name}.proto is imported, but it is not one of this cognet's schemas — a cognet's schemas import only each other and cognet/cognet.proto` })
                    return join(opts.out, file.name)
                }
                const marker = registry.getExtension("cognet.frames")
                if (!marker) throw err("COGNET_SCHEMA_INVALID", { detail: "the runtime's schema defines no cognet.frames — the installed @arcforge/cognet is older than this platform" })
                const frames = Frames({
                    walked: walked,
                    named: named,
                    files: sources.map(source => registry.getFile(source.named)).filter(file => file !== undefined),
                    handles: base,
                    isFrames: message => getOption(message, marker) === true,
                })
                const context: Context = { registry: registry, types: file => `${base(file)}.types`, handles: base, frame: frames.find }

                for (const source of sources) {
                    const file = registry.getFile(source.named)
                    if (!file) throw err("COGNET_SCHEMA_INVALID", { detail: `${source.named} compiled to nothing` })
                    const generated = typescript.file(file, source.named, context)
                    mkdirSync(dirname(base(file)), { recursive: true })
                    writeIfChanged(`${context.types(file)}.ts`, generated.types)
                    written.push(`${context.types(file)}.ts`)
                    if (generated.handles) {
                        writeIfChanged(`${base(file)}.ts`, generated.handles)
                        written.push(`${base(file)}.ts`)
                    }
                }
                const files = sources.map(source => registry.getFile(source.named)).filter(file => file !== undefined)
                for (const one of interfaces.compiled) described.push(describe(one, registry.getFile(one.named)))
                if (opts.rust) writeIfChanged(opts.rust, rust.module(files, registry))
                if (opts.python) {
                    for (const [relativePath, content] of python.files(files, registry)) {
                        const target = join(opts.python, relativePath)
                        mkdirSync(dirname(target), { recursive: true })
                        writeIfChanged(target, content)
                        let directory = dirname(target)
                        while (directory !== opts.python) {
                            writeIfChanged(join(directory, "__init__.py"), "# Generated by axon prepare.\n")
                            directory = dirname(directory)
                        }
                    }
                }
            }
            // `out` is the generator's alone: whatever it did not write this time is a schema that is gone.
            const kept = new Set(written)
            for (const stale of existsSync(opts.out) ? await fsx.walk(opts.out) : []) {
                if (!kept.has(stale.absPath)) rmSync(stale.absPath)
            }
            if (native.length || existsSync(join(dirname(opts.out), ".schema-lock.json"))) components.save()
            return { written: written, interfaces: described }
        },
    }
}

export type SchemaT = ReturnType<typeof Schema>

/** One interface as the runtime holds it: its name, how a use writes it, and each method's kind. */
export type Described = { name: string; written: string; methods: Record<string, { kind: "describe" | "call" | "stream" | "session"; params: string[] }>; conformance: string | null }

/** An interface's methods and their kinds, read from its compiled service: the streaming says the kind. */
function describe(compiled: { name: string; written: string; named: string; conformance: string | null }, file: DescFile | undefined): Described {
    const service = file?.services[0]
    if (!service) throw err("COGNET_SCHEMA_INVALID", { detail: `${compiled.named} compiled to no service` })
    const methods: Described["methods"] = {}
    for (const method of service.methods) {
        const name = method.name[0]!.toLowerCase() + method.name.slice(1)
        const kind = name === "describe" ? "describe" : method.methodKind === "bidi_streaming" ? "session" : method.methodKind === "server_streaming" ? "stream" : "call"
        // A call's arguments are its request's fields, by the names the interface gave its parameters.
        methods[name] = { kind: kind, params: kind === "call" || kind === "stream" ? method.input.fields.map(field => field.jsonName) : [] }
    }
    return { name: compiled.name, written: compiled.written, methods: methods, conformance: compiled.conformance }
}

/** The standard library's file for `chat@1`, from the agent's installed runtime; null when it has none. */
function standard(name: string, agentRoot: string): string | null {
    if (!/^[a-z][a-z0-9-]*@\d+$/.test(name)) return null
    try {
        return Bun.resolveSync(`@arcforge/cognet/interfaces/${name}`, agentRoot)
    } catch {
        // Resolution failing is the answer: the installed runtime has no such interface.
        return null
    }
}

/**
 * Every frame a schema may draw a component in, by name: those its schemas
 * declare, and those still written by hand in TypeScript. Named as
 * components are: the folder, then the export; found by the full name, or the
 * bare one when one frame alone is called that.
 */
function Frames(opts: { walked: Array<{ absPath: string; relPath: string }>; named: (relPath: string) => string; files: DescFile[]; handles: (file: DescFile) => string; isFrames: (message: DescMessage) => boolean }) {
    const all: Array<{ name: string; module: string; exported: string }> = []
    for (const file of opts.files) {
        const folder = dirname(file.name)
        for (const message of everyMessage(file.messages)) {
            if (!opts.isFrames(message)) continue
            for (const field of message.fields) all.push({ name: folder === "." ? field.jsonName : `${folder}/${field.jsonName}`, module: opts.handles(file), exported: field.jsonName })
        }
    }
    for (const file of opts.walked) {
        if (!file.relPath.endsWith(".ts") || file.relPath.endsWith(".d.ts") || file.relPath.endsWith(".test.ts") || BESIDE.test(file.relPath)) continue
        const folder = dirname(opts.named(file.relPath))
        for (const match of readFileSync(file.absPath, "utf8").matchAll(HANDWRITTEN_FRAME)) {
            all.push({ name: folder === "." ? match[1]! : `${folder}/${match[1]!}`, module: file.absPath.slice(0, -".ts".length), exported: match[1]! })
        }
    }
    return {
        find(name: string): { module: string; exported: string } {
            const exact = all.filter(one => one.name === name)
            const bare = exact.length > 0 ? exact : all.filter(one => one.exported === name)
            if (bare.length === 1) return bare[0]!
            throw err("COGNET_SCHEMA_INVALID", {
                detail: bare.length === 0 ? `no frame is named "${name}"` : `"${name}" is ${bare.map(one => one.name).join(" and ")} — write the full name`,
            })
        },
    }
}

/** A message and every message nested in it, depth first. */
function everyMessage(messages: readonly DescMessage[]): DescMessage[] {
    return messages.flatMap(message => [message, ...everyMessage(message.nestedMessages)])
}

/** The path a schema is NAMED and imported by: under `src/` when the cognet keeps its code there, as components are named. */
function naming(sourceDir: string): (relPath: string) => string {
    const nested = existsSync(join(sourceDir, "src"))
    return relPath => (nested && relPath.startsWith("src/") ? relPath.slice("src/".length) : relPath)
}
