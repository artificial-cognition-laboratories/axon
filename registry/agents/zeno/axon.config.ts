// https://axon.arclabs.it/docs/v2/agent/config
export default defineAgent({
    model: "codex:gpt-5.6-terra",
    modules: [
        "@axon/fs",
        "@axon/subagent",
        "@axon/docs",
    ],
})
