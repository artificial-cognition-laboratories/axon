import { resetClient } from "./src/github/client"

export default defineModule({
    name: "github",
    description: "GitHub integration — repository navigation, issue triage, and pull request review. Provides repo.get/files/file/search, issues.list/get/create/comment/update/search, and prs.list/get/diff/files/commits/review/comment. Requires GITHUB_TOKEN.",
    public: true,

    env: {
        GITHUB_TOKEN: {
            required: true,
            description: "Personal access token from https://github.com/settings/tokens — needs repo scope for private repos, public_repo for public only.",
        },
    },

    async setup({ axon }) {
        axon.hook("axon:agent:shutdown", () => resetClient())
    },
})
