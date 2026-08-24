// https://axon.arclabs.it/docs/v2/agent/config
export default defineAgent({
    modules: [
        "@axon/fs",
        "@axon/subagent",
        "@axon/search",
        "@axon/docs",
    ],
})
