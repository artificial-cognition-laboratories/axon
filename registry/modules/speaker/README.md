# @axon/speaker

A hardware-only audio output body for Axon agents.

The module listens for `cognet:output:audio`, resolves an output device, and
renders supported PCM audio. It does not synthesize speech or interpret the
meaning of an output. TTS, output policy, interruption, queueing, and
conversation state remain in the cognet.

## Configuration

Install the module in an agent:

```ts
export default defineAgent({
    modules: ["@axon/speaker"],
})
```

The optional `device` setting accepts:

- `"auto"` (default): use the operating-system default output;
- `"default"`: explicitly use the operating-system default;
- a platform-specific device identifier or case-insensitive device name.

The selected device is logged at startup. An unavailable device is reported
and the agent continues without audio.

## Audio contract

The initial supported envelope is:

```ts
{
    channel?: string
    ref: {
        uri: "data:audio/pcm;base64,..."
        mime: "audio/pcm;rate=16000;bits=16;ch=1"
        bytes?: number
    }
}
```

Supported PCM is signed, little-endian, 16-bit, mono or stereo. The sample
rate is read from `mime`; it is not assumed by the module.

Malformed references, unsupported formats, and byte-count mismatches are
rejected with a warning. No audio data is persisted by the module.

## Backends

- Linux: `aplay` when available, with `ffplay` as fallback;
- macOS and Windows: `ffplay` when available.

The module does not install system audio tools. The host must provide a
supported playback backend.

## Lifecycle

Playback processes are stopped during shutdown and hot reload. Backend stderr
is drained so diagnostic output cannot deadlock playback.
