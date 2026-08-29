// zero — what this brain declares. Identity comes from package.json and
// behavior from src/main.ts; the compile step composes the three.
export default defineCognet({
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
