import { describe, expect, test } from "bun:test"
import { Releases } from "../../src/cloud/releases"

describe("cloud.releases", () => {
    test("maps Axon release discovery to the public backend route", async () => {
        const calls: string[] = []
        const releases = Releases({
            http: {
                async get(path: string) {
                    calls.push(path)
                    return {
                        package: "@arcforge/axon",
                        channel: "latest",
                        version: "2.4.1",
                    }
                },
            } as never,
        })

        expect(await releases.axon()).toEqual({
            package: "@arcforge/axon",
            channel: "latest",
            version: "2.4.1",
        })
        expect(calls).toEqual(["/api/releases/axon"])
    })

    test("requests uncached release discovery for an update commitment", async () => {
        const calls: string[] = []
        const releases = Releases({
            http: {
                async get(path: string) {
                    calls.push(path)
                    return { package: "@arcforge/axon", channel: "latest", version: "2.4.2" }
                },
            } as never,
        })

        await releases.axon(undefined, { fresh: true })
        expect(calls).toEqual(["/api/releases/axon?fresh=1"])
    })
})
