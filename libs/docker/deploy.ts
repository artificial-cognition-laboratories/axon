#!/usr/bin/env bun
/**
 * axon-base image build + push script.
 *
 * Usage:
 *   bun run libs/axon/packages/docker/deploy.ts               # build + push current version
 *   bun run libs/axon/packages/docker/deploy.ts --bump patch   # bump patch, build, push
 *   bun run libs/axon/packages/docker/deploy.ts --bump minor   # bump minor, build, push
 *   bun run libs/axon/packages/docker/deploy.ts --bump major   # bump major, build, push
 *   bun run libs/axon/packages/docker/deploy.ts --local        # build local tag only, no push
 *
 * Must be run from the repo root (build context is the monorepo root).
 */

import { join } from "node:path"
import { readFileSync, writeFileSync } from "node:fs"

const REGISTRY = "europe-west1-docker.pkg.dev/axon-487515/axon"
const IMAGE_NAME = "axon-base"
const DOCKER_DIR = "libs/axon/packages/docker"
const VERSION_FILE = join(DOCKER_DIR, "VERSION")
const DOCKERFILE = join(DOCKER_DIR, "Dockerfile")
// AXON_BASE_VERSION lives with the provisioner that stamps it onto each
// deployed service's image tag.
const CLOUDRUN_UTILS = "apps/backend/platform/gcloud/deployments.ts"

// ── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const bumpArg = args[args.indexOf("--bump") + 1] as "patch" | "minor" | "major" | undefined
const isLocal = args.includes("--local")
const dryRun = args.includes("--dry-run")

// ── Version ──────────────────────────────────────────────────────────────────

function readVersion(): string {
    return readFileSync(VERSION_FILE, "utf-8").trim()
}

function bumpVersion(version: string, part: "patch" | "minor" | "major"): string {
    const [maj, min, pat] = version.split(".").map(Number)
    switch (part) {
        case "major":
            return `${maj + 1}.0.0`
        case "minor":
            return `${maj}.${min + 1}.0`
        case "patch":
            return `${maj}.${min}.${pat + 1}`
    }
}

let version = readVersion()

if (bumpArg) {
    if (!["patch", "minor", "major"].includes(bumpArg)) {
        console.error(`[deploy] invalid --bump value: ${bumpArg}. Use patch | minor | major`)
        process.exit(1)
    }
    const next = bumpVersion(version, bumpArg)
    console.log(`[deploy] bumping version ${version} → ${next}`)
    if (!dryRun) writeFileSync(VERSION_FILE, next + "\n")
    version = next
}

console.log(`[deploy] axon-base v${version}`)

// ── Sync version into backend ─────────────────────────────────────────────────
// Keep AXON_BASE_VERSION in cloudrun.ts in sync with the image we're deploying.
// Skip for --local builds (no push, no backend update needed).
if (!isLocal) {
    const src = readFileSync(CLOUDRUN_UTILS, "utf-8")
    const updated = src.replace(
        /export const AXON_BASE_VERSION = ["'][^"']+["']/,
        `export const AXON_BASE_VERSION = "${version}"`
    )
    if (updated === src) {
        console.warn(
            `[deploy] warning: could not find AXON_BASE_VERSION in ${CLOUDRUN_UTILS} — update manually`
        )
    } else if (!dryRun) {
        writeFileSync(CLOUDRUN_UTILS, updated)
        console.log(`[deploy] updated AXON_BASE_VERSION → ${version} in ${CLOUDRUN_UTILS}`)
    } else {
        console.log(
            `[deploy] dry-run: would update AXON_BASE_VERSION → ${version} in ${CLOUDRUN_UTILS}`
        )
    }
}

// ── Tags ─────────────────────────────────────────────────────────────────────

const versionedTag = isLocal ? `${IMAGE_NAME}:${version}` : `${REGISTRY}/${IMAGE_NAME}:${version}`

const latestTag = isLocal ? `${IMAGE_NAME}:latest` : `${REGISTRY}/${IMAGE_NAME}:latest`

// ── Build ────────────────────────────────────────────────────────────────────

const buildCmd = [
    "docker",
    "build",
    "-f",
    DOCKERFILE,
    "-t",
    versionedTag,
    "-t",
    latestTag,
    ".", // build context = monorepo root
]

console.log(`[deploy] building image...`)
console.log(`         ${buildCmd.join(" ")}`)

if (!dryRun) {
    const build = Bun.spawnSync(buildCmd, { stdio: ["inherit", "inherit", "inherit"] })
    if (build.exitCode !== 0) {
        console.error(`[deploy] docker build failed (exit ${build.exitCode})`)
        process.exit(build.exitCode ?? 1)
    }
}

// ── Push ─────────────────────────────────────────────────────────────────────

if (!isLocal) {
    for (const tag of [versionedTag, latestTag]) {
        console.log(`[deploy] pushing ${tag}`)
        if (!dryRun) {
            const push = Bun.spawnSync(["docker", "push", tag], {
                stdio: ["inherit", "inherit", "inherit"],
            })
            if (push.exitCode !== 0) {
                console.error(`[deploy] docker push failed for ${tag} (exit ${push.exitCode})`)
                process.exit(push.exitCode ?? 1)
            }
        }
    }
    console.log(`[deploy] pushed ${REGISTRY}/${IMAGE_NAME}:${version}`)
    console.log(`[deploy] pushed ${REGISTRY}/${IMAGE_NAME}:latest`)
} else {
    console.log(`[deploy] local build complete — skipping push (--local)`)
}

console.log(`[deploy] done. axon-base v${version}`)
