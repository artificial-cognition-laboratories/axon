import type { AxonCloudClient } from "@arclabs/cloud"
import { foldChunks, type AxonBlueprint, type AxonRequestInput, type AxonResult } from "@arcforge/types"
import { AxonHooksT, Inject } from "../platform"
import { Prompt } from "./source/render"
import { Scripts } from "./source/scripts"
import { Tools } from "./source/tools"
import { AxonKernelT } from "@arcforge/kernel"
import type { AxonSessionT } from "@arcforge/session"

type AxonHandleOpts = {
    cloud: AxonCloudClient
    hooks: AxonHooksT
    blueprint: AxonBlueprint
    kernel: AxonKernelT
    session: AxonSessionT
    inject: ReturnType<typeof Inject>
}

/**
 * Invoke — the handle's two invocation verbs.
 *
 * Owns the whole translation between the public shape and the kernel's:
 * the public surface takes a prompt (or a bare string), the kernel takes
 * content, and `request` additionally folds the wake's entries into the
 * single `text` a caller expects. Split out so AxonHandle below stays pure
 * composition — it wires organs together and exposes a shape, it does not
 * reshape payloads.
 */
function Invoke(opts: { kernel: AxonKernelT }) {
    const { kernel } = opts

    /** The public surface takes a prompt; the kernel takes content. */
    function toKernelInput(input: AxonRequestInput | string) {
        const normalized = typeof input === "string" ? { prompt: input } : input
        return { content: normalized.prompt }
    }

    return {
        /**
         * Run to completion. `text` is every text output the wake produced,
         * chunk-folded and joined — the one-line answer a caller usually
         * wants — with the full entry list alongside it for anyone who needs
         * the causal detail.
         */
        async request(input: AxonRequestInput | string): Promise<AxonResult> {
            const { entries } = await kernel.request(toKernelInput(input))
            const text = foldChunks(entries)
                .filter(e => e.type === "cognet:output:text")
                .map(e => (e.data as { content: string }).content)
                .join("\n")
            return { text, entries }
        },

        /** The same invocation, as a live entry stream plus an interrupt handle. */
        stream(input: AxonRequestInput | string) {
            return kernel.stream(toKernelInput(input))
        },
    }
}

/**
 * Composes the runtime-facing handle — the `axon` global agent code sees.
 *
 * Pure composition: builds each organ (prompt, scripts, tools, invoke) and
 * exposes one coherent shape over them. Anything with logic of its own lives
 * in the organ that owns it, never here.
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

    const invoke = Invoke({ kernel })

    const handle = {
        prompt: prompt.render,

        prompts: {
            list: prompt.list,
        },

        request: invoke.request,

        stream: invoke.stream,

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

        /**
         * Session identity and logs, read-only. Getters rather than a snapshot:
         * the underlying arrays are live and a consumer reading `entries` must
         * see the current state, not whatever existed when the handle was built.
         */
        session: {
            get id() { return session.id },
            get entries() { return session.entries },
            get log() { return session.log },
            get kernelLog() { return session.kernelLog },
        },
    }

    return handle
}
