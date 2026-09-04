import { describe, expect, it } from "bun:test"
import { backendsFor, buildArgs } from "../../src/services/mic/capture"

/**
 * Microphone capture, for every platform, from one machine.
 *
 * ── Why this is worth pinning ───────────────────────────────────────────────
 *
 * Capture spawns a CLI tool and reads raw PCM off its stdout. Which tool, and
 * with which flags, depends entirely on the OS — three backend orders and six
 * argv shapes, none of which execute on Linux CI except the Linux ones.
 *
 * The failure mode is what makes it worth testing rather than eyeballing: a
 * wrong flag does not throw. The backend spawns, produces nothing or produces
 * the wrong format, and the user sees a microphone that silently does not
 * work — indistinguishable from a machine with no capture tool installed.
 *
 * ── The invariant underneath ────────────────────────────────────────────────
 *
 * Every branch, on every platform, must emit raw signed 16-bit little-endian
 * PCM, mono, at the requested rate, on stdout. That is what the reader
 * downstream assumes; a branch that drifts from it produces audio that decodes
 * to noise. The last test asserts it across all nine combinations at once,
 * which is the property that actually matters.
 */

const PLATFORMS = ["linux", "darwin", "win32"] as const

describe("backend selection", () => {
    it("offers ALSA first on Linux, where arecord is always present", () => {
        expect(backendsFor("linux")).toEqual(["arecord", "sox", "ffmpeg"])
    })

    it("never offers arecord off Linux — ALSA is Linux's subsystem", () => {
        // Selecting it on macOS or Windows would spawn a binary that is not
        // there, and fall through to "no backend" without saying why.
        expect(backendsFor("darwin")).not.toContain("arecord")
        expect(backendsFor("win32")).not.toContain("arecord")
    })

    it("falls back to sox then ffmpeg everywhere else", () => {
        expect(backendsFor("darwin")).toEqual(["sox", "ffmpeg"])
        expect(backendsFor("win32")).toEqual(["sox", "ffmpeg"])
    })
})

describe("capture arguments", () => {
    it("names each platform's own audio subsystem for ffmpeg", () => {
        // The one place a wrong string is both invisible and total: ffmpeg
        // exits immediately on an unknown input format.
        expect(buildArgs("ffmpeg", 16_000, "darwin")).toContain("avfoundation")
        expect(buildArgs("ffmpeg", 16_000, "win32")).toContain("dshow")
        expect(buildArgs("ffmpeg", 16_000, "linux")).toContain("alsa")
    })

    it("lets sox pick its own default device off Linux, and names it on Linux", () => {
        // `-d` is sox's default input, which macOS and Windows resolve
        // themselves. Linux needs the ALSA device named explicitly.
        expect(buildArgs("sox", 16_000, "darwin")).toContain("-d")
        expect(buildArgs("sox", 16_000, "win32")).toContain("-d")
        expect(buildArgs("sox", 16_000, "linux")).toContain("alsa")
    })

    it("carries the requested sample rate into every backend", () => {
        // A rate that silently reverts to a default produces audio the reader
        // resamples wrongly — a subtle corruption rather than a failure.
        for (const platform of PLATFORMS) {
            for (const backend of ["arecord", "sox", "ffmpeg"] as const) {
                expect(buildArgs(backend, 48_000, platform)).toContain("48000")
            }
        }
    })

    it("emits raw mono 16-bit PCM on stdout in every combination", () => {
        // THE invariant. Nine combinations, one contract — the reader
        // downstream decodes signed 16-bit LE mono and nothing else.
        for (const platform of PLATFORMS) {
            for (const backend of ["arecord", "sox", "ffmpeg"] as const) {
                const args = buildArgs(backend, 16_000, platform)
                const argv = args.join(" ")

                // stdout, not a file.
                expect(args.at(-1)).toBe("-")
                // mono — spelled per backend, but always one channel.
                expect(/(-c 1|-ac 1)/.test(argv)).toBe(true)
                // signed 16-bit little-endian, however this backend spells it.
                expect(/(S16_LE|s16le|signed-integer)/.test(argv)).toBe(true)
            }
        }
    })
})
