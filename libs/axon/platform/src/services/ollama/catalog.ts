import type { CatalogModel } from "./types"

/**
 * The models Axon offers for local inference.
 *
 * Curated deliberately, because **Ollama has no search API**. There is no
 * `/api/search`, the registry's `/v2/.../tags/list` catalog endpoints answer
 * 404, and ollama.com serves HTML only. The alternatives were scraping a web
 * page — a silent breakage the first time the markup moves — or offering
 * nothing.
 *
 * So this is the shelf, and `Registry.resolve()` is the counter: any name a
 * user types is verified against the live registry and pulled, listed here or
 * not. A palette gets a real list; power users are not fenced in.
 *
 * Sizes are absent on purpose. What a variant IS belongs here; how many bytes
 * that currently amounts to belongs to the registry, which is asked at display
 * time. Recording a size here would be a number that silently goes stale.
 */
export const CATALOG: CatalogModel[] = [
    {
        name: "gemma3:1b",
        model: "gemma3",
        tag: "1b",
        description: "Google's smallest Gemma 3 — fast enough for a laptop CPU, capable enough for simple tasks.",
        parameters: "1B",
        capabilities: ["chat"],
    },
    {
        name: "gemma3:4b",
        model: "gemma3",
        tag: "4b",
        description: "Gemma 3 with vision. The best general default on consumer hardware.",
        parameters: "4B",
        capabilities: ["chat", "vision"],
    },
    {
        name: "gemma3:12b",
        model: "gemma3",
        tag: "12b",
        description: "Gemma 3 at a size that rewards a real GPU — noticeably stronger reasoning.",
        parameters: "12B",
        capabilities: ["chat", "vision"],
    },
    {
        name: "qwen3:4b",
        model: "qwen3",
        tag: "4b",
        description: "Qwen 3 with tool calling and thinking — the smallest model here that can drive an agent.",
        parameters: "4B",
        capabilities: ["chat", "tools", "thinking"],
    },
    {
        name: "qwen3:8b",
        model: "qwen3",
        tag: "8b",
        description: "Qwen 3 at 8B. Strong tool use for its size; a good agent default with a GPU.",
        parameters: "8B",
        capabilities: ["chat", "tools", "thinking"],
    },
    {
        name: "qwen3:14b",
        model: "qwen3",
        tag: "14b",
        description: "Qwen 3 at 14B — the most capable local agent model most machines can hold.",
        parameters: "14B",
        capabilities: ["chat", "tools", "thinking"],
    },
    {
        name: "qwen2.5-coder:7b",
        model: "qwen2.5-coder",
        tag: "7b",
        description: "Code-specialised Qwen 2.5. Fill-in-the-middle and repository-scale context.",
        parameters: "7B",
        capabilities: ["chat", "tools"],
    },
    {
        name: "llama3.2:3b",
        model: "llama3.2",
        tag: "3b",
        description: "Meta's compact Llama 3.2 — broad general knowledge at a small footprint.",
        parameters: "3B",
        capabilities: ["chat", "tools"],
    },
    {
        name: "mistral:7b",
        model: "mistral",
        tag: "7b",
        description: "Mistral 7B. A dependable general-purpose model with a permissive licence.",
        parameters: "7B",
        capabilities: ["chat", "tools"],
    },
    {
        name: "phi4:14b",
        model: "phi4",
        tag: "14b",
        description: "Microsoft's Phi-4 — punches well above its parameter count on reasoning.",
        parameters: "14B",
        capabilities: ["chat"],
    },
    {
        name: "deepseek-r1:7b",
        model: "deepseek-r1",
        tag: "7b",
        description: "Reasoning-first model that shows its working before answering.",
        parameters: "7B",
        capabilities: ["chat", "thinking"],
    },
    {
        name: "nomic-embed-text:latest",
        model: "nomic-embed-text",
        tag: "latest",
        description: "Embeddings only — for retrieval and memory, not conversation.",
        parameters: "137M",
        capabilities: ["embedding"],
    },
]

/** Every distinct model family on the shelf, in catalog order. */
export function families(): string[] {
    return [...new Set(CATALOG.map(entry => entry.model))]
}
