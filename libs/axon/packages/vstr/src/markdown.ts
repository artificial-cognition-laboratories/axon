import TurndownService from "turndown"

const service = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "_",
    strongDelimiter: "**",
    linkStyle: "inlined",
})

// <section> → horizontal rule separator — useful for visually separating prompt sections
service.addRule("section", {
    filter: "section",
    replacement(content) {
        return `\n\n---\n\n${content.trim()}\n\n---\n`
    },
})

// <pre data-lang="ts"> → fenced code block with language tag
// Plain <pre> → fenced block without language
service.addRule("pre", {
    filter: "pre",
    replacement(content, node) {
        // structural cast — avoids requiring the DOM lib in server-side consumers
        const el = node as { getAttribute(name: string): string | null; textContent: string | null }
        const lang = el.getAttribute("data-lang") ?? ""
        const code = el.textContent ?? content
        return `\n\`\`\`${lang}\n${code.trim()}\n\`\`\`\n`
    },
})

export function htmlToMarkdown(html: string): string {
    return service.turndown(html).replace(/\n{3,}/g, "\n\n").trim()
}
