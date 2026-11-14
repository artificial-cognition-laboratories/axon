import { Axon as AxonRuntime } from "@arcforge/core"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import type { AxonEngineDriver, AxonEngineRawEvent, AxonTransformDriver, RemoteEngines } from "@arcforge/types"
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

function probeCognet(body: (kernel: never) => Promise<void>, engines: Record<string, unknown> = { main: { type: "generate", in: "text", out: "text", primary: true } }) {
    return {
        name: "probe",
        version: "1.0.0",
        abi: KERNEL_ABI_VERSION,
        definition: defineCognet({
            name: "probe",
            version: "1.0.0",
            abi: KERNEL_ABI_VERSION,
            mode: { kind: "invocation" },
            engines: engines as never,
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

/** A transform nothing should call — the generate tests never ask for one. */
const NO_TRANSFORM = (): AxonTransformDriver => ({
    kind: "transform",
    transform: async () => { throw new Error("no transform in this test") },
})

/** Remote engines whose generate driver is `generate`. */
function remote(generate: (role: string) => AxonEngineDriver): RemoteEngines {
    return { generate: generate, transform: NO_TRANSFORM }
}

/** A remote driver, standing in for one whose tokens arrive over the link. */
function remoteDriver(events: AxonEngineRawEvent[]): RemoteEngines {
    return remote(() => ({
        // eslint-disable-next-line require-yield
        async *stream(): AsyncGenerator<AxonEngineRawEvent> {
            for (const event of events) yield event
        },
    }))
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
            remote: remote(role => {
                usedRemote = true
                expect(role).toBe("main")
                return {
                    async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                        yield done("<text>ok</text>")
                    },
                }
            }),
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
            remote: remote(role => {
                seenRoles.push(role)
                return {
                    async *stream(): AsyncGenerator<AxonEngineRawEvent> {
                        yield done("<text>ok</text>")
                    },
                }
            }),
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

    it("sends a transform through the remote side, with the wake's signal", async () => {
        // Transforms had no remote path: a confined cognet asking for features
        // was refused as unbound however well the supervisor could serve it.
        const seen: Array<{ role: string; input: unknown; signal: boolean }> = []
        let result: unknown = null
        const runtime = await AxonRuntime({
            remote: {
                generate: () => { throw new Error("no generate in this test") },
                transform: role => ({
                    kind: "transform",
                    transform: async (input, opts) => {
                        seen.push({ role: role, input: input, signal: opts?.signal instanceof AbortSignal })
                        return { kind: "features", patch: 16 }
                    },
                }),
            },
            blueprint: {
                profileProviders: [],
                cognet: probeCognet(async (abi: never) => {
                    const kernel = abi as unknown as { engine(role: string): { transform(input: unknown): Promise<unknown> } }
                    result = await kernel.engine("features").transform({ kind: "image" })
                }, { features: { type: "transform", in: "image", out: "features" } }),
            },
        })

        await runtime.axon.request("go")
        expect(seen).toEqual([{ role: "features", input: { kind: "image" }, signal: true }])
        expect(result).toEqual({ kind: "features", patch: 16 })
        await runtime.shutdown()
    }, 20_000)

    it("says an optional role is present only when the supervisor filled it", async () => {
        // An unfilled optional role once read as present in the box, and a
        // brain called into nothing six hundred times instead of degrading.
        const seen: Record<string, boolean> = {}
        const boot = async (resolvedEngines?: Record<string, unknown>) => {
            const runtime = await AxonRuntime({
                remote: remote(() => { throw new Error("no generate in this test") }),
                blueprint: {
                    profileProviders: [],
                    cognet: {
                        ...probeCognet(async (abi: never) => {
                            const kernel = abi as unknown as { engine: { has(role: string): boolean } }
                            seen[resolvedEngines ? "filled" : "empty"] = kernel.engine.has("features")
                        }, { features: { type: "transform", in: "image", out: "features", optional: true } }),
                        ...(resolvedEngines ? { resolvedEngines: resolvedEngines } : {}),
                    } as never,
                },
            })
            await runtime.axon.request("go")
            await runtime.shutdown()
        }
        await boot()
        await boot({ features: { type: "transform", modalities: { in: ["image"], out: ["features"] }, slots: 1 } })
        expect(seen).toEqual({ empty: false, filled: true })
    }, 20_000)
})
