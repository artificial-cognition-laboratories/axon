---
title: .agent/
icon: vscode-icons:default-folder
---

# .agent/

Generated output folder. Created by `axon prepare` and `axon build`. Never edit anything
inside it — the whole folder is regenerated on every prepare run.

```bash
.agent/
├── .dockerignore
├── axon.d.ts            # global type declarations for scripts and routes
├── axon.manifest.json   # full agent manifest — tools, prompts, scripts, routes
├── components.d.ts      # auto-imported component declarations
├── Dockerfile           # container image for deployment
├── image.json           # Docker image metadata
├── prompts.d.ts         # prompt name declarations
├── scripts.d.ts         # script name declarations
├── source.tar.gz        # source archive for deployment
├── tool-globals.d.ts    # tool function globals
├── tools.d.ts           # typed tool namespace declarations
└── tsconfig.json        # TypeScript config extending the agent's own
```

## What `axon prepare` generates

Running `axon prepare` (or opening Axon, which runs it automatically) scans the agent
folder and generates:

**Type declarations** — `.d.ts` files that give your IDE full autocomplete on
`axon.tools.*`, `axon.prompt("name")`, and `axon.scripts.request("name")`. After adding
a new tool function or prompt file, run `axon prepare` to refresh types without reopening
the agent.

**Manifest** — `axon.manifest.json` is the machine-readable description of the entire
agent: every tool function with its declaration and JSDoc, every prompt with its props,
every script with its args, every route with its method and path. The runtime uses this
to register tools with the model and to power the TUI palette. The registry uses it for
discovery and display.

## What `axon build` adds

`axon build` runs `prepare` first, then adds deployment artifacts:

**`Dockerfile`** — a production container image for the agent. Self-contained — includes
the agent source, dependencies, and the Axon runtime. Build it, push it, deploy it to any
container platform.

**`source.tar.gz`** — source archive used by Axon Cloud deployment. Contains everything
needed to run the agent on managed infrastructure.

**`image.json`** — metadata about the built image: digest, tags, build timestamp.

## `.gitignore`

Add `.agent/` to your `.gitignore`. It's generated output — committing it adds noise and
creates merge conflicts. The manifest and declarations are always regenerated fresh.

```bash
# .gitignore
.agent/
```

## The manifest in detail

`axon.manifest.json` is what the runtime and the registry actually read. It's worth
understanding what's in it:

```json
{
  "name": "my-agent",
  "version": "0.1.0",
  "kind": "agent",
  "tools": [
    {
      "name": "kanban",
      "origin": "src",
      "fns": [
        {
          "name": "list",
          "declaration": "function list(): Promise<Task[]>",
          "jsdoc": "List all tasks across the three kanban stages."
        }
      ]
    }
  ],
  "prompts": [
    {
      "name": "session",
      "kind": "dynamic",
      "filePath": "src/prompts/session.vue"
    }
  ],
  "scripts": [
    {
      "name": "scout",
      "args": []
    }
  ],
  "routes": [
    {
      "method": "POST",
      "path": "/api/scout",
      "file": "server/api/scout.post.ts"
    }
  ],
  "context": {
    "boot": {
      "path": "src/boot.vue",
      "kind": "dynamic"
    }
  }
}
```

The tool declarations and JSDoc in the manifest are exactly what the model sees when
deciding whether and how to call a tool. Write JSDoc as if explaining the function to
someone who has never seen your code — because that's what it's for.
