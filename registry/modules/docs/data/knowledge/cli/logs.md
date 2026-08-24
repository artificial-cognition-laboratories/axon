---
title: axon logs
---

# axon logs

Read recent logs from a deployed agent.

```bash
axon logs
axon logs @team/support
axon logs --follow
```

`--follow` keeps polling for new deployment logs. As with `axon status`, the
current agent project supplies an omitted target.
