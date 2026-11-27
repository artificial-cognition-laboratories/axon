// https://axon.arclabs.it/docs/v2/agent/config
export default defineAgent({
    model: "openrouter:moonshotai/kimi-k2.7-code",
    modules: [
        "@axon/fs",
        "@axon/subagent",
        "@axon/docs",
    ],
})
