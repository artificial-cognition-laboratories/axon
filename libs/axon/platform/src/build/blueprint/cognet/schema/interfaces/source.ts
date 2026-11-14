import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import { err } from "@arcforge/err"
import type { ServiceUse } from "@arcforge/types"
import type { Source } from "../compile"
import { fail, fieldType, protoName, typescript, type Answer, type Contract, type File } from "../components"

/** An interface file: its name and major version in the file's own name. */
const INTERFACE_FILE = /^([a-z][a-z0-9-]*)@(\d+)\.interface\.ts$/

/** Where the standard library is imported from, by authors and by each other. */
const STANDARD = "@arcforge/cognet/interfaces/"

export type InterfacesOpts = {
    /** The cognet's source directory. */
    root: string
    /** The cognet's package name — the scope its own interfaces are named in. */
    cognet: string
    /** What the cognet uses: each names the interface it needs compiled. */
    uses: Readonly<Record<string, ServiceUse>>
    /** The standard library's file for `chat@1`, or null when there is none — resolved from the agent's installed runtime. */
    standard(name: string): string | null
    /** Every component file, read: value types an interface may import. */
    components: readonly File[]
}

/** One interface, compiled: its full name, the use-facing name a use writes, its proto file, and where its conformance cases are. */
export type Compiled = { name: string; written: string; named: string; conformance: string | null }

/**
 * Interfaces — the contracts a cognet's uses name, compiled to the same
 * protobuf image as its components. Each becomes a `service` whose methods'
 * streaming says their kind, its arguments a `…Request` message, and its
 * value types messages like any component's — so every language a system is
 * written in gets the same types, and the runtime reads each method's kind
 * from the image rather than from the source.
 *
 * Compiled: every interface in the cognet's own `interfaces/`, and each
 * standard one a use names, with whatever they import.
 */
export function Interfaces(opts: InterfacesOpts) {
    const own = join(opts.root, "interfaces")

    return {
        sources(): { sources: Source[]; compiled: Compiled[] } {
            const wanted = new Set<string>()
            const compiled: Compiled[] = []
            for (const [use, declared] of Object.entries(opts.uses)) {
                const path = locate(declared.interface)
                if (!path) {
                    throw err("INTERFACE_NOT_FOUND", {
                        detail: `uses.${use}: no interface ${declared.interface} — ${declared.interface.startsWith("./") ? `expected ${join(opts.root, `${declared.interface.slice(2)}.interface.ts`)}` : "the standard library has none by that name and version"}`,
                        context: { use: use, interface: declared.interface },
                    })
                }
                wanted.add(path)
            }
            if (existsSync(own)) {
                for (const entry of new Bun.Glob("**/*.ts").scanSync({ cwd: own })) {
                    if (!entry.endsWith(".d.ts") && !entry.endsWith(".test.ts")) wanted.add(join(own, entry))
                }
            }

            // Each wanted file, and what it imports, read once.
            const files = new Map<string, File & { contracts: Contract[] }>()
            const pending = [...wanted]
            while (pending.length) {
                const path = pending.pop()!
                if (files.has(path) || opts.components.some(file => file.absPath === path)) continue
                const parsed = typescript(path, readFileSync(path, "utf8"), { contract: true, resolve: specifier => resolveStandard(specifier) })
                const named = protoFile(path)
                files.set(path, { absPath: path, relPath: relative(opts.root, path), named: named, package: protoPackage(named), shapes: parsed.shapes, imports: parsed.imports, contracts: parsed.contracts })
                for (const imported of Object.values(parsed.imports)) pending.push(imported.path)
            }

            const known: File[] = [...files.values(), ...opts.components]
            const sources = [...files.values()].map(file => {
                const name = interfaceName(file.absPath)
                if (name && file.contracts.length !== 1) fail(file.absPath, `an interface file holds exactly one interface — an exported interface with methods; found ${file.contracts.length}`)
                if (!name && file.contracts.length) fail(file.absPath, `an interface is written in a file named for it and its major version — ${file.contracts[0]!.name.toLowerCase()}@1.interface.ts`)
                if (name) {
                    const cases = file.absPath.replace(/\.interface\.ts$/, ".conformance")
                    compiled.push({ name: name, written: written(file.absPath), named: file.named, conformance: existsSync(join(cases, "cases.json")) ? cases : null })
                }
                return { absPath: file.absPath, named: file.named, content: emit(file, known, name) }
            })
            return { sources: sources, compiled: compiled }
        },
    }

    /** The file a use's `interface` names, or null when there is none. */
    function locate(declared: string): string | null {
        if (declared.startsWith("./")) {
            const path = join(opts.root, `${declared.slice(2)}.interface.ts`)
            return existsSync(path) ? path : null
        }
        return opts.standard(declared)
    }

    function resolveStandard(specifier: string): string | null {
        if (!specifier.startsWith(STANDARD)) return null
        const path = opts.standard(specifier.slice(STANDARD.length))
        if (!path) fail(specifier, `no standard interface ${specifier.slice(STANDARD.length)}`)
        return path
    }

    function isOwn(path: string): boolean {
        return path.startsWith(`${own}/`)
    }

    /** `chat@1` for a standard interface; `@cody/terry/scene@1` for the cognet's own. Null for a file of value types. */
    function interfaceName(path: string): string | null {
        const match = basename(path).match(INTERFACE_FILE)
        if (!match) return null
        return isOwn(path) ? `${opts.cognet}/${match[1]}@${match[2]}` : `${match[1]}@${match[2]}`
    }

    /** What a use writes to name it: `chat@1`, or `./interfaces/scene@1`. */
    function written(path: string): string {
        return isOwn(path) ? `./${relative(opts.root, path).replace(/\.interface\.ts$/, "")}` : basename(path).replace(/\.interface\.ts$/, "")
    }

    /** `interfaces/scene.v1.proto` for the cognet's own; `axon/interfaces/chat.v1.proto` for the standard library's. */
    function protoFile(path: string): string {
        const file = basename(path).replace(INTERFACE_FILE, "$1.v$2.proto").replace(/\.ts$/, ".proto")
        return isOwn(path) ? join("interfaces", dirname(relative(own, path)), file) : join("axon/interfaces", file)
    }
}

function protoPackage(named: string): string {
    return named.slice(0, -".proto".length).split(/[/.]/).map(part => part.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=\d)/, "_")).join(".")
}

/** The proto for one interface file: its value types and handles as messages, its contract as a service. */
function emit(file: File & { contracts: Contract[] }, known: readonly File[], name: string | null): string {
    const imports = new Set<string>()
    const blocks: string[] = []
    const taken = new Set(file.shapes.map(shape => shape.name))

    const resolve = (owner: File, type: string): string => {
        // Always fully qualified: inside a service a method's name shadows a message's, and `rpc Surface(…) returns (Surface)` would name the method.
        if (owner.shapes.some(shape => shape.name === type)) return `.${owner.package}.${type}`
        const imported = owner.imports[type]
        if (!imported) fail(owner.absPath, `${type} is not declared here or imported`)
        const from = known.find(one => one.absPath === imported.path)
        if (!from || !from.shapes.some(shape => shape.name === imported.name)) fail(owner.absPath, `${type}: ${imported.path} declares no ${imported.name}`)
        if (from !== owner) imports.add(from.named)
        return `.${from.package}.${imported.name}`
    }

    const message = (messageName: string, fields: File["shapes"][number]["fields"], doc?: string): void => {
        const lines = fields.map((field, index) => {
            const type = fieldType(field.type, file, resolve)
            const options = [...type.options]
            if (field.optional && type.repeated) options.push("(cognet.optional) = true")
            if (field.nullable) options.push("(cognet.nullable) = true")
            return `  ${field.optional && !type.repeated ? "optional " : ""}${type.proto} ${protoName(field.name)} = ${index + 1}${options.length ? ` [${options.join(", ")}]` : ""};`
        })
        blocks.push(...comment(doc), `message ${messageName} {`, ...lines, "}", "")
    }

    for (const shape of file.shapes) {
        if (shape.alias) fail(file.absPath, `${shape.name}: an interface's value types are object shapes`)
        if (shape.handle) blocks.push(...comment(shape.doc), `message ${shape.name} {`, `  option (cognet.handle) = ${JSON.stringify(shape.name)};`, "  string id = 1;", "}", "")
        else message(shape.name, shape.fields, shape.doc)
    }

    const contract = file.contracts[0]
    if (contract && name) {
        const generated = (suffix: string, method: string): string => {
            const generatedName = `${pascal(method)}${suffix}`
            if (taken.has(generatedName)) fail(file.absPath, `${generatedName} is generated for ${contract.name}.${method} — rename the type`)
            taken.add(generatedName)
            return generatedName
        }
        const answered = (answer: Answer, method: string): string => {
            if (answer === null) return ".cognet.Nothing"
            if ("named" in answer) return resolve(file, answer.named)
            const answerName = generated(method === "describe" ? "" : "Answer", method === "describe" ? `${contract.name}Describe` : method)
            message(answerName, answer.inline)
            return `.${file.package}.${answerName}`
        }
        const rpcs = contract.methods.map(method => {
            const answer = answered(method.answer, method.name)
            const request = method.kind === "describe" || method.kind === "session" ? null : generated("Request", method.name)
            if (request) message(request, method.params)
            const input = method.kind === "describe" ? ".cognet.Nothing" : method.kind === "session" ? `stream ${resolve(file, method.push!)}` : `.${file.package}.${request!}`
            const output = method.kind === "stream" || method.kind === "session" ? `stream ${answer}` : answer
            return [...comment(method.doc, "  "), `  rpc ${pascal(method.name)}(${input}) returns (${output});`]
        })
        blocks.push(...comment(contract.doc), `service ${contract.name} {`, `  option (cognet.interface) = ${JSON.stringify(name)};`, ...rpcs.flat(), "}", "")
    }

    const head = [
        `// Generated by axon prepare from ${file.relPath}.`,
        'syntax = "proto3";',
        `package ${file.package};`,
        'import "cognet/cognet.proto";',
        ...[...imports].sort().map(one => `import ${JSON.stringify(one)};`),
        "",
    ]
    return [...head, ...blocks].join("\n")
}

function pascal(name: string): string {
    return name[0]!.toUpperCase() + name.slice(1)
}

function comment(doc: string | undefined, indent = ""): string[] {
    return doc ? doc.split("\n").map(line => `${indent}// ${line}`) : []
}

/** The contract an interface file declares — its exported interface with methods — by name. Throws when it holds none. */
export function contractOf(file: string): string {
    const contract = typescript(file, readFileSync(file, "utf8"), { contract: true, resolve: () => null }).contracts[0]
    if (!contract) fail(file, "an interface file holds an exported interface with methods; this one holds none")
    return contract.name
}
