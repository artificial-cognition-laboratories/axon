import { err, errorMap, type AxonErrorCode } from "@arcforge/err"

/**
 * Turn a failed response back into the error the domain threw.
 *
 * The daemon sends the whole AxonError, so the code survives the wire and a
 * caller sees what a local caller would. `errorMap` is keyed by NAME and the
 * error carries its CODE, so this looks the name back up — one linear scan
 * over a static map, paid only on failure.
 *
 * DAEMON_NOT_WIRED remains the fallback, and now means what it says: the
 * daemon answered with something that carries no code, which is either a
 * thrown non-Error or a daemon older than this client.
 */
export function rebuild(
    path: readonly string[],
    body: { error?: string; fault?: { code?: string; message?: string; context?: unknown } },
): Error {
    const verb = path.join(".")
    const code = body.fault?.code
    if (code) {
        const name = (Object.keys(errorMap) as AxonErrorCode[])
            .find(key => errorMap[key].code === code)
        if (name) {
            return err(name, {
                detail: body.fault?.message ?? body.error ?? verb,
                context: {
                    ...(body.fault?.context && typeof body.fault.context === "object"
                        ? body.fault.context as Record<string, unknown>
                        : {}),
                    verb: verb,
                },
            })
        }
    }
    return err("DAEMON_NOT_WIRED", {
        detail: `${verb} — ${body.error ?? "unknown error"}`,
        context: { verb: verb },
    })
}
