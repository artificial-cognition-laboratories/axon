/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE BODY CONTRACT — axon.body/1                          2026-10-08
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * How any body — a Minecraft player, a Terraria one, a container's shell, a
 * robot behind ROS — is worn by any mind. Exported from @arcforge/types as
 * the `body` namespace (`body.Manifest`). Checking a manifest, the wire, URDF
 * and examples of real bodies are @arcforge/body's.
 *
 * THE SHAPE
 *
 *   lab lease ─► endpoint ─► connect ─► Manifest ─► readings · commands · skills
 *                                               └─► truth (recorded, never to the mind)
 *
 *   A body describes itself once, in a Manifest, then streams readings and
 *   takes commands on the channels it declared. Everything game- or
 *   robot-specific lives on the body's side, so an agent needs ONE generic
 *   body module, not one per game.
 *
 * THE RULES
 *
 *   1. The kernel's two verbs already split the way ROS does. `output()` is a
 *      topic the mind publishes — unmediated, for control loops — and carries
 *      Commands. `run()` is an action — policy-checked, with a result — and
 *      carries Skill requests. A control loop never goes through `run()`.
 *
 *   2. Physical quantities are SI (ROS REP 103): metres, seconds, radians. A
 *      Minecraft block is one metre, Minecraft's own convention. The body
 *      converts once, so no mind ever converts per body.
 *
 *   3. Truth is a different message, not a filtered field. What the body
 *      senses is a Reading; what the world knows (true position, velocity) is
 *      Truth, recorded beside the session and never delivered. Nothing has to
 *      be stripped before the mind sees it.
 *
 *   4. Every reading is stamped on the body's own clock, and every command
 *      says which reading it was decided on — so sense-to-act latency is
 *      measured for every command, on one clock.
 *
 *   5. Three protections, three places — none of them in a control loop:
 *      CONTAINMENT (the OS wall around the mind's process) is paid once, at
 *      spawn. MEDIATION (the policy check on `run()`) is per skill. LIMITS
 *      (ranges, slew, the lapse) are enforced by the BODY, on whatever
 *      arrives: the manifest declares them so the mind knows, and the mind
 *      cannot change them. So `output()` needs no check: the body clamps —
 *      and says, in `applied`, what it actually did.
 *
 *   6. What is safe when the mind stops is the body's to say. Letting go is
 *      safe for legs and fatal for a drone, so every control declares its
 *      lapse: let go, keep the target, or a behaviour of the body's own
 *      (hover, then land). The mind never has to stay alive to keep a body
 *      safe.
 *
 *   7. One mind wears one body, and one agent has one mind. A swarm, a house
 *      of devices, two arms: each is one body with many parts, or many
 *      agents. Nothing here addresses a second body.
 *
 * HOW IT MAPS TO ROS
 *
 *   Clock        header stamp           Sense      sensor_msgs topic
 *   Frame        link (URDF), tf        Control    ros2_control command interface
 *   Joint        joint (URDF)           Skill      action (goal → progress → result)
 *   Place        map, odom, earth       Lapse      a controller's timeout and safe state
 *   Lens         sensor_msgs/CameraInfo Trajectory trajectory_msgs/JointTrajectory
 *   Component    message field          Truth      — (a lab's privilege)
 */

// ═══════════════════════════════════════════════════════════════════════════
//  0. JOINING — how a mind comes to wear a body
// ═══════════════════════════════════════════════════════════════════════════
//
//  The WORLD brings the body; the agent brings only the mind. A body is part
//  of its world — a player in Minecraft, a robot in a simulator — so the lab
//  offers bodies, and the agent's body module asks for one:
//
//    1. Lease      the body module asks the lab for a body (LeaseRequest);
//                  the lab picks or boots one, puts it in the world, and
//                  answers where it is (Lease). A lab hands out bodies of
//                  its own kind; which lab an agent asks is its choice.
//    2. Connect    to the endpoint, with the token. The body sends its
//                  Manifest, then Presence.
//    3. Mount      the manifest is handed to the kernel; senses become
//                  stimuli, controls are what `output()` drives, skills are
//                  what `run()` may ask, truth goes to the recorder.
//    4. Live       Readings in; Commands and SkillRequests out.
//    5. Leave      release the lease, or drop the connection: every control
//                  lapses as it declared, and the lab takes the body back.

/** What the agent's body module asks a lab for. */
export type LeaseRequest = {
    /** The agent, as its package names it. */
    agent: string
}

/** The lab's answer: a body, where it is, and how to reach it. */
export type Lease = {
    lease: string
    /** What the lab calls the body, the world it is in, and the name it goes by there — for logs and people. */
    body: string
    world: string
    identity: string
    /** Where the body speaks this contract — a WebSocket URL. */
    endpoint: string
    /** Presented when connecting; good for this lease only. */
    token: string
    /** When the lease runs out unless renewed, ms since the epoch; absent, it is held until released. */
    expires?: number
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. THE MANIFEST — what a body says about itself
// ═══════════════════════════════════════════════════════════════════════════

/** Sent when the body connects, and whole again whenever any of it changes. */
export type Manifest = {
    /** A body speaking a contract the mind does not know is refused by name, never guessed at. */
    contract: "axon.body/1"
    /** `minecraft.player`, `ros2:turtlebot4`. For logs and people — a mind must never branch on it. */
    kind: string
    clock: Clock
    world: World
    frames: Frame[]
    senses: Sense[]
    controls: Control[]
    skills: Skill[]
}

/**
 * What every `sensed` stamp counts: milliseconds since some moment of the
 * body's own. A body that moves in steps (a game at 20 ticks a second, a
 * physics simulation) gives its step.
 *
 * Stamps from one body compare only with each other — never with the mind's
 * clock, never with another body's.
 */
export type Clock = {
    unit: "ms"
    step?: number
    pace: Pace
}

/**
 * How the body's time passes against the wall's — what a mind needs to know
 * before it budgets a deadline in it.
 *
 *   real      as the wall's: a robot, a game played live
 *   scaled    `factor` times the wall's: a simulation run fast or slow, 0
 *             while paused. A change of pace is a change of manifest.
 *   stepped   only when told: the body advances `steps` steps on a Step,
 *             says everything it sensed, then waits (Waiting). Training,
 *             and any simulation that must not run ahead of its mind.
 *             Needs `step`.
 */
export type Pace = { kind: "real" } | { kind: "scaled"; factor: number } | { kind: "stepped" }

/**
 * The world as the body lives in it — what is true of the space, not of the
 * body: how many dimensions it has, how hard it pulls, and the frames fixed
 * to it that some senses read in (REP 105).
 */
export type World = {
    space: Space
    /** How hard the world pulls down (its −z), m/s². Absent where nothing pulls: orbit, a top-down world. */
    gravity?: number
    /** The base is fixed to the world and never moves in it: an arm on a bench, a house. */
    anchored?: boolean
    /** Frames fixed to the world rather than the body. A sense may read in one; none is ever a body's frame. */
    places: Place[]
}

/**
 * Three dimensions, or two: a plane the body lives in, named by the two of its
 * base's axes that span it. A side-on world (Terraria) is `xz` — forward and
 * up, nothing to the left. A top-down world is `xy` — no up. Or none: a body
 * with no place in any space — a shell, an account — is its base alone, and
 * nothing in it names a frame.
 */
export type Space = { dimensions: 3 } | { dimensions: 2; plane: "xz" | "xy" } | { dimensions: 0 }

/**
 * A frame fixed to the world.
 *
 *   local      flat and level: z up, x and y level — east and north where the
 *              place has a compass. A room's motion capture, a site's map, a
 *              game's world.
 *   geodetic   on a planet: latitude and longitude, rad, and height above
 *              its reference surface, m — what a GNSS receiver reads.
 *              `datum` names the surface: `WGS84` for Earth,
 *              `IAU_2015:49900` for Mars.
 */
export type Place = { name: string; kind: "local" } | { name: string; kind: "geodetic"; datum: string }

/**
 * A set of axes, placed on its parent. Exactly one frame has no parent: the
 * body's base. Together they form a tree (ROS: tf).
 *
 *   flu — x forward, y left, z up      for a body and its parts
 *   rdf — x right, y down, z forward   for a camera's optical axes
 *
 * A frame is a link of the body's skeleton (URDF). `at` and `turn` place it
 * on its parent as it rests. A frame with no `joint` never moves on its parent
 * (a camera bolted to a head); one with a joint moves as the joint does.
 *
 * A skeleton is optional: a body may be one frame and a camera (Terraria), or
 * a dozen jointed links (a quadruped). It is the same shape either way.
 */
export type Frame = {
    name: string
    parent: string | null
    axes: "flu" | "rdf"
    /** metres, in the parent's axes, at rest */
    at: Vec3
    /** a unit quaternion, [x, y, z, w], at rest */
    turn: Quat
    joint?: Joint
    /** What the link is, for a mind that models its own body: what it is made of, what it bumps into. */
    shape?: Shape
    /** kg */
    mass?: number
    /** Where the mass is centred, metres in the frame's axes — at its origin when absent. */
    centre?: Vec3
    /** kg·m², about the centre of mass, in the frame's axes: [ixx, ixy, ixz, iyy, iyz, izz] — for a mind, or a simulator, that models its dynamics. */
    inertia?: [number, number, number, number, number, number]
}

/**
 * How a frame moves on its parent (URDF joint types):
 *
 *   revolute     turns about `axis`, within limits — a knee
 *   continuous   turns about `axis`, without end — a wheel
 *   prismatic    slides along `axis` — a lift
 *   planar       moves in the plane normal to `axis`
 *   floating     moves freely — a body's base in its world
 *
 * Where a joint IS arrives on a sense of profile `sensor_msgs/JointState`, its
 * components named after the joints; a joint no sense reports is known only
 * through what the body feels and what was sent.
 */
export type Joint = {
    /** The joint's own name, where it has one apart from its frame's (URDF names joints and links separately). */
    name?: string
    type: "revolute" | "continuous" | "prismatic" | "planar" | "floating"
    /** In this frame's own axes, a unit vector. */
    axis: Vec3
    limits?: {
        /** rad or m */
        position?: [number, number]
        /** rad/s or m/s */
        velocity?: number
        /** N·m or N */
        effort?: number
    }
    /** How the joint resists: viscous `damping` (N·m·s/rad or N·s/m) and dry `friction` (N·m or N). */
    dynamics?: { damping?: number; friction?: number }
    /**
     * Moves as another joint does, never on its own: at `multiplier` × the
     * other's position + `offset` — a gripper's second finger. `joint` names
     * the other's frame. Nothing drives a mimicking joint.
     */
    mimic?: { joint: string; multiplier: number; offset: number }
}

/**
 * What a link is shaped like, placed on its frame by `place` (at its origin
 * when absent). One shape a link: a cylinder's length runs along its z, as in
 * URDF.
 */
export type Shape = (
    | { kind: "box"; size: Vec3 }
    | { kind: "cylinder"; radius: number; length: number }
    | { kind: "sphere"; radius: number }
    /** A mesh too large to carry, scaled by `scale`. */
    | { kind: "mesh"; ref: Ref; scale?: Vec3 }
) & { place?: { at: Vec3; turn: Quat } }

/** One number in a reading or a command: what it is, in what, and its limits. */
export type Component = {
    name: string
    /**
     * SI when physical — m, m/s, m/s², rad, rad/s, N, K; otherwise bool,
     * count, fraction — or `category`: one of `categories`, by its index (a
     * flight mode, a gear, what the hands hold).
     */
    unit: string
    range?: [number, number]
    /** How far off one reading is, one standard deviation, in its unit — what an estimator weighs it by (ROS: covariance). */
    noise?: number
    /** What each index means, when the unit is `category`; only then. */
    categories?: string[]
}

// ── senses ────────────────────────────────────────────────────────────────

/**
 * One instrument, on the channel its readings arrive as stimuli. What every
 * reading would otherwise repeat — its frame, its components, a camera's lens —
 * is said once, here.
 */
export type Sense = VectorSense | VisualSense | AudioSense | TextSense

type SenseBase = {
    channel: string
    /** Whose axes its numbers or its picture are in — a body frame, or a place (a GNSS fix is the planet's). Absent for what has no direction: hunger, a microphone. */
    frame?: string
    /** Readings a second, nominal; every reading carries its own stamp. */
    rate?: number
    /** The convention it follows — `sensor_msgs/Imu`, `sensor_msgs/JointState`, `axon/contact`. A join key, never validated. */
    profile?: string
}

/** Measured quantities: an IMU, contact, joint angles, hunger, a GNSS fix. */
export type VectorSense = SenseBase & {
    kind: "vector"
    components: Component[]
}

/** A picture: its size, how it lies on the world, and what each pixel measures. */
export type VisualSense = SenseBase & {
    kind: "visual"
    width: number
    height: number
    lens: Lens
    pixel: Pixel
}

/**
 * How a picture lies on the world, in the sense's frame.
 *
 *   perspective    a pinhole (ROS CameraInfo): `focal` lengths and the
 *                  optical `centre`, px, and the lens's distortion when it
 *                  has any. Its optical frame is `rdf`.
 *   orthographic   `scale` metres of world a pixel — a side-on game's camera.
 *   polar          a scanner, or a camera that sees all round: each column a
 *                  direction about the frame's z, `from` to `to` rad; each
 *                  row an elevation, rad, top row first — evenly `from` `to`,
 *                  or each row's own (a 3D lidar's beams are uneven). A 2D
 *                  lidar is one row at elevation 0.
 */
export type Lens =
    | { kind: "perspective"; focal: [number, number]; centre: [number, number]; distortion?: Distortion }
    | { kind: "orthographic"; scale: number }
    | { kind: "polar"; from: number; to: number; elevation: { from: number; to: number } | number[] }

/**
 * A lens's distortion, as ROS's camera models give it: `plumb_bob` (k1 k2 p1
 * p2 k3), `rational_polynomial` (k1 k2 p1 p2 k3 k4 k5 k6), `equidistant` — a
 * fisheye — (k1 k2 k3 k4).
 */
export type Distortion = { model: "plumb_bob" | "rational_polynomial" | "equidistant"; coefficients: number[] }

/**
 * What one pixel measures.
 *
 *   colour    light, as seen
 *   depth     how far what it sees is — along the camera's z for a
 *             perspective lens (ROS depth images), along the ray for a polar
 *             one — m, up to `range`; 0 where nothing was met
 *   measure   one quantity in `unit`: a thermal camera's K, a lidar's return
 *             intensity
 */
export type Pixel = { kind: "colour" } | { kind: "depth"; range: number } | { kind: "measure"; unit: string; range?: [number, number] }

export type AudioSense = SenseBase & {
    kind: "audio"
    /** samples a second */
    sampleRate: number
    channels: number
}

/**
 * Words the body hears or reads — a terminal's output — or, with `format`
 * `json`, a reading of a shape the body declares in `schema`: things of no
 * fixed number (what is detected, who is near, what the hands hold), and
 * chat with who said it. Either way it reaches the mind as text, which is
 * what symbols are.
 */
export type TextSense = SenseBase & {
    kind: "text"
    format?: "json"
    /** JSON Schema of every reading's text, parsed; only with `format` `json`. */
    schema?: object
}

// ── controls ──────────────────────────────────────────────────────────────

/**
 * One stream of acts, on the channel the mind outputs on. The mirror of a
 * Sense: a vector control moves something, a text control says something (a
 * chat line), an audio control sounds something.
 */
export type Control = VectorControl | TextControl | AudioControl

type ControlBase = {
    channel: string
    profile?: string
}

/**
 * Something driven: a command sets every component at once, in declared order
 * — one act, not several.
 */
export type VectorControl = ControlBase & {
    kind: "vector"
    /** Whose axes it is given in: a body frame, or a place — a drone told a velocity over the ground. */
    frame?: string
    components: ControlComponent[]
    lapse: Lapse
    /** How often the body reads it: commands sent faster are superseded unseen. */
    rate?: number
    /**
     * It takes commands planned ahead — up to `points` timed points, each
     * applied at its time on the body's clock, `step` held until the next or
     * `linear` moved towards it. A rover's drive sequence, an arm's
     * trajectory. The lapse counts from the last point.
     */
    trajectory?: { points: number; interpolation: "step" | "linear" }
}

/**
 * What the body does when the mind stops saying — a command's time runs out,
 * the connection drops, the lease ends.
 *
 *   release     `after` ms without a command, every component is let go: a
 *               switch off; an axis, velocity or effort zero; a position no
 *               longer held, so the joint goes limp. Legs, wheels.
 *   keep        the last command stays applied until the next. Only for
 *               targets — a position, a choice — never a velocity or effort,
 *               which run away left applied.
 *   behaviour   `after` ms without a command, the body takes over with a
 *               behaviour of its own until commanded again: a drone hovers
 *               then lands, a car brakes to a stop.
 */
export type Lapse =
    | { kind: "release"; after: number }
    | { kind: "keep" }
    | { kind: "behaviour"; after: number; name: string; describe: string }

/** Words the body says or types: a chat line, keystrokes into a terminal. */
export type TextControl = ControlBase & {
    kind: "text"
}

/** Sound the body makes. */
export type AudioControl = ControlBase & {
    kind: "audio"
    sampleRate: number
    channels: number
}

export type ControlComponent = Component & {
    interface: Interface
    /** The joint it drives, when it drives one — by the name of the FRAME it moves (as a mimic names its leader), so nothing depends on order. */
    joint?: string
    /** The most it may change in a second, in its unit per second — an acceleration limit on a velocity. The body clamps it. */
    slew?: number
}

/**
 * How a component is driven (ros2_control's command interfaces):
 *
 *   switch     on or off — a key
 *   axis       −1..1 — a stick
 *   choice     one of the component's `categories`, by index — a gear
 *   position   driven to a target, in its unit
 *   velocity   driven at a speed, in its unit
 *   effort     driven with a force or torque, in its unit
 */
export type Interface = "switch" | "axis" | "choice" | "position" | "velocity" | "effort"

// ── skills ────────────────────────────────────────────────────────────────

/**
 * Something the body can be asked to do, that answers (ROS: an action) —
 * `craft`, `navigate_to`, `exec`. Asked through `run()`, so it passes the
 * policy check like every other request.
 *
 * Seen this way, the TypeScript and bash a coding agent runs today are the
 * Linux machine's skills: the agent already wears the machine as a body.
 */
export type Skill = {
    name: string
    /** What it does — for a person, or a model choosing a skill. */
    describe: string
    /** JSON Schema of what it is asked with. */
    args: object
    /** JSON Schema of what it answers. */
    result: object
    cancellable: boolean
    /** The longest it takes before the body itself gives up, ms. */
    within: number
}

// ═══════════════════════════════════════════════════════════════════════════
//  2. FROM THE BODY — what a body says while worn
// ═══════════════════════════════════════════════════════════════════════════

export type FromBody = ManifestMessage | Reading | Truth | Applied | SkillUpdate | Presence | Waiting

export type ManifestMessage = {
    type: "manifest"
    manifest: Manifest
}

/**
 * One reading of one sense: it becomes the stimulus its Sense declared. A
 * vector sense sends `values`, in its components' order; a camera or
 * microphone sends a `ref` to the bytes; a text sense sends `text` — JSON of
 * its schema, when its format is `json`.
 */
export type Reading = {
    type: "reading"
    channel: string
    /** Counts this channel's readings, so a gap is visible. */
    seq: number
    /** When it was sensed, on the body's clock. */
    sensed: number
    values?: number[]
    ref?: Ref
    text?: string
}

/** Bytes too large to carry — a picture, a stretch of sound — and where they are. */
export type Ref = {
    uri: string
    mime: string
    bytes?: number
}

/**
 * The world's answer key: what is true, that the body does not sense — true
 * position, true velocity, health. Recorded beside the session for scoring,
 * NEVER delivered to the mind.
 */
export type Truth = {
    type: "truth"
    sensed: number
    values: number[]
    components: Component[]
}

/**
 * A command took effect — the other end of a command's `basis` — and what
 * took effect: after the body's limits, a vector control's `values` are what
 * the body actually did, so a mind whose command was clamped learns it.
 */
export type Applied = {
    type: "applied"
    channel: string
    /** The command's own seq. */
    seq: number
    /** Which of a trajectory's points; absent for a command of one. */
    point?: number
    /** When it took effect, on the body's clock. */
    sensed: number
    /** A vector control's components as applied, in declared order. */
    values?: number[]
}

export type SkillUpdate = {
    type: "skill"
    /** The id the mind asked with. */
    id: string
    state: "running" | "succeeded" | "failed" | "cancelled"
    progress?: unknown
    result?: unknown
    error?: string
}

/**
 * Whether the body is the mind's to move.
 *
 *   embodied     in the world: it senses, and commands act
 *   held         it senses, but holds itself and acts on nothing — an
 *                emergency stop, a safe mode, a rover asleep through the night
 *   overridden   it senses, but someone else drives it — a safety driver, a
 *                person with the controller. Commands are not applied.
 *   detached     not in any world: it neither senses nor acts
 *
 * `why` is said for every state but embodied.
 */
export type Presence =
    | { type: "presence"; state: "embodied" }
    | { type: "presence"; state: "held" | "overridden"; why: string }
    | { type: "presence"; state: "detached"; why: string }

/**
 * A stepped body has said everything it sensed up to `sensed`, and waits for
 * a Step. Only from a body whose pace is `stepped`.
 */
export type Waiting = {
    type: "waiting"
    sensed: number
}

// ═══════════════════════════════════════════════════════════════════════════
//  3. TO THE BODY — what a mind says
// ═══════════════════════════════════════════════════════════════════════════

export type ToBody = Command | SkillRequest | SkillCancel | Step

/**
 * One act on one Control — sent by `output()`. A vector control takes
 * `values`, every component at once, or — when it takes trajectories — a
 * `trajectory` of timed points; text, `text`; audio, a `ref`.
 */
export type Command = {
    type: "command"
    channel: string
    seq: number
    values?: number[]
    /** Points in order of `at`, on the body's clock; it replaces whatever plan the control was following. */
    trajectory?: { at: number; values: number[] }[]
    text?: string
    ref?: Ref
    /**
     * The `sensed` stamp of the newest reading this was decided on. With the
     * body's `applied`, it closes the loop: sensed → decided → applied, the
     * latency of acting on what was sensed.
     */
    basis?: number
}

/** Asked by `run()`, after the policy check. */
export type SkillRequest = {
    type: "skill"
    id: string
    name: string
    args: unknown
}

export type SkillCancel = {
    type: "cancel"
    id: string
}

/** Advance a stepped body `steps` steps. Only to a body whose pace is `stepped`. */
export type Step = {
    type: "step"
    steps: number
}

// ═══════════════════════════════════════════════════════════════════════════
//  4. OPEN — to settle before /1 is final
// ═══════════════════════════════════════════════════════════════════════════
//
//  · How the Manifest reaches a cognet. Stimulus kinds are closed and a
//    manifest is not a sense — it is self-knowledge. A kernel fact a cognet
//    reads, like its scope, rather than a stimulus?
//  · Minecraft's neck: declared as joints; whether a JointState sense reports
//    them (proprioception, as a robot's encoders do) or they stay truth (as
//    today, known only through the gyro and what was sent) is the lab's call.
//  · What `run()` carries for a skill: today it carries TypeScript source; a
//    skill is `{ skill, args }`, and the policy check would need both.
//  · Skills against controls: whether a skill may run while the mind drives
//    the same parts (navigate_to and /cmd_vel), and which wins. And whether a
//    skill can be unavailable for now (crafting with no table near).
//  · Media transport: refs today point at shared memory and files the daemon
//    sets up. A remote robot shares no memory with the mind; a link to Mars
//    is minutes long and narrow, and stores what it cannot send.
//  · Noise that changes reading by reading (a GNSS fix's accuracy), and
//    where each of a microphone array's channels sits.
//  · Rates: may a mind ask a body for a different rate, or is declared final?
//  · Truth's frame: true position is in some world frame; truth should name
//    which of the body's places.
//  · Bodies that are not rigid links — a tentacle, cloth — are not described.

type Vec3 = [number, number, number]
type Quat = [number, number, number, number]
