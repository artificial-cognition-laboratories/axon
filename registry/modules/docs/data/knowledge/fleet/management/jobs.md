---
title: Jobs
---

# Jobs

A job is a concern you want worked: a bug, a migration, a standing review. It holds a
brief, and a log of everything that has happened on it.

::TerminalImage{src="/fleet/workspace.png" alt="The Workspace view showing jobs grouped by the repo they belong to"}
::

Grouped by repo, because that is where contention is. Two agents editing one working tree
conflict; two agents in different repos do not.

## A job is a directory

```
jobs/
└── flaky-auth-test/
    ├── job.md              ← the brief: what this work is, now
    └── log/
        ├── 001.dispatch.md ← what you asked for
        ├── 002.report.md   ← what the agent found
        └── 003.proposal.md ← what it suggests doing
```

::TerminalImage{src="/fleet/job-detail.png" alt="A job opened showing its brief above the log of dispatches, reports and proposals"}
::

No database, no schema, no client. **An agent participates by writing a file** — so an
agent that knows nothing about Fleet can take part with the filesystem tools it already
has.

Jobs live on the branch they belong to. Work on a feature branch travels with it and
arrives with the pull request.

## The brief changes; the log does not

The brief says what the work is *now* — edit it in place as understanding improves. The
log is append-only: an entry records what was true when it landed.

::TerminalImage{src="/fleet/job-log.png" alt="The append-only job log with a report and a proposal from an agent"}
::

## Dispatching

Pair an asset with a job: this agent, running this prompt, against this work.

::TerminalVideo{src="/fleet/dispatch.mp4"}
::

While it runs, the assignment appears under the job it is working, and the
[Console](/docs/v2/fleet/debugging/console) points at it like any other instance.

::TerminalImage{src="/fleet/live-assignment.png" alt="A live assignment nested under the job it is working"}
::

**The session is the durable record.** Who ran what, what changed, how long it took —
all of it is in the trace. Nothing is copied into the job, because a copy can disagree
with the thing it copied. A job entry naming its session is a claim; the session is the
evidence.

When a run exits, how it ended is kept rather than cleared — a run that produced nothing
still reports why.

## The gradient

A brief can carry keys naming what to run against it: which agent, which prompt. All
optional.

::TerminalImage{src="/fleet/job-gradient.png" alt="Three jobs side by side: a plain note, one naming an agent, one fully specified and dispatchable"}
::

A job with none is a note you wrote yourself. Add an agent and a prompt and it becomes one
click. **Filling keys in is how work moves toward automation without changing what the
file is** — no promotion step, no conversion, no second artifact.

---

Back to [Managing Agents](/docs/v2/fleet/management), or on to
[Debugging](/docs/v2/fleet/debugging).
