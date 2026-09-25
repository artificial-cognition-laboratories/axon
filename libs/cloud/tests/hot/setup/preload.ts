/**
 * The hot suite runs against the same local backend and database as the full
 * gate. Connecting here is a no-op when the staging daemon is already warm,
 * and boots it when a developer starts from a cold machine.
 *
 * Test workers read the daemon lockfile through full/setup/staging.ts, so this
 * preload deliberately owns only daemon readiness. It does not fund accounts,
 * call Stripe, or perform any other full-gate setup.
 */
import { Repo } from "@arclabs/repo"

await Repo().daemon.connect()
