import { jwt } from "../auth/jwt"
import type { CodexCredential } from "./types"

type LoginOpts = {
    /** Open the authorization URL (browser, or print it). The package collects the callback itself. */
    open: (url: string) => void | Promise<void>
    /**
     * Manual fallback: prompt the user to paste the callback when the
     * local callback port is busy. Omitting it makes a busy port fatal.
     */
    paste?: () => Promise<string>
}

/**
 * The Codex (OpenAI) PKCE flow — the interactive half of a vault
 * connection, which must run on the user's machine (browser + localhost
 * callback). login() yields the full grant exactly once; the caller
 * (vault.connections.openai.connect) uploads it to the backend, which
 * owns refresh and rotation from then on. Nothing here persists or
 * refreshes anything.
 */
export const codexOAuth = {
    async login(opts: LoginOpts): Promise<CodexCredential> {
        const crypto = (await import("node:crypto")).default
        const flow = authorize(crypto)

        const server = await CallbackServer()
        let callback: string
        if (server) {
            await opts.open(flow.url)
            callback = await server.callback
        } else {
            if (!opts.paste) {
                throw new Error("CODEX_PORT_BUSY: port 1455 is in use and no paste fallback was provided")
            }
            await opts.open(flow.url)
            callback = await opts.paste()
        }

        const { code, state } = parseCallback(callback)
        if (!code) throw new Error("Codex login failed: no authorization code in callback")
        if (state && state !== flow.state) throw new Error("Codex login failed: state mismatch — possible CSRF, try again")

        return exchange(code, flow.verifier)
    },
}

// ── CallbackServer — one-shot localhost receiver for the OAuth redirect ─────

const CALLBACK_PORT = 1455
const CALLBACK_PATH = "/auth/callback"
const CALLBACK_TIMEOUT_MS = 5 * 60_000

/**
 * Listens once on localhost:1455 for the OAuth redirect and resolves with
 * the full callback URL. Returns null when the port is taken (another
 * process, or a second login) — the caller decides the fallback.
 */
async function CallbackServer(): Promise<{ callback: Promise<string> } | null> {
    const http = (await import("node:http")).default
    return new Promise((resolveServer) => {
        const server = http.createServer()

        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") return resolveServer(null)
            throw err
        })

        server.listen(CALLBACK_PORT, "127.0.0.1", () => {
            const callback = new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    server.close()
                    reject(new Error("CODEX_CALLBACK_TIMEOUT: no OAuth redirect received within 5 minutes"))
                }, CALLBACK_TIMEOUT_MS)

                server.on("request", (req, res) => {
                    const url = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`)
                    if (url.pathname !== CALLBACK_PATH) {
                        res.writeHead(404).end()
                        return
                    }
                    res.writeHead(200, { "Content-Type": "text/html" })
                    res.end("<html><body>Connected — you can close this tab and return to the terminal.</body></html>")
                    clearTimeout(timeout)
                    server.close()
                    resolve(url.toString())
                })
            })
            resolveServer({ callback })
        })
    })
}

// ── The OAuth protocol itself ────────────────────────────────────────────────

// OAuth constants — OpenAI's Codex CLI app registration
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const REDIRECT_URI = "http://localhost:1455/auth/callback"
const SCOPE = "openid profile email offline_access"
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth"

type AuthorizeFlow = {
    url: string
    state: string
    /** PKCE verifier — kept secret, sent on code exchange */
    verifier: string
}

/** Build the authorization URL with a fresh PKCE pair and CSRF state. */
function authorize(crypto: typeof import("node:crypto")): AuthorizeFlow {
    const verifier = crypto.randomBytes(32).toString("base64url")
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url")
    const state = crypto.randomBytes(16).toString("hex")

    const url = new URL(AUTHORIZE_URL)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("client_id", CLIENT_ID)
    url.searchParams.set("redirect_uri", REDIRECT_URI)
    url.searchParams.set("scope", SCOPE)
    url.searchParams.set("code_challenge", challenge)
    url.searchParams.set("code_challenge_method", "S256")
    url.searchParams.set("state", state)
    url.searchParams.set("id_token_add_organizations", "true")
    url.searchParams.set("codex_cli_simplified_flow", "true")
    url.searchParams.set("originator", "codex_cli_rs")

    return { url: url.toString(), state, verifier }
}

/** Exchange an authorization code (+ PKCE verifier) for the full grant. */
async function exchange(code: string, verifier: string): Promise<CodexCredential> {
    const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
        }).toString(),
    })

    if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw new Error(`Codex token request failed: ${response.status}${text ? ` - ${text}` : ""}`)
    }

    const json = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
        throw new Error("Codex token response missing required fields")
    }

    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + json.expires_in * 1000,
        accountId: decodeAccountId(json.access_token),
        connectedAt: Date.now(),
    }
}

function decodeAccountId(accessToken: string): string {
    const claim = jwt.decode(accessToken)[ACCOUNT_ID_CLAIM] as { chatgpt_account_id?: string } | undefined
    if (!claim?.chatgpt_account_id) {
        throw new Error(`Codex token missing chatgpt_account_id in "${ACCOUNT_ID_CLAIM}" claim`)
    }
    return claim.chatgpt_account_id
}

/**
 * Parse whatever the user pastes back — full callback URL, `code#state`,
 * a query string, or the raw code.
 */
function parseCallback(input: string): { code?: string; state?: string } {
    const value = input.trim()
    if (!value) return {}

    try {
        const url = new URL(value)
        return {
            code: url.searchParams.get("code") ?? undefined,
            state: url.searchParams.get("state") ?? undefined,
        }
    } catch {
        // not a URL — fall through
    }

    if (value.includes("#")) {
        const [code, state] = value.split("#", 2)
        return { code: code || undefined, state: state || undefined }
    }

    if (value.includes("code=")) {
        const params = new URLSearchParams(value)
        return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined }
    }

    return { code: value }
}
