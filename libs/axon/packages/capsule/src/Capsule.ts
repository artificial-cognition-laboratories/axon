import { CapsuleBus } from "../platform/bus"
import { CapsuleSubprocess } from "./sandbox/subprocess"
import type { CapsulePartialConfig } from "../types/config"
import { Blueprint } from "./blueprint"

/**
 * Capsule — the in-process manager of one sandboxed subprocess.
 *
 * Construction is wiring only; boot() spawns. Takes anything from {} up —
 * CapsuleBlueprint() normalizes at this one seam, so nothing downstream
 * checks a config field for absence.
 *
 * Lifetimes:
 *   the capsule    — this handle, the bus, the subprocess
 *   an incarnation — one subprocess, rebuilt on crash (Build)
 *   a conversation — one run(), one escalation, one child proc — owned by
 *                    the subprocess, since all three are just clients of it
 */
export function Capsule(input?: CapsulePartialConfig) {
    const blueprint = Blueprint(input)
    const bus = CapsuleBus()
    const subprocess = CapsuleSubprocess({ config: blueprint, bus })

    return {
        // execution
        run: subprocess.run,
        /**
         * run() plus the top-level bindings the submission left behind.
         * Separate verb rather than a wider run(): the scope is only
         * meaningful to a caller about to render a template against it, and
         * every other caller would have to unwrap a field it never reads.
         */
        exec: subprocess.exec,
        interrupt: subprocess.interrupt,

        // managed child processes — live mirror
        process: subprocess.proc,

        /** Authoritative model-facing declarations for everything executable in this capsule. */
        get scope() {
            return subprocess.scope
        },

        /** the root process — the sandboxed TS runtime every child runs under */
        get main() {
            return subprocess.main
        },

        // observation — read-only: the capsule is the single writer of its stream
        on: bus.on,
        once: bus.once,
        off: bus.off,
        onAny: bus.onAny,

        // lifecycle
        boot: subprocess.boot,
        update: subprocess.update,
        shutdown: subprocess.shutdown,
    }
}

export type CapsuleT = ReturnType<typeof Capsule>
