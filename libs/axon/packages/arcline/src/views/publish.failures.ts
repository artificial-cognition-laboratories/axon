/**
 * The ways a publish plausibly fails, as fixtures.
 *
 * Every entry is a REAL code from `@arcforge/err`'s map, with that entry's own
 * title and description — not invented prose. A fixture that reads better than
 * production would make this gallery a way of fooling ourselves, so when one
 * of these looks bad the fix belongs in the error map, not here.
 *
 * The set is chosen to cover the axes the renderer actually branches on:
 *
 *   auth       expected, no stack, one-line fix          → is the common case calm?
 *   verify     unexpected, full trace + source snippet   → is a real trace readable?
 *   network    unexpected, with a `cause` chain          → does the underlying fault survive?
 *   kind       expected, context-heavy, no fix command   → does it hold up with no hint?
 *
 * `expected` is err's own classification and the split it drives is deliberate:
 * a failure the USER caused renders headline + description, because our stack
 * frames describe code they did not write.
 */

import type { AxonErrorLike } from "@arcforge/err"

export type Failure = {
    /** Which step died. Everything before it passed. */
    failedAt: (typeof FAILURE_STEP_ORDER)[number]
    error: AxonErrorLike
    hint?: string
}

export const FAILURE_STEP_ORDER = ["Bundling", "Verifying", "Registering", "Uploading"] as const

export const failures: Record<string, Failure> = {
    /**
     * The most common publish failure and the one that must feel calmest:
     * nothing is broken, the user simply has not logged in.
     */
    auth: {
        failedAt: "Registering",
        hint: "axon login",
        error: {
            code: "AX-TUI-002",
            title: "Not Logged In",
            description: "The action needs an active profile, but none is logged in yet.",
            message: "Not Logged In",
            severity: "fatal",
            source: "tui",
            context: undefined,
            frames: [],
            expected: true,
        },
    },

    /**
     * The expensive one. The artifact built fine but does not compile the way a
     * consumer would compile it, so publishing would ship something nobody can
     * install — and a published version is immutable, so it is caught here.
     */
    verify: {
        failedAt: "Verifying",
        hint: "add the missing file to `files` in package.json, then re-run",
        error: {
            code: "AX-PROJECT-013",
            title: "Artifact Does Not Compile",
            description:
                "The package was built, but compiling it the way a consumer would failed — so publishing it would ship something nobody can install. Usually a file the source imports was left out of the package. Published versions are immutable, so this is caught before upload rather than after.",
            message: "Cannot find module './lib/format' from 'src/index.ts'",
            severity: "fatal",
            source: "manifest",
            context: {
                name: "@cody/zeno",
                version: "0.3.1",
                missing: "./lib/format",
            },
            frames: [
                {
                    functionName: "verifyArtifact",
                    fileName: "libs/axon/platform/src/build/project/publish/verify.ts",
                    lineNumber: 88,
                    columnNumber: 20,
                    source: [
                        { lineNumber: 86, text: "    const scope = await Tools({ root: scratch })" },
                        { lineNumber: 87, text: "" },
                        { lineNumber: 88, text: "    if (!scope.ok) throw err(\"PUBLISH_VERIFY_FAILED\", { context })" },
                        { lineNumber: 89, text: "" },
                        { lineNumber: 90, text: "    return scope" },
                    ],
                },
                {
                    functionName: "publish",
                    fileName: "libs/axon/platform/src/build/project/publish.ts",
                    lineNumber: 109,
                    columnNumber: 15,
                    source: null,
                },
            ],
        },
    },

    /**
     * The upload died mid-flight. The `cause` is the most actionable line in
     * the whole report — it names the underlying fault, which the title cannot.
     */
    network: {
        failedAt: "Uploading",
        hint: "check your connection, then re-run `axon publish`",
        error: {
            code: "AX-TUI-044",
            title: "Backend Unreachable",
            description:
                "A stored credential could not be verified because the backend could not be reached. The credential is NOT discarded — it may be perfectly valid — but it cannot be trusted until it is checked, so the action is refused rather than proceeding unverified.",
            message: "POST /api/registry/artifacts failed after 3 attempts",
            severity: "fatal",
            source: "tui",
            context: { endpoint: "https://axon.arclabs.it", attempts: 3 },
            frames: [
                {
                    functionName: "Http.post",
                    fileName: "libs/cloud/src/platform/http.ts",
                    lineNumber: 142,
                    columnNumber: 11,
                    source: null,
                },
            ],
            cause: new Error("connect ECONNREFUSED 34.117.0.12:443"),
            expected: true,
        },
    },

    /**
     * Context-heavy and deliberately WITHOUT a hint — there is no command that
     * fixes it, and the renderer must read well when it has nothing to suggest.
     */
    kind: {
        failedAt: "Bundling",
        error: {
            code: "AX-PROJECT-009",
            title: "This Project Kind Cannot Publish",
            description:
                "The registry accepts agents, modules, cognets, benches and prompts. Extensions are not accepted yet — the `registry_artifact_kind` enum needs the value first, and publishing before then would register under the wrong kind and claim the name in the shared namespace.",
            message: "This Project Kind Cannot Publish",
            severity: "fatal",
            source: "manifest",
            context: { kind: "extension", publishable: false },
            frames: [],
            expected: true,
        },
    },
}
