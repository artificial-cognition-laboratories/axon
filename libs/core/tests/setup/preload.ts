/**
 * Bun preload — runs once per worker before any test file.
 *
 * Ensures the local staging daemon is running (db + backend), booting it if
 * this is a cold machine/CI run. Safe to call from multiple workers/packages
 * concurrently — Daemon.connect() is idempotent and race-safe.
 */
import { Repo } from "@arclabs/repo"

const repo = Repo()
const { backendUrl, dbUrl } = await repo.daemon.connect()

process.env.AXON_API_BASE = backendUrl
process.env.DATABASE_URL = dbUrl
