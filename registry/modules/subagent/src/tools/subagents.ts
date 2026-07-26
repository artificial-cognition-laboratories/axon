
export const subagents = {
    async request(prompt: string) {
        const result = await axon.request(prompt)
        return result.text
    },
}
