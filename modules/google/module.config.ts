export default defineModule({
    name: "google",
    description: "Google Search integration — search the web from any agent.",
    public: true,

    env: {
        GOOGLE_API_KEY: {
            required: true,
            description: "Google Cloud API key with Custom Search API enabled.",
        },
        GOOGLE_CSE_ID: {
            required: true,
            description: "Custom Search Engine ID from cse.google.com.",
        },
    },

    policy: {
        network: { needs: ["www.googleapis.com"] },
    },
})
