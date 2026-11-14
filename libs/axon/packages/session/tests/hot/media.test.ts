import { describe, expect, it } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { home } from "../../src/home"
import { Media } from "../../src/media"

/**
 * Heavy bytes are kept once, beside the session, and referred to — never
 * carried by an event. The window is bounded, and a resumed session counts
 * what an earlier run left.
 */

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "axon-media-"))
    return { root: root, dir: home.data.media.dir(root, "s1"), clean: () => rm(root, { recursive: true, force: true }) }
}

const frame = (fill: number) => new Uint8Array(100).fill(fill)

describe("Media", () => {
    it("keeps the bytes whole and returns a reference that reads them back", async () => {
        const { root, clean } = await fixture()
        const media = Media({ root: root, sessionId: "s1" })
        const ref = await media.keep(frame(7), "image/jpeg")
        expect(ref.mime).toBe("image/jpeg")
        expect(ref.bytes).toBe(100)
        expect(ref.uri.startsWith("file://")).toBe(true)
        expect(new Uint8Array(await readFile(fileURLToPath(ref.uri)))).toEqual(frame(7))
        await clean()
    })

    it("drops the oldest once over its bound, never the newest", async () => {
        const { root, dir, clean } = await fixture()
        const media = Media({ root: root, sessionId: "s1", maxBytes: 250 })
        const refs = await Promise.all([1, 2, 3, 4].map(fill => media.keep(frame(fill), "image/jpeg")))
        expect((await readdir(dir)).sort()).toEqual(["0000000002.jpg", "0000000003.jpg"])
        expect(media.bytes).toBe(200)
        expect(new Uint8Array(await readFile(fileURLToPath(refs[3]!.uri)))).toEqual(frame(4))
        await clean()
    })

    it("counts what an earlier run left, and numbers after it", async () => {
        const { root, dir, clean } = await fixture()
        await Media({ root: root, sessionId: "s1" }).keep(frame(1), "image/jpeg")
        const resumed = Media({ root: root, sessionId: "s1", maxBytes: 150 })
        await resumed.keep(frame(2), "image/jpeg")
        expect(await readdir(dir)).toEqual(["0000000001.jpg"])
        await clean()
    })

    it("refuses a kind it has no file for", async () => {
        const { root, clean } = await fixture()
        expect(() => Media({ root: root, sessionId: "s1" }).keep(frame(1), "video/x-unknown")).toThrow("cannot be kept")
        await clean()
    })
})
