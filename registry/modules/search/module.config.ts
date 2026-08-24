/**
 * search — web search over whichever provider you have a key for.
 *
 * Every var is OPTIONAL, deliberately. `required: true` would mean an agent
 * without that specific key fails to boot, which is exactly wrong for a
 * cascade: the module's whole purpose is that one key out of several is
 * enough. What it cannot express is "at least one of these" — so the check
 * lives at the call, where it can name every key that would have worked.
 */
export default defineModule({
    env: {
        TAVILY_API_KEY: {
            required: false,
            description: "Tavily — built for agents, returns prose extracts. Tried first.",
        },
        BRAVE_API_KEY: {
            required: false,
            description: "Brave Search — independent index, one key, generous free tier.",
        },
        GOOGLE_API_KEY: {
            required: false,
            description: "Google Custom Search — needs GOOGLE_CSE_ID as well.",
        },
        GOOGLE_CSE_ID: {
            required: false,
            description: "Google Custom Search engine id. Useless without GOOGLE_API_KEY.",
        },
    },
})
