# @axon/search

Web search that cascades across providers. Set one key, or several.

[video of axon agent searching](./assets/demo.mp4)

```ts
const { items } = await search.web("bun test runner")
const { items } = await search.web("axon", { site: "github.com", count: 3 })
```

## Providers

Tried in this order. A provider with no key is skipped; a provider that fails
falls through to the next.

| Provider | Env | Notes |
|---|---|---|
| Tavily | `TAVILY_API_KEY` | Built for agents — returns prose extracts rather than SERP blurbs. |
| Brave | `BRAVE_API_KEY` | Independent index, one key, generous free tier. |
| Google | `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` | Best index, but needs a custom search engine configured by hand. |

Put keys in the agent's `.env`. One is enough.

## Why one tool

An agent wants to know things; which API answers is an accident of which key
happens to be set. A single `search.web()` keeps that out of every prompt —
otherwise each one has to branch on "use tavily, or google if that fails, or
say you cannot search".

## Options

- `count` — results to return. Default 5, clamped per provider.
- `site` — restrict to one domain.
- `safe` — filter explicit results. Default true.
- `deep` — dig deeper where supported (Tavily). Default false.
- `only` — force one provider. Throws if it is not configured.

`search.providers()` reports what this agent can use, without spending a
request.
