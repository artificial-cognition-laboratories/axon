import type { AxonCloudClient } from "@arclabs/cloud"
import { foldChunks, type AxonBlueprint, type AxonRequestInput, type AxonResult } from "@arcforge/types"
import { AxonHooksT, Inject } from "../platform"
import type { AxonBusT } from "../platform"
import type { AxonOutputEvent } from "@arcforge/types"
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
    /** Backs `on()` — every committed entry is announced here. */
    bus: AxonBusT
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

    // Rebuilt on every update(): the tool map is projected from the
    // blueprint's declared namespaces, so a tool added, removed or renamed by a
    // hot reload changes it. Built once, `axon.tools.github` stayed whatever
    // boot saw — an agent could call a newly added tool (the capsule was
    // reloaded) while a script calling the same tool through this handle got
    // undefined, and a tool the author deleted stayed callable here until
    // restart.
    let tools = Tools({ blueprint: opts.blueprint, kernel })

    const invoke = Invoke({ kernel })

    const handle = {
        // Getter, not a snapshot: a reload can unload the brain at any time,
        // and a consumer holding the handle must see the current answer.
        get ready() { return kernel.ready },

        prompt: prompt.render,

        prompts: {
            list: prompt.list,
        },

        request: invoke.request,

        stream: invoke.stream,

        /**
         * The sense door. Delegates straight to the session's ingest, which
         * commits the stimulus and queues it for the next wake — the buffer's
         * one drainer is the scheduler, so a stimulus is delivered exactly
         * once and then gone.
         *
         * This is the "future AxonHandle surface" session.stimuli.ingest was
         * written for; the machinery predates the verb.
         */
        stim: session.stimuli.ingest,

        /**
         * Observe what the brain emits — the counterpart to stim().
         *
         * Subscribes to the BUS rather than to the commit pipeline. Delivery
         * and durability are separate questions: an output that is one day
         * transient (a 24kHz speech stream is the same firehose problem as a
         * microphone, in reverse) must still reach the body, and wiring this
         * to the commit would silently couple the two.
         */
        on<K extends keyof AxonOutputEvent>(
            type: K,
            handler: (data: AxonOutputEvent[K]) => void | Promise<void>,
        ): () => void {
            // onAny + filter rather than on(type). Entries are FORWARDED onto
            // the bus (bus.forward) rather than declared in AxonEventMap, so
            // there is no typed channel to subscribe to — the same reason the
            // WebSocket relay reads them this way. The type parameter is the
            // contract with the caller; the filter is what enforces it.
            return opts.bus.onAny(async (event: string, payload: unknown) => {
                if (event !== type) return

                // The bus carries whole envelopes; a handler wants the fact,
                // not the correlation metadata around it.
                const data = (payload as { data?: unknown })?.data ?? payload
                try {
                    await handler(data as AxonOutputEvent[K])
                } catch (cause) {
                    // Swallowed on purpose. The emission already committed and
                    // cannot be un-emitted, and a broken speaker is not the
                    // mind's problem — a body that throws must not take the
                    // brain down with it. Logged, never propagated.
                    console.error(`[axon] handler for ${type} failed:`, cause)
                }
            })
        },

        // No tick() here. The body emits stimuli and never decides when the
        // brain looks at them: how fast frames arrive is a property of a
        // sensor, how often it is worth thinking about them is a property of
        // a mind. A cognet plugin drives kernel.tick() from inside the brain.
        //
        // This also makes bodies swappable — one that drove a specific brain
        // had to be rewritten whenever the brain changed — and it is the only
        // answer that survives composition, where two sensors at different
        // rates have no claim to being "the" tick.

        scripts: scripts,

        // Getter, not a snapshot: update() swaps the map, and a consumer
        // holding `axon.tools` must see the current one.
        get tools() { return tools },

        async update(blueprint: AxonBlueprint) {
            await kernel.update(blueprint)
            // Re-project the tool map from the blueprint that just went live,
            // so this handle and the capsule always agree on what exists.
            tools = Tools({ blueprint, kernel })
            // …and re-bind the host-side tool globals off the new map, so a
            // script sees the same set. Inject owns every globalThis write;
            // this asks it to redo them rather than reaching for the global
            // itself.
            opts.inject.runtime(handle as never, blueprint)
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
