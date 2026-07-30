export const fleet = {
    kanban: {
        async propose(input: { name: string; description: string }) {
            return { id: crypto.randomUUID(), name: input.name, description: input.description }
        },

        async list() {
            return {
                accepted: [],
                completed: [],
                proposed: [],
            }
        },

        async read(id: string) { },
    },

    project: {
        async list() { },

    },
}