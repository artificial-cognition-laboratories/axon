import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Installer, fromArgv, toArgv, type UpdateRequest } from "@arcforge/platform/update"
import { main } from "@arcforge/platform/bin/update-helper"

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function statePath(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-helper-"))
    roots.push(root)
    return join(root, "update.json")
}

const request = (state: string): UpdateRequest => ({
    from: "2.0.20",
    to: "2.0.21",
    bun: "/bun",
    axon: "/axon",
    state,
})

/** Silence the installer's progress writes — the assertions are on commands and state. */
const quiet = { out: () => {}, err: () => {} }

describe("Axon update installer", () => {
    test("installs the exact version, verifies, and records completion", async () => {
        const state = await statePath()
        const commands: string[][] = []
        const code = await Installer({
            ...quiet,
            run: async command => {
                commands.push(command)
                return command[0] === "/axon"
                    ? { code: 0, stdout: "2.0.21\n" }
                    : { code: 0, stdout: "" }
            },
        }).apply(request(state))

        expect(code).toBe(0)
        expect(commands).toEqual([
            ["/bun", "add", "-g", "--no-cache", "@arcforge/axon@2.0.21"],
            ["/axon", "--version"],
        ])
        expect(JSON.parse(await readFile(state, "utf-8"))).toMatchObject({ status: "complete" })
    })

    test("rolls back to the previous exact version after failed verification", async () => {
        const state = await statePath()
        const commands: string[][] = []
        const code = await Installer({
            ...quiet,
            run: async command => {
                commands.push(command)
                if (command[0] === "/axon") return { code: 0, stdout: "2.0.19\n" }
                return { code: 0, stdout: "" }
            },
        }).apply(request(state))

        expect(code).toBe(1)
        expect(commands.at(-1)).toEqual(["/bun", "add", "-g", "@arcforge/axon@2.0.20"])
        expect(JSON.parse(await readFile(state, "utf-8"))).toMatchObject({ status: "rolled-back" })
    })

    test("retries an exact install while a fresh npm release propagates", async () => {
        const state = await statePath()
        const commands: string[][] = []
        const delays: number[] = []
        let installs = 0
        const code = await Installer({
            ...quiet,
            sleep: async milliseconds => { delays.push(milliseconds) },
            run: async command => {
                commands.push(command)
                if (command[0] === "/axon") return { code: 0, stdout: "2.0.21\n" }
                installs++
                return { code: installs < 3 ? 1 : 0, stdout: "" }
            },
        }).apply(request(state))

        expect(code).toBe(0)
        expect(delays).toEqual([1_000, 2_000])
        expect(commands.filter(command => command[0] === "/bun")).toHaveLength(3)
        expect(JSON.parse(await readFile(state, "utf-8"))).toMatchObject({ status: "complete" })
    })
})

describe("update handshake contract", () => {
    test("round-trips a request through argv", () => {
        const original = request("/tmp/update.json")
        expect(fromArgv(toArgv(original))).toEqual(original)
    })

    test("rejects malformed versions before constructing package arguments", () => {
        // Asserted on the code, not the message: the code is the map's stable
        // identity, while title/detail are rendering and free to change.
        expect(() => fromArgv([
            "--from", "2.0.20",
            "--to", "latest; rm -rf /",
            "--bun", "/bun",
            "--axon", "/axon",
            "--state", "/tmp/update.json",
        ])).toThrow(expect.objectContaining({ code: "AX-TUI-034" }))
    })

    test("rejects an incomplete request", () => {
        expect(() => fromArgv(["--from", "2.0.20", "--to", "2.0.21"]))
            .toThrow(expect.objectContaining({ code: "AX-TUI-033" }))
    })
})

describe("update-helper executable", () => {
    test("hard-exits with the completed update's status", async () => {
        const state = await statePath()
        const exits: number[] = []
        await main(toArgv(request(state)), {
            ...quiet,
            run: async command => command[0] === "/axon"
                ? { code: 0, stdout: "2.0.21\n" }
                : { code: 0, stdout: "" },
            exit: code => { exits.push(code) },
        })

        expect(exits).toEqual([0])
    })

    test("hard-exits nonzero when the request is unusable", async () => {
        const exits: number[] = []
        const reports: string[] = []
        await main([], {
            ...quiet,
            exit: code => { exits.push(code) },
            err: message => { reports.push(message) },
        })

        expect(exits).toEqual([1])
        // The rendered message carries the error's detail, which names exactly
        // which flags were missing — the helper is spawned, so a stderr line is
        // the only diagnostic anyone gets.
        expect(reports).toEqual(["Axon updater failed: missing --from, --to, --bun, --axon, --state\n"])
    })
})
