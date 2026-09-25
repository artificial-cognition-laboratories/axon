/**
 * Vision: the frames the occupied body renders, published as
 * cognet:stimulus:visual.
 *
 * This is delivery only — a pure producer, same as the body sense. Whether a
 * cognet's wake mask includes this channel, and what (if anything) it does
 * with a frame, is entirely a cognet decision. An unattended frame simply
 * ages out of the sensory ring buffer; nothing here needs to know or care
 * whether anyone is looking.
 *
 * Capture belongs to the BODY: the lab records each body's virtual display
 * into a folder, whether or not anyone occupies it, and this reads the folder
 * of the body this agent leased. It stays off the AxonT cable on purpose — a
 * client's render output is not internal state the way health or position
 * are, and it does not belong on the same wire as BodySense.
 */
import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { AxonHandle } from "@arcforge/types"
import { bridge } from "../../src/bridge"

const VISION_CHANNEL = "/vision"
const FPS = 24
const POLL_MS = Math.round(1000 / FPS)

const VISION = Symbol.for("axon.terraria.vision")
const globalVision = globalThis as typeof globalThis & { [VISION]?: { stopped: boolean } }

/**
 * Publish the newest settled frame each poll, deleting what it read and
 * everything older. The newest file is still being written, so it is left for
 * the next pass rather than read torn.
 */
async function publishLoop(axon: AxonHandle, state: { stopped: boolean }): Promise<void> {
  while (!state.stopped) {
    await Bun.sleep(POLL_MS)

    const embodiment = bridge().embodiment()
    if (!embodiment) continue
    const dir = embodiment.frames

    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (cause) {
      // The lab creates this folder before the body is ready, so its absence
      // means the body is gone — said, not skipped.
      console.error(`[terraria:vision] cannot read ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`)
      await Bun.sleep(1_000)
      continue
    }
    const numbered = entries.filter(name => /^frame_\d+\.jpg$/.test(name)).sort()
    const settled = numbered.slice(0, -1)
    if (settled.length === 0) continue

    const freshest = settled[settled.length - 1]!
    const bytes = await Bun.file(join(dir, freshest)).arrayBuffer()
    await Promise.all(settled.map(name => rm(join(dir, name), { force: true })))

    const base64 = Buffer.from(bytes).toString("base64")
    void axon.stim("cognet:stimulus:visual", {
      channel: VISION_CHANNEL,
      ref: { uri: `data:image/jpeg;base64,${base64}`, mime: "image/jpeg", bytes: bytes.byteLength },
      kind: "image",
    }).catch(cause => console.error("[terraria:vision] could not commit frame:", cause))
  }
}

export default defineAxonPlugin(axon => {
  if (globalVision[VISION]) return
  const state = { stopped: false }
  globalVision[VISION] = state

  void publishLoop(axon, state)

  axon.hooks.hook("shutdown:before", () => {
    state.stopped = true
    delete globalVision[VISION]
  })
})
