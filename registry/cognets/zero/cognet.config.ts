// zero — identity only. Behavior lives in src/main.ts; this file is the
// manifest the compile step composes it with.
export default defineCognet({
    name: "zero",
    version: "0.1.2",
    abi: "11",
    mode: { kind: "invocation" },

    engines: {
        main: {
            type: "generate",
            in: "text",
            out: "text",
            context: 100_000,
            structured: true,
            primary: true,
        },
    },
})
