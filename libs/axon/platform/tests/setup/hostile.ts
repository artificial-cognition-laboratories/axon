/**
 * A deliberately hostile environment, for code that must not read one.
 *
 * ── The failure this exists to catch ────────────────────────────────────────
 *
 * Tool loading materialized bundled source to `join(os.tmpdir(), …)`, and
 * `os.tmpdir()` reads `TMPDIR`. The agent process is spawned with an
 * environment built from nothing, and `TMPDIR` was not on the pass-through
 * list — so the host resolved one directory and the agent resolved another,
 * and every tool import failed. Agents could not boot on macOS at all.
 *
 * The seam was COVERED. Integration tests spawn real agents through the real
 * spawnConfined on every run. They passed because `TMPDIR` is usually unset on
 * Linux, so both sides fell back to `/tmp` and agreed by COINCIDENCE.
 *
 * That is the shape this harness targets. The property that broke is not "is
 * this path exercised" but "does this code read ambient state that may differ
 * across a boundary" — and that is answerable on one machine by making the
 * ambient state wrong, rather than by running CI on three operating systems.
 *
 * ── How to use it ───────────────────────────────────────────────────────────
 *
 * Wrap the call under test and assert on where its output landed:
 *
 * ```ts
 * const file = await hostile(() => materializeTool(scratch, source))
 * expect(file.startsWith(scratch)).toBe(true)   // the CALLER's path, not the env's
 * ```
 *
 * A test that passes here is asserting independence, which is the only claim
 * that survives moving to another machine.
 */

/** What a hostile environment overrides, and what each one would break. */
export type HostileEnv = {
    /** Scratch space. Reading this was the TMPDIR bug. */
    TMPDIR?: string
    /** The store root — `~/.axon` and every profile under it. */
    HOME?: string
    /** A stale working directory, as a long-lived daemon accumulates. */
    PWD?: string
    /** Emptied by default: nothing may silently depend on a binary being found. */
    PATH?: string
}

/**
 * Names overridden by default.
 *
 * Each is set to a path that EXISTS NOWHERE, so code reading it produces a
 * visibly wrong answer rather than a plausible one. A decoy that happens to be
 * writable would let a bug pass by accident, which is the failure mode this
 * whole harness exists to remove.
 */
const DECOYS: Required<Omit<HostileEnv, "PATH">> = {
    TMPDIR: "/nonexistent/hostile/tmp",
    HOME: "/nonexistent/hostile/home",
    PWD: "/nonexistent/hostile/pwd",
}

/**
 * Run `body` with the environment made hostile, then restore it exactly.
 *
 * Restoration distinguishes "was set to X" from "was not set at all": leaving
 * a name present with an empty value is not the same as absent, and the
 * difference is precisely what `{ ...floorEnv(), ...env }` spreads are
 * sensitive to.
 *
 * `PATH` is emptied rather than decoyed, because the interesting failure is a
 * spawn that cannot find its binary at all. Pass an explicit `PATH` to opt out
 * — a test that genuinely needs to spawn `bun` should say so rather than have
 * the harness quietly keep it.
 *
 * Synchronous restore in a finally: the env is process-global, so a body that
 * throws must not leave the next test running under decoys.
 */
export async function hostile<T>(body: () => T | Promise<T>, over: HostileEnv = {}): Promise<T> {
    const applied: Record<string, string> = { ...DECOYS, PATH: "", ...over }
    const previous = new Map<string, string | undefined>()

    for (const [name, value] of Object.entries(applied)) {
        previous.set(name, process.env[name])
        process.env[name] = value
    }

    try {
        return await body()
    } finally {
        for (const [name, value] of previous) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    }
}

/**
 * The hostile environment as a plain object, for code that takes an `env`
 * rather than reading `process.env`.
 *
 * The same decoys, so a spawn helper and an in-process call are held to one
 * standard — and a caller cannot accidentally test against a weaker set.
 */
export function hostileEnv(over: HostileEnv = {}): Record<string, string> {
    return { ...DECOYS, PATH: "", ...over }
}
