import { resetClient } from "./src/github/client"

export default defineModule({
    env: {
        GITHUB_TOKEN: {
            required: true,
            description: "Personal access token from https://github.com/settings/tokens — needs repo scope for private repos, public_repo for public only.",
        },
    },

    async setup({ axon }) {
        axon.onDispose(() => resetClient())
    },
})
