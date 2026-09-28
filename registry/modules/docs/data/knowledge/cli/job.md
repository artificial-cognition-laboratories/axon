---
title: axon job
---

# axon job

Delegate work to an agent and keep the record of what happened.

```bash
axon job create -p "update the changelog for the last three commits"
axon job list
axon job show 9c533cee
```

This is the counterpart to `axon <agent>`. That is a conversation you are present for; a
job is work you hand off and collect later.

A job is not an agent run. A run is one attempt; the job is the thing you asked for and
survives its attempts, so a retry keeps the thread rather than starting a new one.

## Creating

```bash
axon job create -p "do the thing"
axon job create "do the thing"
axon job create -p "do the thing" -t "Changelog" --agent @team/writer
```

The title is optional and taken from the first line of the content when omitted. The
working directory is captured at creation from where you ran the command, never resolved
later.

## Two states, not one

`run` is the agent's lifecycle (`queued`, `claimed`, `running`, `blocked`, `finished`,
`failed`, `cancelled`). `acknowledged` is yours. They are separate so that neither the
agent can clear your list nor you are stuck unable to.

`blocked` means the agent needs something only a person can answer.

## Working a job

```bash
axon job say 9c533cee "use the gb layout"   # answering a blocked job unblocks it
axon job done 9c533cee                      # your acknowledgement
axon job cancel 9c533cee
axon job retry 9c533cee                     # same job, fresh attempt
```

Jobs are addressed by the short ref shown in `axon job list`. An ambiguous prefix is
refused rather than guessed, because `cancel` takes a ref too.

## Agents can create jobs, not close them

An agent may create jobs and report progress on them. `done`, `cancel` and `retry` belong
to the person who asked for the work — an agent that could acknowledge its own output
would make the list meaningless. Being signed in is what marks you as that person.

## Where jobs live

The daemon owns them, so a job outlives the terminal that created it. Each job is an
append-only log of what happened, and its state is read back from that log rather than
stored as a field.
