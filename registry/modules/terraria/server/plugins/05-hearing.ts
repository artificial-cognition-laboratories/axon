/**
 * Hearing: the stereo the occupied body plays, published as
 * cognet:stimulus:audio.
 *
 * Delivery only, exactly like vision — a pure producer. Whether a cognet
 * listens, and what it makes of a waveform, is entirely the cognet's business.
 * An unattended chunk ages out of the sensory ring.
 *
 * ## Why stereo, and why this is not game data
 *
 * One channel cannot localise anything: a sound is either playing or not, and
 * an organism that cannot tell left from right has no reason to turn around.
 *
 * Terraria's mixer already pans every sound by its position relative to the
 * camera and attenuates it by distance. So the level difference between the
 * two channels IS the direction cue, and the amplitude IS a rough range —
 * carried in the audio signal itself, the same one a person at the speakers
 * hears. **The mixer is the propagation model.** Nothing here reads a sound's
 * position, and nothing invents physics the world does not have: Terraria has
 * no propagation delay, so there is no interaural TIME difference to be had,
 * and faking one would mean synthesising it from a source position nobody is
 * allowed to know.
 *
 * Capture belongs to the BODY, like the frames: the lab gives each body a null
 * sink — virtual speakers next to its virtual screen — and records its
 * monitor. This reads the folder of the body this agent leased.
 *
 * The reason to have this at all: hearing is the only sense that reports what
 * is OFF-SCREEN. Vision gives a 320×180 window; this gives the rest.
 */
import { readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import type { AxonHandle } from "@arcforge/types"
import { bridge } from "../../src/bridge"

const HEARING_CHANNEL = "/hearing"
/** Chunks are 100ms; polling twice that keeps latency low without spinning. */
const POLL_MS = 50
/**
 * Chunks published per poll, at most.
 *
 * A backlog means the agent fell behind, and an organism does not owe the past
 * an answer — the newest few are published and the rest are dropped, the same
 * rule the retina uses for frames.
 */
const MAX_BURST = 4

const HEARING = Symbol.for("axon.terraria.hearing")
const globalHearing = globalThis as typeof globalThis & { [HEARING]?: { stopped: boolean } }

/**
 * Publish settled chunks each poll, deleting what was read and everything
 * older. The newest file is still being written by ffmpeg, so it is left for
 * the next pass rather than read torn — the same contract the frames use, and
 * the reason neither capture needs a protocol.
 */
async function publishLoop(axon: AxonHandle, state: { stopped: boolean }): Promise<void> {
  while (!state.stopped) {
    await Bun.sleep(POLL_MS)

    const embodiment = bridge().embodiment()
    if (!embodiment) continue
    const dir = embodiment.audio

    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (cause) {
      // The lab creates this folder before the body is ready, so its absence
      // means the body is gone — said, not skipped.
      console.error(`[terraria:hearing] cannot read ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`)
      await Bun.sleep(1_000)
      continue
    }

    const numbered = entries.filter(name => /^chunk_\d+\.wav$/.test(name)).sort()
    const settled = numbered.slice(0, -1)
    if (settled.length === 0) continue

    const publish = settled.slice(-MAX_BURST)
    const stale = settled.slice(0, -MAX_BURST)
    await Promise.all(stale.map(name => rm(join(dir, name), { force: true })))

    for (const name of publish) {
      const path = join(dir, name)
      // A zero-length chunk is ffmpeg having just opened the next segment. It
      // is not silence, and committing it as silence would put a lie in the
      // ring.
      const size = await stat(path).then(info => info.size).catch(() => 0)
      if (size <= WAV_HEADER_BYTES) {
        await rm(path, { force: true })
        continue
      }

      const bytes = await Bun.file(path).arrayBuffer()
      await rm(path, { force: true })

      const base64 = Buffer.from(bytes).toString("base64")
      void axon.stim("cognet:stimulus:audio", {
        channel: HEARING_CHANNEL,
        ref: { uri: `data:audio/wav;base64,${base64}`, mime: "audio/wav", bytes: bytes.byteLength },
        // From the bytes, not from the requested segment length: ffmpeg's
        // segments are not exactly equal, and a duration that disagrees with
        // the samples would misplace every onset inside it.
        durationMs: Math.round(((bytes.byteLength - WAV_HEADER_BYTES) / (RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000),
      }).catch(cause => console.error("[terraria:hearing] could not commit chunk:", cause))
    }
  }
}

/** A canonical PCM wav header. Anything this size or smaller carries no samples. */
const WAV_HEADER_BYTES = 44
/** What the lab's capture writes. Stated here so a duration can be computed from a byte count. */
const RATE = 22_050
const CHANNELS = 2
const BYTES_PER_SAMPLE = 2

export default defineAxonPlugin(axon => {
  if (globalHearing[HEARING]) return
  const state = { stopped: false }
  globalHearing[HEARING] = state

  void publishLoop(axon, state)

  axon.hooks.hook("shutdown:before", () => {
    state.stopped = true
    delete globalHearing[HEARING]
  })
})
