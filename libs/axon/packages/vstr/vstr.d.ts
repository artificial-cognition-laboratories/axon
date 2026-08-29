/**
 * Ambient declarations for @arcforge/vstr context injection.
 *
 * When a .prompt or .vue file is rendered via @arcforge/vstr, the host may inject
 * globals via `options.context`. These are available as bare identifiers in
 * <script setup> without imports.
 *
 * To suppress "Cannot find name" errors in your editor, declare the globals you
 * inject here. This file is intentionally minimal — add your own declarations
 * alongside it or extend this file per-project.
 *
 * Example — if you inject { axon, db }:
 *
 *   declare const axon: import("@axon/runtime").AxonHandle
 *   declare const db: import("./db").Database
 */

// This file intentionally left sparse.
// Declare context globals here or in a project-local .d.ts file.
