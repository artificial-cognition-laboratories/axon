import { fail, type Shape } from "./model"

/** What a declaration's doc says beyond prose: how it is drawn, or — for a frame — what space it is. */
export type Said = {
    /** The prose, tags removed. */
    doc?: string
    /** `@space <kind>` — the declaration is a frame, not a component. */
    space?: string
    /** `@frame <name>` — the frame its value lives in, as written. */
    frame?: string
    /** Display options written, before what the type implies is added. */
    display: Record<string, string>
}

/**
 * Tags — the words in a doc comment that say what a declaration is, read the
 * same from TypeScript's `/** *\/`, Rust's `///` and a Python docstring, so a
 * component is described once, in whichever language holds it.
 *
 *   @frame session     the frame its value lives in
 *   @archetype span    how a viewer draws it there
 *   @range 0 1         its expected low and high
 *   @unit m            its physical unit
 *   @instrument power  its physical meaning, for a cockpit
 *   @domain / @shape   what it is indexed by and its form — written only to overrule the type
 *   @workspace         attention may draw from it
 *   @space sequence    this export is a frame (it holds no fields)
 *
 * An unknown tag fails: a typo must not quietly draw nothing.
 */
export function said(path: string, shape: Pick<Shape, "name" | "doc">): Said {
    const display: Record<string, string> = {}
    let space: string | undefined
    let frame: string | undefined
    // A tag takes one word — two numbers for @range — so prose may follow it on the line.
    const prose = (shape.doc ?? "").replace(/(^|\s)@([a-z]+)(?:[ \t]+(-?[\d.]+[ \t]+-?[\d.]+|[^\s@]+))?/g, (_, lead: string, tag: string, word: string | undefined) => {
        const value = word ?? ""
        if (tag === "space") space = need(value, tag)
        else if (tag === "workspace") {
            display.workspace = "true"
            return `${lead}${value}`
        }
        else if (tag === "range") {
            const bounds = value.split(/\s+/).map(Number)
            if (bounds.length !== 2 || bounds.some(bound => !Number.isFinite(bound))) fail(path, `${shape.name}: @range takes a low and a high — @range 0 1`)
            display.range = `[${bounds.join(", ")}]`
        }
        else if (tag === "frame") {
            frame = need(value, tag)
            display.frame = JSON.stringify(frame)
        }
        else if (tag === "unit") display.unit = JSON.stringify(need(value, tag))
        else if (tag in ENUMS) display[tag] = `${ENUMS[tag]}_${need(value, tag).replace(/-/g, "_").toUpperCase()}`
        else fail(path, `${shape.name}: unknown tag @${tag} — a component says @frame, @archetype, @range, @unit, @instrument, @domain, @shape or @workspace; a frame says @space`)
        return lead
    }).replace(/[ \t]+$/gm, "").trim()
    return { doc: prose || undefined, space: space, frame: frame, display: display }

    function need(value: string, tag: string): string {
        if (!value || /\s/.test(value)) fail(path, `${shape.name}: @${tag} takes one word`)
        return value
    }
}

/** Tags whose word is a protobuf enum value: `@archetype span` → `ARCHETYPE_SPAN`. */
const ENUMS: Record<string, string> = { archetype: "ARCHETYPE", instrument: "INSTRUMENT", domain: "DOMAIN", shape: "SHAPE" }
