export default defineEventHandler(() => ({ value: process.env.TEST_SECRET ?? null }))
