import { Axon as AxonRuntime } from "@arcforge/core"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import type { AxonEngineDriver, AxonEngineRawEvent } from "@arcforge/types"
import { defineCognet } from "@arcforge/cognet"

/**
 * Inference through a REMOTE driver — the credential boundary, from the
 * kernel's side.
 *
 * The rule this enforces: an asset whose loss is unrecoverable and whose stolen
 * form is portable never enters the untrusted process. A stolen file is one
 * machine's data; a stolen provider key works from anywhere, forever, until
 * somebody notices. So a confined agent can CAUSE inference and can never
 * obtain the credential that performs it.
 *
 * What is asserted here is that the SWAP is invisible above the driver seam:
 * the Engine manager keeps owning AIR parsing, the retry budget and the stall
 * guard, and cannot tell whether tokens came from a provider in this heap or
 * from a supervisor across a socket.
 */
let kernelRef: unknown = null

function probeCognet(body: (kernel: never) => Promise<void>) {
    return {
        name: "probe",
        version: "1.0.0",
        abi: KERNEL_ABI_VERSION,
        definition: defineCognet({
            name: "probe",
            version: "1.0.0",
            abi: KERNEL_ABI_VERSION,
            mode: { kind: "invocation" },
            engines: { main: { type: "generate", in: "text", out: "text", primary: true } },
            // Captured at load so wake() can reach it — the ABI arrives here.
            // The probe runs inside WAKE, not load: an engine call is a
            // syscall and the ABI stamps it with the run it belongs to, so
            // calling one outside a wake throws SYSCALL_OUTSIDE_RUN. That is
            // correct — an untraced engine call is exactly the observability
            // hole the kernel refuses.
            async load(abi) { kernelRef = abi },
            async wake() { await body(kernelRef as never) },
        }),
    }
}

/**
 * A complete `done` response.
 *
 * Written out in full rather than cast: the manager reads `meta.durationMs` on
 * every call, so a partial double fails inside engine code with a TypeError
 * that looks like a runtime bug. `provider` is "supervisor" because that is
 * exactly what served it — the agent never learns anything more specific, which
 * is the whole point of the boundary.
 */
function done(text: string): AxonEngineRawEvent {
    return {
        type: "done",
        response: {
            text,
            stopReason: "end",
            meta: { provider: "supervisor", model: "remote", durationMs: 1 },
        },
    }
}

/** A remote driver, standing in for one whose tokens arrive over the link. */
function remoteDriver(events: AxonEngineRawEvent[]): (role: string) => AxonEngineDriver {
    return () => ({
        // eslint-disable-next-line require-yield
        async *stream(): AsyncGenerator<AxonEngineRawEvent> {
            for (const event of events) yield event
        },
    })
}

describe("kernel — inference through a remote driver", () => {
    it("streams a remote engine's tokens as ordinary engine events", async () => {
        let text = ""
        const runtime = await AxonRuntime({
            remote: remoteDriver([
                { type: "text:delta", content: "<text>hel" },
                { type: "text:delta", content: "lo</text>" },
                done("<text>hello</text>"),
            ]),
            blueprint: {
                profileProviders: [],
                cognet: probeCognet(async (abi: never) => {
                    const kernel = abi as unknown as {
                        engine(role: string): { stream(req: unknown): AsyncGenerator<{ type: string; content?: string }> }
                    }
                    for await (const event of kernel.engine("main").stream({ messages: [] })) {
                        if (event.type === "engine:text") text += event.content ?? ""
                    }
                }),
            },
        })

        await runtime.axon.request("go")
        expect(text).toContain("hello")
        await runtime.shutdown()
    }, 20_000)

    it("prefers the remote driver over any local one, so no key is pulled into the box", async () => {
        // Checked BEFORE `engines` on purpose: a runtime carrying both must not
        // silently take the in-process path and resolve a credential inside a
        // boundary that exists to keep it out.
        let usedRemote = false
        const runtime = await AxonRuntime({
            remote: role => {
                usedRemote = true
                expect(role).toBe("main")
                return {
                    async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                        yield done("<text>ok</text>")
                    },
                }
            },
            blueprint: {
                cognet: probeCognet(async (abi: never) => {
                    const kernel = abi as unknown as {
                        engine(role: string): { stream(req: unknown): AsyncGenerator<unknown> }
                    }
                    for await (const _ of kernel.engine("main").stream({ messages: [] })) { /* drain */ }
                }),
            },
        })

        await runtime.axon.request("go")
        expect(usedRemote).toBe(true)
        await runtime.shutdown()
    }, 20_000)

    it("never hands the agent a model id or a provider — only a role", async () => {
        // The indirection existed by convention (cognition must not learn what
        // is behind a role); the boundary now enforces it.
        const seenRoles: string[] = []
        const runtime = await AxonRuntime({
            remote: role => {
                seenRoles.push(role)
                return {
                    async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                        yield done("<text>ok</text>")
                    },
                }
            },
            blueprint: {
                profileProviders: [],
                cognet: probeCognet(async (abi: never) => {
                    const kernel = abi as unknown as {
                        engine(role: string): { stream(req: unknown): AsyncGenerator<unknown> }
                    }
                    for await (const _ of kernel.engine("main").stream({ messages: [] })) { /* drain */ }
                }),
            },
        })

        await runtime.axon.request("go")
        expect(seenRoles).toEqual(["main"])
        await runtime.shutdown()
    }, 20_000)
})
