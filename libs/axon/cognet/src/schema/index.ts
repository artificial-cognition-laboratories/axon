/** Type-only vocabulary for cognet/types/*.ts. The compiler reads these declarations; no runtime handle is created here. */
import type { ComponentDescriptor, FrameDescriptor } from "../ecs"
export type u32 = number
export type i32 = number
export type f32 = number
export type f64 = number

export type ComponentOptions = {
    display?: Partial<Omit<ComponentDescriptor, "frame">> & { frame?: string }
}

export type FrameOptions = Omit<FrameDescriptor, "relativeTo"> & { relativeTo?: string }

/** The value and its runtime policy, attached to a named component field. */
export type Component<Value, Options extends ComponentOptions> = readonly [Value, Options]
/** The space and its runtime policy, attached to a named frame field. */
export type Frame<Options extends FrameOptions> = Options

/**
 * Something a provider keeps — an encoded picture, a loaded scene — crossing
 * only as its id. Valid for the use that made it, until released, until the
 * provider behind the use changes, or until the run that made it ends.
 */
export type Handle<Name extends string> = { readonly handle: Name; readonly id: string; release(): Promise<void> }

/** Pushes that share state: each push answered in order, until it is closed. */
export interface Session<Push, Answer> {
    push(value: Push): Promise<Answer>
    /** Starts again, as if just opened. */
    reset(): Promise<void>
    close(): Promise<void>
}
