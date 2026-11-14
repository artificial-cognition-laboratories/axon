import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { CognetDefinition, KernelAbi } from "@arcforge/types"
import { bundleCognet } from "../../../src/build/blueprint/cognet/bundle"

/**
 * A Rust system built for real — `cargo`, the generated napi module, the
 * protocol check — reading what it was handed and acting through the kernel.
 * Full tier: a cold build of the crate takes minutes, not seconds.
 */

const ROOT = join(import.meta.dir, ".cognet-rust")

afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true })
})

async function compile(files: Record<string, string>): Promise<CognetDefinition> {
    await mkdir(ROOT, { recursive: true })
    const agent = await mkdtemp(join(ROOT, "agent-"))
    const source = join(agent, "cognet")
    await writeFile(join(agent, "package.json"), JSON.stringify({ name: "rust-test", version: "1.0.0" }))
    // The crate a cognet's Rust is built against comes from the agent's own @arcforge/cognet, as installed.
    await mkdir(join(agent, "node_modules", "@arcforge"), { recursive: true })
    await symlink(join(import.meta.dir, "..", "..", "..", "..", "cognet"), join(agent, "node_modules", "@arcforge", "cognet"))
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(source, path, ".."), { recursive: true })
        await writeFile(join(source, path), content)
    }
    const artifact = await bundleCognet({ sourceDir: source, agentRoot: agent, inline: true })
    const module = await import(`${pathToFileURL(artifact.blueprint.path).href}?v=${artifact.blueprint.hash}`)
    return module.default as CognetDefinition
}

const SCOPE = { modules: [], unavailable: [] }
const PRESENCE = { state: "embodied" }

describe("a Rust system", () => {
    test("reads its stimuli and the body's presence, writes, and acts through the kernel", async () => {
        const definition = await compile({
            "cognet.config.ts": `export default defineCognet({ mode: { kind: "invocation" } })\n`,
            "types/mind/mind.components.ts": "export interface Heard { values: number }\n",
            "mind/drive.system.rs": [
                "use cognet::prelude::*;",
                "use crate::schema::mind::mind_ts_components::Heard;",
                "",
                "#[system(reads = [\"stimuli\"], writes = [\"heard\"])]",
                "fn drive(run: &mut Run) -> Result<(), Fault> {",
                "    let presence = run.kernel.presence()?.ok_or_else(|| Fault::new(\"no presence\"))?;",
                "    let state = presence[\"state\"].as_str().unwrap_or(\"\").to_string();",
                "    let heard = run.stimuli.len() as f64;",
                "    ecs.set(\"self\").put(\"heard\", Heard { values: heard })?;",
                "    run.kernel.output(Output::text(\"/chat\", &format!(\"{state}, heard {heard}\")))?;",
                "    Ok(())",
                "}",
            ].join("\n"),
        })
        const outputs: unknown[] = []
        await definition.load({
            emit: () => {},
            body: () => null,
            presence: () => PRESENCE,
            scope: () => SCOPE,
            engine: Object.assign(() => { throw new Error("no engines here") }, { has: () => false }),
            services: { state: () => ({}) },
            output: async (type: string, data: unknown) => { outputs.push([type, data]) },
        } as unknown as KernelAbi)
        const stimulus = { type: "cognet:stimulus:vector", time: { ms: 1, seq: 1 }, data: { channel: "/imu", values: [0, 0, 9.8] } }
        await definition.wake({ stimuli: [stimulus], signal: new AbortController().signal } as never)
        expect(outputs).toEqual([["cognet:output:text", { channel: "/chat", content: "embodied, heard 1" }]])
        await definition.unload?.()
    }, 600_000)

    test("an async system calls a service — an array there and back — then writes and acts", async () => {
        const definition = await compile({
            "cognet.config.ts": `export default defineCognet({ mode: { kind: "invocation" }, uses: { depth: { interface: "depth-relative@1", optional: true } } })\n`,
            "types/mind/mind.components.ts": "export interface Seen { depth: Float32Array }\n",
            "mind/look.system.rs": [
                "use cognet::prelude::*;",
                "use crate::schema::mind::mind_ts_components::Seen;",
                "",
                "#[derive(serde::Serialize)]",
                "struct Picture { width: u32, height: u32, rgb: Array<f32> }",
                "",
                "#[derive(serde::Deserialize)]",
                "struct Nearness { nearness: Array<f32> }",
                "",
                "#[derive(serde::Serialize)]",
                "struct Estimate { picture: Picture }",
                "",
                "#[system(once, writes = [\"seen\"], uses = [\"depth\"])]",
                "async fn look(run: &mut Run) -> Result<(), Fault> {",
                "    let depth = run.services.get(\"depth\")?;",
                "    if !depth.available() { return Err(Fault::new(\"no depth\")) }",
                "    let picture = Picture { width: 2, height: 1, rgb: Array::new(vec![1.0f32, 2.0]) };",
                "    let found: Nearness = depth.call(\"estimate\", Estimate { picture: picture }).await?;",
                "    run.kernel.output(Output::text(\"/log\", \"looked\"))?;",
                "    ecs.set(\"self\").put(\"seen\", Seen { depth: found.nearness })?;",
                "    Ok(())",
                "}",
            ].join("\n"),
        })
        const outputs: unknown[] = []
        await definition.load({
            emit: () => {},
            body: () => null,
            presence: () => PRESENCE,
            scope: () => SCOPE,
            services: {
                state: () => ({ depth: { available: true, describe: { maxSide: 518 } } }),
                // The picture's pixels arrive as memory, and the answer leaves as memory.
                call: async (_use: string, _method: string, args: { picture: { rgb: Float32Array } }) => ({ width: 2, height: 1, nearness: Float32Array.from(args.picture.rgb, value => value * 10) }),
            },
            output: async (type: string, data: unknown) => { outputs.push([type, data]) },
        } as unknown as KernelAbi)
        await definition.wake({ stimuli: [], signal: new AbortController().signal })
        const world = (globalThis as unknown as { ecs: { query(q: unknown): Array<{ seen: { depth: Float32Array } }> } }).ecs
        const [row] = world.query({ components: ["seen"] })
        expect([...row!.seen.depth]).toEqual([10, 20])
        expect(outputs).toEqual([["cognet:output:text", { channel: "/log", content: "looked" }]])
        await definition.unload?.()
    }, 600_000)
})
