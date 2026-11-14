import { err } from "@arcforge/err"
import type { body } from "@arcforge/types"
import { rotation } from "./rotation"
import type { Skeleton } from "./types"

type Vec3 = [number, number, number]
type Quat = [number, number, number, number]

const INTERFACES = ["position", "velocity", "effort"]

/**
 * URDF text for a skeleton: its frames as links and joints, a mimic joint's
 * `<mimic>`, its driven joints as a `<ros2_control>` block, and — when it is
 * anchored — a `world` link it is fixed to. Senses other than joint states
 * are not written: URDF has none.
 */
export function write(skeleton: Skeleton): string {
    const lines = [`<?xml version="1.0"?>`, `<robot name="${emit.escape(skeleton.name)}">`]
    const names = new Map(skeleton.frames.filter(frame => frame.joint).map(frame => [frame.name, frame.joint!.name ?? frame.name]))
    if (skeleton.anchored) lines.push(`  <link name="world"/>`)
    for (const frame of skeleton.frames) lines.push(...emit.link(frame))
    if (skeleton.anchored) {
        const base = skeleton.frames.find(frame => frame.parent === null)!
        lines.push(`  <joint name="world_fixed" type="fixed">`, `    <parent link="world"/>`, `    <child link="${emit.escape(base.name)}"/>`, `  </joint>`)
    }
    for (const frame of skeleton.frames) if (frame.parent !== null) lines.push(...emit.joint(frame, names))
    lines.push(...emit.control(skeleton, names))
    lines.push(`</robot>`)
    return lines.join("\n") + "\n"
}

/** Each part of a URDF document, written. */
const emit = {
    link(frame: body.Frame): string[] {
        const lines = [`  <link name="${emit.escape(frame.name)}">`]
        if (frame.mass !== undefined) {
            const [ixx, ixy, ixz, iyy, iyz, izz] = frame.inertia ?? [0, 0, 0, 0, 0, 0]
            lines.push(`    <inertial>`, `      ${emit.origin(frame.centre ?? [0, 0, 0], [0, 0, 0, 1])}`, `      <mass value="${frame.mass}"/>`,
                `      <inertia ixx="${ixx}" ixy="${ixy}" ixz="${ixz}" iyy="${iyy}" iyz="${iyz}" izz="${izz}"/>`, `    </inertial>`)
        }
        if (frame.shape) {
            const tag = emit.geometry(frame.shape)
            const placed = emit.origin(frame.shape.place?.at ?? [0, 0, 0], frame.shape.place?.turn ?? [0, 0, 0, 1])
            for (const part of ["visual", "collision"]) lines.push(`    <${part}>`, `      ${placed}`, `      <geometry>${tag}</geometry>`, `    </${part}>`)
        }
        lines.push(`  </link>`)
        return lines
    },

    /** The joint a frame hangs from, `names` giving every moving frame's joint name. */
    joint(frame: body.Frame, names: Map<string, string>): string[] {
        const joint = frame.joint
        const name = joint?.name ?? (joint ? frame.name : `${frame.name}_fixed`)
        const lines = [`  <joint name="${emit.escape(name)}" type="${joint?.type ?? "fixed"}">`, `    <parent link="${emit.escape(frame.parent!)}"/>`, `    <child link="${emit.escape(frame.name)}"/>`,
            `    ${emit.origin(frame.at, frame.turn)}`]
        if (joint) {
            lines.push(`    <axis xyz="${joint.axis.join(" ")}"/>`)
            const limits = joint.limits
            if (limits) {
                const [lower, upper] = limits.position ?? [0, 0]
                lines.push(`    <limit lower="${lower}" upper="${upper}" velocity="${limits.velocity ?? 0}" effort="${limits.effort ?? 0}"/>`)
            }
            if (joint.dynamics) lines.push(`    <dynamics damping="${joint.dynamics.damping ?? 0}" friction="${joint.dynamics.friction ?? 0}"/>`)
            if (joint.mimic) {
                const followed = names.get(joint.mimic.joint)
                if (!followed) fail(`frame ${frame.name} mimics ${joint.mimic.joint}, which has no joint`)
                lines.push(`    <mimic joint="${emit.escape(followed)}" multiplier="${joint.mimic.multiplier}" offset="${joint.mimic.offset}"/>`)
            }
        }
        lines.push(`  </joint>`)
        return lines
    },

    /** The `<ros2_control>` block for the joints a skeleton drives and reads; none when it drives and reads none. */
    control(skeleton: Skeleton, names: Map<string, string>): string[] {
        const driven = emit.driven(skeleton, names)
        if (driven.size === 0) return []
        const lines = [`  <ros2_control name="${emit.escape(skeleton.name)}" type="system">`]
        for (const [joint, interfaces] of driven) {
            lines.push(`    <joint name="${emit.escape(joint)}">`)
            for (const command of interfaces.commands) {
                lines.push(`      <command_interface name="${command.interface}">`)
                if (command.range) lines.push(`        <param name="min">${command.range[0]}</param>`, `        <param name="max">${command.range[1]}</param>`)
                lines.push(`      </command_interface>`)
            }
            for (const state of interfaces.states) lines.push(`      <state_interface name="${state}"/>`)
            lines.push(`    </joint>`)
        }
        lines.push(`  </ros2_control>`)
        return lines
    },

    origin(at: Vec3, turn: Quat): string {
        return `<origin xyz="${at.join(" ")}" rpy="${rotation.toRpy(turn).join(" ")}"/>`
    },

    geometry(shape: body.Shape): string {
        switch (shape.kind) {
            case "box": return `<box size="${shape.size.join(" ")}"/>`
            case "cylinder": return `<cylinder radius="${shape.radius}" length="${shape.length}"/>`
            case "sphere": return `<sphere radius="${shape.radius}"/>`
            case "mesh": return `<mesh filename="${emit.escape(shape.ref.uri)}"${shape.scale ? ` scale="${shape.scale.join(" ")}"` : ""}/>`
        }
    },

    /** The joints a skeleton drives and reads, by URDF joint name: its joint-driving vector controls and JointState senses. */
    driven(skeleton: Skeleton, names: Map<string, string>): Map<string, { commands: body.ControlComponent[]; states: string[] }> {
        const driven = new Map<string, { commands: body.ControlComponent[]; states: string[] }>()
        const entry = (joint: string) => driven.get(joint) ?? (driven.set(joint, { commands: [], states: [] }), driven.get(joint)!)
        for (const control of skeleton.controls) {
            if (control.kind !== "vector") continue
            for (const component of control.components) {
                if (!component.joint || !INTERFACES.includes(component.interface)) continue
                const joint = names.get(component.joint)
                if (!joint) fail(`control ${control.channel} drives ${component.joint}, which has no joint`)
                entry(joint).commands.push(component)
            }
        }
        for (const sense of skeleton.senses) {
            if (sense.kind !== "vector" || sense.profile !== "sensor_msgs/JointState") continue
            for (const component of sense.components) {
                const cut = component.name.lastIndexOf(".")
                const [joint, kind] = [component.name.slice(0, cut), component.name.slice(cut + 1)]
                if (!INTERFACES.includes(kind)) continue
                entry(names.get(joint) ?? joint).states.push(kind)
            }
        }
        return driven
    },

    escape(text: string): string {
        return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    },
}

function fail(detail: string): never {
    throw err("BODY_URDF_INVALID", { detail: detail })
}
