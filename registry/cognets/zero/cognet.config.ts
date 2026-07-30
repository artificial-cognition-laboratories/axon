// zero — identity only. Behavior lives in src/main.ts; this file is the
// manifest the compile step composes it with.
export default defineCognet({
    name: "zero",
    version: "0.1.2",
    abi: "9",

    mode: { kind: "invocation" },

    // runaway guard: a wake that hasn't converged in this many
    // render→infer→act ticks is a loop bug or a stuck model, not progress
    maxTicksPerWake: 32,
})
