# @arcforge/body

The body contract at work. The contract itself — what a body says about itself, and the messages a body and a mind
exchange — is types, in `@arcforge/types` (`body` namespace, `types/src/body/body.ts`). This package is what acts on
it:

| | |
|---|---|
| `manifest.check(value)` | a body's manifest, checked once at the boundary; refused naming the first thing wrong by its path |
| `wire.channels(manifest)` | a manifest's channels, indexed for checking messages |
| `wire.fromBody(text, channels)` · `wire.toBody(text, channels)` | one message, checked against the contract and against the body's manifest |
| `urdf.read(xml, { hold })` · `urdf.write(skeleton)` | a body's skeleton to and from URDF, with a `<ros2_control>` block as its driven and read joints |
| `examples` | real bodies as manifests — Minecraft, Terraria, a container's shell, a TurtleBot, a quadruped |

URDF carries the skeleton — links, joints, mass, inertia, shapes, driven joints — both ways. It has no senses but
joint states, no skills, and no notion of a camera's optical axes (a link named `…optical_frame` is read as one). What
it holds that the contract cannot yet — mimic joints — is refused, not dropped.
