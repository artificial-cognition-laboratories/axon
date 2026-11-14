import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Where the `axon-net` executable is, or null when this install has none.
 *
 * `AXON_NET_BIN` first — an explicit path wins. Then a checkout's own build,
 * release before debug. A published install will add its per-platform package
 * here; until then a missing binary is reported by the network, never guessed.
 */
export function binary(): string | null {
    const candidates = [
        process.env.AXON_NET_BIN,
        fileURLToPath(new URL("../../../net/target/release/axon-net", import.meta.url)),
        fileURLToPath(new URL("../../../net/target/debug/axon-net", import.meta.url)),
    ]
    return candidates.find((path): path is string => path !== undefined && existsSync(path)) ?? null
}
