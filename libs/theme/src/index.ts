/**
 * @axon/theme — shared syntax highlighting theme and UI palette.
 *
 * Source of truth for the Arcnight Shiki theme and the Axon UI color palette.
 * Consumed by VTerm's highlighter, the debugger webview, and any future
 * surface that needs consistent Axon styling.
 */

// ── Arcnight — Shiki-compatible TextMate theme ──────────────────────────────

export const arcnight = {
    name: "arcnight",
    type: "dark" as const,
    colors: {
        "editor.background": "#070b10",
        "editor.foreground": "#c7eaff",
    },
    tokenColors: [
        {
            scope: [
                "variable",
                "variable.other",
                "variable.other.property",
                "variable.other.object.property",
                "variable.other.readwrite",
                "meta.object-literal.key",
                "support.variable.property",
            ],
            settings: { foreground: "#7cceff" },
        },
        {
            scope: [
                "keyword",
                "keyword.control",
                "keyword.other",
                "storage",
                "storage.type",
                "storage.modifier",
            ],
            settings: { foreground: "#345a94" },
        },
        {
            scope: ["constant.numeric", "number"],
            settings: { foreground: "#326396" },
        },
        {
            scope: ["entity.name.type", "entity.name.class", "constant", "support.type"],
            settings: { foreground: "#3caed5" },
        },
        {
            scope: ["entity.name.function", "support.function", "meta.function-call"],
            settings: { foreground: "#3caed5" },
        },
        {
            scope: ["string", "string.quoted", "string.template"],
            settings: { foreground: "#4c6696" },
        },
        {
            scope: ["keyword.operator", "punctuation.accessor"],
            settings: { foreground: "#7cceff" },
        },
        {
            scope: ["comment", "comment.line", "comment.block"],
            settings: { foreground: "#585858", fontStyle: "italic" },
        },
        // ── AIR format scopes ────────────────────────────────────────────────
        { scope: ["punctuation.definition.tag.air"],  settings: { foreground: "#2a4a6a" } },
        { scope: ["entity.name.tag.section.air"],     settings: { foreground: "#345a94" } }, // meta, env, timeline
        { scope: ["entity.name.tag.turn.air"],        settings: { foreground: "#3caed5" } }, // agent, user
        { scope: ["entity.name.tag.execute.air"],     settings: { foreground: "#00B4D8" } }, // typescript, shell
        { scope: ["entity.name.tag.stdout.air"],      settings: { foreground: "#4c6696" } }, // stdout
        { scope: ["entity.name.tag.prose.air"],       settings: { foreground: "#7cceff" } }, // text, thinking
        { scope: ["entity.name.tag.signal.air"],      settings: { foreground: "#3caed5" } }, // done
        { scope: ["entity.name.tag.env.air"],         settings: { foreground: "#345a94" } }, // process, subagent
        { scope: ["entity.name.tag.system.air"],      settings: { foreground: "#b43c3c" } }, // error, note
        { scope: ["entity.name.tag.state.air"],       settings: { foreground: "#585858" } }, // unknown tags
        { scope: ["entity.other.attribute-name.air"], settings: { foreground: "#4c6696" } }, // attr names
        { scope: ["string.quoted.double.air"],        settings: { foreground: "#326396" } }, // attr values
        { scope: ["constant.character.entity.air"],   settings: { foreground: "#4c6696" } }, // &lt; etc
    ],
}

// ── UI Palette — non-syntax colors used across Axon surfaces ────────────────

export const palette = {
    primary:       "#00B4D8",
    userText:      "#c8c8c8",
    agentText:     "#d2d2d2",
    thinkingText:  "#646464",
    thinkingGlyph: "#3c3c3c",
    toolLabel:     "#828282",
    output:        "#505050",
    railDim:       "#3c3c3c",
    railBright:    "#505050",
    omitted:       "#3c3c3c",
    error:         "#b43c3c",
    errorBright:   "#f14c4c",
    waiting:       "#a07828",
    denied:        "#a03c3c",
    codeLine:      "#3c3c3c",
} as const
