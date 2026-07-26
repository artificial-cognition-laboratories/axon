import type { AxonCloudClient } from "../../../../cloud/src"
import { foldChunks, type AxonBlueprint, type AxonRequestInput, type AxonResult } from "@arcforge/types"
import { AxonHooksT } from "../platform/hooks"
import { Inject } from "../platform/inject"
import { Prompt } from "./source/render"
import { Scripts } from "./source/scripts"
import { Tools } from "./source/tools"
import { AxonKernelT } from "../kernel"
import type { AxonSessionT } from "../kernel/session"

type AxonHandleOpts = {
    cloud: AxonCloudClient
    hooks: AxonHooksT
    blueprint: AxonBlueprint
    kernel: AxonKernelT
    session: AxonSessionT
    inject: ReturnType<typeof Inject>
}

/**
 * Composes the runtime-facing handle — the `axon` global agent code sees.
 * Connection lifecycle lives in Backend(); AxonHandle just forwards to it,
 * same as it forwards to session/scripts/prompt.
 *
 * Must satisfy the AxonHandle contract in @arcforge/types — that contract is
 * the public API surface; anything extra here is core-internal. No thread
 * concept: one Axon() instance is always exactly one continuous stream.
 */
export function AxonHandle(opts: AxonHandleOpts) {
    const kernel = opts.kernel
    const session = opts.session

    const prompt = Prompt({
        blueprint: opts.blueprint,
    })

    const scripts = Scripts({
        blueprint: opts.blueprint,
        inject: opts.inject,
    })

    const tools = Tools({
        blueprint: opts.blueprint,
        kernel: kernel,
    })

    // public surface takes a prompt (or bare string); the kernel takes content
    function toKernelInput(input: AxonRequestInput | string) {
        const normalized = typeof input === "string" ? { prompt: input } : input
        return { content: normalized.prompt }
    }

    async function request(input: AxonRequestInput | string): Promise<AxonResult> {
        const { entries } = await kernel.request(toKernelInput(input))
        const text = foldChunks(entries)
            .filter(e => e.type === "cognet:output:text")
            .map(e => (e.data as { content: string }).content)
            .join("\n")
        return { text, entries }
    }

    function stream(input: AxonRequestInput | string) {
        return kernel.stream(toKernelInput(input))
    }

    const handle = {
        prompt: prompt.render,

        prompts: {
            list: prompt.list,
        },

        request: (input: AxonRequestInput | string) => request(input),

        stream: (input: AxonRequestInput | string) => stream(input),

        scripts: scripts,

        tools: tools,

        async update(blueprint: AxonBlueprint) {
            await kernel.update(blueprint)
        },

        // expose lifecycle hooks — one call point, awaited in order, runtime-fired
        hooks: {
            hook: opts.hooks.hook,
            removeHook: opts.hooks.removeHook,
        },

        /** minimal session identity — enough for a script to key its own state or logging */
        session: {
            get id() { return session.id },
        },
    }

    return handle
}
