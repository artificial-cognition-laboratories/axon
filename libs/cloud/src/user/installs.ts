import type { HttpClient } from "../platform/http"

type InstallsOpts = {
    http: HttpClient
}

/**
 * Installs — claims the install on this machine for the signed-in user.
 *
 * ── What it is for ───────────────────────────────────────────────────────
 *
 * The install script writes an anonymous machine id and reports install
 * successes and failures against it. Nothing connects that id to an account,
 * so the backend has two counters — installs and signups — with no way to
 * relate them. "What fraction of installs become accounts" is the main
 * question install telemetry exists to answer, and it is unanswerable without
 * this call.
 *
 * ── Why it never throws ──────────────────────────────────────────────────
 *
 * The only caller is a login path. A metric must not be able to fail a login,
 * and there is nothing a user could do about it if it did — so a failure is
 * swallowed and reported in the return value rather than raised. This is the
 * one place in this package where that is the right shape: everywhere else a
 * failed request means the user's request failed, and here it means one row in
 * a funnel is missing.
 *
 * `attributed` is returned rather than void so a caller that DOES care (a test,
 * a diagnostic command) can tell the difference. Nothing is silently true.
 */
export function Installs(opts: InstallsOpts) {
    return {
        /**
         * Record that this machine's install became the current user.
         *
         * Idempotent and first-wins at the database: re-running it, or running
         * it as a second account on a shared machine, does not re-attribute an
         * install that already converted.
         */
        async attribute(installId: string): Promise<{ attributed: boolean }> {
            try {
                await opts.http.post("/api/installs/attribute", { install_id: installId })
                return { attributed: true }
            } catch {
                return { attributed: false }
            }
        },
    }
}

export type InstallsHandle = ReturnType<typeof Installs>
