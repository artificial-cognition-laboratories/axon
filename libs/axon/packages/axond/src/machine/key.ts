import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { err } from "@arcforge/err"

type KeyOpts = {
    /** Where the key lives: `<store>/machine/key`. */
    path: string
}

/**
 * Key — this machine's identity on the network.
 *
 * A 32-byte Ed25519 seed, generated here on first use and never sent anywhere.
 * Its public half IS the machine's address: other machines dial it, the
 * directory records which account owns it, and the network sidecar proves it
 * in every handshake. The daemon owns it; the sidecar only reads the file.
 *
 * Lives in the store, not the cache — wiping a cache must not turn a machine
 * into a stranger. A reinstall that loses it is a new machine, by design.
 *
 * Created lazily: construction touches nothing.
 */
export function Key(opts: KeyOpts) {
    let id: string | null = null

    /** The seed on disk, written first if there is none. */
    function seed(): Buffer {
        if (!existsSync(opts.path)) {
            mkdirSync(dirname(opts.path), { recursive: true, mode: 0o700 })
            writeFileSync(opts.path, randomBytes(32), { mode: 0o600, flag: "wx" })
        }
        const bytes = readFileSync(opts.path)
        if (bytes.length !== 32) {
            throw err("FILE_UNREADABLE", {
                detail: `machine key at ${opts.path} is ${bytes.length} bytes, expected 32`,
                context: { path: opts.path },
            })
        }
        // `wx` and mode only apply at creation; a key someone loosened is re-tightened.
        chmodSync(opts.path, 0o600)
        return bytes
    }

    return {
        /** The key file the sidecar is pointed at, created if absent. */
        file(): string {
            seed()
            return opts.path
        },

        /** The public key, hex — this machine's id on the network. */
        id(): string {
            if (id === null) id = publicHex(seed())
            return id
        },

        /** An Ed25519 signature over `message` by this machine, hex — how it proves it holds the key. */
        sign(message: string): string {
            return sign(null, Buffer.from(message), secret(seed())).toString("hex")
        },
    }
}

export type KeyT = ReturnType<typeof Key>

/** DER prefix that wraps a raw Ed25519 seed as PKCS#8, which is what node:crypto imports. */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex")

function secret(seed: Buffer) {
    return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" })
}

function publicHex(seed: Buffer): string {
    const spki = createPublicKey(secret(seed)).export({ format: "der", type: "spki" })
    // SPKI for Ed25519 is a fixed 12-byte header followed by the 32-byte key.
    return spki.subarray(spki.length - 32).toString("hex")
}
