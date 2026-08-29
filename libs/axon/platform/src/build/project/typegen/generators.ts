import type { AxonModule, AxonPrompt, AxonScript, AxonTool } from "@arcforge/types"
import { generateAxonDts } from "./axon-dts"
import { generateComponentTypes } from "./components"
import { generateEnvTypes } from "./env"
import { generateHookTypes } from "./hooks"
import { generatePromptTypes } from "./prompts"
import { generateScriptTypes } from "./scripts"
import { generateToolGlobals } from "./tools"
import { ensureProjectTsConfig } from "./tsconfig"
import type { TypegenKind } from "./write"
import { generateCognetDts } from "./cognet-dts"
import { generatePromptDts } from "./prompt-dts"
import { generateTuiDts } from "./tui-dts"
import { generateRegistryDts, type BuiltinRegistry } from "./registry-dts"
import { inlineCognetDir } from "../../blueprint/cognet"
import { KINDS } from "../kinds"

type GeneratorsOpts = {
    root: string
    kind: TypegenKind
}

/**
 * Generators — the individual declaration writers, bound to one project.
 * The mechanism layer under Typegen: each verb writes exactly one file and
 * returns its entry count, so watch mode can regenerate a single domain
 * when a single domain changed.
 */
export function Generators(opts: GeneratorsOpts) {
    const { root, kind } = opts

    return {
        /** The kind's ambient declaration frame — axon.d.ts, or a cognet's/prompt's globals.d.ts. */
        axon(): void {
            if (KINDS[kind].globals === "cognet") {
                generateCognetDts(root)
                return
            }
            if (KINDS[kind].globals === "prompt") {
                generatePromptDts(root)
                return
            }
            if (KINDS[kind].globals === "tui") {
                generateTuiDts(root, kind)
                return
            }
            generateAxonDts(root, kind)

            // An agent that writes its own brain gets the cognet authoring
            // surface too — a SECOND ambient scope in the same frame, kept
            // apart from the agent's by the tsconfig pair in tsconfig.ts.
            // Both are written unconditionally here; which files each scope
            // can see is that writer's decision, not this one's.
            if (kind === "agent" && inlineCognetDir(root)) {
                generateCognetDts(root, "agent")
            }
        },

        /**
         * What a config REGISTERS, as completable names — profile and
         * extension kinds only.
         *
         * `sources` are scanned in load order; `builtins` is Axon's own
         * catalogue, handed in because it lives in the TUI and the platform
         * must not reach into the app it serves.
         */
        registry(sources: readonly string[], builtins?: BuiltinRegistry): void {
            generateRegistryDts(root, kind, sources, builtins)
        },

        /** The canonical tsconfig for the generated-types dir. */
        tsconfig(): void {
            ensureProjectTsConfig(root, kind)
        },

        /** tool-globals.d.ts from blueprint tool surfaces. */
        tools(tools: AxonTool[]): number {
            return generateToolGlobals(root, tools, kind)
        },

        /** prompts.d.ts — AxonPromptMap augmentation. */
        prompts(prompts: AxonPrompt[]): number {
            return generatePromptTypes(root, prompts)
        },

        /** scripts.d.ts — AxonScriptMap augmentation. */
        scripts(scripts: AxonScript[]): number {
            return generateScriptTypes(root, scripts)
        },

        /** components.d.ts — Vue GlobalComponents, agent wins over modules. */
        components(modules: AxonModule[]): Promise<number> {
            return generateComponentTypes(root, modules)
        },

        /** hooks.d.ts — AxonModuleEvents augmentation from installed modules' emits. */
        hooks(modules: AxonModule[]): number {
            return generateHookTypes(root, modules)
        },

        /** env.d.ts from the project's .env keys. */
        env(): number {
            return generateEnvTypes(root)
        },
    }
}

export type GeneratorsT = ReturnType<typeof Generators>
