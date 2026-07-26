import { Grammar, type AirOpts } from "./grammar"
import { Parser } from "./parse"
import { Render } from "./render"

/**
 * Air — the AIR format contract as one handle.
 *
 * Render (what the model sees) and Parse (what the model emits back) are two
 * halves of one grammar. Air() resolves that grammar once and hands it to
 * both, so they cannot drift: enabling a mode changes the <contract> block
 * and the parser's accepted tags together.
 *
 * The kernel constructs Air once per agent; render() runs every tick,
 * parser() creates one stateful parser per engine call.
 */
export function Air(opts: AirOpts = {}) {
    const grammar = Grammar(opts)
    const render = Render({ grammar })

    return {
        grammar,

        /** Pure: context in → ordered messages out. */
        render: render.render,

        /** One parser per engine call: { feed(chunk), flush() }. */
        parser: () => Parser({ grammar }),
    }
}

export type AirT = ReturnType<typeof Air>
export type AirParserT = ReturnType<AirT["parser"]>
