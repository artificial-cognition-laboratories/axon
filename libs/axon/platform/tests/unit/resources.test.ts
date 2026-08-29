import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatSize, parseSize, Reservations, Resources } from "../../src/services/resources"

let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "axon-resources-"))
})

afterEach(async () => {
    await rm(root, { recursive: true, force: true })
})

const GB = 1024 ** 3

/** A Resources bound to a scratch directory, with a fixed ceiling. */
function resources(vram?: string) {
    return Resources({
        budget: () => (vram === undefined ? undefined : { vram }),
        reservations: Reservations({ root }),
    })
}

describe("parseSize", () => {
    it("reads the units a person writes", () => {
        expect(parseSize("8GB")).toBe(8 * GB)
        expect(parseSize("512MB")).toBe(512 * 1024 ** 2)
        expect(parseSize("1.5GB")).toBe(Math.floor(1.5 * GB))
    })

    it("is case and space insensitive", () => {
        expect(parseSize("8gb")).toBe(8 * GB)
        expect(parseSize(" 8 GB ")).toBe(8 * GB)
    })

    it("treats unreadable input as no ceiling, never as zero", () => {
        expect(parseSize("plenty")).toBeNull()
        expect(parseSize("")).toBeNull()
        expect(parseSize(undefined)).toBeNull()
        expect(parseSize("-4GB")).toBeNull()
    })
})

describe("formatSize", () => {
    it("renders a number a person reads", () => {
        expect(formatSize(8 * GB)).toBe("8.0GB")
        expect(formatSize(512 * 1024 ** 2)).toBe("512MB")
    })
})

describe("admission", () => {
    it("admits a load that fits", () => {
        const release = resources("8GB").admit({ agent: "vox", role: "asr", model: "whisper", bytes: 2 * GB })

        expect(typeof release).toBe("function")
    })

    it("refuses a load that does not fit, naming what is holding the memory", () => {
        const res = resources("8GB")
        res.admit({ agent: "vox", role: "asr", model: "whisper", bytes: 6 * GB })

        try {
            res.admit({ agent: "other", role: "vad", model: "silero", bytes: 4 * GB })
            throw new Error("expected a refusal")
        } catch (cause) {
            expect((cause as { code?: string }).code).toBe("AX-RES-001")
            expect((cause as Error).message).toContain("whisper")
        }
    })

    it("never evicts — the first holder keeps its memory", () => {
        const res = resources("8GB")
        res.admit({ agent: "vox", role: "asr", model: "whisper", bytes: 6 * GB })

        expect(() => res.admit({ agent: "other", role: "vad", model: "silero", bytes: 4 * GB })).toThrow()
        expect(res.state().reservations.map(entry => entry.model)).toEqual(["whisper"])
    })

    it("releasing frees the memory for the next load", () => {
        const res = resources("8GB")
        const release = res.admit({ agent: "vox", role: "asr", model: "whisper", bytes: 6 * GB })

        release()

        expect(res.fits(4 * GB)).toBe(true)
    })

    it("releasing twice is not an error", () => {
        const res = resources("8GB")
        const release = res.admit({ agent: "vox", role: "asr", model: "whisper", bytes: 2 * GB })

        release()
        expect(() => release()).not.toThrow()
        expect(res.state().held).toBe(0)
    })

    it("an undeclared, unmeasurable machine bounds nothing", () => {
        // The honest answer when we cannot read the hardware AND the user
        // declared no ceiling: refusing every load here would make local
        // inference unavailable on most machines.
        const res = Resources({ budget: () => undefined, reservations: Reservations({ root }) })

        if (res.hardware.vram === undefined) {
            expect(res.state().available).toBeNull()
            expect(res.fits(999 * GB)).toBe(true)
        }
    })

    it("a declared budget wins over measured hardware", () => {
        // A user who says 4GB on a 24GB card means it.
        const res = resources("4GB")

        expect(res.state().budget).toBe(4 * GB)
        expect(res.fits(6 * GB)).toBe(false)
    })
})

describe("shared state", () => {
    it("two readers see the same holds", () => {
        const first = resources("8GB")
        first.admit({ agent: "vox", role: "asr", model: "whisper", bytes: 2 * GB })

        // A second Resources over the same directory is a second PROCESS, as
        // far as the state is concerned — this is the property that stops two
        // agents both deciding they have room for the same memory.
        const second = resources("8GB")

        expect(second.state().held).toBe(2 * GB)
    })

    it("a dead holder's reservation is reaped rather than held forever", async () => {
        // pid 1 is never this process; the record is well-formed but its
        // holder is not us. A reader probes liveness and clears what it finds.
        await writeFile(
            join(root, "stale.json"),
            JSON.stringify({ pid: 999_999_999, agent: "gone", role: "asr", model: "whisper", bytes: 6 * GB, at: Date.now() }),
        )

        expect(resources("8GB").state().held).toBe(0)
    })

    it("an unparseable record does not empty the whole view", async () => {
        const res = resources("8GB")
        res.admit({ agent: "vox", role: "asr", model: "whisper", bytes: 2 * GB })
        await writeFile(join(root, "torn.json"), "{ not json")

        expect(res.state().held).toBe(2 * GB)
    })

    it("releaseAll drops only this process's holds", () => {
        const res = resources("8GB")
        res.admit({ agent: "vox", role: "asr", model: "whisper", bytes: 2 * GB })

        res.releaseAll()

        expect(res.state().held).toBe(0)
    })
})
