---
title: axon unwatch
---

# axon unwatch

Remove a directory from your agent discovery list.

```bash
axon unwatch ~/projects
```

Only removes the registration — agents already inside the directory are
untouched on disk, they just stop showing up in `axon` and the terminal UI
until the directory is watched again.

See [axon watch](/docs/v2/cli/watch).
