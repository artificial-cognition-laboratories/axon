/**
 * The login demos.
 *
 * The countdown runs at real speed but from a short window — a real code lives
 * ten minutes, and the point being demonstrated is that the clock moves, not
 * how long it takes to die.
 */

import { Live } from "../live/index.ts"
import { login, type LoginOpts } from "./login.ts"
import type { RendererHandle } from "../core/index.ts"
import type { AxonErrorLike } from "@arcforge/err"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type State = {
    authorization?: {
        verificationUri: string
        verificationUriComplete?: string
        userCode: string
        secondsLeft?: number
    }
    result?: NonNullable<LoginOpts["result"]>
    failure?: { error: AxonErrorLike; hint?: string }
}

const AUTHORIZATION = {
    verificationUri: "https://axon.arclabs.it/device",
    verificationUriComplete: "https://axon.arclabs.it/device?code=BXFT-QZLM",
    userCode: "BXFT-QZLM",
}

function surface(r: RendererHandle) {
    return Live<State>({
        renderer: r,
        view: (r, state, frame) => login(r, {
            frame,
            ...(state.authorization ? { authorization: state.authorization } : {}),
            ...(state.result ? { result: state.result } : {}),
            ...(state.failure ? { failure: state.failure } : {}),
        }),
        initial: {},
    })
}

export async function loginDemo(r: RendererHandle, which = "default"): Promise<void> {
    const live = surface(r)

    // Before the code exists. Brief, but it is a real state — the backend has
    // to issue the authorization first — and rendering nothing during it would
    // read as a hung command.
    await sleep(700)

    const window = which === "expired" ? 6 : 120
    live.set({
        ...live.state,
        authorization: { ...AUTHORIZATION, secondsLeft: window },
    })

    // Tick the countdown once a second, as a clock does. The poll interval the
    // backend asks for is separate and invisible; what the user watches is time
    // running out.
    const waitFor = which === "expired" ? window : 4
    for (let elapsed = 1; elapsed <= waitFor; elapsed++) {
        await sleep(1000)
        live.update(s => ({
            ...s,
            authorization: { ...AUTHORIZATION, secondsLeft: window - elapsed },
        }))
    }

    if (which === "expired") {
        live.stop({
            ...live.state,
            failure: {
                error: {
                    code: "AX-TUI-002",
                    title: "Sign-in Code Expired",
                    description:
                        "The code was not approved before it expired. Nothing is wrong with the account — the window simply closed.",
                    message: "device authorization expired",
                    severity: "fatal",
                    source: "tui",
                    context: undefined,
                    frames: [],
                    expected: true,
                },
                hint: "axon login",
            },
        })
        return
    }

    if (which === "denied") {
        live.stop({
            ...live.state,
            failure: {
                error: {
                    code: "AX-TUI-002",
                    title: "Sign-in Was Declined",
                    description: "The request was rejected in the browser, so no session was created.",
                    message: "device authorization denied",
                    severity: "fatal",
                    source: "tui",
                    context: undefined,
                    frames: [],
                    expected: true,
                },
                hint: "axon login",
            },
        })
        return
    }

    // Approved. The code and URL fall away — they were scaffolding for a task
    // that is now finished, and leaving a dead code on screen invites someone
    // to keep trying it.
    live.stop({
        result: {
            email: "cody@hexlabs.co.uk",
            // `no-scope` is the fresh-account case: signed in fine, but unable
            // to publish until a username is set.
            ...(which === "no-scope" ? {} : { scope: "cody" }),
            memberSince: Date.parse("2025-03-14"),
        },
    })
}
