export default defineAgent({
    policy: {
        // `fs` is a grant list, not a filter: paths not named here do not
        // exist inside the box, so there is no `deny` to write. The previous
        // form listed `.env` and `**/secrets/**` under a `deny` key the type
        // never had — it parsed as nothing and enforced nothing, while reading
        // as though it did.
        fs: {
            read: ["./src", "./eslint.config.js", "./data"],
            write: ["./data"],
        },
        shell: {
            allow: ["eslint", "bun", "npx"],
            args: { bun: { allow: ["lint", "run lint"] } },
            raw: false,
        },
        // No `net` block at all: the box gets no network stack.
    },
})
