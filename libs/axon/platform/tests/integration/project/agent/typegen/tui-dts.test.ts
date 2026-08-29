import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../../setup/user"

/**
 * globals.d.ts is written in two halves that must agree, and nothing else
 * checks that they do.
 *
 * The contract half is `TUI_CONTRACT`, generated from `types/src/tui.ts`. The
 * const half — `const tui: AxonTui` and its nine siblings — is a hand-written
 * template literal in tui-dts.ts. A type renamed in tui.ts leaves that literal
 * pointing at a name that no longer exists, and TypeScript's response to an
 * unresolvable type in an ambient `declare global` is not an error a profile
 * ever sees: the global silently becomes `any`.
 *
 * That is precisely what shipped. Six of the ten globals — `tui`, `palette`,
 * `mode`, `theme`, `lines`, `components` — were `any` in every profile on
 * disk, so `tui.hook("tui:copy", ({ text }) => ...)` had no payload type and
 * `lines.create()` accepted any component name at all. The package's own
 * contract test passed throughout, because it only ever read the contract half.
 *
 * So these tests read the ARTIFACT and cross-check the halves against each
 * other. A rename that updates one and not the other fails here.
 */

async function globals(): Promise<string> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
    const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
    try {
        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        const project = await platform.projects.create("extension", {
            name: `@${TEST_USER.username}/test-ext-${crypto.randomUUID().slice(0, 8)}`,
            dir,
        })
        await project.typegen()
        return await readFile(join(project.root, ".extension", "types", "globals.d.ts"), "utf-8")
    } finally {
        await rm(storeDir, { recursive: true, force: true })
        await rm(dir, { recursive: true, force: true })
    }
}

describe("typegen() globals.d.ts", () => {
    it("declares all ten globals", async () => {
        const dts = await globals()

        // The pairing is the product surface: these ten names are what a user
        // types in main.ts, and each must carry its real type.
        expect(dts).toContain("const tui: AxonTui")
        expect(dts).toContain("const palette: AxonPalette")
        expect(dts).toContain("const commands: AxonCommands")
        expect(dts).toContain("const keys: AxonKeys")
        expect(dts).toContain("const mode: AxonMode")
        expect(dts).toContain("const input: AxonInput")
        expect(dts).toContain("const agents: AxonAgents")
        expect(dts).toContain("const theme: AxonTheme")
        expect(dts).toContain("const lines: AxonLines")
        expect(dts).toContain("const components: AxonComponents")
    })

    it("every type a global is declared as is defined in the same file", async () => {
        const dts = await globals()

        // The general form of the check above, and the one that survives a
        // global being added: whatever `const x: T` names, `type T` must exist
        // alongside it. An unresolvable T is the silent-`any` failure.
        const declared = [...dts.matchAll(/^\s+const \w+: (\w+)$/gm)].map(m => m[1]!)
        expect(declared.length).toBe(10)

        const missing = declared.filter(name => !new RegExp(`^\\s+(type|interface) ${name}\\b`, "m").test(dts))
        expect(missing).toEqual([])
    })

    it("names every global type Axon*", async () => {
        const dts = await globals()

        // One spelling for the whole public surface. The drift that produced
        // the silent-`any` bug started as a half-finished rename to this
        // convention, so the convention itself is now enforced.
        const declared = [...dts.matchAll(/^\s+const \w+: (\w+)$/gm)].map(m => m[1]!)
        expect(declared.filter(name => !name.startsWith("Axon"))).toEqual([])
    })
})
