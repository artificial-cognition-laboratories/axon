import type { MockStep } from "./mock"

/**
 * How a mock step is written as AIR.
 *
 * Mock is the one "driver" that AUTHORS tokens rather than relaying them.
 * Every other driver is a dumb pipe: a real model produced the blocks, and
 * the driver never knows or cares which grammar they are in. Mock has no
 * model, so it must emit the syntax itself.
 *
 * There is only one vocabulary to emit. `<text>` is a structure the model
 * produced; `<script>` is the computation it ran. Every protocol that has
 * blocks at all uses those two, so nothing here has to detect anything —
 * this used to read the rendered <contract> to pick between two dialects,
 * which stopped being a question once the tags unified.
 *
 * A step describes INTENT — speak, or run code. That is why the public
 * MockStep API never changed when the tags did.
 */
export function render(step: MockStep, isLast: boolean): string {
    // <done/> is the model handing control back, and both kinds of step do
    // that: a script yields so it can see its own result next wake, spoken
    // text yields because it is finished. What differs is a NON-final step
    // in a sequence — "hi" then "how are you?" is one continuing turn, not
    // two independent replies, so it withholds the tag.
    const block = typeof step === "string"
        ? `<text>${step}</text>`
        : `<script>${step.code}</script>`
    return isLast ? `${block}<done/>` : block
}
