import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProcessesT } from "../../processes"

const VERSION = "2.0.0"
const ARCHIVE = `selkies-${VERSION}-x86_64.pkg.tar.zst`
const SHA256 = "39d195ac7acb2924f57cfa564aa97f2ede0d6a5f3c92720c1906142c824a8f74"
const URL = `https://github.com/selkies-project/selkies/releases/download/${VERSION}/${ARCHIVE}`
// TEMP: 2026-10-06 — Selkies 2.0.0 requires Ctrl+Shift+click to lock and does not
// forward Escape when the browser consumes it to release pointer lock.
// Keep this exact-version adaptation until the client exposes both behaviors.
const CLIENT = "selkies-core-BbKps5RD.js"
const POINTER_LOCK = "i&&e.button===0&&e.ctrlKey&&e.shiftKey&&this.shortcutsEnabled"
const CLICK_TO_LOCK = "i&&e.button===0&&e.type===`mousedown`&&e.target===this.element&&!this._isStreamLocked()"
const KEY_EVENT = "_sendKeyEvent(e,t,n){if(e===null)return;let r=e;"
const TRACK_ESCAPE = "_sendKeyEvent(e,t,n){if(e===null)return;n&&t===`Escape`&&(this._studioEscapeAt=performance.now());let r=e;"
const POINTER_RELEASE = "_pointerLock(){this._relCarryX=0,this._relCarryY=0,this._isStreamLocked()?(this.send(`p,1`),this.send(`SET_NATIVE_CURSOR_RENDERING,1`),this.cursorDiv.style.visibility=`hidden`):(this.send(`p,0`),this.send(`SET_NATIVE_CURSOR_RENDERING,0`),this.resetKeyboard(),this.cursorDiv.style.visibility=`visible`)}"
const PAUSE_ON_RELEASE = "_pointerLock(){const studioWasLocked=this._studioWasLocked===true;this._studioWasLocked=this._isStreamLocked();this._relCarryX=0,this._relCarryY=0,this._studioWasLocked?(this.send(`p,1`),this.send(`SET_NATIVE_CURSOR_RENDERING,1`),this.cursorDiv.style.visibility=`hidden`):(this.send(`p,0`),this.send(`SET_NATIVE_CURSOR_RENDERING,0`),this.resetKeyboard(),this.cursorDiv.style.visibility=`visible`),studioWasLocked&&!this._studioWasLocked&&document.visibilityState===`visible`&&setTimeout(()=>{!this._isStreamLocked()&&(this._studioEscapeAt===undefined||performance.now()-this._studioEscapeAt>100)&&this._sendMomentaryKey(A.XK_Escape)},30)}"

export function Streamer(opts: { root: string; processes: ProcessesT; display: string; sink: string; log: string }) {
    const install = join(opts.root, `selkies-${VERSION}`)
    const pythonPath = join(install, "opt", "selkies", "lib", "python3.14", "site-packages")
    const client = join(pythonPath, "selkies", "selkies_web", "assets", CLIENT)

    async function adaptClient(): Promise<void> {
        let source = await readFile(client, "utf-8")
        let changed = false
        const patches = [
            [POINTER_LOCK, CLICK_TO_LOCK],
            [KEY_EVENT, TRACK_ESCAPE],
            [POINTER_RELEASE, PAUSE_ON_RELEASE],
        ] as const
        for (const [before, after] of patches) {
            if (source.includes(after)) continue
            if (source.split(before).length !== 2) throw new Error(`Selkies ${VERSION} Studio input client changed; cannot apply mouse capture patch`)
            source = source.replace(before, after)
            changed = true
        }
        if (changed) await writeFile(client, source)
    }

    async function ensure(): Promise<void> {
        if (existsSync(join(pythonPath, "selkies", "__main__.py"))) {
            await adaptClient()
            return
        }
        if (process.platform !== "linux" || process.arch !== "x64") {
            throw new Error("Minecraft Studio streaming currently requires Linux x86_64")
        }
        if (!Bun.which("python3.14") || !Bun.which("tar")) {
            throw new Error("Minecraft Studio streaming requires Python 3.14 and tar")
        }
        const response = await fetch(URL)
        if (!response.ok) throw new Error(`Could not download Selkies ${VERSION}: HTTP ${response.status}`)
        const bytes = Buffer.from(await response.arrayBuffer())
        const digest = createHash("sha256").update(bytes).digest("hex")
        if (digest !== SHA256) throw new Error(`Selkies ${VERSION} download failed SHA-256 verification`)
        await mkdir(opts.root, { recursive: true })
        const staging = join(opts.root, `selkies-${VERSION}.staging-${process.pid}`)
        const archive = join(staging, ARCHIVE)
        await mkdir(staging, { recursive: true })
        try {
            await writeFile(archive, bytes)
            const unpack = Bun.spawn(["tar", "-xf", archive, "-C", staging], { stdout: "pipe", stderr: "pipe" })
            const [stderr, code] = await Promise.all([new Response(unpack.stderr).text(), unpack.exited])
            if (code !== 0) throw new Error(`Could not unpack Selkies ${VERSION}: ${stderr.trim()}`)
            await rm(archive)
            await rename(staging, install)
        } catch (cause) {
            await rm(staging, { recursive: true, force: true })
            throw cause
        }
        if (!existsSync(join(pythonPath, "selkies", "__main__.py"))) {
            throw new Error(`Selkies ${VERSION} package did not contain its Python module`)
        }
        await adaptClient()
    }

    return {
        pythonPath: pythonPath,
        async resize(width: number, height: number): Promise<void> {
            await ensure()
            const script = "import asyncio, sys; from selkies.display_utils import resize_display; size = asyncio.run(resize_display(sys.argv[1])); print(f'{size[0]}x{size[1]}' if size else 'failed')"
            const child = Bun.spawn(["python3.14", "-c", script, `${width}x${height}`], {
                env: { ...process.env, DISPLAY: opts.display, PYTHONPATH: pythonPath },
                stdout: "pipe", stderr: "pipe",
            })
            const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
            if (code !== 0 || output.trim() !== `${width}x${height}`) {
                throw new Error(`Could not size Studio display to ${width}x${height}: ${errors.trim() || output.trim()}`)
            }
        },
        async start(port: number, masterToken: string): Promise<ReturnType<ProcessesT["spawn"]>> {
            await ensure()
            return opts.processes.spawn({
                label: "minecraft-studio:stream",
                cmd: [
                    "python3.14", "-m", "selkies",
                    "--addr=127.0.0.1", `--port=${port}`,
                    "--enable-https=false", "--enable-basic-auth=false",
                    "--encoder=h264enc", "--framerate=60", "--enable-resize=false",
                    "--enable-metrics-http=true",
                    `--audio-device-name=${opts.sink}.monitor`,
                    "--command-enabled=false", "--file-transfers=none", "--enable-clipboard=false",
                    "--enable-sharing=false", "--printing-enabled=false",
                ],
                env: { DISPLAY: opts.display, PYTHONPATH: pythonPath, SELKIES_MASTER_TOKEN: masterToken },
                stdout: opts.log,
            })
        },
    }
}

export type StreamerT = ReturnType<typeof Streamer>
