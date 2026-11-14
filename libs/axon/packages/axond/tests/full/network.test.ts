import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { errorMap } from "@arcforge/err"
import { Key } from "../../src/machine/index"
import { Network } from "../setup/network"

/**
 * The network's slower proofs. An absent machine costs a full dial timeout to
 * prove absent, so it lives here; the sidecar's own hot suite covers the same
 * fast-fail at its boundary (`libs/axon/packages/net/tests/network.rs`).
 */
const network = Network()
afterEach(() => network.dispose())

describe("machines on the network", () => {
    test("a machine that is not there fails fast with a code, not a hang", async () => {
        const laptop = await network.machine("laptop", { network: true })
        // A real key with no machine behind it.
        const nobody = Key({ path: join(laptop.root, "nobody.key") }).id()

        await expect(laptop.axond.net.request({ key: nobody, addrs: ["127.0.0.1:9"] }, { path: ["machine", "state"] }))
            .rejects.toThrow(expect.objectContaining({ code: errorMap.NET_UNREACHABLE.code }))
    })
})
