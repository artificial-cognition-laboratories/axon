import type { GrammarT } from "../grammar"
import type { AirMessage, AirRenderInput } from "../types"
import {
    renderContract,
    renderMeta,
    renderScope,
    renderSystem,
    renderTimeline,
} from "./blocks"

type RenderOpts = {
    grammar: GrammarT
}

/**
 * Render — domain in, ordered messages out. Pure.
 *
 * The caller passes what it holds (base string, AxonTool[], AxonEntry[]);
 * the block renderers own every translation into protocol shape. System
 * sections (meta, scope, system, contract) become individual system messages;
 * the timeline becomes a single user message — proper conversation structure
 * rather than one monolithic system prompt.
 *
 * Section order: <meta> → <scope> → <system> → <contract> → timeline
 */
export function Render(opts: RenderOpts) {
    const { grammar } = opts

    return {
        render(input: AirRenderInput): AirMessage[] {
            const messages: AirMessage[] = []

            const sys = (content: string) => {
                if (content) messages.push({ role: "system", content })
            }

            sys(renderMeta(grammar))
            if (input.scope) sys(renderScope(input.scope))
            sys(renderSystem(input.base))
            sys(renderContract(grammar))

            if (input.history && input.history.length > 0) {
                messages.push({ role: "user", content: renderTimeline(input.history) })
            }

            return messages
        },
    }
}

export type RenderT = ReturnType<typeof Render>
