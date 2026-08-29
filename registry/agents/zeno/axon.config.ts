// https://axon.arclabs.it/docs/v2/agent/config
export default defineAgent({
    model: "axon:z-ai/glm-5.3-flash",
    modules: [
        "@axon/fs",
        "@axon/subagent",
        "@axon/docs",
    ],
})
