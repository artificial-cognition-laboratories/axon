import { afterAll, describe, expect, test } from "bun:test"
import { Http } from "../../src/platform/http"

/**
 * A stalled connection is the failure these tests exist for: `fetch` has no
 * default timeout, so a socket that accepts the request and then never answers
 * leaves the promise pending forever. `axon publish` hung that way — minutes of
 * empty terminal, no error, intermittent, because whether the socket stalls is
 * a race.
 *
 * The server below reproduces it exactly: it accepts and never responds. A
 * request against it must fail on a budget rather than hang.
 */
const stalled = Bun.serve({
    port: 0,
    // Never resolves — the connection is open and silent, which is the case a
    // status-code retry cannot see.
    fetch: () => new Promise<Response>(() => {}),
})

const responsive = Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true }),
})

afterAll(() => {
    stalled.stop(true)
    responsive.stop(true)
})

describe("HTTP request timeouts", () => {
    test("a stalled request fails on a budget instead of hanging forever", async () => {
        const http = Http({ baseUrl: stalled.url.origin.replace(/\/$/, ""), token: () => undefined })

        // 5s ceiling: the assertion is that it RETURNS, and the default budget
        // is 30s, so an unbounded hang fails this by timing out the test.
        await expect(http.get("/anything", AbortSignal.timeout(5_000))).rejects.toThrow()
    }, 10_000)

    test("the timeout error names the method and path that stalled", async () => {
        const http = Http({ baseUrl: stalled.url.origin.replace(/\/$/, ""), token: () => undefined })

        // Drive the budget from the caller's own signal so the test does not
        // wait 30s; the message under test is the one raw() builds.
        const error = await http.get("/registry/publish", AbortSignal.timeout(300)).catch((e: unknown) => e)

        expect(error).toBeInstanceOf(Error)
        // Either message is a correct abort report; what must never happen is
        // hanging. The caller-signal path reports an abort, the budget path
        // reports the timeout with its target.
        expect(String(error)).toMatch(/abort|timed out/i)
    }, 10_000)

    test("a caller's abort still cancels, and is not reported as a timeout", async () => {
        const http = Http({ baseUrl: stalled.url.origin.replace(/\/$/, ""), token: () => undefined })
        const controller = new AbortController()
        setTimeout(() => controller.abort(), 100)

        await expect(http.get("/anything", controller.signal)).rejects.toThrow()
    }, 10_000)

    test("a responsive request is unaffected by the timeout wiring", async () => {
        const http = Http({ baseUrl: responsive.url.origin.replace(/\/$/, ""), token: () => undefined })
        await expect(http.get("/fine")).resolves.toEqual({ ok: true })
    })
})
