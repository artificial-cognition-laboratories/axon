import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Id } from "../../types"
import type { Persistence, Row, SerializedRegion, StoredBasis } from "./types"

/**
 * Durable rows in SQLite; the columnar index is DERIVED at load.
 *
 * Coordinates are stored one row at a time as raw float blobs, not as persisted
 * columns. Writes are then ordinary transactional inserts, and the only cost is
 * one pass at boot to build the in-memory columns — rather than rewriting a
 * multi-megabyte column blob on every put, which is the shape a naive "save the
 * columns" design falls into.
 */
export function SqlitePersistence(opts: { path: string }): Persistence {
    // The folder too: the place is named by whoever owns it (the kernel, for a
    // cognet) and is first created by the database that lives there.
    mkdirSync(dirname(opts.path), { recursive: true })
    const db = new Database(opts.path, { create: true })
    db.exec("PRAGMA journal_mode = WAL")
    db.exec(`
        CREATE TABLE IF NOT EXISTS rows (
            id     TEXT PRIMARY KEY,
            at     INTEGER NOT NULL,
            values_ BLOB NOT NULL,
            conf   BLOB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS rows_at ON rows (at);

        CREATE TABLE IF NOT EXISTS payloads (
            id   TEXT PRIMARY KEY,
            json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS regions (
            name       TEXT PRIMARY KEY,
            radius     REAL NOT NULL,
            count      INTEGER NOT NULL,
            domain     TEXT,
            prototypes BLOB NOT NULL,
            arity      INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS basis (
            id        INTEGER PRIMARY KEY CHECK (id = 1),
            version   TEXT NOT NULL,
            ordinal   INTEGER NOT NULL,
            axes      TEXT NOT NULL,
            writtenAt INTEGER NOT NULL
        );
    `)

    // Prepared once. Re-preparing a statement per call was a measurable share of
    // load time, and a transaction wrapper only helps if the statement is reused.
    const insertRow = db.query("INSERT OR REPLACE INTO rows (id, at, values_, conf) VALUES (?, ?, ?, ?)")
    const deleteRow = db.query("DELETE FROM rows WHERE id = ?")
    const insertPayload = db.query("INSERT OR REPLACE INTO payloads (id, json) VALUES (?, ?)")
    const deletePayload = db.query("DELETE FROM payloads WHERE id = ?")

    const writeRows = db.transaction((batch: readonly Row[]) => {
        for (const row of batch) insertRow.run(row.id, row.at, toBlob(row.values), toBlob(row.conf))
    })
    const dropRows = db.transaction((ids: readonly Id[]) => {
        for (const id of ids) deleteRow.run(id)
    })
    const writePayloads = db.transaction((entries: readonly { id: Id; payload: unknown }[]) => {
        for (const entry of entries) insertPayload.run(entry.id, JSON.stringify(entry.payload ?? null))
    })
    const dropPayloads = db.transaction((ids: readonly Id[]) => {
        for (const id of ids) deletePayload.run(id)
    })

    return {
        rows: {
            async all() {
                const found = db.query("SELECT id, at, values_, conf FROM rows").all() as RowShape[]
                return found.map(row => ({
                    id: row.id,
                    at: row.at,
                    values: toFloats(row.values_),
                    conf: toFloats(row.conf),
                }))
            },
            async put(row) {
                insertRow.run(row.id, row.at, toBlob(row.values), toBlob(row.conf))
            },
            async putMany(batch) {
                // One transaction for the lot. Per-row autocommit is what made a
                // 50k load take 4.6s — the cost is fsync, not the inserts.
                writeRows(batch)
            },
            async delete(id) {
                deleteRow.run(id)
            },
            async deleteMany(ids) {
                dropRows(ids)
            },
        },
        payload: {
            async get(id) {
                const found = db.query("SELECT json FROM payloads WHERE id = ?").get(id) as { json: string } | null
                return found ? JSON.parse(found.json) : null
            },
            async getMany(ids) {
                const found = new Map<Id, unknown>()
                if (ids.length === 0) return found
                // Chunked because SQLite caps bound parameters (999 by default).
                for (let i = 0; i < ids.length; i += 500) {
                    const slice = ids.slice(i, i + 500)
                    const holes = slice.map(() => "?").join(",")
                    const rows = db
                        .query(`SELECT id, json FROM payloads WHERE id IN (${holes})`)
                        .all(...slice) as { id: string; json: string }[]
                    for (const row of rows) found.set(row.id, JSON.parse(row.json))
                }
                return found
            },
            async put(id, payload) {
                insertPayload.run(id, JSON.stringify(payload ?? null))
            },
            async putMany(entries) {
                writePayloads(entries)
            },
            async delete(id) {
                deletePayload.run(id)
            },
            async deleteMany(ids) {
                dropPayloads(ids)
            },
        },
        regions: {
            async all() {
                const found = db.query("SELECT name, radius, count, domain, prototypes, arity FROM regions").all() as RegionShape[]
                return found.map(row => ({
                    name: row.name,
                    radius: row.radius,
                    count: row.count,
                    ...(row.domain !== null ? { domain: row.domain } : {}),
                    prototypes: unpackPrototypes(row.prototypes, row.arity),
                }))
            },
            async put(region) {
                const arity = region.prototypes[0]?.values.length ?? 0
                db.query(
                    "INSERT OR REPLACE INTO regions (name, radius, count, domain, prototypes, arity) VALUES (?, ?, ?, ?, ?, ?)"
                ).run(region.name, region.radius, region.count, region.domain ?? null, packPrototypes(region), arity)
            },
            async delete(name) {
                db.query("DELETE FROM regions WHERE name = ?").run(name)
            },
        },
        basis: {
            async read() {
                const found = db.query("SELECT version, ordinal, axes, writtenAt FROM basis WHERE id = 1").get() as BasisShape | null
                if (!found) return null
                return {
                    version: found.version,
                    ordinal: found.ordinal,
                    axes: JSON.parse(found.axes) as string[],
                    writtenAt: found.writtenAt,
                }
            },
            async write(basis) {
                db.query(
                    "INSERT OR REPLACE INTO basis (id, version, ordinal, axes, writtenAt) VALUES (1, ?, ?, ?, ?)"
                ).run(basis.version, basis.ordinal, JSON.stringify(basis.axes), basis.writtenAt)
            },
        },
        async close() {
            db.close()
        },
    }
}

type RowShape = { id: string; at: number; values_: Uint8Array; conf: Uint8Array }
type RegionShape = { name: string; radius: number; count: number; domain: string | null; prototypes: Uint8Array; arity: number }
type BasisShape = { version: string; ordinal: number; axes: string; writtenAt: number }

function toBlob(floats: Float32Array): Uint8Array {
    return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength)
}

/** Copy rather than view: a blob handed back by sqlite is not guaranteed to be 4-byte aligned. */
function toFloats(blob: Uint8Array): Float32Array {
    const copy = new Uint8Array(blob.byteLength)
    copy.set(blob)
    return new Float32Array(copy.buffer)
}

/** Prototypes pack as `[values, conf]` pairs back to back — arity is stored beside them so unpacking needs no delimiter. */
function packPrototypes(region: SerializedRegion): Uint8Array {
    const arity = region.prototypes[0]?.values.length ?? 0
    const flat = new Float32Array(region.prototypes.length * arity * 2)
    let offset = 0
    for (const prototype of region.prototypes) {
        flat.set(prototype.values, offset)
        offset += arity
        flat.set(prototype.conf, offset)
        offset += arity
    }
    return new Uint8Array(flat.buffer)
}

function unpackPrototypes(blob: Uint8Array, arity: number): { values: Float32Array; conf: Float32Array }[] {
    if (arity === 0) return []
    const flat = toFloats(blob)
    const out: { values: Float32Array; conf: Float32Array }[] = []
    for (let offset = 0; offset + arity * 2 <= flat.length; offset += arity * 2) {
        out.push({
            values: flat.slice(offset, offset + arity),
            conf: flat.slice(offset + arity, offset + arity * 2),
        })
    }
    return out
}
