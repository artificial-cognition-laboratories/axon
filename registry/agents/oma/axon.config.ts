// https://axon.arclabs.it/docs/v2/agent/config
export default defineAgent({
    model: "codex:gpt-5.6-terra",
    modules: [
        "@axon/fs",
    ],

    policy: {
        shell: {
            // Oma's installed-command catalogue uses pipes and redirection.
            // `allow` admits binaries; `raw` separately admits shell syntax.
            allow: ["*"],
            raw: true,
        }
    }
})
