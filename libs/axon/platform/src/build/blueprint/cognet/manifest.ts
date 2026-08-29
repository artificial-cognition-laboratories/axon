import { isAbsolute, join, resolve } from "node:path"
import type { CognetBlueprint } from "@arcforge/types"
import { fsx } from "../../../utils/fs"
import { Frame } from "../../frame"
import type { ScanWarning } from "../types"

type ManifestShape = CognetBlueprint & { path: string; hash: string }

/**
 * readManifest — reads the brain slot the compile step wrote:
 * <agent>/.agent/cognet/manifest.json → blueprint.cognet (path+hash form).
 *
 * A reader, never a builder: bundling belongs to prepare/dev. Missing
 * manifest = warning + absent field — core's normalizer then refuses
 * loudly (NO_COGNET), so an unprepared agent fails at the one seam with
 * one message, not here with a second.
 */
export async function readManifest(root: string): Promise<{ entry: CognetBlueprint | null; warnings: ScanWarning[] }> {
    const manifestPath = Frame({ root: root, kind: "agent" }).file("cognet", "manifest.json")
    const manifest = await fsx.readJson<ManifestShape>(manifestPath)

    if (!manifest) {
        return {
            entry: null,
            warnings: [{ domain: "cognet", error: `no compiled cognet at ${manifestPath} — run \`axon prepare\`` }],
        }
    }

    const artifactPath = isAbsolute(manifest.path) ? manifest.path : resolve(root, manifest.path)
    if (!fsx.exists(artifactPath)) {
        return {
            entry: null,
            warnings: [{ domain: "cognet", error: `cognet manifest points at a missing bundle: ${artifactPath} — run \`axon prepare\`` }],
        }
    }

    return { entry: { ...manifest, path: artifactPath }, warnings: [] }
}
