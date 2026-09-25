import { readFile } from "node:fs/promises"
import { join } from "node:path"

const PAGE = join(import.meta.dir, "../../src/vox/page.html")

export default defineEventHandler(async event => {
    setHeader(event, "content-type", "text/html; charset=utf-8")
    setHeader(event, "cache-control", "no-store")
    return await readFile(PAGE, "utf8")
})
