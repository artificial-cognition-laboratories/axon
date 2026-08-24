// https://axon.arclabs.it/docs/v2/agent/config
export default defineAgent({
    modules: [
        "@axon/fs",
        "@axon/subagent",
    ],

    engine: Axon({
        model: "auto",
    }),
})
