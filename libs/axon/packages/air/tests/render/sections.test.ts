import { Air } from "../../src"
import { describe, it, expect } from "bun:test"

/**
 * Render with the history as ONE `<timeline>` document.
 *
 * The default is now a real conversation — user turns as `user` messages,
 * the agent's own replies as `assistant` messages — because the document
 * form never showed a model an assistant turn in its own context. These
 * suites assert the document renderer specifically, so they pin it; the
 * conversation shape has its own suite.
 */
function asDocument<T>(render: () => T): T {
    const previous = process.env.AXON_AIR_TIMELINE
    process.env.AXON_AIR_TIMELINE = "document"
    try {
        return render()
    } finally {
        if (previous === undefined) delete process.env.AXON_AIR_TIMELINE
        else process.env.AXON_AIR_TIMELINE = previous
    }
}


describe("Air render: sections", () => {
    it("always renders a meta section as a system message", () => {
        const messages = Air().render({})
        const meta = messages.find(m => m.content.includes('type="contract"'))
        expect(meta?.role).toBe("system")
    })

    it("teaches the REPL substrate — the facts a model cannot derive", () => {
        const meta = Air().render({}).find(m => m.content.includes('type="contract"'))?.content ?? ""

        expect(meta).toContain("persistent Bun")
        expect(meta).toContain("process.chdir(path)")
        expect(meta).toContain("not an exhaustive runtime")
        expect(meta).toContain("TypeScript syntax is accepted")
        expect(meta).toContain('await import("module")')
        // `<env>` is a retired block and must never be named. `<state>` IS
        // named — it is in meta's list of context blocks — and the old
        // assertion only passed because the tags were escaped, so the check
        // was reading `&lt;state&gt;` and never matching.
        expect(meta).not.toContain("<env>")
    })

    /**
     * Meta describes the SUBSTRATE, never the body it runs in.
     *
     * AIR is loaded by the cognet, and a cognet cannot see its environment —
     * so a directory tree here was an assertion nothing could verify and
     * nothing could falsify. It named data/knowledge/ and .env for bodies
     * that may have neither. Identity has a home the user controls; the
     * layout has no home here at all.
     */
    it("asserts nothing about the agent's filesystem or identity", () => {
        const meta = Air().render({}).find(m => m.content.includes('type="contract"'))?.content ?? ""

        expect(meta).not.toContain("AXON_HOME")
        expect(meta).not.toContain("boot.vue")
        expect(meta).not.toContain(".env")
        expect(meta).not.toContain("data/knowledge/")
        expect(meta).not.toContain("You are an Axon agent")
    })


    it("renders NO system block when no base is given", () => {
        const messages = Air().render({})
        // Identity leads the context now, so an empty <system></system> would
        // make a declared-and-blank identity the first thing the model reads.
        expect(messages.some(m => m.content.includes('type="user"'))).toBe(false)
    })

    it("renders the given base inside the system block", () => {
        const messages = Air().render({ base: "You are a helpful agent." })
        expect(messages.some(m => m.content.includes("You are a helpful agent."))).toBe(true)
    })

    it("always renders a contract section", () => {
        const messages = Air().render({})
        expect(messages.some(m => m.content.includes('type="contract"'))).toBe(true)
    })

    it("renders no scope section when no scope is given", () => {
        const messages = Air().render({})
        expect(messages.some(m => m.content.startsWith("<scope"))).toBe(false)
    })

    it("renders no env or state sections — those blocks were removed", () => {
        const messages = Air().render({ base: "x" })
        expect(messages.some(m => m.content.startsWith("<env>"))).toBe(false)
        expect(messages.some(m => m.content.startsWith("<state>"))).toBe(false)
    })

    /**
     * Order is a CACHING contract, not a stylistic one.
     *
     * meta/scope/contract are stable across turns; system can change on
     * every render (boot.vue may be Vuedown), state changes most turns, and
     * the timeline changes every turn. A volatile block inside the stable
     * head invalidates a provider's prefix cache for everything behind it —
     * which is why <system> sits after <contract> rather than before it.
     */
    it("section order is system(user) → contract → scope → state → conversation", () => {
        const messages = Air().render({
            base: "sys",
            scope: { modules: [{ name: "fs", members: [{ name: "read", declaration: "function read(p: string): Promise<string>" }] }] },
            state: [{ name: "knowledge", content: [{ name: "axon/terminal.md" }] }],
            history: [threadEntry("cognet:stimulus:text", { channel: "user", content: "hi" })],
        })
        // The history is the conversation and renders as chat turns, so only
        // the stable head is matched by tag; it must be followed by the turns.
        const tags = messages.map(m => m.content.match(/^<(\w+)/)?.[1] ?? "")
        // The version marker leads — see renderVersion.
        expect(tags.slice(0, 5)).toEqual(["system", "system", "system", "scope", "state"])
        expect(messages.slice(0, 5).every(m => m.role === "system")).toBe(true)
        expect(messages.at(-1)?.role).not.toBe("system")
    })

    it("keeps every volatile block behind the stable head", () => {
        const messages = Air().render({
            base: "sys",
            state: [{ name: "world", content: {} }],
            history: [threadEntry("cognet:stimulus:text", { channel: "user", content: "hi" })],
        })
        const tags = messages.map(m => m.content.match(/^<(\w+)/)?.[1] ?? "")
        // Nothing that can change per render may precede the contract.
        // Identity leads — the head of the system prompt is the highest
        // authority position, and it used to sit behind 12k of scope.
        expect(tags.indexOf("system")).toBe(0)
        expect(tags.lastIndexOf("state")).toBeGreaterThan(tags.indexOf("scope"))
        // The history is the most volatile of all, so it comes last — now as
        // conversation turns rather than one block, which is a change of shape
        // and not of the caching contract this asserts.
        const lastSystem = messages.map(m => m.role).lastIndexOf("system")
        expect(lastSystem).toBe(tags.indexOf("state"))
        expect(messages.length).toBeGreaterThan(lastSystem + 1)
    })
})

/**
 * <state> — arbitrary named data, one tag for every concept.
 *
 * The tests that matter here are the ones defending AIR's ignorance: it must
 * render a knowledge catalogue, a world model and a goal stack through the
 * same function without learning what any of them are.
 */
describe("Air render: state", () => {
    const blocks = (input: Parameters<ReturnType<typeof Air>["render"]>[0]) =>
        Air().render(input).filter(m => m.content.startsWith("<state"))

    it("renders no state blocks when none are given", () => {
        expect(blocks({})).toHaveLength(0)
        expect(blocks({ state: [] })).toHaveLength(0)
    })

    it("renders one system message per block, carrying name and lang", () => {
        const [block] = blocks({ state: [{ name: "world", content: { people: 3 } }] })
        expect(block?.role).toBe("system")
        expect(block?.content).toContain(`<state name="world" lang="json">`)
        expect(block?.content).toContain(`"people": 3`)
    })

    it("omits the description attribute rather than rendering it empty", () => {
        // An empty attribute is noise the model still reads past.
        const [block] = blocks({ state: [{ name: "world", content: {} }] })
        expect(block?.content).not.toContain("description=")
    })

    it("renders a description when one is given", () => {
        const [block] = blocks({
            state: [{ name: "knowledge", description: "Material you can read by name.", content: [] }],
        })
        expect(block?.content).toContain(`description="Material you can read by name."`)
    })

    it("passes a pre-rendered string through untouched", () => {
        // A cognet that formatted its own material must not have it
        // reformatted underneath it.
        const [block] = blocks({ state: [{ name: "notes", lang: "yaml", content: "a: 1\nb: 2" }] })
        expect(block?.content).toContain("a: 1")
        expect(block?.content).toContain(`lang="yaml"`)
    })

    it("refuses an unimplemented lang rather than emitting JSON under a false label", () => {
        // A model told it is reading YAML and handed JSON has been lied to in
        // the one place the format exists to be precise about.
        expect(() => Air().render({ state: [{ name: "x", lang: "yaml", content: { a: 1 } }] }))
            .toThrow(/not implemented/)
    })

    it("renders several blocks in the caller's order", () => {
        const rendered = blocks({
            state: [
                { name: "knowledge", content: [] },
                { name: "world", content: {} },
            ],
        })
        expect(rendered.map(m => m.content.match(/name="(\w+)"/)?.[1])).toEqual(["knowledge", "world"])
    })

    it("carries no timestamp — state is what IS, the timeline is what happened", () => {
        // Recency belongs inside content as a field the cognet writes, never
        // as a field AIR branches on to decide placement.
        const [block] = blocks({ state: [{ name: "seen", content: { observedAt: "14:03" } }] })
        expect(block?.content).toContain("observedAt")
        expect(block?.content).not.toMatch(/<state[^>]*\bat=/)
    })
})

// minimal enveloped entry for render tests
function threadEntry(type: string, data: unknown) {
    return { id: type, type, time: { ms: 0, seq: 0 }, context: { agentId: "a", sessionId: "s" }, data } as never
}

/**
 * The prose a real model reads, guarded against drift.
 *
 * Nothing else checks this — a stale sentence here does not fail a test, it
 * teaches every model a grammar the runtime no longer speaks, which shows up
 * as an agent that silently emits blocks the parser discards. These assert
 * the things that were WRONG after the protocol changed, so the same drift
 * cannot happen quietly again.
 */
describe("Air prose: classic contract", () => {
    const meta = () => Air({ protocol: "classic" }).render({}).find(m => m.content.includes('type="contract"'))?.content ?? ""
    const contract = () => Air({ protocol: "classic" }).render({}).find(m => m.content.includes('type="contract"'))?.content ?? ""

    // The CONTRACT owns the grammar — which blocks exist and when to emit
    // them. Meta owns the substrate and names <script> only because that is
    // where code runs; it must never describe the block set, because that is
    // the duplication which let it outlive two tag renames.
    it("names the blocks the parser actually accepts", () => {
        expect(contract()).toContain("script")
        expect(contract()).toContain("text")
    })

    // The duplication guard that used to live here is gone with the split it
    // guarded: `<meta>` and `<contract>` were two blocks describing one
    // grammar, and nothing but a test stopped them drifting — which they did,
    // twice, teaching models a tag set the parser no longer spoke. They are
    // one block now, so there is no second copy to disagree.

    // Meta names every block the model will actually receive. A block
    // rendered but never introduced is one the model has to guess at.
    it("introduces each context block the renderer can emit", () => {
        for (const block of ["scope", "contract", "system", "state", "timeline"]) {
            expect(meta()).toContain(`<${block}>`)
        }
    })

    it("frames state as current rather than historical", () => {
        expect(meta()).toContain("Current, not historical")
    })

    // The old names outlived their grammar by one refactor; a model still
    // told about them emits tags nothing parses.
    it("never mentions the retired tag names", () => {
        // `<template>` and `<typescript>` are both retired. `<template>` came
        // from an abandoned SFC experiment and outlived it: a Vue word for
        // "your message to the user", on a different axis from `<user>` — which
        // is why `<agent>` had to nest, and why the model kept emitting a tag
        // its own contract said did not exist. One axis now: the tag says what
        // a block IS, `from` says who produced it.
        for (const source of [meta(), contract()]) {
            expect(source).not.toContain("<template>")
            expect(source).not.toContain("<typescript>")
            expect(source).not.toContain("<agent>")
        }
    })

    // <done/> is back, under protest: a progress report and a final answer
    // are structurally identical, so nothing can derive the difference yet.
    // What the prose MUST NOT do is conflate yielding with finishing — a
    // model that thinks speaking ends its turn stops mid-task, which is
    // exactly the failure the tag exists to avoid.
    it("tells the model that speaking does not end its turn", () => {
        expect(contract()).toContain("Speaking does not end your turn")
    })

    it("frames the yield tag as handing control back, not as completing the task", () => {
        const rule = contract().split("\n").find(l => l.trim().startsWith("- `<done/>`")) ?? ""
        expect(rule).toContain("handing control back")
        // The distinction is the whole point: a model that reads <done/> as
        // "the task is finished" holds it back mid-run and never yields.
        expect(rule).toContain("THIS TURN")
    })

    /**
     * The block-independence rules, guarded because a model broke on their
     * absence.
     *
     * Haiku 4.5 emitted a script reading a doc AND a template describing that
     * doc's contents in the same message — inventing an API, then correcting
     * itself a turn later. The contract had stated the mechanism ("returns to
     * you on your next turn") without its consequence, and had invited the
     * failure by telling the model to act and speak "in the same breath".
     */
    it("states that a script's result is not visible in the same message", () => {
        expect(contract()).toContain("you cannot see the result in this message")
    })

    it("forbids a template reporting what its own script found", () => {
        const rules = contract()
        expect(rules).toContain("can never report what that script found")
        expect(rules).toContain("send the script ALONE")
    })

    it("no longer invites acting and reporting findings in one message", () => {
        // The exact phrasing the model followed into the failure.
        expect(contract()).not.toContain("in the same breath")
    })

    it("shows act-now-speak-next-turn, the pattern a coding agent uses most", () => {
        // Every example was previously script-alone or template-alone, so the
        // only modelled way to act AND speak was to do both at once.
        expect(contract()).toContain("script ALONE, because the answer depends on what comes back")
        expect(contract()).toContain("on the next turn, with the content actually in front of you")
    })

    // Structured output is a `result` binding the script builds and the
    // checker verifies — not JSON the model types by hand.
    it("teaches structured output as a built value, never hand-written JSON", () => {
        expect(meta()).toContain("result")
        expect(meta()).toContain("Never hand-write the JSON")
        expect(contract()).toContain("Never hand-write JSON")
    })

    it("warns about the two things that fail the output check", () => {
        expect(meta()).toContain("satisfies")
        expect(meta()).toContain("any")
    })

    // raw is for internal calls — no grammar to comply with at all.
    it("renders no contract for raw", () => {
        const raw = Air({ protocol: "raw" }).render({}).find(m => m.content.includes('type="contract"'))?.content ?? ""
        // Empty of RULES — the tag still carries its lang like every other block.
        // raw has no grammar and no meta, so it renders no contract block at all.
        expect(raw).toBe("")
    })
})

/**
 * Nothing the model is INSTRUCTED with may reach it as an HTML entity.
 *
 * `<meta>` and `<contract>` pass their prose through raw — they are not run
 * through esc() — so tags written pre-escaped arrived as `&lt;script&gt;`.
 * Every instruction naming a tag the model must emit was showing it the wrong
 * characters, 36 entities per call, and models visibly failed to comply with
 * a protocol they were being mis-taught.
 */
describe("Air render: instructions are literal, never entity-escaped", () => {
    it("renders no HTML entities anywhere in the context", () => {
        const all = Air().render({}).map(m => m.content).join("\n")
        expect(all).not.toContain("&lt;")
        expect(all).not.toContain("&gt;")
    })

    it("names the blocks with literal angle brackets", () => {
        const all = Air().render({}).map(m => m.content).join("\n")
        expect(all).toContain("<script>")
        expect(all).toContain("<text>")
        expect(all).toContain("<done/>")
    })
})

/**
 * A block declaring `lang="md"` must contain markdown that actually parses.
 *
 * The `lang` attribute is an instruction to the model about how to read the
 * body, so getting it wrong is the same class of defect as the entity
 * escaping above — we tell the model one thing and hand it another. This
 * caught a real one: labelling every fence in the examples list, including
 * the closing ones, left twelve fences that never closed.
 */
describe("Air render: a declared lang is honoured", () => {
    const mdBlocks = (): string[] => {
        const all = Air().render({ base: "# Agent\n\nYou do things." }).map(m => m.content).join("\n")
        return [...all.matchAll(/<(system)\b[^>]*lang="md"[^>]*>([\s\S]*?)<\/\1>/g)]
            .map(m => m[2]!)
    }

    it("renders every system block as markdown", () => {
        // Both the user block and the contract declare lang="md".
        expect(mdBlocks().length).toBeGreaterThanOrEqual(2)
    })

    it("closes every fence it opens", () => {
        for (const body of mdBlocks()) {
            const fences = body.split("\n").filter(l => l.trim().startsWith("```")).length
            expect(fences % 2).toBe(0)
        }
    })

    it("puts a language on opening fences and never on closing ones", () => {
        for (const body of mdBlocks()) {
            let open = false
            for (const line of body.split("\n")) {
                const trimmed = line.trim()
                if (!trimmed.startsWith("```")) continue
                const label = trimmed.slice(3)
                if (open) expect(label).toBe("")
                else expect(label.length).toBeGreaterThan(0)
                open = !open
            }
        }
    })
})
