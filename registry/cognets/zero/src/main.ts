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

loop(async ({ stimuli, stop }) => {
    await phase("sync", async () => {
        sync()
    })

    // Dense sensory entries are not durable. Hold this wake's media in
    // cognition long enough for every render and structured-output retry.
    const sensory = stimuli.filter(entry =>
        entry.type === "cognet:stimulus:visual" || entry.type === "cognet:stimulus:audio"
    )
    const images = sensory.filter(entry =>
        entry.type === "cognet:stimulus:visual" && entry.data.kind === "image"
    )
    const main = kernel.engine("main")
    if (images.length > 0 && !main.modalities.in.includes("image")) {
        await kernel.output("cognet:output:text", {
            content: "Image input is not available with this cognet's currently bound cortex model.",
            channel: "",
        })
        stop()
        return
    }

    const render = async () => {
        sync()
        const knowledge = await knowledgeState()
        return air.render({
            base: await kernel.base(),
            scope: kernel.scope(),
            state: knowledge ? [knowledge] : [],
            history: [...state.entries, ...sensory],
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
            const stream = main.stream({
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
                        // `<done/>` is the model's claim that it is handing
                        // control back, not an instruction to terminate the
                        // wake. A bare marker made Zero stop a live request
                        // with no reply and no action. A handback is terminal
                        // only after actual user-facing output, and never
                        // while a script still owes the model its result.
                        if (event.yielded && !event.spoke && !event.acted) {
                            await kernel.fault({
                                code: "OUTPUT_EMPTY_HANDBACK",
                                message: "You emitted `<done/>` without a reply or an action. The user's request is still live. Continue by sending one useful `<text>` reply or one `<script>` action; do not send `<done/>` alone.",
                            })
                            break
                        }
                        finished = event.yielded && event.spoke && !event.acted
                        break
                }
            }
        })

        if (pending.length > 0) await system("act", async () => kernel.run(pending))

        return finished
    })

    if (done) stop()
})
