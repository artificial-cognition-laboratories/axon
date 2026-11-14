/**
 * Ask an external binary a question, and never block this thread for the answer.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every machine probe here — GPU memory, GPU utilisation, the macOS platform
 * UUID — works the same way: run a vendor tool, parse a line, tolerate its
 * absence. All of them originally used a bare `Bun.spawnSync(...)`, which makes
 * the calling thread hostage to a third-party binary.
 *
 * ── Why a timeout was NOT the whole fix ─────────────────────────────────────
 *
 * The first version of this file bounded `Bun.spawnSync` at two seconds and
 * treated the problem as solved. It was not. Caught in the act on 2026-09-08:
 * a `bun test --test-worker --isolate` process alive for 4h57m with
 * `nvidia-smi <defunct>` as its child — and the worker in state R, spinning on
 * CPU rather than blocked. The child had exited and was never reaped; the
 * parent never resumed. `spawnSync`'s `timeout` does not bound that.
 *
 * The damage was not confined to the wedged suite. That one process pushed the
 * machine's load average past 12, and every other suite then failed at its
 * exact declared ceiling — store tests at 5000ms, blueprint loads at 60000ms,
 * a tui install at 30000ms, staging tests mid-release. They read as unrelated
 * flakes and blocked several attempts to ship.
 *
 * ── The fix: nothing waits ──────────────────────────────────────────────────
 *
 * `ask` never spawns synchronously. It answers from a cache and refreshes that
 * cache in the BACKGROUND with `Bun.spawn`, whose exit is awaited against an
 * AbortSignal. A hung vendor tool now costs one stale metric and one abandoned
 * subprocess — never a stalled thread.
 *
 * The first call for a command reports "unknown", which is a shape every caller
 * already handles: they all read `exitCode !== 0` as "we do not know", the same
 * answer they give for a missing binary. So a metric appears one tick late
 * rather than wrongly, and `read()` stays synchronous and safe to call from a
 * timer — which is what kept this fix from cascading into the admission path
 * that has to answer at an instant.
 */

/** A healthy vendor probe answers in tens of milliseconds; this is a hang bound, not a budget. */
export const PROBE_TIMEOUT_MS = 2_000

export type Probe = { exitCode: number | null; stdout: Buffer; stderr: Buffer }

/** What a caller gets before the first refresh lands, and after a failed one. */
function unknown(detail: string): Probe {
    return { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.from(detail) }
}

const NOT_YET = "probe has not answered yet"

/**
 * Has this question simply not come back yet, as opposed to failing?
 *
 * Both are `exitCode !== 0` and most callers are right not to care — "we do not
 * know" covers both. It matters only to a caller that CACHES the answer:
 * latching "no GPU" because the first background refresh had not landed yet
 * would be permanently wrong on a machine that has one.
 */
export function pending(probe: Probe): boolean {
    return probe.exitCode === null && probe.stderr.toString() === NOT_YET
}

/** Last known answer per command, plus whether a refresh is already in flight. */
const answers = new Map<string, Probe>()
const inFlight = new Set<string>()

/**
 * Run the tool and record its answer. Never throws, never rejects — a probe
 * cannot answer wrongly, only absently.
 *
 * A MISSING binary is the ordinary case (most machines have no `nvidia-smi`,
 * no Linux machine has `ioreg`), and `Bun.spawn` raises on it. That failure and
 * a timeout collapse into the same `exitCode: null` shape, so no call site
 * needs its own try/catch to express "no GPU".
 */
async function refresh(key: string, cmd: string[]): Promise<void> {
    try {
        const child = Bun.spawn({
            cmd: cmd,
            stdout: "pipe",
            stderr: "pipe",
            // Abandoned rather than awaited if it wedges: the point of this
            // whole file is that a stuck vendor tool never holds anything up.
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        const [stdout, stderr] = await Promise.all([
            new Response(child.stdout).arrayBuffer(),
            new Response(child.stderr).arrayBuffer(),
        ])
        const exitCode = await child.exited
        answers.set(key, {
            exitCode: exitCode,
            stdout: Buffer.from(stdout),
            stderr: Buffer.from(stderr),
        })
    } catch (cause) {
        // The reason travels back in `stderr`, so a caller that reports probe
        // failures (Hardware does) still has something to say.
        answers.set(key, unknown(cause instanceof Error ? cause.message : String(cause)))
    } finally {
        inFlight.delete(key)
    }
}

/**
 * The last answer to this question, and a refresh started if none is running.
 *
 * Named `ask` because that is the whole contract: pose a question, take the
 * most recent answer, and carry on without waiting for a new one.
 */
export function ask(cmd: string[]): Probe {
    const key = cmd.join(" ")

    if (!inFlight.has(key)) {
        inFlight.add(key)
        // Deliberately unawaited — this is the entire mechanism. `refresh`
        // cannot reject, so there is no rejection to handle.
        void refresh(key, cmd)
    }

    return answers.get(key) ?? unknown(NOT_YET)
}

/**
 * Await any refresh currently in flight.
 *
 * For tests and for a caller that genuinely needs a reading before continuing
 * (`axon machine` printing a one-shot report, where "unknown" on a healthy box
 * would be a wrong answer rather than a late one). Bounded by the same ceiling
 * as the probe itself, so waiting here cannot reintroduce the hang.
 */
export async function settled(): Promise<void> {
    const deadline = Date.now() + PROBE_TIMEOUT_MS * 2
    while (inFlight.size > 0 && Date.now() < deadline) {
        await Bun.sleep(10)
    }
}
