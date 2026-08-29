import { describe, expect, test } from "bun:test"
import { PRODUCTION_API_BASE, resolveDefaultBaseUrl } from "../../src/platform/http"

describe("HTTP backend target", () => {
    test("uses the production API host by default, never the website host", () => {
        expect(resolveDefaultBaseUrl({})).toBe(PRODUCTION_API_BASE)
    })

    test("honours an explicit API base over every default", () => {
        expect(resolveDefaultBaseUrl({
            AXON_API_BASE: "http://127.0.0.1:3099",
            AXON_STAGING_MODE: "true",
        })).toBe("http://127.0.0.1:3099")
    })

    test("uses local staging only when it is explicitly selected", () => {
        expect(resolveDefaultBaseUrl({ AXON_STAGING_MODE: "true" })).toBe("http://localhost:3099")
    })
})
