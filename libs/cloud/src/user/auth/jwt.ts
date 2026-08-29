/**
 * JWT inspection — read-side only, no verification. Safe for tokens we
 * hold ourselves; the backend is the authority on validity.
 */
export const jwt = {
    /** Decode a JWT's payload without verifying the signature. */
    decode(token: string): Record<string, unknown> {
        const parts = token.split(".")
        if (parts.length !== 3) {
            throw new Error("invalid JWT format: expected 3 parts")
        }
        try {
            const decoded = Buffer.from(parts[1]!, "base64url").toString("utf-8")
            return JSON.parse(decoded) as Record<string, unknown>
        } catch (error) {
            throw new Error(`failed to decode JWT payload: ${error instanceof Error ? error.message : String(error)}`)
        }
    },

    token: {
        /**
         * Expiry timestamp (unix ms) from the exp claim.
         *
         * Malformed tokens and missing claims return a 24h-future default
         * rather than throwing — this is a read-side refresh hint only; the
         * server always has the final say on validity.
         */
        parse(token: string): number {
            try {
                const exp = jwt.decode(token).exp
                if (typeof exp !== "number") return Date.now() + 24 * 60 * 60 * 1000
                return exp * 1000
            } catch {
                return Date.now() + 24 * 60 * 60 * 1000
            }
        },

        /** True when the token is expired or within bufferMs of expiring. */
        isExpired(token: string, bufferMs = 0): boolean {
            return Date.now() + bufferMs >= jwt.token.parse(token)
        },
    },
}
