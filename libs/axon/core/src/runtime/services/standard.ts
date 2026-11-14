import type {
    AxonDriver,
    AxonEngineDriver,
    AxonEngineMessage,
    AxonEngineResponse,
    AxonTransformDriver,
    EngineRequirement,
    ResolvedEngineFacts,
    ServiceProvider,
    ServiceUse,
} from "@arcforge/types"
import { err } from "@arcforge/err"

/** What a standard interface's adapter knows: how a use of it resolves, and how a bound driver serves it. */
type Adapter = {
    /**
     * What a model must be to answer this interface for this use. Only what
     * the interface decides; what every use decides alike — optional,
     * primary, its models, how many at once — is added by `engineRoles`.
     */
    requirement(use: ServiceUse): EngineRequirement
    /**
     * The driver bound to that requirement, as a provider of the interface.
     * `name` is the route that serves it; `facts` what resolution learned of
     * it — the same facts a confined agent is sent, so one adapter serves both.
     */
    provider(driver: AxonDriver, name: string, facts: ResolvedEngineFacts): ServiceProvider
}

/**
 * The standard interfaces the machine's own engines serve — each a table row,
 * never a branch. A row maps an interface onto the engine requirement that
 * finds a model able to answer it, and wraps the model's driver as a
 * provider: the interface's values in, the driver's own shapes across, the
 * interface's values back.
 *
 * An interface not here is served only by a provider the agent writes.
 */
export const STANDARD: Readonly<Record<string, Adapter>> = {
    "chat@1": {
        requirement: use => ({
            type: "generate",
            in: wants(use, "pictures", true) ? ["text", "image"] : ["text"],
            out: ["text"],
            ...(min(use, "context") !== undefined ? { context: min(use, "context") } : {}),
        }),
        provider: (driver, name, facts) => {
            const generate = kind(driver, "generate", name) as AxonEngineDriver
            return {
                name: name,
                describe: () => ({
                    ...(facts.context !== undefined ? { context: facts.context } : {}),
                    pictures: facts.modalities.in.includes("image"),
                    slots: facts.slots,
                }),
                async call(method, args, signal) {
                    if (method !== "request") throw unknown(name, "chat@1", method)
                    let text = ""
                    for await (const event of generate.stream(request(args, name, signal))) {
                        if (event.type === "text:delta") text += event.content
                        if (event.type === "done") return reply(event.response, text)
                    }
                    throw err("SERVICE_FAILED", { detail: `${name} ended its reply without saying it was done` })
                },
                async *stream(method, args, signal) {
                    if (method !== "stream") throw unknown(name, "chat@1", method)
                    for await (const event of generate.stream(request(args, name, signal))) {
                        if (event.type === "text:delta") yield { text: event.content }
                        if (event.type === "done") {
                            const { stop, usage } = reply(event.response, "")
                            yield { text: "", stop: stop, ...(usage ? { usage: usage } : {}) }
                            return
                        }
                    }
                    throw err("SERVICE_FAILED", { detail: `${name} ended its reply without saying it was done` })
                },
                open: () => Promise.reject(unknown(name, "chat@1", "open")),
                release: () => Promise.resolve(),
            }
        },
    },

    "depth-relative@1": {
        requirement: () => ({ type: "transform", in: ["image"], out: ["depth"] }),
        provider: (driver, name) => {
            const transform = kind(driver, "transform", name) as AxonTransformDriver
            return {
                name: name,
                describe: () => ({}),
                async call(method, args, signal) {
                    if (method !== "estimate") throw unknown(name, "depth-relative@1", method)
                    const answer = await transform.transform(image(args.picture), signal ? { signal: signal } : {}) as { depth: Tensor }
                    const [height, width] = answer.depth.dims as [number, number]
                    return { width: width, height: height, nearness: floats(answer.depth) }
                },
                stream: () => { throw unknown(name, "depth-relative@1", "stream") },
                open: () => Promise.reject(unknown(name, "depth-relative@1", "open")),
                release: () => Promise.resolve(),
            }
        },
    },

    "segment@1": {
        requirement: () => ({ type: "transform", in: ["image"], out: ["masks"] }),
        provider: (driver, name) => {
            const transform = kind(driver, "transform", name) as AxonTransformDriver
            /** Encoded pictures, by the id handed out for each. The model encodes per prompt; the picture is what is kept. */
            const kept = new Map<string, unknown>()
            return {
                name: name,
                describe: () => ({}),
                async call(method, args, signal) {
                    if (method === "encode") {
                        const id = Bun.randomUUIDv7()
                        kept.set(id, image(args.picture))
                        return { handle: "Encoded", id: id }
                    }
                    if (method !== "mask") throw unknown(name, "segment@1", method)
                    const encoded = args.encoded as { id: string }
                    const picture = kept.get(encoded.id)
                    if (!picture) throw err("SERVICE_HANDLE_ENDED", { detail: `${name} keeps no picture ${encoded.id}` })
                    const prompt = args.prompt as { point?: [number, number]; box?: number[] }
                    if (!prompt.point) throw err("SERVICE_INVALID", { detail: `${name} finds a region from a point; a box prompt is not something it can answer` })
                    const answer = await transform.transform({ kind: "segment", image: picture, points: [{ x: prompt.point[0], y: prompt.point[1] }] }, signal ? { signal: signal } : {}) as { masks: Array<{ mask: Tensor; score: number }> }
                    const found = answer.masks[0]
                    if (!found) throw err("SERVICE_FAILED", { detail: `${name} answered a prompt with no region` })
                    const [height, width] = found.mask.dims as [number, number]
                    return { width: width, height: height, mask: bytes(found.mask), score: found.score }
                },
                stream: () => { throw unknown(name, "segment@1", "stream") },
                open: () => Promise.reject(unknown(name, "segment@1", "open")),
                async release(id) {
                    kept.delete(id)
                },
            }
        },
    },
}

/** A tensor, as a transform driver answers with it. */
type Tensor = { dims: number[]; dtype: "float32" | "uint8"; data: string }

/** The conversation, as the driver is asked it. Pictures cross as a stimulus reference, which a raw picture is not. */
function request(args: Readonly<Record<string, unknown>>, name: string, signal?: AbortSignal) {
    const conversation = args.conversation as { system?: string; messages: Array<{ role: string; text: string; pictures?: unknown[] }>; limit?: number }
    const messages: AxonEngineMessage[] = [
        ...(conversation.system !== undefined ? [{ role: "system" as const, content: conversation.system }] : []),
        ...conversation.messages.map(message => {
            if (message.pictures?.length) throw err("SERVICE_INVALID", { detail: `${name}: pictures in a conversation are not wired through this provider yet` })
            if (message.role !== "user" && message.role !== "assistant") throw err("SERVICE_INVALID", { detail: `a message's role is "user" or "assistant", not "${message.role}"` })
            return { role: message.role, content: message.text } as AxonEngineMessage
        }),
    ]
    return { messages: messages, ...(conversation.limit !== undefined ? { maxTokens: conversation.limit } : {}), ...(signal ? { signal: signal } : {}) }
}

function reply(response: AxonEngineResponse, written: string) {
    if (response.stopReason === "abort") throw new DOMException("the reply was cancelled", "AbortError")
    const tokens = response.meta.tokens
    return {
        text: written || response.text,
        stop: response.stopReason === "length" ? "limit" : "done",
        ...(tokens ? { usage: { input: tokens.in, output: tokens.out } } : {}),
    }
}

/** A picture, as a transform driver takes one: RGB bytes, base64 across a socket. */
function image(picture: unknown) {
    const { width, height, rgb } = picture as { width: number; height: number; rgb: Uint8Array }
    if (rgb.length !== width * height * 3) throw err("SERVICE_INVALID", { detail: `a ${width}×${height} picture holds ${width * height * 3} bytes, not ${rgb.length}` })
    return { kind: "image", width: width, height: height, channels: 3, data: Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength).toString("base64") }
}

function floats(tensor: Tensor): Float32Array {
    const raw = Buffer.from(tensor.data, "base64")
    return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength))
}

function bytes(tensor: Tensor): Uint8Array {
    return new Uint8Array(Buffer.from(tensor.data, "base64"))
}

function kind(driver: AxonDriver, expected: "generate" | "transform", name: string): AxonDriver {
    const actual = driver.kind ?? "generate"
    if (actual !== expected) throw err("SERVICE_FAILED", { detail: `${name} was bound as a ${actual} engine where a ${expected} engine was resolved` })
    return driver
}

function unknown(name: string, named: string, method: string) {
    return err("SERVICE_INVALID", { detail: `${name} serves ${named}, which has no ${method}` })
}

/** The `min` a use requires of a numeric field of describe(), if any. */
function min(use: ServiceUse, field: string): number | undefined {
    const required = use.requires?.[field]
    if (typeof required === "number") return required
    if (typeof required === "object" && required !== null && "min" in required) return required.min
    return undefined
}

function wants(use: ServiceUse, field: string, value: unknown): boolean {
    return use.requires?.[field] === value
}
