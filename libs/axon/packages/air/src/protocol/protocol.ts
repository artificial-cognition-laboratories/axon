import type { AirMode, AirModeType, AirProtocolName } from "../types"
import { CLASSIC_META } from "./classic"

/**
 * Protocol — one named output grammar, resolved as a unit.
 *
 * A protocol owns everything that varies between output styles together:
 * the meta prose (how the model is told to operate), the permitted modes
 * (which tags it may emit), and the structural rules the contract states.
 * These cannot be chosen independently — a protocol's prose describes the
 * exact tags its mode list permits, so one is meaningless beside another's.
 *
 * Bundling them is what makes switching a change of value. `Air({ protocol:
 * "raw" })` swaps the contract, the accepted tag set, and the prose in one
 * move, with no possibility of a half-applied grammar.
 *
 * Adding a protocol is adding an entry to PROTOCOLS. Nothing else in AIR
 * branches on the name.
 */


/**
 * One turn of the opening exchange, as DATA rather than as rendered markup.
 *
 * It used to be hand-written message strings, which made the demonstration a
 * second implementation of the format it demonstrates — the exact duplication
 * that let `<meta>` outlive two tag renames. Declared as turns and rendered
 * through the ordinary timeline renderer, the example cannot describe a
 * grammar the renderer no longer speaks: rename a tag and the preflight
 * renames with it.
 *
 * This is also the seam that makes interaction STYLE editable. The exchange
 * teaches rhythm as much as syntax — a model shown four silent working turns
 * then a report tends to work that way — and having it as data is what turns
 * that from an accident into something a protocol (and eventually a user) can
 * choose.
 */
/**
 * The AIR format's own version — NOT the package's.
 *
 * The package version tracks a monorepo release and moves for reasons that
 * have nothing to do with the grammar; this moves only when what the model
 * reads or writes changes. A consumer branching on the format needs the second
 * number, and would be misled by the first.
 *
 * Semver, read as a contract with the MODEL rather than with a compiler:
 *
 *   - major — a reply valid under the old version may be invalid now. A
 *     renamed or removed tag.
 *   - minor — new capability, old replies still valid. An added block.
 *   - patch — the prose changed. Same grammar, better explanation.
 *
 * Rendered first in the context, so a model can recognise the dialect rather
 * than infer it from shape — and so the format is identifiable in whatever
 * training corpus these conversations eventually reach. See renderVersion.
 */
export const AIR_VERSION = "1.0.0"

export type Protocol = {
    name: AirProtocolName
    /** Meta-block prose — how this protocol tells the model to operate. */
    meta: string
    /** Permitted output modes, in contract-declaration order. */
    modes: AirMode[]
    /** Structural rules stated in the contract's Rules section. */
    rules: string[]
    /** Contract examples, already entity-escaped for display to the model. */
    examples: string[]
}

/** Default descriptions for each output mode. */
/**
 * Default descriptions for each output mode.
 *
 * `script` states the CONSEQUENCE of deferred output, not just its timing.
 * "Its output returns to you on your next turn" is accurate and was not
 * enough: it reads as a detail about delivery, and a capable model still
 * wrote a template describing what its script was going to find. The fact
 * that has to be explicit is that the result does not exist yet — the model
 * is being asked not to predict a value it cannot see.
 */
export const MODE_DEFAULTS: Record<AirModeType, string> = {
    script:
        "TypeScript executed inside your persistent Bun process. Native runtime globals and declared tool namespaces are in scope. Its output returns to you on your NEXT turn — you cannot see the result in this message.",
    text:
        "Your message to the user, in markdown. Outbound communication — not a scratchpad, not narration.",
}

/**
 * The yield tag, appended to every protocol that has blocks at all.
 *
 * KNOWN DEBT, kept because nothing better works yet. Whether a turn is over
 * is a SEMANTIC question: "I see the issue, it's in the loader" and "the fix
 * is deployed" are structurally identical — same block, no script — so no
 * reduction over what a response DID can separate a progress report from a
 * final answer. Deriving it structurally stops a long run the first time the
 * model narrates between actions, which is fatal for a coding agent.
 *
 * The honest fix is a classifier judging the situation rather than the
 * response, and that is not close. Until then the model is asked, which
 * works consistently enough, and the runtime treats the answer as a signal a
 * loop may weigh rather than an instruction it obeys.
 */
export const DONE_RULE = [
    `- \`<done/>\` — end every message with this once you have nothing further to do THIS TURN. It means "I am handing control back", not "the task is complete": emit it after a final reply, and also after code whose result you want to see before continuing. A message without it means you are still working.`,
    `  Announcing work is not doing it. If your message says what you are about to do — "I am checking X next", "I will now trace Y" — you are not handing control back, so do NOT emit \`<done/>\`. Either run the thing you just described in the same message, or say nothing and run it. A turn that ends on a stated intention leaves the user waiting for something nobody is doing.`,
].join("\n")

/**
 * classic — the two-block grammar: <script> computes, <template> speaks.
 *
 * INDEPENDENT blocks. A template renders on its own and a script runs on its
 * own; neither waits for the other, which is what lets a reply stream token
 * by token while any code in it runs separately.
 *
 * THAT INDEPENDENCE IS THE ONE THING MODELS GET WRONG, so the rules state it
 * as a constraint rather than as timing. Observed with Haiku 4.5: asked what
 * a themeable surface was, it emitted a script reading the doc AND a template
 * confidently describing an API it had not read yet — inventing plausible
 * component-level tokens the platform does not have, then correcting itself a
 * turn later once the real content arrived.
 *
 * The contract had invited exactly that. It said a script's output "returns
 * to you on your next turn" (true, but reads as delivery timing) and then
 * told the model to emit both blocks "when you want to act and say something
 * about it in the same breath" — which is what the model did. No example
 * showed the dominant coding-agent pattern of act-now-speak-later, so the
 * only modelled way to act and speak was to do both at once.
 *
 * The fix is not "prefer script alone" — that would over-specify and lose the
 * legitimate case of reporting progress while working. It is to name what a
 * template may ASSERT: what you are doing is knowable when you write it, what
 * you found is not.
 *
 * That independence is the whole design. A coupled variant (a template
 * interpolating its script's bindings) reads well on paper and fights
 * streaming in practice: the template cannot render until the script has
 * closed and run, so nothing can be shown until everything is finished, and
 * whoever suspends in the middle needs both the parser and the capsule at
 * once. Every placement of that suspension crossed a boundary — into
 * cognition, into ring 0, or into a library the author has to remember to
 * apply. The idea is worth revisiting; it belongs in a cognet, built by
 * someone who wants it, not in the protocol everything else pays for.
 *
 * Turn completion is signalled by <done/> — see DONE_RULE for why the
 * model is asked rather than the loop deriving it. The prose here once
 * claimed the opposite ("there is no yield tag") while the contract shipped
 * one, which is a contradiction the model reads in a single render and
 * cannot resolve; the tag is real, and this comment now says so.
 */
const CLASSIC: Protocol = {
    name: "classic",
    meta: CLASSIC_META,
    modes: [{ type: "text" }, { type: "script" }],
    rules: [
        `At most ONE \`<text>\` and ONE \`<script>\` per message. Either may be omitted, and which you emit says what kind of turn this is: script alone is a pure action, text alone is a pure message. Several scripts in one message all run AT THE SAME TIME — a later one cannot use what an earlier one wrote, and one failure discards them all. Send one step, see what it returns, then send the next.`,
        `A text block beside a script can never report what that script found. The result does not exist until your next turn, so anything you write about it is a guess. If you need the result in order to answer, send the script ALONE and answer once you have seen it.`,
        `Emit both blocks only when the text says what you are DOING, not what you discovered — and only when it earns the user's attention. An action does not need a message stapled to it.`,
        `Speaking does not end your turn — \`<done/>\` does. You may report progress mid-task and keep working; emit \`<done/>\` only when you are handing control back.`,
        `A text block is what you are SAYING: markdown prose. No HTML, no components, no control flow.`,
        `When a required result shape is declared in your \`<scope>\`, build it in your \`<script>\` and assign it to 'result'. Never hand-write JSON — the value is serialised for you, which is what makes a large or deeply nested result as reliable as a small one.`,
    ],
    examples: [
        `Looking something up before you can answer — script ALONE, because the answer depends on what comes back:`,
        "```air",
        `<script>await fs.read("docs/theme.md")</script><done/>`,
        "```",
        `Then, on the next turn, with the content actually in front of you:`,
        "```air",
        `<text>The theme API is seven tokens: primary, background, text...</text><done/>`,
        "```",
        `Acting, then waiting to see the result:`,
        "```air",
        `<script>await fs.write("notes.md", "hello")</script><done/>`,
        "```",
        `Replying:`,
        "```air",
        `<text>message here</text><done/>`,
        "```",
        `Reporting progress WITHOUT ending the turn — no <done/>, so you keep working:`,
        "```air",
        `<text>Found the bug in the loader. Fixing it now.</text>`,
        "```",
        `Producing a declared result shape — built in TypeScript, never typed by hand:`,
        "```air",
        `<script>const result = { ok: true, files: await fs.list("src") }</script><done/>`,
        "```",
    ],
}

/**
 * raw — no grammar at all.
 *
 * For internal model calls that are not the cortex: classification,
 * summarisation, a one-shot extraction. The model is handed the context and
 * its reply is the whole message, with no blocks to comply with and no
 * <done/> to remember. Text in, text out.
 *
 * An empty mode list renders an empty <contract> and gives the parser no
 * tags, so every token flows straight through as text.
 */
const RAW: Protocol = {
    name: "raw",
    meta: "",
    modes: [],
    rules: [],
    examples: [],
}

const PROTOCOLS: Record<AirProtocolName, Protocol> = {
    classic: CLASSIC,
    raw: RAW,
}

/** Resolve a protocol by name. Unknown names are a programming error, not input. */
export function resolveProtocol(name: AirProtocolName): Protocol {
    const protocol = PROTOCOLS[name]
    if (!protocol) throw new Error(`AIR: unknown protocol "${name}"`)
    return protocol
}

