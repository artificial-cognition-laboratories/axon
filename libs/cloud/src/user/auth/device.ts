import type { HttpClient } from "../../platform/http"
import { record, str } from "../../platform/parse"
import type { DeviceAuthorization, PollResult } from "./types"

export type ApproveResult = {
    apiKeyId: string
    name: string
}

type DeviceFlowOpts = {
    /** Lazy — Auth is constructed before Http; the device endpoints are unauthenticated anyway. */
    http: () => HttpClient
}

/**
 * The device-flow conversation with the backend:
 *   authorize() → user visits verification URL, enters code → wait() polls
 *   until approved. Pure protocol; persistence and state belong to Auth.
 */
export function DeviceFlow(opts: DeviceFlowOpts) {
    async function authorize(hint?: string): Promise<DeviceAuthorization> {
        const raw = await opts.http().post<Record<string, unknown>>(
            "/api/user/device/authorize",
            hint ? { hint } : {},
        )

        if (typeof raw.device_code !== "string") throw new Error("invalid authorize response: missing device_code")
        if (typeof raw.user_code !== "string") throw new Error("invalid authorize response: missing user_code")
        if (typeof raw.verification_uri !== "string") throw new Error("invalid authorize response: missing verification_uri")
        if (typeof raw.verification_uri_complete !== "string") throw new Error("invalid authorize response: missing verification_uri_complete")
        if (typeof raw.interval !== "number") throw new Error("invalid authorize response: missing interval")
        if (typeof raw.expires_in !== "number") throw new Error("invalid authorize response: missing expires_in")

        return {
            deviceCode: raw.device_code,
            userCode: raw.user_code,
            verificationUri: raw.verification_uri,
            verificationUriComplete: raw.verification_uri_complete,
            interval: raw.interval,
            expiresIn: raw.expires_in,
        }
    }

    async function poll(deviceCode: string, signal?: AbortSignal): Promise<PollResult> {
        const raw = await opts.http().get<Record<string, unknown>>(
            `/api/user/device/poll?device_code=${encodeURIComponent(deviceCode)}`,
            signal,
        )

        if (raw.status === "approved") {
            if (typeof raw.access_token !== "string") throw new Error("invalid poll response: missing access_token")
            return { status: "approved", accessToken: raw.access_token }
        }
        if (raw.status === "expired") return { status: "expired" }
        return { status: "pending" }
    }

    /**
     * Poll until a terminal state. Resolves on approval with the raw access
     * token; throws on expiry or abort. Pure protocol — identity resolution
     * (a follow-up call to /api/user/me/session, once the token is live)
     * is the caller's job, same as Auth.login() already does for adopt().
     *
     * The natural-expiry branch (deadline exhausted without an abort) isn't
     * exercised by this package's test suite — the real device flow's
     * expiry is 15 minutes server-side, impractical to wait out honestly in
     * a test. The abort path is covered via Auth.login()'s own tests.
     */
    async function wait(
        authorization: DeviceAuthorization,
        signal?: AbortSignal,
    ): Promise<{ accessToken: string }> {
        const deadline = Date.now() + authorization.expiresIn * 1000

        while (Date.now() < deadline) {
            if (signal?.aborted) throw new Error("device authorization aborted")

            // POLL FIRST, then wait. The loop used to sleep a full interval
            // before its first request, so a code approved before that sleep
            // elapsed — the normal case when approval is fast, and every case
            // in the tests — still cost the full interval for nothing. The
            // server has no slow_down enforcement, so an immediate first poll
            // is legal; the wait only exists to space out SUBSEQUENT ones.
            const result = await poll(authorization.deviceCode, signal)
            if (result.status === "approved") return { accessToken: result.accessToken }
            if (result.status === "expired") throw new Error("device authorization expired")

            await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, authorization.interval * 1000)
                signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("device authorization aborted")) }, { once: true })
            })
        }

        throw new Error("device authorization expired")
    }

    /**
     * Approve a pending device code — the browser side of the flow. Called
     * by a logged-in user (Http sends their bearer token); links the code
     * to their account and mints the CLI's API key.
     */
    async function approve(input: { userCode: string; deviceName?: string }): Promise<ApproveResult> {
        const raw = record(
            await opts.http().post<Record<string, unknown>>("/api/user/device/approve", {
                user_code: input.userCode,
                ...(input.deviceName !== undefined ? { device_name: input.deviceName } : {}),
            }),
            "approve result",
        )
        const device = record(raw.device, "approve result device")
        return { apiKeyId: str(device, "apiKeyId"), name: str(device, "name") }
    }

    return {
        authorize: authorize,
        poll: poll,
        wait: wait,
        approve: approve,
    }
}
