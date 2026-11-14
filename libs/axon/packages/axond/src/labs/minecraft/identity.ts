import { createHash } from "node:crypto"

/**
 * The UUID an offline Minecraft server gives a player of this name.
 *
 * Minecraft derives it as a version-3 (MD5) UUID over the ASCII bytes of
 * `OfflinePlayer:<name>`, so it is a pure function of the name — which is what
 * makes a named body's identity stable across boots without any account, and
 * what lets `Lease.identity` mean the same thing it means in Terraria.
 *
 * Derived here rather than read back from the server: a body has to present a
 * UUID on the command line BEFORE it connects, so there is nothing to read.
 */
export function offlineUuid(name: string): string {
    const digest = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest()
    // Version 3 and the RFC 4122 variant, exactly as Java's
    // UUID.nameUUIDFromBytes stamps them.
    digest[6] = (digest[6]! & 0x0f) | 0x30
    digest[8] = (digest[8]! & 0x3f) | 0x80
    const hex = digest.toString("hex")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
