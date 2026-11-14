import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "@arcforge/platform/store"
import { Credential } from "../../src/agents/index"
import { OTHER_USER, TEST_USER } from "../setup/user"

/**
 * A daemon outlives logins. It starts at boot, often before anyone has signed
 * in, and a login happens in another process writing the shared store. Its
 * client must follow the store — a client built once, with no key, answers
 * the backend's 401 by scrubbing the login the person just made.
 */
let root: string | null = null
afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
})

function signIn(store: string, user: typeof TEST_USER): void {
    Store({ root: store }).profiles.save(user.id, { user: { id: user.id, email: user.email }, auth: { apiKey: user.apiKey } })
}

test("a login made after the daemon started is the one its client uses", () => {
    root = mkdtempSync(join(tmpdir(), "axond-cred-"))
    const credential = Credential({ store: root })
    expect(credential.account()).toBeNull()

    signIn(root, TEST_USER)

    expect(credential.account()).toEqual({ id: TEST_USER.id })
    expect(credential.client().user.auth.apiKey).toBe(TEST_USER.apiKey)
})

test("switching account switches the client with it", () => {
    root = mkdtempSync(join(tmpdir(), "axond-cred-"))
    signIn(root, TEST_USER)
    const credential = Credential({ store: root })
    expect(credential.client().user.auth.apiKey).toBe(TEST_USER.apiKey)

    signIn(root, OTHER_USER)

    expect(credential.client().user.auth.apiKey).toBe(OTHER_USER.apiKey)
})
