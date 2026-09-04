import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableId(): string {
    return `test-user-${crypto.randomUUID()}`
}

function disposableEmail(): string {
    return `test-${crypto.randomUUID()}@axon.dev`
}

async function withProfile(fn: (platform: ReturnType<typeof Platform>) => void | Promise<void>): Promise<void> {
    const storeDir = await mkdtemp(join(tmpdir(), "axon-test-intent-"))
    try {
        const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
        const id = disposableId()
        platform.store.profiles.save(id, { user: { id, email: disposableEmail() }, auth: {} })
        await fn(platform)
    } finally {
        await rm(storeDir, { recursive: true, force: true })
    }
}

/**
 * What the TUI should open on its next boot, written by a CLI command.
 *
 * `axon attach <url>` cannot attach in the CLI process — there is no terminal
 * UI there — so it records an intent and returns "boot". The distinguishing
 * property against `state` is the LIFETIME: state is continuity, re-read
 * forever; an intent is an instruction, carried out once and gone.
 */
describe("store.intent", () => {
    it("is empty when nothing has been recorded", async () => {
        await withProfile(platform => {
            expect(platform.store.intent.take()).toBeNull()
        })
    })

    it("take() returns what set() recorded", async () => {
        await withProfile(platform => {
            platform.store.intent.set({ kind: "attach", ref: "http://localhost:3010" })
            expect(platform.store.intent.take()).toEqual({ kind: "attach", ref: "http://localhost:3010" })
        })
    })

    it("CLEARS on take — an intent must never fire twice", async () => {
        await withProfile(platform => {
            platform.store.intent.set({ kind: "attach", ref: "http://localhost:3010" })
            platform.store.intent.take()
            // Left in place, this would silently reconnect to a URL someone
            // visited once, on every subsequent start, forever.
            expect(platform.store.intent.take()).toBeNull()
        })
    })

    it("the newest intent replaces an unconsumed one", async () => {
        await withProfile(platform => {
            platform.store.intent.set({ kind: "attach", ref: "http://first:3010" })
            platform.store.intent.set({ kind: "session", sessionId: "abc", agent: "zeno" })
            // Two pending intents would be ambiguous; the last command typed wins.
            expect(platform.store.intent.take()).toEqual({ kind: "session", sessionId: "abc", agent: "zeno" })
        })
    })

    it("does not disturb app state — the two have opposite lifetimes", async () => {
        await withProfile(platform => {
            platform.store.state.update(current => ({ ...current, lastAgent: "zeno" }))
            platform.store.intent.set({ kind: "attach", ref: "http://localhost:3010" })
            platform.store.intent.take()

            // Clearing an intent must not rewrite continuity data — the reason
            // they are separate files rather than one field.
            expect(platform.store.state.get()).toEqual({ lastAgent: "zeno" })
        })
    })

    it("take() is null when logged out, rather than throwing", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-intent-"))
        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            // Boot reads this before anything else; throwing here would fail
            // the whole startup for a logged-out user.
            expect(platform.store.intent.take()).toBeNull()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
        }
    })
})
