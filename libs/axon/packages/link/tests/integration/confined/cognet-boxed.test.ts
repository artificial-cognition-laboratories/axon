import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepare } from "../../../src/spawn"
import { Confinement, probe } from "../../../src/confine"
import { boxedPid } from "../../../src/confine/netns"
import type { CapsulePolicy } from "@arcforge/types"

/**
 * THE PROOF: a whole agent inside one OS box, with the COGNET'S OWN CODE bound
 * by the user's policy.
 *
 * Before the reshuffle the cognet was `await import()`ed into the kernel's heap
 * and handed a live closure table, so cognet-authored code reached globalThis,
 * node builtins and the network directly. A `net` policy applied to
 * model-emitted code and to nothing else. That matters because a cognet is a
 * REGISTRY ARTIFACT — the product thesis is that a user swaps `axon-astra-v1`
 * for a newer name and gets better cognition, which makes it a supply-chain
 * dependency written by a stranger.
 *
 * ── Why the fixture speaks the wire protocol by hand ────────────────────────
 *
 * The agent must be SELF-CONTAINED. A first version imported the real link
 * modules by absolute path and every run died with "Cannot find module": those
 * files are outside the box, which is the confinement working exactly as
 * designed. Rather than widen the mount to make a test pass — which would have
 * quietly weakened the thing under test — the fixture imports nothing outside
 * its own root and frames its own messages. The protocol it speaks is pinned by
 * `tests/unit/link/frame.test.ts`.
 *
 * Skipped where no OS wall can exist (no bwrap / no unprivileged userns —
 * macOS, Windows, a standard container). The mediator still applies there, but
 * "the user denied it and the OS enforced it" is a Linux-with-userns claim and
 * must never be asserted where it is untrue.
 */
const boxed = probe().auto ? describe : describe.skip

boxed("confinement — the cognet is bound by the user's policy", () => {
    let dir: string

    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "axon-boxed-")) })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    /**
     * An agent whose body runs as cognet-authored code would: in the agent's
     * own heap, inside the box, NOT as model-emitted `<typescript>`.
     *
     * `body` must set `outcome`. It is reported through the real link, so a
     * result reaching the supervisor also proves the wire survived the wall.
     */
    function agentSource(body: string): string {
        return `
const paths = JSON.parse(process.env.AXON_AGENT_LINK)

/** The wire's framing: 4-byte big-endian length, then the payload. */
function frame(message) {
    const payload = new TextEncoder().encode(JSON.stringify(message))
    const out = new Uint8Array(4 + payload.byteLength)
    new DataView(out.buffer).setUint32(0, payload.byteLength, false)
    out.set(payload, 4)
    return out
}

let outcome = "blocked"
try { ${body} } catch (error) { outcome = "blocked" }

const data = await Bun.connect({ unix: paths.data, socket: { data() {} } })
data.write(frame({
    k: "send",
    verb: "commit",
    arg: { type: "axon:log:info", data: { message: "probe:" + outcome } },
}))
await new Promise(resolve => setTimeout(resolve, 200))
process.exit(0)
`
    }

    async function run(body: string, policy: Partial<CapsulePolicy>): Promise<string[]> {
        const root = join(dir, "agent")
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "probe", type: "module" }))
        const entry = join(root, "main.ts")
        writeFileSync(entry, agentSource(body))

        const seen: string[] = []

        /**
         * Wait for the probe's REPORT, not for a fixed duration.
         *
         * A sleep long enough for a slow box wastes it on every fast run and is
         * still too short under load — which is how a security test becomes
         * flaky, and a flaky security test is one people re-run rather than
         * read. The probe sends one line; its arrival is the signal, and the
         * timeout only backstops an agent that never boots.
         */
        let reported!: () => void
        const arrival = new Promise<void>(resolve => { reported = resolve })

        const link = prepare({
            sessionId: `boxed-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            services: {
                async *infer() {},
                commit: (_type, data) => {
                    const message = (data as { message?: string })?.message
                    if (typeof message !== "string") return
                    seen.push(message)
                    if (message.startsWith("probe:")) reported()
                },
            },
            onError: () => {},
        })

        const confinement = await Confinement({
            tier: "auto",
            cwd: root,
            policy: { shell: { allow: ["*"], spawn: true }, isolation: "auto", ...policy } as CapsulePolicy,
            entrypoint: entry,
            // The socket directory, so the agent can dial its supervisor.
            // The box is --clearenv'd, so the link plumbing must be declared
            // here rather than only on the spawn below.
            env: link.env as Record<string, string>,
            control: [link.root],
            // The agent's own code. Without this the box has no program to run.
            project: [root],
        }).build()

        const child = Bun.spawn(
            [confinement.spawnCommand.command, ...confinement.spawnCommand.args],
            { env: { ...process.env, ...link.env }, stdout: "pipe", stderr: "pipe" },
        )
        void (async () => { for await (const c of child.stderr as ReadableStream<Uint8Array>) process.stderr.write(c) })().catch(() => {})

        /**
         * The box's network stack, attached once the child exists.
         *
         * `slirp4netns` joins a namespace by PID, so this cannot happen while
         * the box is being built. The pid it needs is the process INSIDE the
         * namespace — bwrap's child — not bwrap itself, which is still in the
         * host's namespaces and yields "setns: Operation not permitted".
         *
         * Only for a net-granting policy: without one the box has
         * `--unshare-net` and no stack, which is the point.
         */
        let stack: ReturnType<typeof Bun.spawn> | null = null
        if (confinement.network) {
            // The SAME helper production uses. This test previously carried
            // its own correct implementation while confined.ts carried a broken
            // one — which is exactly how the bug survived a green suite.
            const inner = await boxedPid(child.pid)
            if (inner) {
                stack = Bun.spawn(
                    ["slirp4netns", "--configure", "--mtu=65520", "--disable-host-loopback", String(inner), "tap0"],
                    { stdout: "ignore", stderr: "ignore" },
                )
            }
        }

        await Promise.race([arrival, new Promise(resolve => setTimeout(resolve, 15_000))])
        stack?.kill()
        child.kill()
        // The confinement owns a temp directory holding the launcher, the nft
        // ruleset and the hosts file. Skipping this leaked one per test — the
        // same leak production had on its failed-boot path.
        await confinement.cleanup()
        link.connected.then(a => a.dispose()).catch(() => {})
        return seen
    }

    it("blocks a cognet's fetch when the user denied network", async () => {
        // Before the reshuffle this returned REACHED: the cognet lived in the
        // kernel's heap and the network policy never applied to it.
        const seen = await run(
            `await fetch("https://example.com", { signal: AbortSignal.timeout(3000) }); outcome = "REACHED"`,
            { net: undefined },
        )
        expect(seen).toContain("probe:blocked")
        expect(seen).not.toContain("probe:REACHED")
    }, 40_000)

    it("lets the same cognet fetch when the user GRANTED network", async () => {
        // The control. A wall that blocks everything is not a policy, it is a
        // brick — without this, the test above proves only that the box breaks
        // the agent.
        const seen = await run(
            `const r = await fetch("https://example.com", { signal: AbortSignal.timeout(5000) }); outcome = "REACHED"`,
            { net: { allow: ["example.com:443"], dns: "allowlist" } },
        )
        expect(seen).toContain("probe:REACHED")
    }, 40_000)

    /**
     * The case the old implementation could not express — and the one the docs
     * claimed. `network: { "api.github.com": true, "*": false }` compiled to
     * nothing: any grant handed the box the host's whole network stack, so a
     * policy naming one host reached every host. This asserts the allowlist is
     * actually an allowlist.
     */
    it("blocks a host the net policy did not name", async () => {
        const seen = await run(
            `await fetch("https://example.com", { signal: AbortSignal.timeout(5000) }); outcome = "REACHED"`,
            { net: { allow: ["api.github.com:443"], dns: "allowlist" } },
        )
        expect(seen).toContain("probe:blocked")
        expect(seen).not.toContain("probe:REACHED")
    }, 40_000)

    it("blocks a raw connection to a denied ADDRESS, bypassing DNS entirely", async () => {
        // The property a mediator cannot provide. Resolving is not how the box
        // is escaped — a socket to a literal IP is — so the filter has to be in
        // the kernel rather than in front of a hostname lookup.
        const seen = await run(
            `await fetch("https://1.1.1.1", { signal: AbortSignal.timeout(5000) }); outcome = "REACHED"`,
            { net: { allow: ["api.github.com:443"], dns: "allowlist" } },
        )
        expect(seen).toContain("probe:blocked")
        expect(seen).not.toContain("probe:REACHED")
    }, 40_000)

    /**
     * The env boundary. The box used to inherit the whole invoking shell, so an
     * `fs` policy denying `.env` on disk was undone by the same secrets
     * arriving as environment.
     */
    it("does not carry a host secret into the box", async () => {
        process.env.AXON_WALL_PROBE_SECRET = "must-not-cross"
        try {
            const seen = await run(
                `outcome = process.env.AXON_WALL_PROBE_SECRET ? "REACHED" : "blocked"`,
                {},
            )
            expect(seen).toContain("probe:blocked")
            expect(seen).not.toContain("probe:REACHED")
        } finally {
            delete process.env.AXON_WALL_PROBE_SECRET
        }
    }, 40_000)

    it("blocks a cognet's read outside the declared fs policy", async () => {
        // The path must not EXIST in the box — ENOENT, not EACCES. That
        // distinction is the point of a mount namespace: the agent cannot even
        // enumerate what it was not granted.
        //
        // The target is written by the TEST and plainly readable by this user,
        // so a "blocked" result can only mean the namespace removed it.
        const secret = join(dir, "secret.txt")
        writeFileSync(secret, "the-agent-must-not-read-this")

        const seen = await run(
            `await Bun.file(${JSON.stringify(secret)}).text(); outcome = "REACHED"`,
            { fs: { read: [join(dir, "agent")] } },
        )
        expect(seen).toContain("probe:blocked")
        expect(seen).not.toContain("probe:REACHED")
    }, 40_000)

    it("lets the same cognet read what the policy GRANTED", async () => {
        const root = join(dir, "agent")
        mkdirSync(root, { recursive: true })
        const allowed = join(root, "data.txt")
        writeFileSync(allowed, "readable")

        const seen = await run(
            `outcome = (await Bun.file(${JSON.stringify(allowed)}).text()).trim()`,
            { fs: { read: [root] } },
        )
        expect(seen).toContain("probe:readable")
    }, 40_000)
})
