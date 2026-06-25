# google

Google Search integration for Axon agents. Lets any agent search the web using Google Custom Search.

## Install

```bash
axon module install google
```

## Setup

Requires two environment variables:

| Variable | Description |
|---|---|
| `GOOGLE_API_KEY` | Google Cloud API key with Custom Search API enabled |
| `GOOGLE_CSE_ID` | Custom Search Engine ID from [cse.google.com](https://cse.google.com) |

Set them in your agent's environment:

```bash
axon env set GOOGLE_API_KEY=your_key
axon env set GOOGLE_CSE_ID=your_cse_id
```

## Usage

```ts
import { google } from "@axon/google"

// Basic search
const results = await google.search("bun javascript runtime")

// Limit results
const results = await google.search("TypeScript decorators", { count: 3 })

// Restrict to a domain
const results = await google.search("async iterators", { site: "github.com" })
```

## API

### `google.search(query, options?)`

Search the web via Google Custom Search.

**Parameters**

- `query` — search string
- `options.count` — number of results to return (default: `5`, max: `10`)
- `options.site` — restrict results to a domain, e.g. `"github.com"`
- `options.safe` — enable safe search (default: `true`)

**Returns**

```ts
{
  query: string        // query as Google interpreted it
  total: number        // estimated total results
  items: Array<{
    title: string
    url: string
    snippet: string
  }>
}
```

## Permissions

This module makes outbound requests to `www.googleapis.com`. The capsule policy is set automatically on install — no manual configuration needed.
