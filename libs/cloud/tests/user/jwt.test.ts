import { jwt } from "../../src/user/auth/jwt"

// Pure decode logic, no server round-trip — the malformed-token fallback
// this exercises can't be produced organically through a real device-flow
// session (login() only ever adopts genuine, well-formed JWTs), so it's
// tested directly as its own subject rather than as another function's
// internals.
describe("jwt.decode", () => {
    it("decodes a real JWT's payload", () => {
        const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
        const payload = Buffer.from(JSON.stringify({ sub: "abc", exp: 123 })).toString("base64url")
        const token = `${header}.${payload}.signature`

        expect(jwt.decode(token)).toEqual({ sub: "abc", exp: 123 })
    })

    it("rejects a token with the wrong number of dot-separated parts", () => {
        expect(() => jwt.decode("not-a-jwt")).toThrow(/expected 3 parts/)
    })

    it("rejects a token whose payload segment isn't valid base64url JSON", () => {
        const token = "header.not-valid-json-!!!.signature"
        expect(() => jwt.decode(token)).toThrow(/failed to decode JWT payload/)
    })
})

describe("jwt.token.parse", () => {
    it("returns the real exp claim in milliseconds", () => {
        const payload = Buffer.from(JSON.stringify({ exp: 1000 })).toString("base64url")
        const token = `header.${payload}.signature`

        expect(jwt.token.parse(token)).toBe(1_000_000)
    })

    it("falls back to a ~24h-future default when exp is missing", () => {
        const payload = Buffer.from(JSON.stringify({ sub: "abc" })).toString("base64url")
        const token = `header.${payload}.signature`

        const before = Date.now()
        const parsed = jwt.token.parse(token)

        expect(parsed).toBeGreaterThan(before + 23 * 60 * 60 * 1000)
        expect(parsed).toBeLessThan(before + 25 * 60 * 60 * 1000)
    })

    it("falls back to the same ~24h default for a totally malformed token, rather than throwing", () => {
        const before = Date.now()
        const parsed = jwt.token.parse("garbage")

        expect(parsed).toBeGreaterThan(before + 23 * 60 * 60 * 1000)
    })
})

describe("jwt.token.isExpired", () => {
    it("is false for a token whose exp is well in the future", () => {
        const exp = Math.floor(Date.now() / 1000) + 3600
        const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url")
        const token = `header.${payload}.signature`

        expect(jwt.token.isExpired(token)).toBe(false)
    })

    it("is true for a token whose exp is in the past", () => {
        const exp = Math.floor(Date.now() / 1000) - 3600
        const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url")
        const token = `header.${payload}.signature`

        expect(jwt.token.isExpired(token)).toBe(true)
    })

    it("respects the buffer — a token expiring within bufferMs counts as expired", () => {
        const exp = Math.floor(Date.now() / 1000) + 60
        const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url")
        const token = `header.${payload}.signature`

        expect(jwt.token.isExpired(token, 120_000)).toBe(true)
    })
})
