// Example HTTP route: POST /api/hello
// Add your own routes in server/api/ — filename becomes the URL path.
export default defineEventHandler(async (event) => {
    const body = await readBody(event)
    return { message: `Hello, ${body.name ?? "world"}!` }
})
