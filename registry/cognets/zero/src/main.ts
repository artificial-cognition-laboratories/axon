import { Air } from "@arcforge/air"
import { state, sync } from "./state"
import { renderKnowledgeTree } from "./knowledge"
import { ZERO_PREFLIGHT } from "./preflight"

const air = Air({ protocol: "classic" })

const KNOWLEDGE_LIMIT = 400

/**
 * The knowledge catalogue, rendered as a tree.
 *
 * Resident state: this is in EVERY call, so its size is a per-turn tax for the
 * whole session. As a JSON array of `{ name, description, path }` it cost
 * ~9,400 tokens on a 194-file corpus, four fifths of which was repeated JSON
 * scaffolding and the shared prefix of every name written out in full. The tree
 * says each segment once — ~2,000 tokens for the same information.
 *
 * `lang: "text"` because the content is authored output. AIR forwards a string
 * untouched (serializeState), so declaring `json` here would tell the model to
 * parse a tree as JSON.
 */
async function knowledgeState() {
    const entries = await kernel.knowledge.list()
    if (entries.length === 0) return null

    const shown = entries.slice(0, KNOWLEDGE_LIMIT)
    const truncated = entries.length > shown.length
        ? `\n\n(${shown.length} of ${entries.length} shown)`
        : ""

    return {
        name: "knowledge",
        description: "Reference material available to you, as a file tree. The first line is the directory it is rooted at; join it with a file's path down the tree and read it with fs.read(). A directory's own overview, where it has one, is its index.md.",
        lang: "text" as const,
        content: renderKnowledgeTree(shown) + truncated,
    }
}

loop(async ({ stop }) => {
    await phase("sync", async () => {
        sync()
    })

    const render = async () => {
        sync()
        const knowledge = await knowledgeState()
        return air.render({
            base: await kernel.base(),
            scope: kernel.scope(),
            state: knowledge ? [knowledge] : [],
            history: state.entries,
            // The trajectory this agent starts on — see ZERO_PREFLIGHT. Passed
            // rather than assumed: what a model should see FIRST is cognition,
            // and it used to be welded into the protocol where no cognet could
            // reach it.
            preflight: ZERO_PREFLIGHT,
        })
    }

    const messages = await phase("render", render)

    const done = await phase("invoke", async () => {
        let finished = false

        const pending: string[] = []

        await system("drain", async () => {
            const stream = kernel.engine("main").stream({
                messages: messages,
                protocol: air.protocol,
                rerender: render,
            })

            for await (const event of stream) {
                switch (event.type) {
                    case "engine:start":
                        break

                    case "engine:text":
                        await kernel.output("cognet:output:text", event)
                        break

                    case "engine:script":
                        pending.push(event.content)
                        break

                    case "engine:failure":
                        break

                    case "engine:done":
                        finished = event.yielded && !event.acted
                        break
                }
            }
        })

        if (pending.length > 0) await system("act", async () => kernel.run(pending))

        return finished
    })

    if (done) stop()
})
