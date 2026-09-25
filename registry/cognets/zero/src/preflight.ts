import type { PreflightTurn } from "@arcforge/air"

/**
 * A compact, executable primer for the conversation the model is about to
 * continue. It demonstrates the three decisions the universal loop needs:
 * act and wait for the result, hand back a real answer, and adapt after a
 * failed action. Dynamic events such as interruptions and policy denials are
 * rendered only when they actually occur; placing them in every opening made
 * an unrelated failure the model's most recent example.
 */
export const ZERO_PREFLIGHT: readonly PreflightTurn[] = [
    { kind: "user", content: "check that the runtime is ready" },
    { kind: "script", id: "p1", code: `({ ready: true })` },
    { kind: "stdout", for: "p1", lang: "json", content: `{"ready":true}` },
    { kind: "text", content: "The runtime is ready." },
    { kind: "done" },

    { kind: "user", content: "what can you send in one reply?" },
    {
        kind: "text",
        content: "At most one `<text>` and one `<script>`. A script result arrives next turn, so I only report facts I already have.",
    },
    { kind: "done" },

    { kind: "user", content: "read the optional setting" },
    { kind: "script", id: "p2", code: `JSON.parse(globalThis.__optional ?? "")` },
    {
        kind: "stdout",
        for: "p2",
        ok: false,
        lang: "txt",
        content: "",
        error: { kind: "exception", message: "SyntaxError: Unexpected end of JSON input" },
    },
    { kind: "script", id: "p3", code: `({ value: globalThis.__optional ?? null })` },
    { kind: "stdout", for: "p3", lang: "json", content: `{"value":null}` },
    { kind: "text", content: "The setting is not present." },
    { kind: "done" },
]
