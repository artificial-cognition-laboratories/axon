/**
 * File-type resolution — the single owner of "what does this filename mean".
 *
 * Two questions, one table: which vscode-icons glyph a row shows, and which
 * language the code viewer highlights it as. Both were previously answered by
 * three separate copies (two tree components and the tar parser) which had
 * already drifted apart — a file could show a JSON icon and highlight as text.
 *
 * Every icon string here is verified to exist in @iconify-json/vscode-icons.
 * A name absent from that set renders as a blank box rather than falling back,
 * so entries are checked against the installed icons.json, never guessed.
 *
 * SHARED, because the website and the Fleet extension both need to answer it
 * and three drifted copies is exactly how this file came to exist. The two
 * surfaces render different glyph SETS — a VS Code webview cannot load
 * vscode-icons — so a consumer that needs codicons maps from `fileLang` and
 * the filename rather than from `fileIcon`.
 */

const ICON = "vscode-icons:"

/**
 * Exact filenames. Checked before extensions, because `bun.lock` is a Bun file
 * and not a generic lockfile, and `tsconfig.json` is not a plain JSON file.
 */
const BY_NAME: Record<string, string> = {
    "package.json": "file-type-npm",
    "package-lock.json": "file-type-npm",
    "bun.lock": "file-type-bun",
    "bun.lockb": "file-type-bun",
    "bunfig.toml": "file-type-bunfig",
    "yarn.lock": "file-type-yarn",
    "pnpm-lock.yaml": "file-type-pnpm",
    "tsconfig.json": "file-type-tsconfig",
    "dockerfile": "file-type-docker",
    "docker-compose.yml": "file-type-docker",
    "docker-compose.yaml": "file-type-docker",
    ".gitignore": "file-type-git",
    ".gitattributes": "file-type-git",
    ".editorconfig": "file-type-editorconfig",
    "license": "file-type-license",
    "license.md": "file-type-license",
    "nuxt.config.ts": "file-type-nuxt",
    policy: "file-type-config",
}

/**
 * Extension → icon. Longest suffix wins, so `.d.ts` beats `.ts` regardless of
 * declaration order.
 */
const BY_EXT: Record<string, string> = {
    ".d.ts": "file-type-typescript-official",
    ".ts": "file-type-typescript",
    ".tsx": "file-type-reactjs",
    ".js": "file-type-js",
    ".mjs": "file-type-js",
    ".cjs": "file-type-js",
    ".jsx": "file-type-reactjs",
    ".vue": "file-type-vue",
    ".json": "file-type-json",
    ".jsonc": "file-type-json",
    ".md": "file-type-markdown",
    ".mdx": "file-type-markdown",
    ".html": "file-type-html",
    ".htm": "file-type-html",
    ".toml": "file-type-toml",
    ".lock": "file-type-config",
    ".css": "file-type-css",
    ".scss": "file-type-scss",
    ".sass": "file-type-scss",
    ".yaml": "file-type-yaml",
    ".yml": "file-type-yaml",
    ".xml": "file-type-xml",
    ".ini": "file-type-ini",
    ".conf": "file-type-config",
    ".config": "file-type-config",
    ".policy": "file-type-config",
    ".sh": "file-type-shell",
    ".bash": "file-type-shell",
    ".zsh": "file-type-shell",
    ".py": "file-type-python",
    ".rs": "file-type-rust",
    ".go": "file-type-go",
    ".rb": "file-type-ruby",
    ".php": "file-type-php",
    ".java": "file-type-java",
    ".c": "file-type-c",
    ".h": "file-type-c",
    ".cpp": "file-type-cpp",
    ".swift": "file-type-swift",
    ".kt": "file-type-kotlin",
    ".lua": "file-type-lua",
    ".zig": "file-type-zig",
    ".sql": "file-type-sql",
    ".graphql": "file-type-graphql",
    ".gql": "file-type-graphql",
    ".svg": "file-type-svg",
    ".png": "file-type-image",
    ".jpg": "file-type-image",
    ".jpeg": "file-type-image",
    ".gif": "file-type-image",
    ".webp": "file-type-image",
    ".ico": "file-type-image",
    ".woff": "file-type-font",
    ".woff2": "file-type-font",
    ".ttf": "file-type-font",
    ".otf": "file-type-font",
    ".mp3": "file-type-audio",
    ".wav": "file-type-audio",
    ".mp4": "file-type-video",
    ".webm": "file-type-video",
    ".zip": "file-type-zip",
    ".tar": "file-type-zip",
    ".gz": "file-type-zip",
    ".tgz": "file-type-zip",
    ".log": "file-type-log",
    ".txt": "file-type-text",
    ".wasm": "file-type-binary",
}

/** Extension → the language name the code viewer highlights with. */
const BY_LANG: Record<string, string> = {
    ".d.ts": "typescript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".vue": "vue",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascript",
    ".json": "json",
    ".jsonc": "json",
    ".md": "markdown",
    ".mdx": "markdown",
    ".html": "html",
    ".htm": "html",
    ".toml": "toml",
    ".css": "css",
    ".scss": "scss",
    ".sass": "scss",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".xml": "xml",
    ".ini": "ini",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".rb": "ruby",
    ".php": "php",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".swift": "swift",
    ".kt": "kotlin",
    ".lua": "lua",
    ".sql": "sql",
    ".graphql": "graphql",
    ".gql": "graphql",
    ".svg": "xml",
}

/** Longest matching suffix in `table`, or null. */
function suffixMatch(name: string, table: Record<string, string>): string | null {
    let best: string | null = null
    let bestLength = 0
    for (const ext of Object.keys(table)) {
        if (name.endsWith(ext) && ext.length > bestLength) {
            best = table[ext]!
            bestLength = ext.length
        }
    }
    return best
}

/** Full `vscode-icons:` name for a file row. Always resolves to a real icon. */
export function fileIcon(fileName: string): string {
    const name = fileName.toLowerCase()

    // `.env`, `.env.local`, `.env.production` — a family, not a suffix.
    if (name === ".env" || name.startsWith(".env.")) return `${ICON}file-type-dotenv`

    const exact = BY_NAME[name]
    if (exact) return `${ICON}${exact}`

    // `bun.lock` matched above; anything else named *.lock is a generic one.
    // pnpm/yaml lockfiles must not fall through to the plain .yaml icon.
    if (name.endsWith("-lock.yaml") || name.endsWith("-lock.yml")) return `${ICON}file-type-config`

    return `${ICON}${suffixMatch(name, BY_EXT) ?? "file-type-text"}`
}

/**
 * Folder name → its vscode-icons type. Every entry is verified to have both a
 * base and an `-opened` variant, so a folder always reads as open or closed.
 */
const FOLDER_TYPES: Record<string, string> = {
    node_modules: "node",
    server: "server",
    api: "api",
    scripts: "script",
    src: "src",
    test: "test",
    tests: "test",
    __tests__: "test",
    __mocks__: "mock",
    tools: "tools",
    prompts: "template",
    templates: "template",
    middleware: "middleware",
    plugins: "plugin",
    components: "component",
    composables: "hook",
    hooks: "hook",
    images: "images",
    img: "images",
    public: "public",
    static: "public",
    dist: "dist",
    build: "dist",
    config: "config",
    docs: "docs",
    doc: "docs",
    views: "view",
    pages: "view",
    styles: "css",
    css: "css",
    ".git": "git",
    ".github": "github",
    ".vscode": "vscode",
    types: "typescript",
    packages: "package",
    modules: "module",
}

/** Full `vscode-icons:` name for a folder row, open or closed. */
export function folderIcon(folderName: string, open: boolean): string {
    const type = FOLDER_TYPES[folderName.toLowerCase()]
    const suffix = open ? "-opened" : ""
    return type ? `${ICON}folder-type-${type}${suffix}` : `${ICON}default-folder${suffix}`
}

/** Highlighting language for a file's contents. */
export function fileLang(fileName: string): string {
    const name = fileName.toLowerCase()
    if (name === ".env" || name.startsWith(".env.")) return "shell"
    if (name === "dockerfile") return "docker"
    if (name.endsWith(".lock")) return "text"
    return suffixMatch(name, BY_LANG) ?? "text"
}
