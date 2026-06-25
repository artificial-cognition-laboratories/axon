import { spawn } from "node:child_process"
import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    StreamType,
    VoiceConnectionStatus,
    entersState,
    type VoiceConnection,
    type AudioPlayer,
} from "@discordjs/voice"
import { type Guild, type GuildMember } from "discord.js"
import { getClient } from "./client"

// videoUrl is the canonical YouTube watch URL (not a signed CDN URL).
// yt-dlp re-resolves the signed stream URL at playback time internally.
type QueueEntry = { title: string; videoUrl: string; requestedBy: string }
type PlayerState = {
    connection: VoiceConnection
    player: AudioPlayer
    queue: QueueEntry[]
    current: QueueEntry | null
    guildId: string
}

const players = new Map<string, PlayerState>()

async function resolve(query: string): Promise<{ title: string; videoUrl: string }> {
    // Fetch title + canonical watch URL in one yt-dlp call.
    // We store the watch URL, not the signed CDN URL — yt-dlp re-resolves at stream time.
    const target = query.startsWith("http") ? query : `ytsearch1:${query}`
    return new Promise((resolve, reject) => {
        const proc = spawn("yt-dlp", ["--get-title", "--get-id", "--no-playlist", target])
        let out = ""
        proc.stdout.on("data", (d: Buffer) => { out += d.toString() })
        proc.stderr.on("data", () => {})
        proc.on("close", code => {
            if (code !== 0) return reject(new Error(`yt-dlp exited ${code} for: ${query}`))
            const lines = out.trim().split("\n").filter(Boolean)
            if (lines.length < 2) return reject(new Error(`yt-dlp returned unexpected output for: ${query}`))
            resolve({ title: lines[0], videoUrl: `https://www.youtube.com/watch?v=${lines[1]}` })
        })
    })
}

function createStream(videoUrl: string, title: string) {
    // yt-dlp pipes audio directly into ffmpeg — handles signed URL resolution internally.
    const ytdlp = spawn("yt-dlp", [
        "--no-playlist",
        "-f", "bestaudio",
        "-o", "-",
        "--quiet",
        videoUrl,
    ], { stdio: ["ignore", "pipe", "ignore"] })

    const ffmpeg = spawn("ffmpeg", [
        "-i", "pipe:0",
        "-vn",
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] })

    ytdlp.stdout!.pipe(ffmpeg.stdin!)

    ffmpeg.stderr!.on("data", (d: Buffer) => {
        const line = d.toString()
        if (line.includes("Error") || line.includes("error")) {
            console.error(`[discord/music] ffmpeg error for "${title}":`, line.trim())
        }
    })
    ffmpeg.on("close", code => {
        if (code !== 0) console.error(`[discord/music] ffmpeg exited ${code} for "${title}"`)
    })

    return ffmpeg.stdout!
}

function createYtdlpStream(url: string, title: string) {
    // Decode to raw PCM s16le — @discordjs/voice re-encodes to opus internally.
    const ffmpeg = spawn("ffmpeg", [
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-i", url,
        "-vn",
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] })
    ffmpeg.stderr!.on("data", (d: Buffer) => {
        const line = d.toString()
        if (line.includes("Error") || line.includes("error")) {
            console.error(`[discord/music] ffmpeg error for "${title}":`, line.trim())
        }
    })
    ffmpeg.on("close", code => {
        if (code !== 0) console.error(`[discord/music] ffmpeg exited ${code} for "${title}"`)
    })
    return ffmpeg.stdout!
}

async function playNext(state: PlayerState): Promise<void> {
    const next = state.queue.shift()
    if (!next) { state.current = null; return }
    state.current = next
    try {
        const stream = createStream(next.videoUrl, next.title)
        const resource = createAudioResource(stream, { inputType: StreamType.Raw })
        state.player.play(resource)
    } catch (err) {
        console.error(`[discord/music] Failed to stream "${next.title}":`, err)
        state.current = null
        if (state.queue.length > 0) await playNext(state)
    }
}

/**
 * Play a song in the voice channel the user is currently in.
 * Accepts a YouTube URL or a plain search query (e.g. "never gonna give you up").
 * If a song is already playing, the track is added to the queue.
 * @param query - YouTube URL or search terms
 * @param userId - Discord user ID — must be in a voice channel
 * @param guildId - Discord server (guild) ID
 */
export async function play(query: string, userId: string, guildId: string): Promise<string> {
    const client = await getClient()
    const guild = client.guilds.cache.get(guildId) as Guild | undefined
    if (!guild) throw new Error("Guild not found — make sure the bot is in the server.")

    const member = guild.members.cache.get(userId) as GuildMember | undefined
    const voiceChannel = member?.voice.channel
    if (!voiceChannel) return "You need to be in a voice channel first."
    if (!voiceChannel.isVoiceBased()) return "That channel doesn't support audio."

    const { title, videoUrl } = await resolve(query)
    const entry: QueueEntry = { title, videoUrl, requestedBy: userId }

    let state = players.get(guildId)
    if (!state) {
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId,
            adapterCreator: guild.voiceAdapterCreator,
        })
        await entersState(connection, VoiceConnectionStatus.Ready, 10_000)
        const player = createAudioPlayer()
        connection.subscribe(player)
        state = { connection, player, queue: [], current: null, guildId }
        player.on(AudioPlayerStatus.Idle, () => { playNext(state!).catch(err => console.error("[discord/music] playNext error:", err)) })
        player.on("error", err => console.error("[discord/music] AudioPlayer error:", err.message, "resource:", (err as any).resource?.metadata))
        players.set(guildId, state)
    }

    if (state.current) {
        state.queue.push(entry)
        return `Queued: **${title}** (position ${state.queue.length})`
    }
    state.queue.push(entry)
    await playNext(state)
    return `Now playing: **${title}**`
}

/**
 * Skip the current song and play the next in queue.
 * @param guildId - Discord server (guild) ID
 */
export async function skip(guildId: string): Promise<string> {
    const state = players.get(guildId)
    if (!state?.current) return "Nothing is playing."
    const skipped = state.current.title
    state.player.stop()
    return `Skipped **${skipped}**.`
}

/**
 * Stop playback, clear the queue, and leave the voice channel.
 * @param guildId - Discord server (guild) ID
 */
export async function stop(guildId: string): Promise<string> {
    const state = players.get(guildId)
    if (!state) return "Nothing is playing."
    state.queue = []
    state.player.stop()
    state.connection.destroy()
    players.delete(guildId)
    return "Stopped and left the voice channel."
}

/**
 * Pause the current song.
 * @param guildId - Discord server (guild) ID
 */
export async function pause(guildId: string): Promise<string> {
    const state = players.get(guildId)
    if (!state?.current) return "Nothing is playing."
    state.player.pause()
    return `Paused **${state.current.title}**.`
}

/**
 * Resume a paused song.
 * @param guildId - Discord server (guild) ID
 */
export async function resume(guildId: string): Promise<string> {
    const state = players.get(guildId)
    if (!state?.current) return "Nothing is paused."
    state.player.unpause()
    return `Resumed **${state.current.title}**.`
}

/**
 * Show the currently playing track and upcoming queue.
 * @param guildId - Discord server (guild) ID
 */
export async function queue(guildId: string): Promise<{ current: string | null; upcoming: string[] }> {
    const state = players.get(guildId)
    return {
        current: state?.current?.title ?? null,
        upcoming: state?.queue.map(e => e.title) ?? [],
    }
}
