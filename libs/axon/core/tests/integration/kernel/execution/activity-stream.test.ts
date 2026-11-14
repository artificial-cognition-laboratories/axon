import { Axon } from "../../../setup/axon"
import { Mock } from "@arcforge/engines"
import { run } from "@arcforge/engines/mock"

describe("kernel activity stream", () => {
    it("records a process.run activity while its command is still running", async () => {
        const runtime = await Axon({
            blueprint: {
                config: {
                    providers: [Mock({ "/go": [run(`await process.run("sleep 0.1")`), "done"] })],
                    policy: { shell: { allow: ["sleep"] } },
                },
            },
        })

        try {
            const request = runtime.kernel.request({ content: "/go" })
            await new Promise(resolve => setTimeout(resolve, 20))

            const activity = runtime.session.kernelLog.find(event => event.type === "process:activity")
            expect(activity).toMatchObject({
                data: {
                    activity: "proc:exec",
                    phase: "declared",
                    data: { command: "sleep 0.1" },
                },
            })

            await request
        } finally {
            await runtime.shutdown()
        }
    }, 20_000)
})
