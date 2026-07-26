import type { AxonEntry, AxonScope, AxonScopeModule } from "@arcforge/types"
import { foldChunks } from "@arcforge/types"
import type { GrammarT } from "../grammar"
import { formatCapsuleOutput } from "./output"
import { esc, escAttr, escCode, indent, normalizeCode } from "./text"

/**
 * The AIR section renderers — one function per block of the context window.
 *
 * These own the DOMAIN → protocol translation: AxonTool[] → <scope>
 * declarations, AxonEntry[] → <timeline> items. Callers pass what they
 * hold; nothing here is exported to userland but the block renderers.
 *
 * Note on escaping: the contract/meta blocks show tags as &lt;text&gt; inside
 * markdown code fences deliberately — the model must see literal tag text as
 * instruction, not as parseable XML. It looks like double-escaping; it isn't.
 */

export function renderMeta(grammar: GrammarT): string {
    return `<meta>\n${indent(grammar.meta, 4)}\n</meta>`
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
export function renderScope(scope: AxonScope): string {
    const modules = scope.modules.filter(module => module.members.length > 0)
    if (modules.length === 0) return ""

    const ambientTypes = [...new Set(modules.flatMap(t => t.ambientTypes ?? []))]
    const sections = [...ambientTypes, ...modules.map(toolDeclarations)]
    return `<scope lang="ts">\n${indent(sections.join("\n\n"), 4)}\n</scope>`
}

function toolDeclarations(module: AxonScopeModule): string {
    const members = module.members.map(member => {
        const jsdoc = member.jsdoc ? `${jsdocBlock(member.jsdoc)}\n` : ""
        // flat: fns are top-level globals; namespaced: members need no `declare`
        return module.flat ? `${jsdoc}declare ${member.declaration}` : `${jsdoc}${member.declaration}`
    })

    const header = module.description ? `${jsdocBlock(module.description)}\n` : ""
    return module.flat
        ? `${header}${members.join("\n\n")}`
        : `${header}declare namespace ${module.name} {\n${indent(members.join("\n\n"), 4)}\n}`
}

function jsdocBlock(text: string): string {
    const lines = text.split("\n")
    if (lines.length === 1) return `/** ${text} */`
    return `/**\n${lines.map(l => ` * ${l}`.trimEnd()).join("\n")}\n */`
}

export function renderSystem(system?: string): string {
    if (!system) return `<system></system>`
    return `<system>\n${system}\n</system>`
}

export function renderContract(grammar: GrammarT): string {
    if (grammar.modes.length === 0) return `<contract></contract>`

    const modeLines = grammar.modes.map(m => `- \`&lt;${m.type}&gt;\` — ${grammar.describe(m)}`)
    modeLines.push(
        `- \`&lt;done/&gt;\` — MANDATORY at the end of every message. No exceptions, including a single short &lt;text&gt; reply. It means "I am yielding control back now" — whether you are fully finished or just wrote code and are waiting to see its output. Without it the runtime assumes you are still mid-turn and will not treat your message as complete.`
    )

    const ruleLines = grammar.rules.map(r => `- ${r}`)

    const hasExec = grammar.modes.some(m => m.type === "typescript" || m.type === "shell")
    const execTag = grammar.modes.find(m => m.type === "typescript") ? "typescript" : "shell"

    const examples: string[] = []
    if (hasExec) {
        examples.push(
            `Acting (no narration before — just the block):`,
            "```",
            `&lt;${execTag}&gt;// code here&lt;/${execTag}&gt;&lt;done/&gt;`,
            "```",
            `Replying — even a short one-line reply always ends with &lt;done/&gt;:`,
            "```",
            `&lt;text&gt;message here&lt;/text&gt;&lt;done/&gt;`,
            "```"
        )
    } else {
        examples.push("```", `&lt;text&gt;message here&lt;/text&gt;&lt;done/&gt;`, "```")
    }

    const body = [
        `## Blocks`,
        modeLines.join("\n"),
        `## Rules`,
        ruleLines.join("\n"),
        `## Examples`,
        examples.join("\n"),
    ].join("\n\n")

    return `<contract>\n${indent(body, 4)}\n</contract>`
}

/**
 * <timeline> — the event history. AIR owns the AxonEntry → rendered-turn
 * translation via the exhaustive switch below: this is the single chokepoint
 * where a new entry-event type must decide its rendering, and it lives next
 * to the parser it has to agree with.
 */
export function renderTimeline(entries: readonly AxonEntry[]): string {
    if (entries.length === 0) return `<timeline></timeline>`

    // chunked emissions fold to one turn each — the group is the fact
    // (AxonChunk standard); the model never sees transport granularity
    const items = foldChunks(entries).map(timelineItem).filter((i): i is TimelineItem => i !== null)
    if (items.length === 0) return `<timeline></timeline>`

    let userCount = 0
    let execCount = 0
    // Maps consumer-supplied execute IDs (UUIDs etc.) to short rendered IDs (e1, e2, ...)
    const execIdMap = new Map<string, string>()

    const shortExecId = (rawId: string): string => {
        if (!execIdMap.has(rawId)) execIdMap.set(rawId, `e${++execCount}`)
        return execIdMap.get(rawId)!
    }

    const lines = items
        .map(item => {
            if (item.role === "user") {
                const id = `u${++userCount}`
                const content = esc(item.content.trim())
                return `    <user id="${id}">\n${indent(content, 8)}\n    </user>`
            }
            if (item.type === "message") {
                const content = esc(item.content.trim())
                return `    <agent>\n        <text>\n${indent(content, 12)}\n        </text>\n    </agent>`
            }
            if (item.type === "execute") {
                const tag = item.lang === "sh" ? "shell" : "typescript"
                const id = shortExecId(item.id)
                return `    <agent>\n        <${tag} id="${id}">\n${indent(escCode(normalizeCode(item.code.trim())), 12)}\n        </${tag}>\n    </agent>`
            }
            if (item.type === "result") {
                const ok = item.ok ? ` ok="true"` : ` ok="false"`
                const errorAttr = item.error ? ` error="${esc(item.error.kind)}: ${esc(item.error.message)}"` : ""
                const content = formatCapsuleOutput(item.content.trim())
                const forId = shortExecId(item.for)
                return `    <stdout for="${forId}"${ok}${errorAttr}>\n${indent(content, 8)}\n    </stdout>`
            }
            if (item.role === "system") {
                const extra = Object.entries(item.attributes ?? {})
                    .filter(([key]) => key !== "type" && key !== "lang")
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, value]) => ` ${key}="${escAttr(value)}"`)
                    .join("")
                return `    <system type="${escAttr(item.systemType)}" lang="${escAttr(item.lang)}"${extra}>\n${indent(esc(item.content.trim()), 8)}\n    </system>`
            }
            return ""
        })
        .filter(Boolean)

    return `<timeline>\n${lines.join("\n\n")}\n</timeline>`
}

// ── domain → timeline item ────────────────────────────────────────────────────
//
// The rendered-turn shapes are private to this file: callers pass
// AxonEntry, AIR translates. Kept minimal — role + type + payload the
// renderer above consumes.

type TimelineItem =
    | { role: "user"; type: "message"; content: string }
    | { role: "agent"; type: "message"; content: string }
    | { role: "agent"; type: "execute"; id: string; lang: string; code: string }
    | { role: "agent"; type: "result"; for: string; ok: boolean; content: string; error?: { kind: "timeout" | "policy" | "interrupt" | "exception"; message: string } }
    | { role: "system"; type: "system"; systemType: string; lang: string; content: string; attributes?: Record<string, string> }

/**
 * One log entry → one rendered turn. Exhaustive: a new AxonEntryEvent
 * type must decide its rendering here (or explicitly return null to omit it).
 * This is the single place the memory format meets the wire format.
 */
function timelineItem(entry: AxonEntry): TimelineItem | null {
    switch (entry.type) {
        case "cognet:stimulus:text":
            return { role: "user", type: "message", content: entry.data.content }

        case "cognet:stimulus:audio":
            return { role: "user", type: "message", content: entry.data.transcript ?? "[audio]" }

        case "cognet:stimulus:visual":
            return { role: "user", type: "message", content: entry.data.caption ?? `[${entry.data.kind}]` }

        case "cognet:stimulus:field":
            return { role: "system", type: "system", systemType: "field", lang: "txt", content: `${entry.data.source.channel}: ${String(entry.data.reading.value)}${entry.data.reading.unit ?? ""}` }

        case "axon:interrupt":
            return { role: "system", type: "system", systemType: "interrupt", lang: "txt", content: `interrupted (${entry.data.reason})` }

        case "cognet:output:text":
            return { role: "agent", type: "message", content: entry.data.content }

        case "cognet:output:audio":
            return { role: "agent", type: "message", content: entry.data.transcript ?? "[audio]" }

        case "cognet:output:visual":
            return { role: "agent", type: "message", content: entry.data.caption ?? `[${entry.data.kind}]` }

        case "cognet:output:field":
            return { role: "system", type: "system", systemType: "field", lang: "txt", content: `${String(entry.data.reading.value)}${entry.data.reading.unit ?? ""}` }

        case "cognet:action:typescript":
            return { role: "agent", type: "execute", id: entry.data.id, lang: "typescript", code: entry.data.content }

        case "cognet:action:result":
            return {
                role: "agent",
                type: "result",
                for: entry.data.for,
                ok: entry.data.ok,
                content: entry.data.content,
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
