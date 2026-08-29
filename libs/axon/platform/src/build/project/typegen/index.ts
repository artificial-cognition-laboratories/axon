import type { AxonPartialBlueprint } from "@arcforge/types"
import { err } from "@arcforge/err"
import { Generators } from "./generators"
import type { BuiltinRegistry } from "./registry-dts"
import { Tools } from "../../blueprint/scan/tools"
import { KINDS, type ProjectKind } from "../kinds"

export type TypegenResult = {
    toolGlobals: number
    prompts: number
    scripts: number
    components: number
    env: number
}

/** Nothing generated beyond the shared frame. What every non-agent kind returns. */
const EMPTY: TypegenResult = { toolGlobals: 0, prompts: 0, scripts: 0, components: 0, env: 0 }

type TypegenOpts = {
    root: string
    kind: ProjectKind
    /**
     * Roots to scan for registrations, in LOAD ORDER — the profile first, then
     * each extension as profile.config.ts lists them.
     *
     * Optional because a caller that knows nothing about extensions (a bare
     * `axon prepare` on a profile directory) still gets that profile's own
     * names. Order decides which description survives a duplicate, matching
     * the loader's first-wins rule.
     */
    sources?: readonly string[]
    /**
     * Axon's own catalogue of component and line names.
     *
     * Passed IN rather than imported: the catalogue lives in the TUI, where the
     * composables it reads live, and the platform must not depend on the app it
     * serves. The names are data — the platform only writes them down.
     */
    builtins?: BuiltinRegistry
}

/**
 * Typegen — the generated type declarations of one project. The policy
 * layer: decides what "write everything" means per kind, delegating each
 * file to Generators (the mechanism — also exposed as `generate` for
 * targeted regeneration in watch mode).
 *
 * Agents: driven by a loaded blueprint (the surfaces ARE the types) —
 * axon.d.ts, tool-globals, prompts, scripts, components, env, tsconfig,
 * all into .agent/.
 *
 * Modules: the static frame plus their own tool declarations —
 * axon.d.ts, tsconfig, and tool-globals.d.ts into .module/. Those
 * declarations are the module's published surface: publish() sends them as
 * the version manifest, and the registry renders them as "what this module
 * gives your agent".
 *
 * Cognets: the ambient authoring frame — cognet-globals.d.ts (loop, kernel,
 * phase, system, defineCognet) + tsconfig into .cognet/types/. An agent with
 * an INLINE cognet gets the same declarations written into its own frame,
 * under a second tsconfig scope — see tsconfig.ts.
 */
export function Typegen(opts: TypegenOpts) {
    const { kind, root } = opts
    const generate = Generators(opts)

    return {
        /** Per-domain generators — regenerate one file when one domain changed. */
        generate,

        /** Write all declarations. Agents require the blueprint — no blueprint, no types. */
        async write(blueprint?: AxonPartialBlueprint): Promise<TypegenResult> {
            if (!KINDS[kind].frame) return EMPTY

            // Every framed kind gets the same two files. What differs is only
            // what is generated ON TOP of them.
            generate.axon()
            generate.tsconfig()

            // A prompt package's whole authoring surface is definePrompt(),
            // which generate.axon() just declared. It has no tools, scripts,
            // or blueprint to generate anything else from.
            if (kind === "prompt") return EMPTY

            /**
             * The two TUI kinds get the ambient contract plus a REGISTRY of
             * what they actually declare.
             *
             * The contract alone types the verbs; this types their arguments —
             * so `lines.set(["me:statuz"])` is a red squiggle while you type it
             * rather than a fault reported after boot, and `me:` completes to
             * whatever you registered in the same file.
             *
             * Scanned from source rather than asked of the runtime, because
             * these types have to exist BEFORE a terminal boots — that is the
             * whole point of them.
             */
            if (kind === "profile" || kind === "extension") {
                generate.registry(opts.sources ?? [root], opts.builtins)
                return EMPTY
            }

            // A module has no blueprint of its own — it is not an agent — but
            // it does have src/tools, and those declarations ARE its public
            // surface: what the registry shows a user, and what publish sends
            // as the version manifest. Scanning them here is what makes that
            // surface exist at all; without it every published module carried
            // a null manifest and rendered as "no tool declarations".
            if (kind === "module") {
                const tools = await Tools(root)
                return { ...EMPTY, toolGlobals: generate.tools(tools.entries) }
            }

            // A bench's declarations come from its own config (axes,
            // measurements), which BenchTypegen owns and the bench branch of
            // prepare() drives. The shared frame above is all this writes, so
            // the two never race to author the same files.
            if (kind === "bench" || kind === "cognet") return EMPTY

            if (!blueprint) {
                throw err("TYPEGEN_NO_BLUEPRINT")
            }

            generate.hooks(blueprint.modules ?? [])

            return {
                toolGlobals: generate.tools(blueprint.tools ?? []),
                prompts: generate.prompts(blueprint.prompts ?? []),
                scripts: generate.scripts(blueprint.scripts ?? []),
                components: await generate.components(blueprint.modules ?? []),
                env: generate.env(),
            }
        },
    }
}

export type TypegenT = ReturnType<typeof Typegen>