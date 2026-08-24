---
title: CLI Reference
---

# CLI Reference

## axon

Open the TUI with the default agent.

```bash
axon
```

## axon --version

Print the installed Axon version.

```bash
axon --version
```

## axon --agent

Open a named agent instead of the default:

```bash
axon --agent <name>
```

Regenerates `axon.manifest.json`, `axon.d.ts`, and `.axon/tools.d.ts` before opening.

## axon login

Authenticate with your Axon account. Required before deploying or publishing.

```bash
axon login
```

Opens a browser to complete authentication. Stores credentials in `~/.axon/auth.json`. Run once — subsequent commands use the stored session.

```bash
axon logout     # clear stored credentials
axon whoami     # print the currently authenticated account
```

## axon init

Scaffold a new named agent at `~/.axon/agents/<name>/`.

```bash
axon init <name>
```

Creates the agent folder with `axon.config.ts`, `tsconfig.json`, `axon.d.ts`, and empty `prompts/`, `scripts/`, and `server/` directories. Open it with `axon --agent <name>`.

## Cloud deployments

Agents are the only deployable Axon artifact. Deployment management therefore
lives at the CLI root, alongside `axon deploy`.

```bash
axon deploy                     # publish and replace the current agent revision
axon ps                         # list cloud deployments
axon status [agent]             # inspect a deployment
axon logs [agent] --follow      # read or follow deployment logs
axon undeploy [agent] --yes     # tear down a deployment
```

When the target is omitted, `status`, `logs`, and `undeploy` use the agent
project in the current directory. Environment values come from that project's
`.env` when deploying; there is no mutable remote environment command.

## axon install / axon uninstall

Install or remove a module from an agent.

```bash
axon install <id>                  # install into the agent at the current directory
axon i <id>                        # shorthand — identical
axon uninstall <id>                # remove an installed module
```

**Notes**

- `<id>` is the registry identifier, always scoped: `@scope/name`. The registry
  namespace is scoped, so a bare `name` matches nothing.
- The target is the agent project resolved from the working directory. There is no
  flag to install into a different agent — `cd` to it.
- Installing merges the module's prompts, scripts, and tool dependencies into the agent folder. Nested module dependencies are resolved and merged automatically.
- If the module declares `needs`, the CLI prompts for env values and writes them to `.env`.

## axon module

Create module projects. Publishing is project-dispatched at the root of the CLI.

```bash
axon module init <name>            # scaffold a new module project in the current directory
axon publish                        # publish the module project in the current directory
```

**Notes**

- `axon module init` creates `module.config.ts` and empty `prompts/`, `scripts/` directories.
- `axon publish` detects the module project from cwd and publishes it to the registry.
- See [Publishing a module](/docs/v2/modules/publishing) for what is included and excluded from the bundle.

## axon run

One execution: an agent, an instruction, go.

```bash
axon run -a <agent> -p <prompt>              # a prompt the agent declares
axon run -a <agent> --text "<instruction>"   # a literal instruction
```

**Notes**

- `-a` takes a path or a bare name under your active profile. Omitting it falls back to the working directory.
- `-p` is a *reference* — resolved, and rendered when it is a `.vue`. `--text` is a *literal*, used verbatim. Passing both is an error.
- Any other flag becomes a prompt argument, available via `defineProps<{}>()` in a rendered prompt.
- `--job <dir>` tags the run with the job it belongs to. Correlation only — it changes nothing about what runs.
- Boots the agent, runs to completion, then exits. No TUI is opened.

```bash
axon run -a barry.mk3 -p scout
axon run -a barry.mk3 -p learn --domain tracing
axon run -a barry.mk3 --text "Audit the org boundary."
```

See [axon run](/docs/v2/cli/run) for the full reference.

## axon prepare

Regenerate `axon.manifest.json`, `axon.d.ts`, and `.axon/tools.d.ts` for the current agent.

```bash
axon prepare
```

`axon.manifest.json` is the agent's module manifest. `axon.d.ts` declares the auto-injected globals. `.axon/tools.d.ts` contains tool type declarations for all installed modules — what makes `axon.tools.*` calls fully typed.

Run this after installing or removing modules if you want updated types without reopening Axon. Runs automatically on open — explicit use is only needed for mid-session type refreshes.
