let count = 0

export default {
    name: "counter",
    exports: {
        increment: () => ++count,
        get: () => count,
    },
}
