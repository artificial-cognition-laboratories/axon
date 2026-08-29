import { err } from "@arcforge/err"
import type {
    AirProtocolName,
    AxonBlueprint,
    AxonEngineCall,
    AxonEngineDriver,
    AxonEngineEvent,
    AxonEngineFault,
    AxonEngineFaultCode,
    AxonEngineResponse,
    EngineCloud,
} from "@arcforge/types"
import { asEngineFault, EngineFailure } from "@arcforge/engines"
import type { AxonErrorCode } from "@arcforge/err"
import type { EnginesT } from "@arcforge/engines/catalogue"
import { Air, type AirBlockEvent, type AirT } from "@arcforge/air"
import type { OutputDiagnostic } from "@arcforge/air/output"
import type { AxonSessionT } from "@arcforge/session"

type EngineOpts = {
    blueprint: AxonBlueprint
    session: AxonSessionT
    /** The runtime's cloud client — handed to drivers at create(); engines call what they need. */
    cloud: EngineCloud
    /**
     * Commit a format violation the model must read and correct.
     *
     * `rejected` is the reply that earned it, verbatim. Without it the next
     * attempt reads a correction whose subject is missing — the malformed text
     * never entered the log, so the model was asked to fix a shape it could
     * not see. Absent only where no reply exists to quote.
     */
    fault(input: { code: string; message: string; excerpt?: string; rejected?: string; attempt?: number }): Promise<void>
    /**
     * The resolved inference roles, when the cognet declared any.
     *
     * Absent for an agent on the single-`engine:` path, which is every
     * published agent today — this manager is what a call naming a role
     * dispatches through, and nothing else changes when it is missing.
     */
    engines?: EnginesT
    /**
     * Build the driver for a role, when inference lives outside this process.
     *
     * Present in a CONFINED agent: the provider credential is held by the
     * supervisor and never enters the box, so the agent asks for a role and
     * receives tokens. Absent everywhere else (a local runtime, a test), where
     * `engines` resolves a real driver in this heap.
     *
     * A DRIVER rather than a new seam, deliberately. `AxonEngineDriver` is
     * already "a dumb token pipe: messages in, raw deltas out — no AIR parsing,
     * no bus, no blocks", which is exactly what a wire is. So everything this
     * manager owns — the grammar, the retry budget, the output contract, the
     * idle-stall guard — stays here and cannot tell the tokens crossed a
     * process boundary to arrive.
     */
    remote?: (role: string) => AxonEngineDriver
}

type EngineContext = {
    runId: string
}

const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [100, 300] as const

/**
 * Attempts allowed after a response fails its declared output shape.
 *
 * Three model calls total is enough for a model to read a type error and fix
 * it — a shape it cannot correct twice is usually one it cannot satisfy at
 * all, and burning more calls on it just costs the caller money.
 */
const DEFAULT_OUTPUT_RETRIES = 2

/**
 * How long the engine wire may go silent before the call is abandoned.
 *
 * Measured BETWEEN events, not across the call: a model thinking hard for two
 * minutes is working, and a wall-clock cap would kill it. A stream that has
 * produced nothing for this long has stalled — the connection is open, the
 * provider is not sending, and nothing downstream will ever fire.
 *
 * That is not hypothetical. A run hung indefinitely after `firstToken`: the
 * upstream went quiet mid-stream, and because the only abort path was the
 * caller's own signal, nothing on this side was watching. The agent sat on
 * "Working…" until the process was killed.
 *
 * Generous, because the cost of being wrong differs by direction. Too short
 * kills a slow-but-live provider; too long only delays a retry that was always
 * going to happen.
 */
const STREAM_IDLE_DEFAULT_MS = 90_000

/**
 * Read per call rather than captured at import: a module-level constant is
 * evaluated once, before a test has had any chance to set the override, so
 * the guard could not be exercised without waiting the full window.
 */
const streamIdleMs = (): number => Number(process.env.AXON_STREAM_IDLE_MS) || STREAM_IDLE_DEFAULT_MS

/**
 * The driver's stream, abandoned if it goes quiet.
 *
 * Wraps rather than replaces: the driver keeps its own signal handling, and
 * this adds the guard it cannot provide — a driver cannot know whether silence
 * means the provider is thinking or gone. Racing each `next()` against a timer
 * is what makes the distinction observable at all.
 *
 * Throws on stall so the existing catch treats it exactly as any other engine
 * fault: it retries, backs off, and records the attempt.
 */
async function* withIdleTimeout<T>(
    source: AsyncIterable<T>,
    idleMs: number,
    onStall: () => Error,
): AsyncGenerator<T> {
    const iterator = source[Symbol.asyncIterator]()
    try {
        for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined
            const stalled = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(onStall()), idleMs)
            })
            try {
                const step = await Promise.race([iterator.next(), stalled])
                if (step.done) return
                yield step.value
            } finally {
                if (timer) clearTimeout(timer)
            }
        }
    } finally {
        // A stall leaves the underlying stream open — the provider still holds
        // a connection nobody is reading. Closing it is what makes the retry a
        // fresh call rather than a second reader on a dead socket.
        //
        // NOT awaited. `return()` resumes the generator at its suspension
        // point, and a stalled one is suspended on a promise that never
        // settles — so awaiting it deadlocks in the very case this guard
        // exists to escape. Fire it and move on; the socket is closed by the
        // driver's own signal handling and by process teardown.
        void Promise.resolve(iterator.return?.()).catch(() => {})
    }
}

/**
 * The request for the next attempt, re-rendered from the session.
 *
 * The diagnostic reaches the model as part of the DOCUMENT, not appended after
 * it. A violation is committed as an entry before this runs, so re-rendering
 * now produces a context whose timeline ends with the rejected reply and the
 * correction it earned — in the structure, in the order, where the contract
 * says a `<system>` block lives.
 *
 * The previous version appended the correction as an extra message, which put
 * it AFTER `</timeline>` — outside every structure the context had just spent
 * ten thousand tokens establishing, in the last and highest-attention position
 * on the wire. That is a demonstration that blocks may float free, delivered
 * immediately before an instruction not to let blocks float free, and models
 * were observed doing exactly that: emitting bare prose after being corrected
 * for emitting bare prose.
 *
 * Always derived from the ORIGINAL call, never chained from the previous
 * attempt's — the render decides what history to show, and stacking messages
 * here would fight it.
 */
async function reframe(call: AxonEngineCall, correction: string): Promise<AxonEngineCall> {
    // A caller with no renderer (an internal one-shot with hand-built
    // messages) has no document to rebuild. It still gets the correction —
    // appended, since there is no structure to place it inside — because one
    // out-of-band block in a two-message call is not the failure above.
    if (!call.rerender) {
        const framed = `<system type="format-violation" lang="md">\n${correction}\n</system>`
        return { ...call, messages: [...call.messages, { role: "user" as const, content: framed }] }
    }
    return { ...call, messages: await call.rerender() }
}

/**
 * What the model is told when a block never closed.
 *
 * Almost always a truncated stream rather than a choice — the provider stopped
 * mid-block — so the instruction is "send it again", not "stop doing that".
 * Naming the specific tag matters: the previous behaviour dropped the block
 * silently and reported OUTPUT_EMPTY, which told a model that had just sent a
 * script that it had sent no script, and quoted the script as proof.
 */
function describeTruncatedBlock(tag: "text" | "script", raw: string | undefined): string {
    const tail = (raw ?? "").trimEnd().slice(-160)
    return [
        `## Your \`<${tag}>\` block never closed`,
        "",
        `The reply ended part-way through a \`<${tag}>\` block — there was no \`</${tag}>\`, so nothing in it could be used.`,
        "",
        "This is usually a cut-off response rather than anything you did wrong.",
        "",
        ...(tail ? ["It ended here:", "", "```", tail, "```", ""] : []),
        `Send the block again, complete, and close it with \`</${tag}>\`. If it was long, send a smaller step.`,
    ].join("\n")
}

/**
 * What the model is told when it sent more blocks than the grammar allows.
 *
 * Leads with the consequence rather than the rule. "One script per message" is
 * a constraint to comply with; "your blocks all run at once, so the second
 * cannot see what the first wrote" is a reason, and a model given the reason
 * splits the work correctly instead of merely obeying.
 */
function describeTooManyBlocks(texts: number, scripts: number): string {
    const fence = (body: string): string => ["```", body, "```"].join("\n")
    const over: string[] = []
    if (scripts > 1) over.push(`${scripts} \`<script>\` blocks`)
    if (texts > 1) over.push(`${texts} \`<text>\` blocks`)

    return [
        "## Too many blocks",
        "",
        `You sent ${over.join(" and ")}. A message carries at most one of each.`,
        "",
        ...(scripts > 1
            ? [
                "Every `<script>` in one message runs **at the same time**, not in order — so a later block cannot use what an earlier one wrote, and one failure discards them all.",
                "",
                "Send the FIRST step only. Its output comes back to you next turn, and you write the next step knowing what it returned.",
                "",
            ]
            : []),
        "Reply with one block:",
        "",
        fence("<text>…what you want to say…</text>\n<script>…one step of work…</script>"),
    ].join("\n")
}

/** Type errors as the model reads them — its own line numbers, its own code. */
function describeViolations(problems: readonly OutputDiagnostic[], script?: string): string {
    const fence = (body: string): string => ["```", body, "```"].join("\n")
    const lines = problems.map(p => (p.line ? `- line ${p.line}: ${p.message}` : `- ${p.message}`))
    return [
        "## Your `<script>` does not produce the required shape",
        "",
        ...lines,
        "",
        // The script itself, quoted back.
        //
        // Without it the model reads a line number against code it can no
        // longer see: the reply was discarded, so "line 3" refers to nothing
        // in its context. A diagnostic that names a location has to show the
        // thing the location is in.
        ...(script ? ["This is the script that was rejected:", "", fence(script.trim()), ""] : []),
        "Fix it so `result` matches the declared type, then reply again.",
    ].join("\n")
}

/**
 * The tags the protocol actually defines. Anything else in a reply is a tag
 * the model invented, and naming it back is the whole difference between a
 * correctable instruction and a restatement of the rules it already read.
 */
const KNOWN_BLOCKS = new Set(["text", "script", "done", "thinking"])

/**
 * The first tag in a reply that is NOT one of ours, or undefined.
 *
 * This is what turns "your reply had no block" — which reads as false to a
 * model that plainly wrapped its content — into "you used <lemma_code>, which
 * is not a block". A model given the second has somewhere to go.
 */
function unknownTagIn(text: string | undefined): string | undefined {
    if (!text) return undefined
    for (const match of text.matchAll(/<\s*([a-zA-Z][\w:-]*)/g)) {
        const tag = match[1]!
        if (!KNOWN_BLOCKS.has(tag.toLowerCase())) return tag
    }
    return undefined
}

/** Does this look like code rather than prose? Used only to pick which block to name. */
function looksLikeCode(text: string): boolean {
    return /\b(?:const|let|var|await|function|import|return|=>)\b/.test(text)
}

/**
 * What the model is told when its reply parsed to nothing at all.
 *
 * Written as an instruction rather than a report, and it names the exact tags,
 * because this is fed straight back as the next attempt's context and the model
 * has to act on it without any other explanation.
 *
 * ── Why it diagnoses instead of restating ────────────────────────────────────
 *
 * The first version said the same nine lines every attempt and varied only the
 * quoted excerpt. That is a weak steer, and against a specific failure it is
 * actively confusing: a model that replied `<lemma_code><code>…</code>` DID
 * wrap its content, so "wrap your content" reads as a contradiction and offers
 * no gradient. A real run died that way — three attempts, the third carrying
 * complete correct TypeScript one tag-name away from valid.
 *
 * So the message leads with what THIS reply did wrong. An invented tag gets
 * named and mapped to the block it should have been; a bare fragment gets told
 * it was cut short; prose outside a block gets the original explanation, which
 * was always right for that case.
 *
 * `attempt` escalates the tone. By the last try the model has read the rules
 * twice and not complied, so repeating them a third time is not the move —
 * the final message is short, imperative, and asks for one block and nothing
 * else.
 */
function describeEmptyResponse(
    protocol: string | undefined,
    raw: string | undefined,
    attempt: number,
    lastAttempt: boolean,
): string {
    const unknown = unknownTagIn(raw)
    const suggested = raw && looksLikeCode(raw) ? "script" : "text"

    // Written as MARKDOWN, because that is what it is rendered as: the
    // correction lands in a `lang="md"` system block, so a heading is a
    // heading and a fenced example is a fence. Bare tags are backticked —
    // unquoted `<text>` in markdown is an HTML tag, which a model may
    // read as structure rather than as the literal string it must type.
    const fence = (body: string): string => ["```", body, "```"].join("\n")

    // Tags are LITERAL here.
    //
    // This message reaches the model through steer(), which appends it to the
    // request as-is — it does not pass through the <system> body renderer, so
    // nothing escapes it downstream. The one message whose entire job is "emit
    // exactly these characters" must therefore contain exactly those
    // characters.
    //
    // The copy committed to the SESSION renders through that escaper and comes
    // out as entities, which is correct for a transcript nobody has to retype.
    // Two audiences, two paths, and only one of them is being instructed.
    const tag = (name: string): string => `<${name}>`
    const closeTag = (name: string): string => `</${name}>`

    // Last chance: no explanation, just the shape. Everything the model needed
    // to know it has already been told twice.
    if (lastAttempt) {
        return [
            "## Final attempt",
            "",
            "Reply with exactly one block and nothing outside it:",
            "",
            fence(`${tag(suggested)}…${closeTag(suggested)}`),
            "",
            ...(unknown ? [`Do **not** use \`${tag(unknown)}\` — it is not a block in this protocol.`, ""] : []),
            `Valid blocks: \`${tag("text")}\` for prose, \`${tag("script")}\` for code, \`<done/>\` when finished.`,
        ].join("\n")
    }

    const lead = unknown
        ? [
            `## Wrong tag: \`${tag(unknown)}\``,
            "",
            `\`${tag(unknown)}\` is not a block in this protocol. The content itself looked right — only the tag was wrong.`,
            "",
            `Send the same content wrapped in \`${tag(suggested)}\` instead:`,
            "",
            fence(`${tag(suggested)}…your content…${closeTag(suggested)}`),
        ]
        : [
            "## No block in your reply",
            "",
            `Your reply contained no \`${tag("text")}\` or \`${tag("script")}\` block, so none of it could be used. Text outside a block is discarded.`,
            "",
            "Every reply must wrap its content:",
            "",
            fence(`${tag("text")}…what you want to say…${closeTag("text")}\n${tag("script")}…code you want to run…${closeTag("script")}`),
        ]

    return [
        ...lead,
        "",
        `Valid blocks: \`${tag("text")}\`, \`${tag("script")}\`, \`<done/>\`. There are no others.`,
        ...(protocol ? ["", `Protocol: \`${protocol}\`.`] : []),
        // The reply itself is NOT quoted here.
        //
        // It is committed as its own entry and renders directly above this
        // correction, as the blocks the model sent with `status="rejected"` on
        // them. Quoting it again put the same text on screen twice — once as
        // the model's own output and once as a fenced string inside the
        // complaint about it — which is noise in the exact place attention
        // matters most.
        ...(attempt > 1 ? ["", `This is attempt ${attempt}. The previous attempt failed the same way.`] : []),
    ].join("\n")
}

/**
 * Engine — the inference layer of the runtime. Drivers are raw token pipes;
 * this manager owns AIR parsing, bounded pre-output retries, and the durable
 * accounting span around every logical call.
 *
 * A retry is deliberately invisible to cognition only while an attempt has
 * produced no raw delta. Once any text or thinking has crossed the boundary,
 * retrying could duplicate semantic output, so that failure is terminal.
 */
export function Engine(opts: EngineOpts) {
    /**
     * One Air per protocol, built on first use and reused.
     *
     * The grammar is resolved from the CALLER's protocol, not the runtime's:
     * the cognet that rendered the context is the only thing that knows which
     * contract the model was shown, and a parser accepting different tags
     * than the contract declared would silently discard every block.
     */
    const airs = new Map<AirProtocolName, AirT>()
    const airFor = (protocol: AirProtocolName = "classic"): AirT => {
        let air = airs.get(protocol)
        if (!air) {
            air = Air({ protocol })
            airs.set(protocol, air)
        }
        return air
    }

    let blueprint = opts.blueprint

    /**
     * The driver for one call.
     *
     * Always by ROLE. The agent's single `engine:` is gone, so there is no
     * unnamed default to fall back to and no second selection path to keep in
     * step: a call names what it needs, and resolution already decided what
     * fills it.
     */
    function select(role: string | undefined): { driver: AxonEngineDriver; name: string } | null {
        if (!role) return null

        // Remote first: in a confined agent there is no local driver to fall
        // back to, because there is no credential in the box to build one
        // with. Checked before `engines` so a runtime that happens to carry
        // both cannot silently prefer the in-process path and pull a key
        // inside the boundary.
        if (opts.remote) return { driver: opts.remote(role), name: "supervisor" }

        if (!opts.engines) return null
        const bound = opts.engines.get(role)

        // This manager IS the generate path — AIR parsing, the retry budget,
        // the output contract. A transform or a session driver has none of
        // that and cannot be fed a message array, so reaching here with one
        // is a wiring fault rather than a model that failed. Resolution
        // already matched the declared type, so the only way to arrive here
        // is a provider whose create() disagreed with the capability it was
        // handed — loud, not coerced.
        if (bound.driver.kind !== undefined && bound.driver.kind !== "generate") {
            throw new EngineFailure({
                code: "INVALID_REQUEST",
                message: `ENGINE_KIND_MISMATCH: role "${role}" is bound to a ${bound.driver.kind} driver, which cannot serve a generate call`,
                retryable: false,
                provider: bound.binding.capability.provider,
                model: bound.binding.capability.id,
            })
        }

        return { driver: bound.driver as AxonEngineDriver, name: bound.binding.capability.provider }
    }

    /**
     * One logical call, as AIR BLOCKS — the raw half.
     *
     * Owns everything about talking to a driver: transport retries,
     * reconciling the authoritative final text against what actually
     * streamed, and the durable accounting span. It knows the grammar only
     * well enough to parse it, and nothing about what the blocks MEAN.
     *
     * The response half (running scripts, rendering text, enforcing an
     * output shape) wraps this — see stream() below.
     */
    async function* blocks(
        call: AxonEngineCall,
        context: EngineContext,
    ): AsyncGenerator<AirBlockEvent, AxonEngineResponse> {
        // Protocol is the manager's concern, never the driver's — drivers are
        // token pipes and must not receive a field they'd have to ignore.
        const { protocol, output: _output, retries: _retries, ...req } = call
        const air = airFor(protocol)
        const span = { ...context, spanId: Bun.randomUUIDv7() }
        // The whole logical call, retries and AIR parsing included — distinct
        // from meta.durationMs, which is one attempt's provider latency. A
        // call that succeeded on its third try shows both numbers honestly.
        const callStarted = Date.now()
        const selected = select(call.role)
        if (!selected) {
            const fault = {
                code: "INVALID_REQUEST" as const,
                message: `NO_ENGINE: no engine bound for ${call.role ? `role "${call.role}"` : "this agent"}`,
                retryable: false,
                provider: "unconfigured",
            }
            await opts.session.commit("kernel:engine:failed", { attempts: 0, fault, durationMs: Date.now() - callStarted }, span)
            throw err("ENGINE_MISSING")
        }
        // What resolution actually bound, not what a config named — nothing
        // names a model any more, and the binding is the only honest answer
        // to "which model served this call".
        const bound = call.role ? opts.engines?.get(call.role).binding.capability.id : undefined
        const model = req.model ?? bound
        const correlation = model ? { provider: selected.name, model } : { provider: selected.name }

        await opts.session.commit("kernel:engine:start", correlation, span)
        await opts.session.commit("kernel:engine:input", {
            messages: req.messages,
            bytes: new TextEncoder().encode(JSON.stringify(req.messages)).byteLength,
        }, span)

        /**
         * The request as the NEXT attempt will see it.
         *
         * Retries used to re-send `req` byte for byte. The diagnostic was
         * committed to the session, and the session is rendered once per TICK
         * — but all three attempts happen inside one tick, so the model was
         * re-asked the identical question three times and told nothing about
         * why the last answer failed. Three identical prompts get three
         * similar replies; that is what a run looked like when it died here.
         *
         * Appended as a user turn rather than folded into the system message:
         * it is feedback about the exchange in progress, and it must be the
         * last thing the model reads.
         */
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const parser = air.parser()
            let semanticOutputSeen = false
            /**
             * Whether anything reached the CONSUMER this attempt.
             *
             * Distinct from `semanticOutputSeen`, which is true the moment a
             * non-blank delta arrives — including one that never completed a
             * block and so never crossed to anyone. Retry has to be gated on
             * what escaped, not on what was received: a stream that produced
             * `<text>thinking` and then died emitted nothing usable, and
             * refusing to retry it strands the caller on a partial reply.
             */
            let emitted = false
            let doneSeen = false
            const started = Date.now()
            let firstTokenAt: number | undefined
            // What the parser actually saw, streamed. Some drivers (Codex)
            // additionally emit an authoritative text:final that silently
            // overwrites the response text without ever re-crossing the
            // parser (see Collect()) — if that final text disagrees with
            // what was streamed, the parser's incompleteness judgment was
            // made against data that was never the real, final output. On
            // `done`, reconcile: re-parse the authoritative text fresh
            // rather than trust a parser that only ever saw a divergent
            // stream.
            let streamedText = ""

            try {
                const wire = withIdleTimeout(
                    selected.driver.stream(req),
                    streamIdleMs(),
                    () => new EngineFailure({
                        code: "TRANSPORT",
                        message: `engine stream produced nothing for ${streamIdleMs() / 1000}s — abandoning the call`,
                        retryable: true,
                        provider: selected.name,
                        ...(model ? { model } : {}),
                    }),
                )

                for await (const raw of wire) {
                    if (raw.type !== "done" && firstTokenAt === undefined) {
                        firstTokenAt = Date.now()
                        // Committed as it happens rather than folded into
                        // :complete's meta, so the latency/generation split is
                        // visible on a live bar and survives a call that never
                        // completes. Awaited like every other commit in this
                        // span — the writer serializes, and ordering before the
                        // first parsed block is what makes containment honest.
                        await opts.session.commit("kernel:engine:firstToken", {
                            attempt,
                            elapsedMs: firstTokenAt - started,
                        }, span)
                    }
                    if (raw.type === "text:delta" && raw.content.trim()) semanticOutputSeen = true

                    switch (raw.type) {
                        case "text:delta":
                            // Track exactly what crossed as deltas so the
                            // `done` reconciliation can tell a missing tail
                            // (extend) from a full re-feed (which would
                            // double-fire every already-streamed block).
                            streamedText += raw.content
                            for (const event of parser.feed(raw.content)) {
                                // What forfeits the retry is output the caller
                                // can KEEP — a block that closed.
                                //
                                // An `open` is a structural marker, and a
                                // `delta` is a fragment of a block that may
                                // never close: a stream that emitted
                                // `<text>thinking` and then went silent gave
                                // the caller nothing usable, but counted as
                                // escaped output and blocked the retry, so the
                                // whole call failed on a stall it was supposed
                                // to recover from.
                                if (event.type.endsWith(":done")) emitted = true
                                yield event
                            }
                            break

                        case "thinking:delta":
                            // dropped at the boundary — thinking never crosses the wire
                            break

                        case "done": {
                            if (doneSeen) {
                                throw protocolFailure(selected.name, model, "driver emitted more than one done event")
                            }
                            doneSeen = true
                            if (!semanticOutputSeen && raw.response.text.trim().length === 0) {
                                throw new EngineFailure({
                                    code: "EMPTY_RESPONSE",
                                    message: `empty response from model \"${raw.response.meta.model}\"`,
                                    retryable: true,
                                    provider: selected.name,
                                    model: raw.response.meta.model,
                                })
                            }
                            // Some drivers report an authoritative final text
                            // that carries more than what actually crossed as
                            // deltas (e.g. Codex's output_text.done can trail
                            // the last output_text.delta). Feed the missing
                            // suffix into the SAME parser before flush() — it
                            // already emitted blocks from streamedText, so
                            // this must extend, never restart, or already-
                            // committed blocks would double-fire. Only safe
                            // when response.text is a strict extension of
                            // what was streamed; a genuine mismatch (not just
                            // a missing tail) is left to fail honestly rather
                            // than risk reconciling against the wrong content.
                            if (extendsStreamedText(streamedText, raw.response.text)) {
                                const missing = raw.response.text.slice(streamedText.length)
                                if (missing.length > 0) yield* parser.feed(missing)
                            }
                            yield* parser.flush()

                            const meta = {
                                ...raw.response.meta,
                                durationMs: raw.response.meta.durationMs || Date.now() - started,
                                ...(raw.response.meta.firstTokenMs === undefined && firstTokenAt !== undefined
                                    ? { firstTokenMs: firstTokenAt - started }
                                    : {}),
                            }
                            const response = { ...raw.response, meta }
                            await opts.session.commit("kernel:engine:complete", {
                                attempts: attempt,
                                text: response.text,
                                ...(response.thinking ? { thinking: response.thinking } : {}),
                                stopReason: response.stopReason,
                                meta,
                                durationMs: Date.now() - callStarted,
                            }, span)
                            return response
                        }
                    }
                }

                if (!doneSeen) {
                    throw protocolFailure(selected.name, model, "driver stream ended without a done event")
                }
            } catch (error) {
                // Cancellation is control flow, not an engine fault. Drivers
                // vary in what they throw on abort (DOMException, plain Error,
                // or a transport wrapper), so the request signal is the one
                // authoritative source. Wake() records kernel:run:interrupted
                // and closes the wire; emitting engine:failed here would turn
                // an intentional Escape/Ctrl+C into AX-KERNEL-008.
                if (req.signal?.aborted) throw abortError(req.signal)

                const fault = asEngineFault(error, correlation)
                // Gated on what ESCAPED, not on what arrived. A stall after a
                // partial delta produced no usable output, and treating those
                // bytes as "already emitted" left the caller with a truncated
                // reply and no second attempt.
                const canRetry = fault.retryable && !emitted && !req.signal?.aborted && attempt < MAX_ATTEMPTS

                if (canRetry) {
                    const suggestedDelay = fault.retryAfterMs ?? RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!
                    const delayMs = Math.min(suggestedDelay, 5_000)
                    await opts.session.commit("kernel:engine:retry", {
                        attempt,
                        nextAttempt: attempt + 1,
                        delayMs,
                        fault,
                    }, span)
                    try {
                        await delay(delayMs, req.signal)
                    } catch (delayError) {
                        // Same rule as the outer catch above: an interrupt
                        // landing during retry backoff is cancellation, not
                        // an engine fault — the signal is authoritative, not
                        // whatever delay() happened to throw.
                        if (req.signal?.aborted) throw abortError(req.signal)

                        const abortFault = asEngineFault(delayError, correlation)
                        await opts.session.commit("kernel:engine:failed", { attempts: attempt, fault: abortFault, durationMs: Date.now() - callStarted }, span)
                        throw engineError(abortFault, attempt, delayError)
                    }
                    continue
                }

                await opts.session.commit("kernel:engine:failed", { attempts: attempt, fault, durationMs: Date.now() - callStarted }, span)
                throw engineError(fault, attempt, error)
            }
        }

        // The loop either returns on `done` or throws; exhausting every
        // attempt without either is unreachable, but TS needs the return type
        // satisfied on this path.
        throw err("ENGINE_NO_DONE")
    }

    /**
     * One logical call, as engine events.
     *
     * Maps parsed blocks onto the wire vocabulary and enforces a declared
     * output shape, retrying a response that misses it. What it does NOT do
     * is act: a script is reported, never run. Running code is an act, and
     * acts belong to the brain — the kernel is the authority on HOW code
     * runs (policy, capsule, commit), never on WHETHER this particular reply
     * should have run any.
     *
     * That line is what keeps the service general. A cognet may call a model
     * to classify a stimulus, rank an inference, or plan; if the kernel ran
     * whatever came back, every one of those would touch the world unasked.
     */
    async function* stream(call: AxonEngineCall, context: EngineContext): AsyncGenerator<AxonEngineEvent> {
        const output = call.output
        // Attempts AFTER the first, so `retries: 0` means one shot.
        //
        // Every call gets a budget, not only one declaring an output shape. A
        // declared contract is one way a response can be unusable; producing NO
        // BLOCK AT ALL is another, and it does not depend on the caller having
        // asked for a shape — the protocol itself requires the reply to be
        // wrapped. Gating retries on `output` meant a model that forgot
        // `<text>` got exactly one attempt, its prose was discarded by the
        // parser, and the run completed clean with an empty screen.
        const budget = call.retries ?? DEFAULT_OUTPUT_RETRIES
        let lastFault: string | undefined
        /** Which failure the LAST attempt hit — decides the terminal error code. */
        let lastFailure: "empty" | "shape" | undefined

        yield { type: "engine:start" }

        /**
         * The call as the NEXT attempt will make it.
         *
         * Retries used to re-send `call` byte for byte. The diagnostic was
         * committed to the session, and the session is rendered once per TICK
         * — but every retry happens inside one tick, so the model was re-asked
         * the identical question and told nothing about why its last answer
         * failed. Three identical prompts get three similar replies, which is
         * precisely how a run died here: `<lemma?`, then prose, then prose.
         *
         * Always derived from the ORIGINAL call, never chained from the
         * previous attempt's: stacking corrections would put three of them —
         * each quoting a malformed reply — in front of the third try, which is
         * the accumulation the render-side collapse exists to prevent.
         */
        let attemptCall = call

        for (let attempt = 0; attempt <= budget; attempt++) {
            const raw = blocks(attemptCall, context)
            let violations: readonly OutputDiagnostic[] = []
            let violatingScript: string | undefined
            let spoke = false
            let acted = false
            let yielded = false
            /**
             * How many of each block this reply carried.
             *
             * The grammar allows one of each, and models were emitting four
             * and five scripts in a single message — which runs them as a
             * concurrent batch, so a write in block three and a read in block
             * four race, and one bad pattern discards the lot. Counted rather
             * than silently truncated: a reply that broke the shape is
             * returned for the model to correct, the same as any other
             * contract violation.
             */
            /**
             * A block whose closing tag never arrived.
             *
             * Dropped silently before, which produced the WRONG diagnostic: a
             * truncated `<script>` reported as OUTPUT_EMPTY — "your reply
             * contained no block" — while the correction quoted that very
             * block back as proof. A model told a script block is not a script
             * block has no move left, and a real run looped until it exhausted
             * its retries.
             *
             * Naming it is the whole fix: "your block never closed" is
             * actionable, and it is usually a provider truncation rather than
             * anything the model chose.
             */
            let truncated: "text" | "script" | undefined

            let texts = 0
            let scripts = 0
            let lang: "md" | "json" = "md"
            let group: string | null = null
            let pending: string | null = null

            /**
             * Text this attempt has ALREADY streamed to the caller.
             *
             * Emitted as it parses rather than accumulated — see `drain()`
             * below for why that is safe, and what it fixes.
             */
            let streamedOut = 0

            /**
             * Blocks produced by this attempt, in order.
             *
             * Still a list, because emission is not immediate for everything:
             * a chunk is held exactly one step (the parser reports each block's
             * `done` in arrears, so the LAST chunk is only knowable then —
             * emitting eagerly would force an empty terminal chunk to close the
             * group, turning a one-line reply into two entries on the record),
             * and SCRIPTS are held until the reply is complete.
             *
             * Scripts wait because they are the only block a shape violation
             * can reject (`output.check` runs on `script:done`), and a rejected
             * attempt must reach the caller as nothing at all rather than as a
             * partial answer it would act on.
             */
            const events: AxonEngineEvent[] = []

            /**
             * Hand the caller every text block parsed so far that is now
             * un-retryable, and report whether anything crossed.
             *
             * ── Why this can emit before the reply is complete ──────────────
             *
             * Holding EVERY event until the attempt finished is what made a
             * streamed reply arrive as one burst: the model wrote for twenty
             * seconds and the whole answer appeared at once, at a token rate
             * far above what the provider could produce. The buffer existed so
             * a shape violation could discard the attempt and retry having
             * shown the user nothing — a real requirement, but a much narrower
             * one than the implementation.
             *
             * Every way this attempt can retry was checked against what it
             * reads:
             *
             *   output.check violations   `script:done` only — never text
             *   texts > 1 / scripts > 1   a SECOND block closing
             *   truncated / empty reply   end of reply, and both require that
             *                             nothing was spoken or acted
             *
             * So the FIRST text block is safe the moment it closes: no retry
             * path can fire while `texts <= 1 && scripts === 0`, and the
             * runtime already treats closed text as un-retryable output
             * (`blocks()` sets `emitted` on any `:done` and refuses transport
             * retries after it — see engine-retry.test.ts, "does not retry
             * after semantic output has crossed the engine boundary"). This
             * makes `stream()` obey the rule its own inner loop already
             * follows, rather than inventing a weaker one.
             *
             * Scripts are never streamed here: they are exactly what a
             * violation rejects, so they wait for the reply to be complete.
             */
            function drain(): AxonEngineEvent[] {
                // A second block means a shape retry is now possible, and the
                // whole attempt may be discarded — stop streaming and let the
                // post-loop checks decide. Anything already sent has crossed;
                // that is what `spoke` reports to those checks.
                if (texts > 1 || scripts > 0) return []

                const ready: AxonEngineEvent[] = []
                while (streamedOut < events.length) {
                    const event = events[streamedOut]!
                    if (event.type !== "engine:text") break
                    ready.push(event)
                    streamedOut++
                }
                return ready
            }

            let step = await raw.next()
            while (!step.done) {
                const block = step.value
                switch (block.type) {
                    case "text:open":
                        lang = block.lang
                        break

                    case "text:delta":
                        // A chunk with no VISIBLE content is not something the
                        // agent said.
                        //
                        // Guarded on `.trim()`, not on truthiness: a model that
                        // opens `<text>` and closes it after a newline emits a
                        // delta of `"\n"`, which is truthy, and that reached
                        // the UI as a bullet with nothing beside it. `text:done`
                        // already dropped the empty tail; this is the same rule
                        // one step earlier, and whitespace is the case that
                        // actually happens in a run.
                        if (pending?.trim()) {
                            group ??= crypto.randomUUID()
                            spoke = true
                            events.push({ type: "engine:text", content: pending, lang, chunk: { of: group } })
                        }
                        pending = block.content
                        break

                    case "text:done": {
                        if (block.incomplete) { truncated = "text"; break }
                        const last = pending ?? block.content
                        pending = null
                        // Same rule as the delta path: a block whose whole
                        // content is whitespace is a message the agent did not
                        // write, and forwarding it produces an empty bubble.
                        if (!last.trim()) break
                        spoke = true
                        texts++
                        events.push(group
                            ? { type: "engine:text", content: last, lang, chunk: { of: group, final: true } }
                            : { type: "engine:text", content: last, lang })
                        group = null
                        break
                    }

                    case "script:done": {
                        if (block.incomplete) { truncated = "script"; break }
                        // Checked BEFORE it is reported, so a script that
                        // cannot satisfy the contract is never handed to a
                        // cognet that would run it.
                        if (output) {
                            const problems = output.check(block.content)
                            if (problems.length > 0) {
                                violations = problems
                                // Kept so the diagnostic can quote it: a line
                                // number against code the model can no longer
                                // see points at nothing.
                                violatingScript = block.content
                                break
                            }
                        }
                        acted = true
                        scripts++
                        events.push({ type: "engine:script", id: crypto.randomUUID(), content: block.content })
                        break
                    }

                    case "done":
                        yielded = true
                        break

                    // Thinking never crosses the boundary.
                    case "thinking:delta":
                    case "thinking:done":
                        break
                }

                // Stream whatever is now safe to send. This is what makes a
                // reply appear as the model writes it instead of all at once
                // when it finishes.
                for (const event of drain()) yield event

                step = await raw.next()
            }

            // One block of each kind, at most.
            //
            // Several scripts in one message run as a CONCURRENT batch, which
            // the model does not expect: a run was observed writing a file in
            // one block and reading it in the next, and the read lost the
            // race. Five blocks also means one bad pattern discards four good
            // ones, and a message that long tends to end `</script><done/>`
            // followed by another `<text>` — the model losing track of its
            // own boundary.
            //
            // Reported as a violation rather than truncated: the extra blocks
            // are work the model intended, and silently dropping them would
            // leave it believing they ran.
            // ── Retry paths, and what streaming means for them ─────────────
            //
            // A retry rewrites the attempt and tries again. That is only
            // honest while the caller has been shown NOTHING: re-answering
            // after a block already reached the session would leave the
            // discarded text on screen with the replacement underneath it.
            //
            // `drain()` guarantees this cannot happen — it stops streaming the
            // moment a second block closes, and every check below requires
            // either a second block or a reply that spoke and acted nothing.
            // The assertion states that invariant where it matters rather than
            // trusting the reader to re-derive it, and fails loudly if a future
            // change to `drain()` breaks it.
            if (violations.length > 0 || texts > 1 || scripts > 1 || (!spoke && !acted)) {
                if (streamedOut > 0) {
                    // Not an EngineFailure: no provider did anything wrong.
                    // This is an internal invariant of this loop, and it must
                    // be unmissable rather than degrade into a duplicated reply.
                    throw new Error(
                        `AXON_INTERNAL: retry reached after ${streamedOut} block(s) already streamed to the caller — `
                        + "drain() emitted something a retry path can still discard",
                    )
                }
            }

            if (violations.length === 0 && (texts > 1 || scripts > 1)) {
                lastFault = describeTooManyBlocks(texts, scripts)
                lastFailure = "shape"
                await opts.fault({ code: "OUTPUT_TOO_MANY_BLOCKS", message: lastFault, rejected: step.value?.text, attempt: attempt + 1 })
                attemptCall = await reframe(call, lastFault)
                continue
            }

            // A reply that parsed to no block is unusable, whatever it said.
            //
            // Checked separately from `violations` because it is a different
            // kind of failure: violations mean "the block was wrong", this
            // means "there was no block". The model almost always DID answer —
            // as prose, outside any tag — so the parser discarded a complete
            // reply and the user saw a blank screen. Retrying with the excerpt
            // quoted back steers it in one attempt.
            //
            // A reply that is ONLY `<done/>` is not that failure. It is the
            // model saying it has nothing further to add — the exact signal
            // the loop's stop condition reads (`yielded && !acted`), and the
            // natural reply after a turn that already spoke and then acted.
            // Treating it as empty forced a model with nothing left to say to
            // invent something, three times, and then failed the wake.
            //
            // ONLY when it is alone. `<done/>` riding alongside discarded
            // prose is the original failure with a tag on the end — the model
            // answered outside any block, the user saw nothing, and that must
            // still retry. So this asks what the reply was APART from the
            // marker, rather than trusting the marker's presence.
            const spareText = (step.value?.text ?? "").replace(/<done\s*\/?>/g, "").trim()

            // ...and only on a FIRST attempt. After a correction, a bare
            // `<done/>` is not a model with nothing to add — it is a model
            // that was told its reply had no block and answered by deleting
            // the reply. A real run ended that way: prose + `<done/>` was
            // discarded, the retry asked for it wrapped, and the model sent
            // the marker alone, which silently became a finished turn and
            // stopped the loop with the work untouched.
            //
            // Accepting that would make the correction a way OUT of the
            // protocol rather than into it.
            const doneOnly = yielded && spareText.length === 0 && attempt === 0

            // A block that never closed is NOT an empty reply, and saying so is
            // the difference between a diagnostic and a contradiction. The
            // model sent a `<script>`; telling it that it sent no script —
            // while quoting the script — leaves it nothing to correct.
            if (violations.length === 0 && !spoke && !acted && truncated) {
                lastFault = describeTruncatedBlock(truncated, step.value?.text)
                lastFailure = "empty"
                await opts.fault({ code: "OUTPUT_TRUNCATED", message: lastFault, rejected: step.value?.text, attempt: attempt + 1 })
                attemptCall = await reframe(call, lastFault)
                continue
            }

            if (violations.length === 0 && !spoke && !acted && !doneOnly) {
                lastFault = describeEmptyResponse(
                    call.protocol,
                    step.value?.text,
                    attempt,
                    attempt >= budget,
                )
                lastFailure = "empty"
                await opts.fault({ code: "OUTPUT_EMPTY", message: lastFault, rejected: step.value?.text, attempt: attempt + 1 })
                attemptCall = await reframe(call, lastFault)
                continue
            }

            if (violations.length === 0) {
                // Only what has NOT already crossed. Re-yielding the streamed
                // prefix would commit every chunk twice — the reply rendering
                // once as it streamed and again, whole, underneath it.
                for (const event of events.slice(streamedOut)) yield event
                yield { type: "engine:done", response: step.value, spoke, acted, yielded }
                return
            }

            // Nothing this attempt produced is emitted: a response that
            // failed its contract is not a partial answer, it is a discarded
            // one. The diagnostic is committed so the next attempt's context
            // carries it, and the model rewrites against its own error.
            lastFault = describeViolations(violations, violatingScript)
            lastFailure = "shape"
            await opts.fault({ code: "OUTPUT_TYPE_ERROR", message: lastFault, rejected: step.value?.text, attempt: attempt + 1 })
            attemptCall = await reframe(call, lastFault)
        }

        // Budget exhausted. Loud, never a degraded return: a caller that
        // asked for a shape gets that shape or an error explaining why it
        // could not be produced, never an unchecked value it would treat as
        // validated.
        //
        // The two exhaustion modes get distinct codes because they mean
        // different things to whoever reads the session. OUTPUT_UNSATISFIED is
        // "your declared shape is more than this model can produce" — a
        // contract problem. OUTPUT_EMPTY is "this model does not follow the
        // block protocol" — usually a model choice problem, and the fix is to
        // change models rather than to loosen a type.
        yield {
            type: "engine:failure",
            error: lastFailure === "empty"
                ? err("OUTPUT_EMPTY", {
                    detail: `the model produced no <text> or <script> block in ${budget + 1} attempts — `
                        + `its replies could not be used. Last attempt: ${lastFault}`,
                    context: { attempts: budget + 1, model: call.model },
                })
                : err("OUTPUT_UNSATISFIED", {
                    detail: `the model could not produce the required output shape after ${budget + 1} attempts. `
                        + `Last errors: ${lastFault ?? "(none recorded)"}`,
                }),
        }
    }

    return {
        get configured() {
            return (opts.engines?.resolution.bound.length ?? 0) > 0
        },

        stream: stream,

        async request(req: AxonEngineCall, context: EngineContext): Promise<AxonEngineResponse> {
            for await (const event of stream(req, context)) {
                if (event.type === "engine:done") return event.response
                if (event.type === "engine:failure") throw event.error
            }
            throw err("ENGINE_NO_DONE")
        },

        /**
         * Adopt a new blueprint on reload.
         *
         * Engine bindings are NOT rebuilt here: they are resolved once at the
         * Axon() seam against the user's providers, and a hot reload of the
         * agent's own config cannot change what a user has. Changing which
         * model serves a role is `Engines.rebind()`, a deliberate act on one
         * role, not a side effect of editing a file.
         */
        update(next: AxonBlueprint) {
            blueprint = next
        },
    }
}

export type AxonEngineT = ReturnType<typeof Engine>



/** True when `final` is `streamed` plus a non-empty trailing suffix — never a divergence, only a possibly-truncated stream catching up to the provider's authoritative text. */
function extendsStreamedText(streamed: string, final: string): boolean {
    return final.length > streamed.length && final.startsWith(streamed)
}

/**
 * Which user-facing error a provider fault becomes.
 *
 * ── Why this table exists ───────────────────────────────────────────────────
 *
 * Drivers classify failures precisely (`AxonEngineFaultCode`) and write a
 * provider-specific sentence for each — "Codex: usage limit reached. Check your
 * ChatGPT subscription.", "OpenRouter: insufficient credits — top up at
 * openrouter.ai". All of that was being collapsed into one internal
 * `ENGINE_STREAM_FAILED`, so a spent subscription reached the user as
 * `AX-KERNEL-008` plus a stack trace through code they did not write.
 *
 * The split is one question: CAN THE USER FIX IT?
 *
 * Mapped codes are `expected` — headline, the driver's own sentence, and what
 * to do about it, with no frames. What is NOT in this table (EMPTY_RESPONSE,
 * PROTOCOL, UNKNOWN) is a model or driver misbehaving, which is ours to debug
 * and keeps the full report.
 *
 * A table rather than a chain of `if`s because this used to be exactly one
 * hardcoded special case (`AUTH_NOT_CONNECTED` + provider === "codex"), and
 * every provider that grew the same condition would have added another branch.
 * Adding a fault code to the union now produces an unmapped fault that falls
 * through to the honest generic error rather than a silently miscategorised
 * one.
 */
const FAULT_ERRORS: Partial<Record<AxonEngineFaultCode, AxonErrorCode>> = {
    AUTH_NOT_CONNECTED: "ENGINE_NOT_CONNECTED",
    AUTH: "ENGINE_AUTH_FAILED",
    RATE_LIMIT: "ENGINE_RATE_LIMITED",
    QUOTA: "ENGINE_QUOTA_EXHAUSTED",
    INVALID_REQUEST: "ENGINE_REQUEST_REJECTED",
    TRANSPORT: "ENGINE_UNREACHABLE",
}

/**
 * Turn a provider fault into the error the user sees.
 *
 * The driver's own message is always carried as `detail` — it is the most
 * specific thing available and names the provider, the condition and usually
 * the fix. `context` keeps the full fault for anyone reading the session log,
 * whichever error was chosen.
 */
function engineError(fault: AxonEngineFault, attempts: number, cause: unknown): Error {
    const context = {
        code: fault.code,
        provider: fault.provider,
        ...(fault.model !== undefined ? { model: fault.model } : {}),
        retryable: fault.retryable,
        attempts,
        ...(fault.status !== undefined ? { status: fault.status } : {}),
        ...(fault.retryAfterMs !== undefined ? { retryAfterMs: fault.retryAfterMs } : {}),
    }

    return err(FAULT_ERRORS[fault.code] ?? "ENGINE_STREAM_FAILED", {
        detail: fault.message,
        context,
        cause,
    })
}

function protocolFailure(provider: string, model: string | undefined, message: string): EngineFailure {
    return new EngineFailure({
        code: "PROTOCOL",
        message,
        retryable: true,
        provider,
        ...(model ? { model } : {}),
    })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, ms)
        function done() {
            signal?.removeEventListener("abort", aborted)
            resolve()
        }
        function aborted() {
            clearTimeout(timer)
            reject(abortError(signal))
        }
        signal?.addEventListener("abort", aborted, { once: true })
    })
}

function abortError(signal?: AbortSignal): DOMException {
    return new DOMException(signal?.reason ? String(signal.reason) : "engine request aborted", "AbortError")
}
