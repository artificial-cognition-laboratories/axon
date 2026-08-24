---
title: Capsule entries
---

# Capsule entries

All capsule entries are emitted automatically by the runtime — no agent code required.

## capsule:stdin

The agent sent code to the capsule for execution.

```ts
type CapsuleStdin = ThreadEntry<"capsule:stdin", {
    commandId: string      // stable ID linking this command to its stdout/stderr/calls
    lang: "shell" | "ts"
    code: string
    cwd?: string
}>
```

## capsule:stdout / capsule:stderr

Streaming output from a running capsule command. Links to `capsule:stdin` via `commandId`.

```ts
type CapsuleStdout = ThreadEntry<"capsule:stdout", { commandId: string; data: string }>
type CapsuleStderr = ThreadEntry<"capsule:stderr", { commandId: string; data: string }>
```

## capsule:calls

Structured function call trace for a completed command. Every tool function invoked
during the command is recorded here.

```ts
type CapsuleCalls = ThreadEntry<"capsule:calls", {
    commandId: string
    calls: Array<{
        module: string
        fn: string
        args: unknown[]
        result?: unknown
        error?: string
        durationMs: number
    }>
}>
```

## capsule:escalating

A tool call is blocked, waiting for user policy approval.

```ts
type CapsuleEscalating = ThreadEntry<"capsule:escalating", {
    commandId: string
    escalationId: string
    module: string
    fn: string
    args: unknown[]
    rule: string      // the policy rule that triggered escalation
}>
```

## capsule:denied

A tool call was denied by policy without escalation.

```ts
type CapsuleDenied = ThreadEntry<"capsule:denied", {
    commandId: string
    module: string
    fn: string
    args: unknown[]
}>
```

## capsule:manifest

The capsule published a TypeScript module into scope. Emitted when a module's
type declarations become available to subsequent commands.

```ts
type CapsuleManifest = ThreadEntry<"capsule:manifest", {
    module: string
    description?: string
    exports: Array<{
        name: string
        declaration: string  // TypeScript declaration string
        jsdoc?: string
    }>
}>
```

## capsule:module:installed / capsule:module:removed

A capsuleer module was added to or removed from the running capsule at runtime.

```ts
type CapsuleModuleInstalled = ThreadEntry<"capsule:module:installed", {
    module: string      // capsuleer module id e.g. "sqlite"
    npmPackage: string  // npm package e.g. "@capsuleer/sqlite"
}>

type CapsuleModuleRemoved = ThreadEntry<"capsule:module:removed", {
    module: string
    npmPackage: string
}>
```

## Proc lifecycle

Emitted for subprocesses spawned inside the capsule via `process.spawn()`.

```ts
type CapsuleProcSpawned = ThreadEntry<"capsule:proc:spawned", {
    procId: string
    command: string
    cwd?: string
    pid?: number     // OS-assigned PID, available after spawn completes
}>

type CapsuleProcStdout = ThreadEntry<"capsule:proc:stdout", {
    procId: string
    data: string     // raw stdout chunk — may be a partial line
}>

type CapsuleProcStderr = ThreadEntry<"capsule:proc:stderr", {
    procId: string
    data: string
}>

type CapsuleProcExit = ThreadEntry<"capsule:proc:exit", {
    procId: string
    command: string   // for display without requiring a proc:spawned lookup
    exitCode: number
    ok: boolean
    durationMs?: number
}>

type CapsuleProcDenied = ThreadEntry<"capsule:proc:denied", {
    procId: string
    command: string
    error: string
}>
```
