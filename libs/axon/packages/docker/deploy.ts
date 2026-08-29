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

// ── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
// indexOf returns -1 when --bump is absent, so `args[-1 + 1]` read args[0] as the
// bump value — any flag-only invocation (`--local`, `--dry-run`) then died with
// "invalid --bump value: --local". Only read the next arg when the flag is there.
const bumpIndex = args.indexOf("--bump")
const bumpArg = bumpIndex === -1
    ? undefined
    : (args[bumpIndex + 1] as "patch" | "minor" | "major" | undefined)
const isLocal = args.includes("--local")
const dryRun = args.includes("--dry-run")

if (bumpIndex !== -1 && bumpArg === undefined) {
    console.error("[deploy] --bump needs a value. Use patch | minor | major")
    process.exit(1)
}

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

// ── Version consistency ───────────────────────────────────────────────────────
//
// Three files name this version and two of them cannot import the third:
//
//   libs/axon/packages/docker/VERSION            what this script tags
//   libs/axon/types/src/deploy.ts                what the BUNDLER writes into a
//                                                self-host Dockerfile
//   apps/backend/.../gcloud/deployments.ts       what the PROVISIONER deploys
//
// The backend declares no @arcforge dependency — decoupled from the platform
// packages deliberately — so it holds its own copy. Types holds the copy the
// bundler reads, since @axon/docker depends on platform and importing it back
// would be a cycle.
//
// So they are checked rather than synced. A rewrite-by-regex was what this
// replaced: it WARNED when its pattern missed and otherwise let the two drift
// in silence, which is how a provisioner ends up running a different runtime
// than the one a user's Dockerfile pins. Failing here is loud, and the fix is
// one edit per file.
if (!isLocal) {
    const mismatches: string[] = []
    for (const [file, pattern] of [
        ["libs/axon/types/src/deploy.ts", /AXON_BASE_VERSION = ["']([^"']+)["']/],
        ["apps/backend/platform/gcloud/deployments.ts", /AXON_BASE_VERSION = ["']([^"']+)["']/],
    ] as const) {
        const found = pattern.exec(readFileSync(file, "utf-8"))?.[1]
        if (found !== version) mismatches.push(`  ${file} says ${found ?? "nothing"}`)
    }

    if (mismatches.length > 0) {
        console.error(
            `[deploy] AXON_BASE_VERSION is ${version} here but:\n${mismatches.join("\n")}\n` +
            `[deploy] update them and re-run — a provisioner and a self-host Dockerfile ` +
            `must never name different runtimes.`,
        )
        if (!dryRun) process.exit(1)
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
