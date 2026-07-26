import { shutdownAll } from "./src/lsp/router"

export default defineModule({
    async setup({ axon }) {
        axon.onDispose(() => shutdownAll())
    },
})
