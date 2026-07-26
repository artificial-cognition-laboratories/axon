export default defineModule({
    env: {
        OBSIDIAN_API_KEY: {
            required: true,
            description: "API key from Obsidian → Settings → Local REST API.",
        },
        OBSIDIAN_BASE_URL: {
            required: false,
            description: "Base URL of the Obsidian REST API. Defaults to http://127.0.0.1:27123 (HTTP). Use https://127.0.0.1:27124 if you have HTTPS enabled.",
        },
    },
})
