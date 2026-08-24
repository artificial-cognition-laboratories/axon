---
title: CLI
---

# CLI

```bash
axon                        # open the TUI with the default agent
axon --agent <name>         # open a specific agent
axon --version              # print installed version
```

## Project commands

Run these from a project directory. Axon detects the project type from the
working directory; a command states when it only applies to an agent.

| Command | What it does |
|---|---|
| `axon init <name>` | Scaffold a new agent folder |
| `axon run -a <agent> -p <prompt>` | Run one agent against one instruction, headlessly |
| `axon install <id>` | Install a module into the current agent project (`axon i`) |
| `axon clone <module> [dir]` | Download a published module as an editable project |
| `axon fork <module> --as <name> [dir]` | Clone a module under a new package identity |
| `axon prepare` | Prepare the current project and regenerate its local output |

## Cloud and deployed agents

Commands for building artifacts and managing deployments.

| Command | What it does |
|---|---|
| `axon build` | Build the current agent project |
| `axon deploy` | Deploy the current agent project to Axon Cloud |
| `axon ps` | List your cloud agent deployments |
| `axon status [agent]` | Inspect a deployment; the current agent project supplies an omitted target |
| `axon logs [agent] --follow` | Read or follow deployment logs |
| `axon undeploy [agent] --yes` | Tear down a deployment |
| `axon module` | Author and publish modules to the registry |

## Authentication

```bash
axon login      # authenticate — required before deploy or publish
axon logout     # clear stored credentials
axon whoami     # print the authenticated account
```

Credentials are stored in `~/.axon/auth.json` after login.
