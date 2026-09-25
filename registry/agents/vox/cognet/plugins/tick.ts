import { state } from "../src/state"

const HZ = 30

export default definePlugin(({ hooks }) => {
    let clock: ReturnType<typeof setInterval> | null = null

    hooks.on("boot", () => {
        clock = setInterval(() => void kernel.wake(), 1000 / HZ)
    })

    hooks.on("shutdown", () => {
        if (clock) clearInterval(clock)
        clock = null
        state.reset()
    })
})
