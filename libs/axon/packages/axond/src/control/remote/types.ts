import type { MachineCapacity, MachineUsage } from "../../machine/index"
import type { ScheduleResult } from "../../schedule/index"

/**
 * The wire shapes of the machine network — everything that may leave this box.
 *
 * Written by hand and picked field by field, never derived from a domain type.
 * A domain record is free to grow a field that must not cross a machine
 * boundary (an agent record carries its control token), and a derived shape
 * would carry it the day it was added. Here, a field crosses only when someone
 * wrote it down.
 */

/**
 * Who is calling: a machine the directory has verified belongs to this
 * account. Always a person's machine — there is no agent caller, because no
 * agent path reaches a remote surface.
 */
export type Peer = {
    /** The verified public key of the calling machine. */
    machine: string
    /** The account both machines belong to. */
    account: string
}

export type RemoteMachine = {
    hostname: string
    platform: string
    arch: string
    capacity: MachineCapacity
    usage: MachineUsage
    budget: number | null
    held: number
    /** Recent readings, oldest first — what a sparkline draws. */
    samples: MachineUsage[]
}

/** A running agent. No pid, no paths, no control channel. */
export type RemoteAgent = {
    session: string
    name: string
    startedAt: string
    parent: string | null
    job: string | null
}

/** An agent project on the box, running or not. */
export type RemoteProject = {
    ref: string
    version: string | null
    profile: string
    usedAt: number | null
}

export type RemoteSchedule = {
    id: string
    agent: string
    every: string
    paused: boolean
    lastRunAt: string | null
    lastResult: ScheduleResult | null
    error: string | null
}

export type RemoteModel = {
    id: string
    name: string
    owner: string
    bytes: number | null
    resident: boolean
    device: "gpu" | "cpu" | null
}

export type RemoteModels = {
    cached: RemoteModel[]
    resident: RemoteModel[]
}
