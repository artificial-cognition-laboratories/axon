# tavily

Tavily Search integration for Axon agents. Lets any agent search the web using the Tavily Search API.

## Install

```bash
axon module install tavily
```

## Setup

Requires one environment variable:

| Variable | Description |
|---|---|
| `TAVILY_API_KEY` | Tavily API key from [app.tavily.com](https://app.tavily.com) |

Set it in your agent's environment:

```bash
axon env set TAVILY_API_KEY=your_key
```

## Usage

```ts
import { tavily } from "@axon/tavily"

// Basic search
const results = await tavily.search("bun javascript runtime")

// Limit results
const results = await tavily.search("TypeScript decorators", { count: 3 })

// Restrict to a domain
const results = await tavily.search("async iterators", { site: "github.com" })

// Deeper (slower, costlier) search
const results = await tavily.search("cognitive architecture research", { depth: "advanced" })
```

## API

### `tavily.search(query, options?)`

Search the web via the Tavily Search API.

**Parameters**

- `query` — search string
- `options.count` — number of results to return (default: `5`, max: `20`)
- `options.site` — restrict results to a domain, e.g. `"github.com"`
- `options.depth` — `"basic"` (fast) or `"advanced"` (deeper, higher cost). Default: `"basic"`

**Returns**

```ts
{
  query: string        // query as sent to Tavily
  items: Array<{
    title: string
    url: string
    snippet: string
  }>
}
```

## Permissions

This module makes outbound requests to `api.tavily.com`. The capsule policy is set automatically on install — no manual configuration needed.
