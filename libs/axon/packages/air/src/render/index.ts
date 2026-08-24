import type { GrammarT } from "../grammar"
import type { AirMessage, AirRenderInput } from "../types"
import { renderConversation } from "./conversation"
import { preflightEntries } from "./preflight"
import { AIR_VERSION } from "../protocol/protocol"
import {
    renderContract,
    renderVersion,
    renderScope,
    renderState,
    renderSystem,
    renderTimeline,
} from "./blocks"

type RenderOpts = {
    grammar: GrammarT
}

/**
 * Whether the history renders as chat turns rather than one document.
 *
 * ON by default. The document form is retained behind
 * `AXON_AIR_TIMELINE=document` so a regression can be A/B'd against a live
 * model without a rebuild, and dropped once the measurement is in.
 */
const conversational = (): boolean => process.env.AXON_AIR_TIMELINE !== "document"

/**
 * Render — domain in, ordered messages out. Pure.
 *
 * The caller passes what it holds (base string, AxonTool[], AxonEntry[]);
 * the block renderers own every translation into protocol shape. System
 * sections (meta, scope, system, contract) become individual system messages;
 * the timeline becomes a single user message — proper conversation structure
 * rather than one monolithic system prompt.
 *
 * Section order: <meta> → <scope> → <contract> → <system> → <state>* → timeline
 *
 * ORDERED BY VOLATILITY, so a provider's prefix cache survives. meta and
 * contract are protocol constants; scope changes only when the capsule
 * reloads. Those three are the stable head. Then the tail, least to most
 * volatile: <system> is dynamic (boot.vue may be Vuedown, re-rendered every
 * call), state changes most turns, and the timeline changes every turn.
 *
 * That is why <system> now sits AFTER <contract> rather than before it — a
 * block that can change per render inside the stable prefix invalidates
 * everything behind it, which cost the whole contract on every turn.
 * Identity keeps its priority through meta naming it, not through position.
 */
export function Render(opts: RenderOpts) {
    const { grammar } = opts

    return {
        render(input: AirRenderInput): AirMessage[] {
            const messages: AirMessage[] = []

            const sys = (content: string) => {
                if (content) messages.push({ role: "system", content })
            }

            // The format's own version, before anything else — see
            // renderVersion. First so a model reads which dialect it is in
            // before it reads a single rule of it.
            sys(renderVersion(AIR_VERSION))

            // Identity FIRST.
            //
            // It sat in position four, behind twelve thousand characters of
            // scope declarations — so the first thing the model read about
            // itself came after a wall of type signatures. Every model treats
            // the head of the system prompt as the highest-authority position,
            // and who the agent is belongs there.
            //
            // This costs the caching argument that put it after <contract>:
            // boot.vue may be Vuedown and re-render per call, and a volatile
            // block at the head invalidates the prefix behind it. Taken
            // deliberately — a cache miss costs latency, and an agent that
            // reads its own identity last behaves like someone else.
            sys(renderSystem(input.base))
            sys(renderContract(grammar))
            // An output contract with no scope still renders: the required
            // shape is itself the instruction.
            if (input.scope || input.output) {
                sys(renderScope(input.scope ?? { modules: [] }, input.output))
            }

            // Caller order is preserved: which belief a mind puts first is
            // cognition, and a cognet that wants its stable blocks ahead of
            // its live ones arranges that itself.
            for (const state of input.state ?? []) sys(renderState(state))

            // The preflight exchange, ahead of everything the agent actually
            // said. See Protocol["preflight"]: the contract describes the
            // grammar, this demonstrates it, and a model continues a
            // conversation far more readily than it follows a description.
            //
            // Only when a real conversation follows. On an empty history it
            // would BE the conversation, and the model would answer a systems
            // check nobody asked for.
            if (input.preflight !== false && input.history && input.history.length > 0 && conversational()) {
                // Rendered through the SAME renderer the real history uses, so
                // the demonstration cannot describe a grammar the renderer no
                // longer speaks. Hand-written markup made the preflight a
                // second implementation of the format — the duplication that
                // let `<meta>` outlive two tag renames.
                messages.push(...renderConversation(preflightEntries(grammar.preflight), grammar, { idPrefix: "p" }))
            }

            if (input.history && input.history.length > 0) {
                // The history as a real conversation, or as one document.
                //
                // A captured failing context showed the whole problem: the
                // user's words arrived nested inside `<timeline><user …>` in a
                // single `user` message, and the model's own past replies were
                // in there too — so it never saw an `assistant` turn in its own
                // context. Nothing demonstrated what its output should look
                // like, and it emitted empty `<template>` blocks: the shape it
                // was told to produce, with the content gone.
                //
                // Kept switchable while both are measured against real models.
                // Default is read per render rather than captured at import so
                // a run can be flipped without a rebuild.
                if (conversational()) messages.push(...renderConversation(input.history, grammar))
                else messages.push({ role: "user", content: renderTimeline(input.history, grammar) })
            }

            return messages
        },
    }
}

export type RenderT = ReturnType<typeof Render>
