import type { AxonEntry, AxonScope, AxonScopeModule } from "@arcforge/types"
import { foldChunks } from "@arcforge/types"
import type { AirState, AirStateLang } from "../types"
import { DONE_RULE } from "../protocol"
import type { GrammarT } from "../grammar"
import { formatCapsuleOutput } from "./output"
import { esc, escAttr, escCode, fenceFor, indent, normalizeCode } from "./text"

/**
 * The AIR section renderers — one function per block of the context window.
 *
 * These own the DOMAIN → protocol translation: AxonTool[] → <scope>
 * declarations, AxonEntry[] → <timeline> items. Callers pass what they
 * hold; nothing here is exported to userland but the block renderers.
 *
 * Note on escaping: <meta> and <contract> pass their prose through RAW —
 * `grammar.meta` and the rules below are not run through esc(). So the tags
 * they name must be written literally, and for a long time they were not:
 * the source pre-escaped them for a renderer that escapes, this one does not,
 * and the model read `&lt;script&gt;` in every instruction telling it which
 * tags to emit. Thirty-six entities reached it per call.
 *
 * The rule: text destined for a raw block is written as the model must read
 * it. Only <system>, <user>, <text> and <stdout> bodies are escaped, and
 * those carry content rather than instruction.
 */

/**
 * <meta> — how the model is told to operate, owned by the protocol.
 *
 * A protocol with no prose (raw) renders nothing at all rather than an empty
 * wrapper: an internal one-shot call should receive the caller's system
 * block and nothing else.
 */
export function renderMeta(grammar: GrammarT): string {
    if (!grammar.meta) return ""
    return grammar.meta
}

/**
 * <scope> — the capsule's authoritative executable TypeScript declarations.
 * AIR owns protocol formatting only: flat modules become top-level `declare`
 * bindings and namespaced modules become `declare namespace` blocks.
 *
 * Ambient types (AxonTool.ambientTypes — interfaces/type aliases a tool's
 * functions reference, e.g. a return type declared in a sibling file) are
 * inlined once at the top, deduped by exact text — the model must never
 * see `Promise<DeployStatus>` with no DeployStatus definition anywhere in
 * context. Same convention the IDE's tool-globals.d.ts uses (see
 * tui/platform/build/project/typegen/tools.ts) — this and that file must
 * never diverge in shape, only audience.
 */
export function renderScope(scope: AxonScope, output?: string): string {
    const modules = scope.modules.filter(module => module.members.length > 0)
    // A scope with nothing callable still renders when something is
    // unavailable: "you have no tools" and "your tools failed to load" are
    // different situations, and the second is the one worth saying.
    if (modules.length === 0 && !output && !scope.unavailable?.length) return ""

    const ambientTypes = [...new Set(modules.flatMap(t => t.ambientTypes ?? []))]
    const sections = [...ambientTypes, ...modules.map(toolDeclarations)]

    // The required output goes LAST and labelled: it is the one binding the
    // model must produce rather than one it may call, and it reads as the
    // task's target when it sits after the capabilities available to reach
    // it. A structured request with no tools still renders a scope — the
    // shape is the whole instruction in that case.
    if (output) {
        sections.push(
            `/** REQUIRED: your <script> must declare \`result\` with exactly this type. */\n${output}`,
        )
    }

    // What the agent declares but does not have this session, INSIDE the scope
    // block and last.
    //
    // Inside, because the scope is the single answer to "what can I call" and a
    // capability listed somewhere else is one the model has to remember to
    // cross-reference. Last, because it is the exception to everything above
    // it. As a comment rather than a declaration: it must never look callable.
    if (scope.unavailable?.length) {
        const lines = scope.unavailable.map(item => ` * - ${item.name}: ${item.reason}`)
        sections.push(
            "/**\n * UNAVAILABLE this session — these failed to load. Do not call them,\n"
            + " * and say so plainly if asked to do something that needs one.\n"
            + `${lines.join("\n")}\n */`,
        )
    }

    return `<scope lang="ts">\n${indent(sections.join("\n\n"), 4)}\n</scope>`
}

function toolDeclarations(module: AxonScopeModule): string {
    // Every export is a top-level global under its own name, so each needs
    // its own `declare`. The module name groups them for the reader; it is
    // not a namespace the model addresses through.
    const members = module.members.map(member => {
        const jsdoc = member.jsdoc ? `${jsdocBlock(member.jsdoc)}\n` : ""
        return `${jsdoc}declare ${member.declaration}`
    })

    const header = module.description ? `${jsdocBlock(module.description)}\n` : ""
    return `${header}${members.join("\n\n")}`
}

function jsdocBlock(text: string): string {
    const lines = text.split("\n")
    if (lines.length === 1) return `/** ${text} */`
    return `/**\n${lines.map(l => ` * ${l}`.trimEnd()).join("\n")}\n */`
}

/**
 * The format's own version, first in the context.
 *
 * A stable, machine-readable declaration of which AIR a reply must satisfy.
 * It costs one short line and buys three things:
 *
 *   - A model can recognise the format rather than infer it. The tags, the
 *     one-of-each rule and the `<done/>` convention are a dialect; naming it
 *     gives a model something to key on that survives being embedded in a
 *     larger prompt.
 *   - Training data gets a marker. The whole reason to fix a canonical format
 *     is so models eventually know it natively, and that starts with the
 *     format being IDENTIFIABLE in the corpus. The earlier the marker exists,
 *     the more of that corpus carries it.
 *   - It becomes the seam for change. A future AIR that renames a tag or adds
 *     a block can say so, and a model (or a parser) can branch on the version
 *     instead of guessing from shape.
 *
 * Deliberately a `<system>` block like everything else instructional, rather
 * than a bespoke tag: the context has exactly one family for "the runtime is
 * telling you something", and a fourth top-level element would be one more
 * thing to explain for no information the type attribute cannot carry.
 */
export function renderVersion(version: string): string {
    return `<system type="air" version="${escAttr(version)}"/>`
}

/**
 * <system type="session:start"/> — where demonstration ends and the real
 * conversation begins.
 *
 * The preflight is a few-shot demonstration rendered as genuine user and
 * assistant turns, because a model continues a conversation far more readily
 * than it follows a description (see Render).
 *
 * DELIBERATELY UNEXPLAINED. The contract says nothing about this tag, and the
 * preflight turns carry no attribute marking them as examples — see
 * Protocol["preflight"], which is explicit that few-shot works precisely
 * because the turns are indistinguishable from real ones. This marks the
 * BOUNDARY, never the demonstration: nothing here tells the model the turns
 * above it were fake, so there is nothing for it to discount.
 *
 * That it is a `<system>` block is what keeps it out of the model's output.
 * The contract declares a closed list of tags the model may emit and
 * `<system>` is not among them — unlike an attribute on a tag the model DOES
 * emit, which is how `from="agent"` ended up in replies.
 *
 * A self-closing marker rather than a wrapper around the preflight, for the
 * same reason `renderVersion` is one: the blocks it separates are already
 * separate MESSAGES in the rendered array, and an element spanning several
 * messages cannot be expressed. A boundary is a point, so it renders as one.
 *
 * Emitted at the head of the session's FIRST turn rather than as a message of
 * its own — a message would be a user turn immediately before another user
 * turn, which providers variously reject or silently merge. See Render.
 *
 * Rendered ONLY when a preflight actually precedes real history. With nothing
 * before it there is no boundary to mark, and a marker announcing the start
 * of something that started at the top of the document is noise the model
 * still has to read past.
 *
 * The viewer reads the same tag. That is deliberate over a display-time
 * comment (see RESPONSE_MARK): the pane is handed `messages` verbatim, so a
 * marker it invents is a second mechanism that can disagree with what the
 * model was actually sent. One tag, both consumers.
 */
export function renderSessionStart(): string {
    return `<system type="session:start"/>`
}

export function renderSystem(system?: string): string {
    // `type="user"` because that is whose instructions these are.
    //
    // The block holds `boot.vue` — what the AGENT'S OWNER wrote about who it
    // is and how it should work. Naming it "identity" described the content;
    // naming it by SOURCE matches every other block in the format, where
    // `from="user"` on a text turn means the same person. One word, one
    // meaning, wherever it appears.
    //
    // No identity renders NOTHING, not an empty block. An empty
    // `<system></system>` was harmless when it sat fourth, behind twelve
    // thousand characters of scope. It is not harmless first: the very first
    // thing the model reads about itself becomes a declared-and-blank
    // identity, which is worse than no claim at all. `Render` drops empty
    // sections, so returning "" removes the message entirely.
    if (!system) return ""
    return `<system type="user" lang="md">\n${system}\n</system>`
}

/**
 * Serialize a state block's content.
 *
 * A string is authored output and passes through untouched — a cognet that
 * formatted its own material must not have that reformatted underneath it.
 * Anything else is a value, serialized per the block's declared `lang`.
 *
 * `yaml` and `ts` are declared in the type but not yet implemented, and
 * throw rather than silently emitting JSON under a lang attribute that
 * claims otherwise: a model told it is reading YAML and handed JSON has
 * been lied to in the one place the format exists to be precise about.
 */
function serializeState(content: unknown, lang: AirStateLang): string {
    if (typeof content === "string") return content
    if (lang === "json") return JSON.stringify(content, null, 2)
    throw new Error(`AIR: <state lang="${lang}"> is not implemented — pass a pre-rendered string, or use lang="json"`)
}

/**
 * <state> — one named assertion of what is currently true.
 *
 * The whole surface for putting arbitrary data in front of a model. AIR
 * knows the shape of the block and nothing about what any given block MEANS
 * — a knowledge catalogue, a world model and a goal stack render through
 * exactly this function, which is what stops AIR growing a renderer per
 * concept.
 *
 * `lang` is on the tag rather than implied, so a model reading a block knows
 * how to parse it before it starts. `description` is optional because a
 * well-named block often needs none, and absent attributes are omitted
 * rather than rendered empty — an attribute with nothing in it is noise the
 * model still has to read past.
 */
export function renderState(state: AirState): string {
    const lang = state.lang ?? "json"
    const attrs = [
        `name="${escAttr(state.name)}"`,
        ...(state.description ? [`description="${escAttr(state.description)}"`] : []),
        `lang="${escAttr(lang)}"`,
    ]
    return `<state ${attrs.join(" ")}>\n${indent(serializeState(state.content, lang), 4)}\n</state>`
}

/**
 * <contract> — the output grammar, rendered from the resolved protocol.
 *
 * Blocks, rules, and examples all come from the grammar rather than being
 * branched on here: a protocol states its own rules and shows its own
 * examples, so adding one never edits this function. An empty mode list
 * (the raw protocol) renders an empty contract — no grammar to comply with.
 */
export function renderContract(grammar: GrammarT): string {
    const meta = renderMeta(grammar)
    if (grammar.modes.length === 0) return meta ? `<system type="contract" lang="md">\n${indent(meta, 4)}\n</system>` : ""

    const modeLines = grammar.modes.map(m => `- \`<${m.type}>\` — ${grammar.describe(m)}`)
    modeLines.push(DONE_RULE)

    // The tag list is stated as CLOSED, and the limit stated with it.
    //
    // Describing each block individually left the grammar open-ended by
    // omission: nothing said the language had a boundary, and models invented
    // tags and sent four and five scripts in one message. A model given an
    // unbounded tag language will use it — so the boundary is named once,
    // before the list, rather than implied by the list's length.
    //
    // Derived from `modes` rather than written out, so a protocol that adds or
    // removes a block cannot leave this sentence describing the old set.
    const tags = [...grammar.modes.map(m => `\`<${m.type}>\``), "`<done/>`"]
    const closed = [
        `These ${tags.length} tags are the ONLY ones you may emit: ${tags.join(", ")}.`,
        `At most one of each, per message. Every one is optional, but a message containing none of them is not a valid reply — prose outside a block is discarded unread.`,
    ].join(" ")

    // Meta leads, because it describes the machine the blocks run on — a rule
    // about `<script>` means nothing before you know what a script IS. They
    // were two blocks and are now one: `<meta>` was a tag whose whole content
    // was "how to operate", which is what a contract is.
    const sections = [...(meta ? [meta] : []), `## Blocks`, closed, modeLines.join("\n")]

    if (grammar.rules.length > 0) {
        sections.push(`## Rules`, grammar.rules.map(r => `- ${r}`).join("\n"))
    }
    if (grammar.examples.length > 0) {
        sections.push(`## Examples`, grammar.examples.join("\n"))
    }

    return `<system type="contract" lang="md">\n${indent(sections.join("\n\n"), 4)}\n</system>`
}

/**
 * <timeline> — the event history. AIR owns the AxonEntry → rendered-turn
 * translation via the exhaustive switch below: this is the single chokepoint
 * where a new entry-event type must decide its rendering, and it lives next
 * to the parser it has to agree with.
 */
/**
 * The history, folded and filtered into the turns a renderer will emit.
 *
 * Extracted because there are two renderings of the same sequence — one
 * document, one conversation — and every rule about WHICH turns survive
 * (chunk folding, wake grouping, dropping a stale rejection) is identical in
 * both. Only the final shaping differs.
 */
export function timelineItems(entries: readonly AxonEntry[]): RenderedItem[] {
    // chunked emissions fold to one turn each — the group is the fact
    // (AxonChunk standard); the model never sees transport granularity
    //
    // `runId` rides along because ONE MODEL MESSAGE IS ONE WAKE: a reply
    // containing both a template and a script commits several entries that
    // all share it. Without it every entry rendered as its own <agent> turn,
    // so a single message came back as two — with the script's own stdout
    // interleaved between them. A model reading that saw a template it had
    // written blind sitting AFTER a result, indistinguishable from one
    // properly derived from it, and treated its own guess as established
    // fact. The fidelity of this record is what the next turn reasons from.
    const items: RenderedItem[] = []
    for (const entry of foldChunks(entries)) {
        const item = timelineItem(entry)
        if (item) items.push({ ...item, runId: entry.context?.runId })
    }

    // ONE rejected exchange renders, ever: the newest, and only while nothing
    // has happened since.
    //
    // A model that sees its own bad output, the correction, and then its own
    // corrected output has been shown a worked example. A model that sees
    // THREE bad outputs and three corrections has been shown that producing
    // malformed output is what happens here — and every retry after that gets
    // worse, which is the spiral this rule exists to stop.
    //
    // Scoping by WAKE does not do it. Retries all happen inside one wake by
    // construction, so a run that failed three times had all three failures
    // sharing a runId and all three surviving — the exact accumulation the
    // scoping was meant to prevent, reintroduced by scoping to the wrong unit.
    //
    // A rejection and the correction it earned are ONE exchange — dropping
    // either alone leaves a correction with no subject, or output with no
    // verdict, both worse than dropping the pair. The record keeps
    // everything; this is the RENDER only.
    const isRejected = (item: RenderedItem): boolean =>
        item.type === "malformed" || (item.type === "system" && item.systemType === "format-violation")

    const rejections = items.filter(isRejected)
    if (rejections.length > 0) {
        // The current exchange: the newest entry plus the one directly beside
        // it of the other kind. Adjacency is not a guess — the kernel commits
        // the pair together, malformed first.
        const newest = rejections.at(-1)!
        const newestIndex = items.lastIndexOf(newest)
        const before = items[newestIndex - 1]
        const partner = newestIndex > 0 && before && isRejected(before) && before.type !== newest.type
            ? before
            : undefined

        // Stale the moment anything follows it. A correction the model has
        // already acted on is a record of a mistake it no longer needs.
        const currentRun = items.at(-1)?.runId
        const superseded = newest.runId !== undefined && currentRun !== undefined && newest.runId !== currentRun

        for (let i = items.length - 1; i >= 0; i--) {
            if (!isRejected(items[i]!)) continue
            const keep = !superseded && (items[i] === newest || items[i] === partner)
            if (!keep) items.splice(i, 1)
        }
    }

    return items
}

/**
 * <timeline> — the event history as ONE document.
 *
 * AIR owns the AxonEntry → rendered-turn translation via the exhaustive
 * switch below: this is the single chokepoint where a new entry-event type
 * must decide its rendering, and it lives next to the parser it has to agree
 * with.
 */
export function renderTimeline(entries: readonly AxonEntry[], grammar: GrammarT): string {
    // One vocabulary, every protocol: a model reads its own history in the
    // same tags its contract declares. There is nothing to branch on.
    const codeTag = "script"
    const speechTag = "text"

    const items = timelineItems(entries)
    if (items.length === 0) return `<timeline></timeline>`

    let userCount = 0
    let execCount = 0
    // Maps consumer-supplied execute IDs (UUIDs etc.) to short rendered IDs (e1, e2, ...)
    const execIdMap = new Map<string, string>()

    const shortExecId = (rawId: string): string => {
        if (!execIdMap.has(rawId)) execIdMap.set(rawId, `e${++execCount}`)
        return execIdMap.get(rawId)!
    }

    /** One block the model itself emitted. */
    const agentBlock = (item: RenderedItem): string => {
        // The turn boundary, inside the turn it ends.
        if (item.type === "done") return `        <done from="agent"/>`
        if (item.type === "message") {
            return `        <${speechTag} from="agent" lang="${escAttr(item.lang)}">\n${indent(esc(item.content.trim()), 12)}\n        </${speechTag}>`
        }
        if (item.type === "execute") {
            const id = shortExecId(item.id)
            return `        <${codeTag} from="agent" id="${id}" lang="${escAttr(item.lang)}">\n${indent(escCode(normalizeCode(item.code.trim())), 12)}\n        </${codeTag}>`
        }
        return ""
    }

    const lines: string[] = []

    /**
     * Group consecutive agent blocks that share a runId into ONE <agent> turn.
     *
     * A `result` deliberately breaks the group and renders outside it: stdout
     * is the world answering, not the agent speaking, so folding it in would
     * claim the agent said something it did not. What this restores is the
     * distinction the flat renderer destroyed — a template and a script the
     * model emitted TOGETHER now sit in one turn, ahead of the stdout that
     * followed, so a template written before any result is visibly that,
     * rather than looking like a considered reply to one.
     */
    for (let i = 0; i < items.length; i++) {
        const item = items[i]!

        if (item.role === "user") {
            // The channel is the RETURN ADDRESS, and without it on the turn
            // the mind cannot answer what it just heard. It used to be absent
            // here, which is why a channel module had to smuggle its address
            // into the content — where the model reads it as something a human
            // typed, and echoes it back.
            //
            // An attribute rather than a prefix: routing is metadata about the
            // turn, not words in it. Every turn carries one so the mind never
            // has to infer a default, and a terminal message is visibly from
            // somewhere rather than from nowhere.
            const channel = escAttr(item.channel ?? "terminal")
            lines.push(`    <text from="user" id="u${++userCount}" channel="${channel}" lang="${escAttr(item.lang)}">\n${indent(esc(item.content.trim()), 8)}\n    </text>`)
            continue
        }

        // A run cut short — its own top-level marker, like `<done/>`.
        //
        // It renders as a `<system type="interrupt">` before, which made it one
        // of several things wearing the generic system tag. An interrupt is a
        // distinct kind of event with its own sources and its own attributes,
        // and giving it a tag is what lets those attributes mean something
        // rather than being keys in a bag.
        if (item.type === "interrupt") {
            const from = item.from ? ` from="${escAttr(item.from)}"` : ""
            lines.push(`    <interrupt${from} reason="${escAttr(item.reason)}"/>`)
            continue
        }

        if (item.type === "system") {
            const extra = Object.entries(item.attributes ?? {})
                .filter(([key]) => key !== "type" && key !== "lang")
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => ` ${key}="${escAttr(value)}"`)
                .join("")
            lines.push(`    <system type="${escAttr(item.systemType)}" lang="${escAttr(item.lang)}"${extra}>\n${indent(esc(item.content.trim()), 8)}\n    </system>`)
            continue
        }

        if (item.type === "result") {
            const ok = item.ok ? ` ok="true"` : ` ok="false"`
            // The error goes in the BODY, not an attribute.
            //
            // A thrown message is arbitrary multi-line text — a stack trace, a
            // pretty-printed Promise.all argument list — and neither escaper
            // here encodes a newline, so a real failure produced an attribute
            // spanning fifteen lines and broke the markup it was meant to
            // describe. `kind` stays an attribute because it is a closed set
            // of single words; the message is content and is rendered as such.
            const kindAttr = item.error ? ` error="${escAttr(item.error.kind)}"` : ""
            const body = item.error
                ? [esc(`${item.error.kind}: ${item.error.message}`), esc(formatCapsuleOutput(item.content.trim()))]
                    .filter(part => part.length > 0).join("\n\n")
                : esc(formatCapsuleOutput(item.content.trim()))
            lines.push(`    <stdout for="${shortExecId(item.for)}" lang="${escAttr(item.lang)}"${ok}${kindAttr}>\n${indent(body, 8)}\n    </stdout>`)
            continue
        }

        // A rejected reply is a WHOLE message, not a block within one.
        //
        // It stands alone rather than joining the grouping below: its text is
        // the entire thing the model sent on that attempt, and folding it in
        // beside valid blocks from the same wake would present the rejected
        // output and the accepted output as one turn — which is the exact
        // confusion the echo exists to remove.
        //
        // Rendered raw inside a fence. The parser already failed on this text,
        // so there is no structure to claim; what the model needs is to see
        // the bytes it actually produced, with the tags intact.
        if (item.type === "malformed") {
            const stamped = item.content.trim().replace(
                /<(text|script)(\s[^>]*?)?>/g,
                (_m, tag: string, attrs: string | undefined) => `<${tag}${attrs ?? ""} status="rejected">`,
            )
            lines.push(stamped === item.content.trim()
                ? `    <text from="agent" status="rejected" lang="md">\n${indent(esc(item.content.trim()), 8)}\n    </text>`
                : indent(stamped, 4))
            continue
        }

        // An agent turn: this block plus every following one from the same
        // wake. A missing runId groups with nothing — an entry whose origin
        // is unknown must not be folded into a neighbour's turn.
        const blocks = [agentBlock(item)]
        while (
            item.runId !== undefined
            && items[i + 1]?.role === "agent"
            && items[i + 1]?.type !== "result"
            && items[i + 1]?.type !== "malformed"
            && items[i + 1]?.runId === item.runId
        ) {
            blocks.push(agentBlock(items[++i]!))
        }

        lines.push(`    <agent>\n${blocks.filter(Boolean).join("\n")}\n    </agent>`)
    }

    return `<timeline>\n${lines.filter(Boolean).join("\n\n")}\n</timeline>`
}

// ── domain → timeline item ────────────────────────────────────────────────────
//
// The rendered-turn shapes are private to this file: callers pass
// AxonEntry, AIR translates. Kept minimal — role + type + payload the
// renderer above consumes.

/**
 * A timeline item plus the wake it came from.
 *
 * `runId` is what lets the renderer reassemble ONE model message from the
 * several entries it committed — see the grouping loop in renderTimeline.
 */
export type RenderedItem = TimelineItem & { runId?: string }

/**
 * Every block declares its `lang`.
 *
 * A model attends better to content whose kind is named BEFORE it starts
 * reading: prose and code and captured output are different things to parse,
 * and the tag alone does not say which — `<stdout>` might be JSON, a stack
 * trace, or nothing. `<system>` carried one from the start; the rest inferred
 * it from position, which is exactly the guess this removes.
 */
type TimelineItem =
    | { role: "user"; type: "message"; content: string; channel?: string; lang: string }
    | { role: "agent"; type: "message"; content: string; lang: string }
    | { role: "agent"; type: "execute"; id: string; lang: string; code: string }
    | { role: "agent"; type: "malformed"; content: string; code: string; attempt: number }
    | { role: "agent"; type: "done" }
    | { role: "system"; type: "interrupt"; reason: string; from?: string }
    | { role: "agent"; type: "result"; for: string; ok: boolean; content: string; lang: string; error?: { kind: "timeout" | "policy" | "interrupt" | "exception"; message: string } }
    | { role: "system"; type: "system"; systemType: string; lang: string; content: string; attributes?: Record<string, string> }

/**
 * One log entry → one rendered turn. Exhaustive: a new AxonEntryEvent
 * type must decide its rendering here (or explicitly return null to omit it).
 * This is the single place the memory format meets the wire format.
 */
/**
 * A measurement, as the model reads it.
 *
 * Labelled when the instrument said what its components are —
 * `Package=50°C Core 0=48°C` reads as nine facts, where `50 48 45 …` reads
 * as noise a model must guess the order of. This is the whole reason
 * `labels` is carried on the protocol rather than left to each consumer to
 * reconstruct from the channel name.
 *
 * A single unlabelled component renders bare (`87%`), because a scalar with
 * a made-up label would be worse than none.
 */
function renderVector(data: { values: number[]; unit?: string; units?: string[]; labels?: string[] }): string {
    // Per-component units win where present — a joint's three numbers are
    // rad, rad/s and Nm, and one shared unit would be a lie about two of
    // them.
    const unitAt = (i: number): string =>
        data.units?.length === data.values.length ? data.units[i]! : data.unit ?? ""

    if (data.labels && data.labels.length === data.values.length) {
        return data.values.map((value, i) => `${data.labels![i]}=${value}${unitAt(i)}`).join(" ")
    }
    return data.values.map((value, i) => `${value}${unitAt(i)}`).join(" ")
}

/**
 * What a captured result IS, so the model knows how to read it before it starts.
 *
 * Most results are JSON — a script's returned value is stringified on the way
 * into the log — and labelling that `txt` makes the model parse structure it
 * was never told to expect. Detected rather than declared because the capsule
 * does not know either: stdout, a returned object and a thrown string all
 * arrive as one string.
 *
 * The cheap guard first: anything not starting with a brace or bracket cannot
 * be a JSON document, which skips the parse for ordinary command output. Only
 * the plausible candidates are parsed, and a parse failure just means text.
 */
function detectLang(content: string): string {
    const trimmed = content.trim()
    if (trimmed.length < 2) return "txt"
    const head = trimmed[0]
    if (head !== "{" && head !== "[") return "txt"
    try {
        JSON.parse(trimmed)
        return "json"
    } catch {
        return "txt"
    }
}

function timelineItem(entry: AxonEntry): TimelineItem | null {
    switch (entry.type) {
        case "cognet:stimulus:text":
            return { role: "user", type: "message", content: entry.data.content, channel: entry.data.channel, lang: entry.data.format ?? "md" }

        case "cognet:stimulus:audio":
            return { role: "user", type: "message", content: entry.data.transcript ?? "[audio]", channel: entry.data.channel, lang: "txt" }

        case "cognet:stimulus:visual":
            return { role: "user", type: "message", content: entry.data.caption ?? `[${entry.data.kind}]`, channel: entry.data.channel, lang: "txt" }

        case "cognet:stimulus:vector":
            return { role: "system", type: "system", systemType: "field", lang: "txt", content: `${entry.data.channel}: ${renderVector(entry.data)}` }

        case "axon:interrupt":
            return {
                role: "system",
                type: "interrupt",
                reason: entry.data.reason,
                ...(entry.data.from ? { from: entry.data.from } : {}),
            }

        case "cognet:output:text":
            return { role: "agent", type: "message", content: entry.data.content, lang: "md" }

        case "cognet:output:audio":
            return { role: "agent", type: "message", content: entry.data.transcript ?? "[audio]", lang: "txt" }

        case "cognet:output:visual":
            return { role: "agent", type: "message", content: entry.data.caption ?? `[${entry.data.kind}]`, lang: "txt" }

        case "cognet:output:vector":
            return { role: "system", type: "system", systemType: "field", lang: "txt", content: `${entry.data.channel}: ${renderVector(entry.data)}` }

        case "axon:agent:done":
            return { role: "agent", type: "done" }

        case "axon:system:malformed":
            return { role: "agent", type: "malformed", content: entry.data.content, code: entry.data.code, attempt: entry.data.attempt }

        case "cognet:action:typescript":
            return { role: "agent", type: "execute", id: entry.data.id, lang: "typescript", code: entry.data.content }

        case "cognet:action:result":
            return {
                role: "agent",
                type: "result",
                for: entry.data.for,
                ok: entry.data.ok,
                content: entry.data.content,
                lang: detectLang(entry.data.content),
                ...(entry.data.error ? { error: entry.data.error } : {}),
            }

        case "axon:system:message":
            return {
                role: "system",
                type: "system",
                systemType: entry.data.type,
                lang: entry.data.lang,
                content: entry.data.content,
                ...(entry.data.attributes ? { attributes: entry.data.attributes } : {}),
            }
    }
}
