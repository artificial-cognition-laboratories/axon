import type { Axis } from "../../src/pure"

/**
 * The first axis table for a coding mind's memory — chosen by the decisions it
 * would serve (what kind of help, how careful to be, how it is landing), not
 * to describe software. `topic` is the deliberate stress case: open-ended
 * subject matter, where named graded axes are least at home.
 *
 * Every question is about ONE message a person sent to a coding agent.
 */
export const AXES: readonly Axis[] = [
    // task — what kind of help is being asked for
    { name: "task:debug", domain: "task", kind: "noul", question: "The person is asking to find or fix something that is broken." },
    { name: "task:design", domain: "task", kind: "noul", question: "The person is working out a design, an architecture or a plan, rather than asking for code now." },
    { name: "task:build", domain: "task", kind: "noul", question: "The person is asking for something new to be implemented." },
    { name: "task:review", domain: "task", kind: "noul", question: "The person is asking for an opinion, an assessment or a review of existing work." },
    { name: "task:operate", domain: "task", kind: "noul", question: "The person is asking about running, installing, deploying or configuring something, rather than changing code." },
    { name: "task:explain", domain: "task", kind: "noul", question: "The person is asking to understand how something works." },

    // state — where the work stands, as the message shows it
    { name: "state:stuck", domain: "state", kind: "noul", question: "Something has failed repeatedly, or the work is going in circles." },
    { name: "state:approve", domain: "state", kind: "noul", question: "The person approves of work the agent just did." },
    { name: "state:correct", domain: "state", kind: "noul", question: "The person says the agent's previous work or understanding was wrong." },

    // mood — how it is landing
    { name: "mood:frustrated", domain: "mood", kind: "noul", question: "The person is frustrated or annoyed." },
    { name: "mood:pleased", domain: "mood", kind: "noul", question: "The person is pleased or enthusiastic." },
    {
        name: "mood:urgency", domain: "mood", kind: "score", question: "How urgently does the person want this?",
        levels: ["No urgency: exploring or thinking aloud", "Normal: ordinary next step", "Pressing: blocking their work", "Urgent: something is broken right now"],
    },

    // scope — how far the change reaches, and what it could break
    {
        name: "scope:reach", domain: "scope", kind: "score", question: "How much of the system does this message concern?",
        levels: ["One line or detail", "One file or function", "One feature or module", "Several modules", "The whole system or its architecture"],
    },
    { name: "scope:risk", domain: "scope", kind: "noul", question: "Acting on this message could destroy data, break production, or be hard to undo." },

    // topic — what part of the system it is about
    { name: "topic:mind", domain: "topic", kind: "noul", question: "It concerns the cognet: the mind, its systems, components, perception or learning." },
    { name: "topic:interface", domain: "topic", kind: "noul", question: "It concerns a user interface: the TUI, the Fleet editor extension, or a web page." },
    { name: "topic:infra", domain: "topic", kind: "noul", question: "It concerns infrastructure: deployment, cloud, CI, containers, servers or the database." },
    { name: "topic:runtime", domain: "topic", kind: "noul", question: "It concerns the agent runtime: Axon core, the kernel, tools, sessions or the CLI." },
    { name: "topic:body", domain: "topic", kind: "noul", question: "It concerns a robot or game body, a simulated world, or a lab." },
    { name: "topic:account", domain: "topic", kind: "noul", question: "It concerns accounts, authentication, credentials, billing or providers." },
    { name: "topic:docs", domain: "topic", kind: "noul", question: "It concerns documentation or written explanation." },
]

/**
 * What a person might search their memory for. Half SITUATIONAL — qualities of
 * a moment, where named axes should be at home — and half TOPICAL, the case
 * the table is weakest at.
 */
export const QUERIES: ReadonlyArray<{ kind: "situational" | "topical"; text: string }> = [
    { kind: "situational", text: "times I was frustrated that something kept breaking" },
    { kind: "situational", text: "when I told the agent it had got it wrong" },
    { kind: "situational", text: "big architecture discussions" },
    { kind: "situational", text: "risky changes that could break production" },
    { kind: "situational", text: "when I was happy with the result" },
    { kind: "topical", text: "auth system" },
    { kind: "topical", text: "the Fleet extension's job view" },
    { kind: "topical", text: "deploying to the cloud" },
    { kind: "topical", text: "the robot's perception" },
    { kind: "topical", text: "how prompts and scripts are declared" },
]
