#!/usr/bin/env bun
/**
 * The capsule subprocess entrypoint — what Spawn() runs. Reads its policy
 * from the env carrier Spawn() sets, boots the sandbox, and reports ready.
 * Everything past this point speaks the protocol in types/protocol.ts and
 * types/events.ts directly — no legacy shape translation.
 */
import type { CapsulePolicy } from "../../types"
import { Sandbox } from "./sandbox"

const raw = process.env.AXON_CAPSULE_POLICY
if (!raw) {
    console.error("CAPSULE_POLICY_MISSING: AXON_CAPSULE_POLICY env var not set")
    process.exit(1)
}

const policy = JSON.parse(raw) as CapsulePolicy
const sandbox = Sandbox({ policy })

/**
 * The guest's last words. Without this, an unhandled throw anywhere in the
 * sandbox kills the process and the host sees only a bare capsule:exit with
 * a status code — the actual error dies with the process it happened in.
 *
 * Emitted synchronously on the wire (a plain stdout write) before exiting,
 * so it lands even though nothing awaits it. The exit is deliberate and
 * immediate: an unhandled error means the sandbox's state is unknown, and a
 * capsule that keeps serving after that is worse than one that dies loudly.
 */
for (const [event, code] of [["uncaughtException", 1], ["unhandledRejection", 1]] as const) {
    process.on(event, (cause: unknown) => {
        sandbox.crash(cause)
        process.exit(code)
    })
}

sandbox.ready()
