import { shutdownAll } from "./src/lsp/router"

export default defineModule({
    name: "lsp",
    description: "Language server integration — hover, definition, references, rename, diagnostics, and code actions across TypeScript, Python, Rust, Go, and C/C++. Requires the relevant language server on PATH; throws a clear error with install instructions if not found.",
    public: true,

    async setup({ axon }) {
        axon.hook("axon:agent:shutdown", () => shutdownAll())
    },
})
