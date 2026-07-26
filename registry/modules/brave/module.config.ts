export default defineModule({
    env: {
        BRAVE_API_KEY: {
            required: true,
            description: "Brave Search API key from api-dashboard.search.brave.com.",
        },
    },

    policy: {
        network: { needs: ["api.search.brave.com"] },
    },
})
