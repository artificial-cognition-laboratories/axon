export default defineModule({
    env: {
        TAVILY_API_KEY: {
            required: true,
            description: "Tavily API key from app.tavily.com.",
        },
    },

    policy: {
        network: { needs: ["api.tavily.com"] },
    },
})
