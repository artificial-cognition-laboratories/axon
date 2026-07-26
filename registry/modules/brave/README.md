# brave

Brave Search integration for Axon agents. Lets any agent search the web using the Brave Search API.

## Install

```bash
axon module install brave
```

## Setup

Requires one environment variable:

| Variable | Description |
|---|---|
| `BRAVE_API_KEY` | Brave Search API key from [api-dashboard.search.brave.com](https://api-dashboard.search.brave.com) |

Set it in your agent's environment:

```bash
axon env set BRAVE_API_KEY=your_key
```

## Usage

```ts
import { brave } from "@axon/brave"

// Basic search
const results = await brave.search("bun javascript runtime")

// Limit results
const results = await brave.search("TypeScript decorators", { count: 3 })

// Restrict to a domain
const results = await brave.search("async iterators", { site: "github.com" })
```

## API

### `brave.search(query, options?)`

Search the web via the Brave Search API.

**Parameters**

- `query` — search string
- `options.count` — number of results to return (default: `5`, max: `20`)
- `options.site` — restrict results to a domain, e.g. `"github.com"`
- `options.safe` — enable safe search (default: `true`)

**Returns**

```ts
{
  query: string        // query as sent to Brave (after any site filter applied)
  items: Array<{
    title: string
    url: string
    snippet: string
  }>
}
```

## Permissions

This module makes outbound requests to `api.search.brave.com`. The capsule policy is set automatically on install — no manual configuration needed.
