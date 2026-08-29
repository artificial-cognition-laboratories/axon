/**
 * The search demos.
 *
 * Static, unlike every other demo here — a search is one request and one
 * answer, so there is no interaction to judge, only the layout. What the cases
 * exercise instead is the shapes that break a list: long names, missing
 * descriptions, mixed kinds, and the empty answer.
 */

import { search } from "./search.ts"
import type { Entry } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"

const RESULTS: Entry[] = [
    {
        name: "@axon/obsidian",
        label: "module",
        version: "1.4.0",
        description: "Read and write an Obsidian vault from your agent — notes, backlinks, daily entries and full-text search over the whole graph.",
        stats: { stars: 42, installs: 1247 },
        installed: true,
    },
    {
        name: "@cody/notion",
        label: "module",
        version: "0.2.0",
        description: "Notion pages and databases as agent memory.",
        stats: { stars: 8, installs: 140 },
    },
    {
        name: "@axon/obsidian-sync",
        label: "module",
        version: "0.9.1",
        // No description: a real registry has these, and a layout that only
        // works when every field is populated is a layout that breaks in
        // production rather than in a demo.
        stats: { stars: 3, installs: 21 },
    },
    {
        name: "@marcus/second-brain",
        label: "agent",
        version: "2.1.0",
        description: "A research agent that files everything it reads into Obsidian.",
        stats: { stars: 156, installs: 8420 },
    },
]

export function searchDemo(r: RendererHandle, which = "default"): void {
    if (which === "empty") {
        r.line(search(r, {
            query: "obsidain",
            results: [],
            suggestion: "check the spelling, or browse with `axon list`",
        }))
        return
    }

    if (which === "filtered") {
        r.line(search(r, {
            query: "obsidian",
            filters: ["module", "@axon"],
            results: RESULTS.filter(e => e.label === "module" && e.name.startsWith("@axon")),
        }))
        return
    }

    // More matches than shown — the truncation notice has to be visible or a
    // partial answer reads as a complete one.
    if (which === "many") {
        r.line(search(r, {
            query: "obsidian",
            results: RESULTS,
            total: 27,
        }))
        return
    }

    r.line(search(r, { query: "obsidian", results: RESULTS }))
}
