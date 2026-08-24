export default defineAgent({
    policy: {
        fs: {
            read: ["./**/*.{ts,js,mjs,cjs,mts,cts,vue,tsx,jsx}", "./eslint.config.*", "./data/**"],
            write: ["./data/**", "./eslint.config.*", "./**/*.{ts,js,mjs,cjs,mts,cts,vue,tsx,jsx}"],
            deny: [".env", ".env.*", "**/secrets/**", "**/node_modules/**"],
        },
        proc: {
            allow: ["eslint *", "bun lint", "bun run lint", "npx eslint *"],
            deny: ["git push*", "rm -rf*"],
        },
        network: {
            allow: [],
        },
    },
})
