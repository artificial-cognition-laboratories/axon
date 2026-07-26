import { Axon } from "../../../setup/axon"

describe("server routing: method types", () => {
    it("mounts an ANY route that matches every HTTP method", async () => {
        const runtime = await Axon({
            blueprint: {
                server: { routes: [
                    { method: "ANY", path: "/any", handler: (event) => ({ method: event.method }) },
                ] },
            },
        })

        const get = await runtime.server.handler(new Request("http://local/any"))
        const post = await runtime.server.handler(new Request("http://local/any", { method: "POST" }))

        expect(await get.json()).toEqual({ method: "GET" })
        expect(await post.json()).toEqual({ method: "POST" })

        await runtime.shutdown()
    })

    it("does not let a typed-method route answer a different method the way ANY would", async () => {
        const runtime = await Axon({
            blueprint: {
                server: { routes: [
                    { method: "GET", path: "/typed", handler: () => ({ ok: true }) },
                    { method: "ANY", path: "/any", handler: () => ({ ok: true }) },
                ] },
            },
        })

        const wrongMethod = await runtime.server.handler(new Request("http://local/typed", { method: "POST" }))
        expect(wrongMethod.status).toBe(404)

        await runtime.shutdown()
    })

    it("mounts a PUT route", async () => {
        const runtime = await Axon({
            blueprint: {
                server: { routes: [
                    { method: "PUT", path: "/put", handler: () => ({ ok: true }) },
                ] },
            },
        })

        const res = await runtime.server.handler(new Request("http://local/put", { method: "PUT" }))
        expect(res.status).toBe(200)

        await runtime.shutdown()
    })

    it("mounts a DELETE route", async () => {
        const runtime = await Axon({
            blueprint: {
                server: { routes: [
                    { method: "DELETE", path: "/thing", handler: () => ({ ok: true }) },
                ] },
            },
        })

        const res = await runtime.server.handler(new Request("http://local/thing", { method: "DELETE" }))
        expect(res.status).toBe(200)

        await runtime.shutdown()
    })
})
