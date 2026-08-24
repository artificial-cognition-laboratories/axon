import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * The Vue toolchain must not load until a .vue prompt actually renders.
 *
 * `@axon/vstr` pulls @vue/compiler-sfc, runtime-core, server-renderer and
 * turndown behind it — ~280ms of module evaluation. It used to be a top-level
 * import in `runtime/source/render.ts` and `platform/boot.ts`, so every agent
 * paid it at import time whether or not it had a single .vue prompt, and it was
 * the largest single cost in booting the runtime.
 *
 * A plain `import { vstr }` restores that instantly and silently — nothing
 * fails, boots just get slow again. So the property is asserted directly:
 * after importing core and booting an agent with only a STATIC prompt, the Vue
 * modules must be absent from the graph; after rendering a dynamic one, present.
 *
 * Runs in a subprocess because it is a statement about a fresh module graph,
 * which cannot be observed in a worker that has already imported everything.
 */

const PKG_ROOT = path.join(import.meta.dir, "..", "..", "..")

async function moduleGraphProbe(body: string): Promise<string> {
    // Written INSIDE the package, not /tmp: workspace specifiers like
    // "@axon/core" resolve from the file's own location, so a probe in a
    // temp dir cannot see the workspace at all.
    const dir = await mkdtemp(path.join(PKG_ROOT, ".lazy-probe-"))
    try {
        const probe = path.join(dir, "probe.ts")
        await writeFile(probe, body)
        const proc = Bun.spawn(["bun", "run", probe], {
            stdout: "pipe",
            stderr: "pipe",
            cwd: PKG_ROOT,
        })
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])
        if (code !== 0) throw new Error(`probe failed (${code}): ${stderr || stdout}`)
        return stdout.trim().split("\n").at(-1) ?? ""
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

/** True when the Vue toolchain is resident — measured by how long a fresh import takes. */
const RESIDENT_MS = 40

describe("prompt rendering loads the Vue toolchain lazily", () => {
    it("does not load vstr when only static prompts are rendered", async () => {
        const loaded = await moduleGraphProbe(`
            const { Axon } = await import("@axon/core")
            const { KERNEL_ABI_VERSION } = await import("@arcforge/types")
            const { TestCognet } = await import("${path.join(import.meta.dir, "..", "..", "setup", "cognet.ts")}")
            const { writeFile, mkdtemp } = await import("node:fs/promises")
            const { tmpdir } = await import("node:os")
            const path = await import("node:path")

            const dir = await mkdtemp(path.join(tmpdir(), "axon-lazy-static-"))
            const filePath = path.join(dir, "hello.md")
            await writeFile(filePath, "# static only")

            const runtime = await Axon({
                blueprint: {
                    cognet: { name: "test", version: "1.0.0", abi: KERNEL_ABI_VERSION, definition: TestCognet() },
                    prompts: [{ name: "hello", kind: "static", filePath }],
                },
            })
            await runtime.axon.prompt("hello")
            await runtime.shutdown()

            // If vstr were already resident this import is ~free; a real load costs ~280ms.
            const start = performance.now()
            await import("@axon/vstr")
            console.log(performance.now() - start)
        `)

        expect(Number(loaded)).toBeGreaterThan(RESIDENT_MS)
    }, 30_000)

    it("has loaded vstr once a dynamic prompt has rendered", async () => {
        const loaded = await moduleGraphProbe(`
            const { Axon } = await import("@axon/core")
            const { KERNEL_ABI_VERSION } = await import("@arcforge/types")
            const { TestCognet } = await import("${path.join(import.meta.dir, "..", "..", "setup", "cognet.ts")}")
            const { writeFile, mkdtemp } = await import("node:fs/promises")
            const { tmpdir } = await import("node:os")
            const path = await import("node:path")

            const dir = await mkdtemp(path.join(tmpdir(), "axon-lazy-dynamic-"))
            const filePath = path.join(dir, "hello.vue")
            await writeFile(filePath, "<template><h1>Hello</h1></template>")

            const runtime = await Axon({
                blueprint: {
                    cognet: { name: "test", version: "1.0.0", abi: KERNEL_ABI_VERSION, definition: TestCognet() },
                    prompts: [{ name: "hello", kind: "dynamic", filePath }],
                },
            })
            const rendered = await runtime.axon.prompt("hello")
            if (!rendered.includes("Hello")) throw new Error("prompt did not render: " + rendered)
            await runtime.shutdown()

            // Now resident — the render loaded it, so this import is a cache hit.
            const start = performance.now()
            await import("@axon/vstr")
            console.log(performance.now() - start)
        `)

        expect(Number(loaded)).toBeLessThan(RESIDENT_MS)
    }, 30_000)
})
