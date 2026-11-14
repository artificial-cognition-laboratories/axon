// https://axon.arclabs.it/docs/v2/agent/config
export default defineAgent({
    model: "codex:gpt-6-sol",
    modules: [
        "@axon/fs",
        "@axon/subagent",
        "@axon/docs",
    ],
})
