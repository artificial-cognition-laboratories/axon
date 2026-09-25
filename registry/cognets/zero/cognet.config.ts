// zero — what this brain declares. Identity comes from package.json and
// behavior from src/main.ts; the compile step composes the three.
export default defineCognet({
    mode: { kind: "invocation" },

    // Zero has an image path only when its cortex actually accepts images.
    // A future multimodel brain can instead name several fallback roles.
    stimuli: {
        text: true,
        image: { engine: "main" },
    },

    engines: {
        main: {
            type: "generate",
            in: "text",
            prefer: { in: "image" },
            out: "text",
            context: 100_000,
            structured: true,
            primary: true,
        },
    },
})
