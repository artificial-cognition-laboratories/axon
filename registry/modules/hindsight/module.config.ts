
/**
 * Connects an agent to an existing Hindsight deployment. The Hindsight server,
 * rather than this module, owns its LLM provider, model, URL, and credentials.
 */
export default defineModule({
    env: {
        HINDSIGHT_BASE_URL: {
            required: true,
            description: "Hindsight API base URL (Cloud or self-hosted), e.g. http://localhost:8888.",
        },
        HINDSIGHT_API_KEY: {
            required: false,
            description: "Hindsight bearer token. Optional only for an intentionally unauthenticated local deployment.",
        },
    },
})
