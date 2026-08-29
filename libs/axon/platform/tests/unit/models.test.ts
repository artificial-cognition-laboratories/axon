import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
    Models,
    ModelStore,
    parseModel,
    parseModels,
    downloadUrl,
} from "@arcforge/platform/build/project"

/**
 * `models:` — a cognet's declared weights, from specifier to absolute path.
 *
 * The invariants worth pinning are the ones that would corrupt a machine
 * quietly: a partial download reaching a valid address, unverified bytes
 * being cached, two agents duplicating a 150MB file, or `--frozen` becoming
 * the thing that provisions what it is meant to be checking.
 */

async function scratch<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "axon-models-"))
    try {
        return await fn(root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex")

describe("model specifiers", () => {
    test("parses the short form, keeping nested repo paths whole", () => {
        expect(parseModel("vad", "hf:runanywhere/silero-vad-v5/silero_vad.onnx")).toEqual({
            key: "vad",
            host: "hf",
            repo: "runanywhere/silero-vad-v5",
            file: "silero_vad.onnx",
            rev: "main",
        })

        // The file may itself be a path — only the first two segments are the repo.
        expect(parseModel("vad", "hf:onnx-community/silero-vad/onnx/model.onnx").file)
            .toBe("onnx/model.onnx")
    })

    test("parses the object form, carrying a revision pin and a hash", () => {
        expect(parseModel("asr", { hf: "ggerganov/whisper.cpp", file: "ggml-base.en.bin", rev: "v1", sha256: "abc" }))
            .toEqual({ key: "asr", host: "hf", repo: "ggerganov/whisper.cpp", file: "ggml-base.en.bin", rev: "v1", sha256: "abc" })
    })

    test("REJECTS a bare repo — a repo is a directory of many weights", () => {
        // ggerganov/whisper.cpp alone names ~20 quantisations of the same
        // model, from 150MB to 1.1GB. Guessing which is not an option.
        expect(() => parseModel("asr", "hf:ggerganov/whisper.cpp")).toThrow()
    })

    test("rejects a missing or unknown scheme rather than assuming one", () => {
        expect(() => parseModel("vad", "runanywhere/silero-vad-v5/model.onnx")).toThrow()
        expect(() => parseModel("vad", "s3:bucket/key/model.onnx")).toThrow()
    })

    test("builds the registry URL from the parsed parts", () => {
        expect(downloadUrl(parseModel("vad", "hf:owner/repo/sub/model.onnx")))
            .toBe("https://huggingface.co/owner/repo/resolve/main/sub/model.onnx")
    })

    test("an absent declaration is not an error — most cognets need no weights", () => {
        expect(parseModels(undefined)).toEqual([])
    })
})

describe("the model store", () => {
    test("addresses a file by its content hash", async () => {
        await scratch(async root => {
            const store = ModelStore({ root })
            const bytes = new TextEncoder().encode("weights")

            const stored = await store.put("model.onnx", bytes)

            expect(stored.sha256).toBe(sha("weights"))
            expect(stored.path).toBe(join(root, sha("weights"), "model.onnx"))
            expect(await Bun.file(stored.path).text()).toBe("weights")
        })
    })

    test("REFUSES bytes that do not match the expected hash", async () => {
        // Caching corrupt weights is worse than failing to cache: every later
        // run would trust them, and content-addressing would be a lie.
        await scratch(async root => {
            const store = ModelStore({ root })
            const attempt = store.put("model.onnx", new TextEncoder().encode("corrupted"), sha("weights"))

            await expect(attempt).rejects.toThrow()
        })
    })

    test("two agents declaring the same weights share one file", async () => {
        await scratch(async root => {
            const a = ModelStore({ root })
            const b = ModelStore({ root })
            const bytes = new TextEncoder().encode("shared")

            const first = await a.put("model.onnx", bytes)
            const second = await b.put("model.onnx", bytes)

            expect(second.path).toBe(first.path)
        })
    })

    test("finds a pinned model already on disk, without a network", async () => {
        await scratch(async root => {
            const store = ModelStore({ root })
            const bytes = new TextEncoder().encode("pinned")
            await store.put("model.onnx", bytes)

            const found = await store.find(parseModel("vad", {
                hf: "owner/repo",
                file: "model.onnx",
                sha256: sha("pinned"),
            }))

            expect(found?.sha256).toBe(sha("pinned"))
        })
    })

    test("remembers what an unpinned specifier resolved to", async () => {
        // Content-addressing alone cannot answer for an unpinned model, and
        // registries do not reliably publish a usable hash — HF's plain etag
        // is a git blob sha, not the hash of the bytes it serves. Without
        // this index every prepare re-downloads every model.
        await scratch(async root => {
            const store = ModelStore({ root })
            const stored = await store.put("model.onnx", new TextEncoder().encode("remembered"))
            await store.remember("hf:owner/repo@main/model.onnx", stored, "model.onnx")

            const hit = await store.resolved("hf:owner/repo@main/model.onnx")
            expect(hit?.path).toBe(stored.path)
            expect(await store.resolved("hf:owner/repo@main/other.onnx")).toBeNull()
        })
    })

    test("the index is a hint, not authority — a dangling entry just misses", async () => {
        // The file is still content-addressed, so a stale or corrupted index
        // costs a refetch and can never produce the wrong bytes.
        await scratch(async root => {
            const store = ModelStore({ root })
            await Bun.write(
                join(root, "index.json"),
                JSON.stringify({ "hf:owner/repo@main/model.onnx": { sha256: "deadbeef", file: "model.onnx" } }),
            )

            expect(await store.resolved("hf:owner/repo@main/model.onnx")).toBeNull()
        })
    })

    test("cannot answer for an unpinned model — the address IS the hash", async () => {
        // Without a declared hash there is nothing to look up; resolution has
        // to ask the registry what the bytes should be first.
        await scratch(async root => {
            const store = ModelStore({ root })
            await store.put("model.onnx", new TextEncoder().encode("x"))

            expect(await store.find(parseModel("vad", "hf:owner/repo/model.onnx"))).toBeNull()
        })
    })
})

describe("resolving a declaration", () => {
    test("resolves entirely from cache when every model is pinned", async () => {
        // The property that keeps prepare fast and offline-capable: a fully
        // pinned cognet touches no network at all.
        await scratch(async root => {
            const store = ModelStore({ root })
            await store.put("silero_vad.onnx", new TextEncoder().encode("vad-weights"))

            const models = Models({ store })
            const result = await models.resolve({
                vad: { hf: "runanywhere/silero-vad-v5", file: "silero_vad.onnx", sha256: sha("vad-weights") },
            })

            expect(result.fetched).toEqual([])
            expect(result.paths.vad).toBe(join(root, sha("vad-weights"), "silero_vad.onnx"))
        })
    })

    test("--frozen REFUSES to fetch rather than provisioning", async () => {
        // A check that fixes what it finds can never fail, so it would be
        // asserting nothing.
        await scratch(async root => {
            const models = Models({ store: ModelStore({ root }) })
            const attempt = models.resolve(
                { vad: { hf: "owner/repo", file: "model.onnx", sha256: sha("absent") } },
                { frozen: true },
            )

            await expect(attempt).rejects.toThrow()
        })
    })

    test("--frozen passes once the cache is populated", async () => {
        await scratch(async root => {
            const store = ModelStore({ root })
            await store.put("model.onnx", new TextEncoder().encode("present"))

            const models = Models({ store })
            const result = await models.resolve(
                { vad: { hf: "owner/repo", file: "model.onnx", sha256: sha("present") } },
                { frozen: true },
            )

            expect(result.paths.vad).toContain(sha("present"))
        })
    })

    test("a malformed specifier fails at parse, before any network", async () => {
        await scratch(async root => {
            const models = Models({ store: ModelStore({ root }) })
            await expect(models.resolve({ vad: "not-a-specifier" })).rejects.toThrow()
        })
    })

    test("declaring nothing resolves to nothing", async () => {
        await scratch(async root => {
            const models = Models({ store: ModelStore({ root }) })
            expect(await models.resolve(undefined)).toEqual({ paths: {}, fetched: [] })
        })
    })
})

describe("reading a declaration from cognet source", () => {
    test("reads models: out of cognet.config.ts textually", async () => {
        // Textual because this runs BEFORE the cognet's own dependencies are
        // installed, where evaluating the config would simply fail.
        const { readCognetModels } = await import("@arcforge/platform/build/blueprint")

        await scratch(async root => {
            await mkdir(root, { recursive: true })
            await writeFile(
                join(root, "cognet.config.ts"),
                `export default defineCognet({
                    name: "vox",
                    abi: "10",
                    models: {
                        vad: "hf:runanywhere/silero-vad-v5/silero_vad.onnx",
                        asr: "hf:ggerganov/whisper.cpp/ggml-base.en.bin",
                    },
                })`,
                "utf8",
            )

            expect(await readCognetModels(root)).toEqual({
                vad: "hf:runanywhere/silero-vad-v5/silero_vad.onnx",
                asr: "hf:ggerganov/whisper.cpp/ggml-base.en.bin",
            })
        })
    })

    test("a cognet with no models declaration reads as empty", async () => {
        const { readCognetModels } = await import("@arcforge/platform/build/blueprint")

        await scratch(async root => {
            await writeFile(join(root, "cognet.config.ts"), `export default defineCognet({ name: "x", abi: "10" })`, "utf8")
            expect(await readCognetModels(root)).toEqual({})
        })
    })
})
