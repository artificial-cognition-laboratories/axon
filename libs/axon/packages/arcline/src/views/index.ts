/**
 * views — the built-in Axon CLI surfaces.
 *
 * A view is a whole surface: `(renderer, opts) => string`, composed from
 * components, pure. Consumers call these directly with their own data.
 *
 * The `gallery` below is the single registry of every view arcline ships. It
 * is what `arcline <name>` renders and what `arcline` with no args lists, so a
 * view is manually testable the moment it is registered. Adding a view means
 * one entry here and nothing else.
 */

import type { RendererHandle } from "../core/index.ts"
import { hello, type HelloOpts } from "./hello.ts"
import { devServer, type DevServerOpts } from "./devServer.ts"
import { publish, PUBLISH_STEPS, type PublishOpts } from "./publish.ts"
import { publishDemo, publishRetryDemo, publishFailDemo } from "./publish.demo.ts"
import { failures } from "./publish.failures.ts"
import { deploy, DEPLOY_STEPS, type DeployOpts } from "./deploy.ts"
import { deployDemo, deployFailDemo, deployFailures } from "./deploy.demo.ts"
import { init, INIT_STEPS, type InitOpts } from "./init.ts"
import { initDemo } from "./init.demo.ts"
import { install, type InstallOpts } from "./install.ts"
import { installDemo } from "./install.demo.ts"
import { login, countdown, type LoginOpts } from "./login.ts"
import { loginDemo } from "./login.demo.ts"
import { whoami, type WhoamiOpts } from "./whoami.ts"
import { identity, type Identity } from "./identity.ts"
import { search, type SearchOpts } from "./search.ts"
import { searchDemo } from "./search.demo.ts"
import { prepare, PREPARE_STEPS, type PrepareOpts } from "./prepare.ts"
import { prepareDemo } from "./prepare.demo.ts"
import { clone, bytes, CLONE_STEPS, type CloneOpts } from "./clone.ts"
import { cloneDemo } from "./clone.demo.ts"

export { hello, devServer, publish, PUBLISH_STEPS, deploy, DEPLOY_STEPS, init, INIT_STEPS, install, login, countdown, search, whoami, identity, prepare, PREPARE_STEPS, clone, bytes, CLONE_STEPS, type HelloOpts, type DevServerOpts, type PublishOpts, type DeployOpts, type InitOpts, type InstallOpts, type LoginOpts, type SearchOpts, type PrepareOpts, type WhoamiOpts, type Identity, type CloneOpts }

/**
 * A gallery entry: a view paired with the fixture that demonstrates it.
 *
 * `run` DRIVES the renderer rather than returning a string, because a static
 * view and a live one cannot be demonstrated the same way — a step list frozen
 * at one frame says nothing about whether the interaction feels right. A still
 * view writes its one frame and returns; a live one scripts a plausible run and
 * resolves when it finishes. The gallery therefore shows each surface the way
 * the user will actually meet it.
 */
export type GalleryEntry = {
    /** One line describing what this view is for, shown in the index. */
    summary: string
    /**
     * Render or play the view with representative fixture data.
     *
     * `args` carries the bin's flags, so a view with several interesting
     * states can expose them (`--fail auth`) rather than needing an entry per
     * variant.
     */
    run(r: RendererHandle, args: Record<string, string>): void | Promise<void>
}

export const gallery: Record<string, GalleryEntry> = {
    whoami: {
        summary: "`axon whoami` — the identity this machine uses; --case no-scope",
        run: (r, args) => r.line(whoami(r, {
            email: "cody@hexlabs.co.uk",
            ...(args.case === "no-scope" ? {} : { scope: "cody" }),
            memberSince: Date.parse("2025-03-14"),
        })),
    },

    clone: {
        summary: "`axon clone` — copy an artifact; --case <fork|not-found>",
        run: (r, args) => cloneDemo(r, args.case === "true" ? "default" : args.case ?? "default"),
    },

    prepare: {
        summary: "`axon prepare` — quiet by default; --case <work|warnings|frozen|drift>",
        run: (r, args) => prepareDemo(r, args.case === "true" ? "default" : args.case ?? "default"),
    },

    search: {
        summary: "`axon search` — registry results; --case <filtered|many|empty>",
        run: (r, args) => searchDemo(r, args.case === "true" ? "default" : args.case ?? "default"),
    },

    login: {
        summary: "`axon login` — device flow; --case <no-scope|expired|denied>",
        run: (r, args) => loginDemo(r, args.case === "true" ? "default" : args.case ?? "default"),
    },

    install: {
        summary: "`axon install` — add modules; --case <not-found|noop|error>",
        run: (r, args) => installDemo(r, args.case === "true" ? "default" : args.case ?? "default"),
    },

    init: {
        summary: "`axon init` — scaffold a project; --ask prompts for the name",
        run: (r, args) => initDemo(r, args.ask ? { ask: true } : {}),
    },

    deploy: {
        summary: `\`axon deploy\` — add --fail <${Object.keys(deployFailures).join("|")}>`,
        run: (r, args) => args.fail
            ? deployFailDemo(r, args.fail === "true" ? "runtime" : args.fail)
            : deployDemo(r),
    },

    publish: {
        // The failure modes are flags on this entry rather than entries of
        // their own: they are the SAME view in a different state, and a user
        // checking how publish looks should not have to know which of three
        // names shows the one they mean.
        summary: `\`axon publish\` — add --fail <${Object.keys(failures).join("|")}> or --retry`,
        run: (r, args) => {
            if (args.fail) return publishFailDemo(r, args.fail === "true" ? "verify" : args.fail)
            if (args.retry) return publishRetryDemo(r)
            return publishDemo(r)
        },
    },

    hello: {
        summary: "Reference view — proves the render pipeline end to end",
        run: r => r.line(hello(r, { name: "Cody" })),
    },

    dev: {
        summary: "The block `axon dev` prints once the server is up",
        run: r => r.line(devServer(r, {
            title: "Axon",
            info: [
                ["Agent", "@cody/zeno"],
                ["Model", "claude-opus-5"],
                ["Modules", "obsidian, github, linear"],
            ],
            links: [
                ["Local", "http://localhost:3141"],
                ["Debug", "http://localhost:3141/__debug"],
                ["Runtime", "ws://localhost:3141/ws"],
            ],
            readyMs: 412,
        })),
    },
}
