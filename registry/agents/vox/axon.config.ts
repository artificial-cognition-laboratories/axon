// https://axon.arclabs.it/docs/v2/agent/config
export default defineAgent({
    modules: [
        "@axon/microphone",
        "@axon/speaker",
    ],
    links: { viewer: "/api/vox" },
})
