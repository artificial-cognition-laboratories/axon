/**
 * Declarative language server definitions.
 *
 * Each entry maps a set of file extensions to a language server binary.
 * All servers speak standard LSP over stdio. The binary must be on PATH —
 * if it isn't, tool calls for that language throw a clear error.
 *
 * Adding a language: add an entry here. No other changes needed.
 */

export type ServerDef = {
    /** Display name for error messages. */
    name: string
    /** Binary to spawn. Must be on PATH. */
    binary: string
    /** CLI args passed to the binary. `--stdio` is standard for most servers. */
    args: string[]
    /** File extensions this server handles (lowercase, with dot). */
    extensions: string[]
    /** Install hint shown when the binary is not found. */
    installHint: string
    /** Optional extra params merged into the LSP `initialize` request. */
    initializationOptions?: Record<string, unknown>
}

export const SERVER_DEFS: ServerDef[] = [
    {
        name: "TypeScript",
        binary: "typescript-language-server",
        args: ["--stdio"],
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
        installHint: "npm i -g typescript-language-server typescript",
    },
    {
        name: "Python",
        binary: "pylsp",
        args: [],
        extensions: [".py", ".pyi"],
        installHint: "pip install python-lsp-server",
    },
    {
        name: "Rust",
        binary: "rust-analyzer",
        args: [],
        extensions: [".rs"],
        installHint: "rustup component add rust-analyzer",
    },
    {
        name: "Go",
        binary: "gopls",
        args: [],
        extensions: [".go"],
        installHint: "go install golang.org/x/tools/gopls@latest",
    },
    {
        name: "C/C++",
        binary: "clangd",
        args: [],
        extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp"],
        installHint: "install clangd via your system package manager (apt install clangd / brew install llvm)",
    },
]

/** Find the server definition for a given file path. Returns null if unsupported. */
export function serverForFile(filePath: string): ServerDef | null {
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
    return SERVER_DEFS.find(s => s.extensions.includes(ext)) ?? null
}
