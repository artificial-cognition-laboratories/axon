import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

type HydrateOpts = {
    /** Where the agent source must end up — what Axon() scans. */
    agentRoot: string
    /**
     * GCS object holding the source tarball, as `gs://bucket/path` or
     * `bucket/path`. Required only when source isn't already on disk (prod).
     * Injected by the deploy env as AXON_SOURCE.
     */
    source?: string
}

/**
 * Hydrate — put the agent's source at `agentRoot` before the runtime boots.
 *
 * Self-configuring by context, one code path for both deploy environments:
 *
 *   • Staging (ProcessPool): the pool extracts the tarball to a scratch dir and
 *     points AGENT_ROOT at it. Source is already present → hydrate is a no-op.
 *
 *   • Production (Cloud Run): AGENT_ROOT is empty local disk. Hydrate pulls the
 *     source tarball from GCS and extracts it into AGENT_ROOT.
 *
 * The discriminator is simply "is there an axon.config.ts at agentRoot already".
 * No env flag, no "am I in the cloud" branch — the presence of source IS the
 * signal. Sessions are NOT hydrated: a deployed agent boots with an empty
 * session dir and the cognet builds fresh working state (platform makes no
 * assumptions about cognet state; persistence across boots is userland).
 */
export async function Hydrate(opts: HydrateOpts): Promise<{ status: "present" | "fetched" }> {
    if (existsSync(join(opts.agentRoot, "axon.config.ts"))) {
        return { status: "present" }
    }

    if (!opts.source) {
        throw new Error(
            `[hydrate] no source at ${opts.agentRoot} and no AXON_SOURCE to fetch from — cannot boot an agent with no code`,
        )
    }

    await mkdir(opts.agentRoot, { recursive: true })
    await fetchAndExtract(opts.source, opts.agentRoot)

    if (!existsSync(join(opts.agentRoot, "axon.config.ts"))) {
        throw new Error(`[hydrate] fetched source from ${opts.source} but no axon.config.ts landed at ${opts.agentRoot}`)
    }

    return { status: "fetched" }
}

/**
 * Download a GCS object and extract it into `dest`. Uses the GCS JSON API with
 * an access token from the Cloud Run metadata server — the agent's own service
 * account (granted read on its bucket at provision time) authenticates the
 * pull. No gcsfuse, no persistent mount: a one-shot object read at boot.
 */
async function fetchAndExtract(source: string, dest: string): Promise<void> {
    const { bucket, object } = parseGcsUri(source)
    const token = await metadataAccessToken()

    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) {
        throw new Error(`[hydrate] GCS download failed for ${source}: ${res.status} ${await res.text().catch(() => "")}`)
    }

    const tarPath = join(dest, "__source.tar.gz")
    await Bun.write(tarPath, await res.arrayBuffer())

    const extract = Bun.spawn(["tar", "-xzf", tarPath, "-C", dest, "--strip-components=0"], { stdout: "ignore", stderr: "pipe" })
    const code = await extract.exited
    if (code !== 0) {
        const stderr = await new Response(extract.stderr).text()
        throw new Error(`[hydrate] tar extract failed (exit ${code}): ${stderr}`)
    }
}

/** Split `gs://bucket/path` or `bucket/path` into bucket + object. */
function parseGcsUri(uri: string): { bucket: string; object: string } {
    const cleaned = uri.replace(/^gs:\/\//, "")
    const slash = cleaned.indexOf("/")
    if (slash === -1) throw new Error(`[hydrate] invalid GCS source "${uri}" — expected gs://bucket/path`)
    return { bucket: cleaned.slice(0, slash), object: cleaned.slice(slash + 1) }
}

/**
 * Fetch an OAuth access token from the Cloud Run metadata server — the ambient
 * identity of the container's service account. Only reachable inside GCP; fails
 * loudly elsewhere (a prod-only path, never exercised in staging where source
 * is already present).
 */
async function metadataAccessToken(): Promise<string> {
    const res = await fetch(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        { headers: { "metadata-flavor": "Google" } },
    ).catch((cause: unknown) => {
        throw new Error(`[hydrate] metadata server unreachable — not running in GCP? ${cause instanceof Error ? cause.message : String(cause)}`)
    })
    if (!res.ok) throw new Error(`[hydrate] metadata token request failed: ${res.status}`)
    return ((await res.json()) as { access_token: string }).access_token
}
