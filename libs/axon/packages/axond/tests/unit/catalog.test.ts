import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Catalog } from "../../src/models/catalog"

/**
 * The model catalogue, and the caching that makes a panel feel instant.
 *
 * `fetch` is faked throughout: a test that hit Hugging Face would be asserting
 * their uptime rather than this cache's behaviour, and would fail offline —
 * which is precisely the condition the cache exists to survive.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A fake HF listing, counting how many times the network was reached. */
function source(models: string[], fail = false) {
    let calls = 0
    const doFetch = (async () => {
        calls++
        if (fail) throw new Error("offline")
        return {
            ok: true,
            json: async () => models.map(id => ({ modelId: id, pipeline_tag: "automatic-speech-recognition", downloads: 1 })),
        } as Response
    }) as unknown as typeof fetch
    return { fetch: doFetch, get calls() { return calls } }
}

async function catalog(net: { fetch: typeof fetch }) {
    const dir = await mkdtemp(join(tmpdir(), "axond-catalog-"))
    roots.push(dir)
    const root = join(dir, "catalog.json")
    return { catalog: Catalog({ root: root, fetch: net.fetch }), root: root }
}

describe("searching", () => {
    test("a fetched query is parsed into records", async () => {
        const net = source(["onnx-community/whisper-base.en"])
        const { catalog: c } = await catalog(net)

        const found = await c.refresh("whisper")

        expect(found?.[0]?.name).toBe("whisper-base.en")
        expect(found?.[0]?.owner).toBe("onnx-community")
        expect(found?.[0]?.id).toBe("hf:onnx-community/whisper-base.en")
    })

    test("a listing reports no size or runtime, and says so rather than guessing", async () => {
        // Which FILE in a repository is the weight is only answerable once
        // fetched, and unknown is a different fact from zero.
        const net = source(["onnx-community/whisper-base.en"])
        const { catalog: c } = await catalog(net)

        const [model] = (await c.refresh("whisper")) ?? []

        expect(model?.bytes).toBeNull()
        expect(model?.runtime).toBeNull()
        expect(model?.cached).toBe(false)
    })
})

describe("caching", () => {
    test("a cold query has nothing cached", async () => {
        const { catalog: c } = await catalog(source([]))

        expect(c.cached("whisper")).toEqual([])
    })

    test("a fetched query survives into a new process", async () => {
        // The whole point: an in-memory cache does nothing for the FIRST open
        // of a panel, which is the one a person notices.
        const net = source(["onnx-community/whisper-base.en"])
        const { catalog: c, root } = await catalog(net)
        await c.refresh("whisper")

        const reopened = Catalog({ root: root, fetch: net.fetch })

        expect(reopened.cached("whisper")).toHaveLength(1)
    })

    test("a warm query is served without touching the network", async () => {
        const net = source(["onnx-community/whisper-base.en"])
        const { catalog: c, root } = await catalog(net)
        await c.refresh("whisper")
        const after = net.calls

        Catalog({ root: root, fetch: net.fetch }).cached("whisper")

        expect(net.calls).toBe(after)
    })

    test("queries are cached separately, so one does not answer another", async () => {
        const net = source(["onnx-community/whisper-base.en"])
        const { catalog: c } = await catalog(net)
        await c.refresh("whisper")

        expect(c.cached("llama")).toEqual([])
    })

    test("case and whitespace do not fragment the cache", async () => {
        // `Whisper` and `whisper ` are one query to a person, and three cache
        // entries would mean two of them pay the network for the same answer.
        const net = source(["onnx-community/whisper-base.en"])
        const { catalog: c } = await catalog(net)
        await c.refresh("Whisper ")

        expect(c.cached("whisper")).toHaveLength(1)
    })
})

describe("failure", () => {
    test("a failed fetch keeps what was cached", async () => {
        // Offline degrades to "slightly stale", never to "nothing exists".
        const working = source(["onnx-community/whisper-base.en"])
        const { catalog: c, root } = await catalog(working)
        await c.refresh("whisper")

        const offline = Catalog({ root: root, fetch: source([], true).fetch })

        expect(await offline.refresh("whisper")).toBeNull()
        expect(offline.cached("whisper")).toHaveLength(1)
    })

    test("a failed fetch with nothing cached is empty, not an error", async () => {
        // The honest answer at that point — a panel must not throw because a
        // catalogue is unreachable.
        const { catalog: c } = await catalog(source([], true))

        expect(await c.refresh("whisper")).toBeNull()
        expect(c.cached("whisper")).toEqual([])
    })

    test("a corrupt cache file is treated as empty", async () => {
        // It costs a refetch and cannot produce wrong rows.
        const net = source(["onnx-community/whisper-base.en"])
        const { root } = await catalog(net)
        await Bun.write(root, "{ not json")

        expect(Catalog({ root: root, fetch: net.fetch }).cached("whisper")).toEqual([])
    })
})
