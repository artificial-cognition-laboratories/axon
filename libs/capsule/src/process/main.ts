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
sandbox.ready()
