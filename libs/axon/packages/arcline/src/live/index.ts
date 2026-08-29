/**
 * live — the animated and interactive layer.
 *
 * The only code in arcline that moves a cursor or reads a key. Everything
 * animated is a pure view repainted by `Live`; everything interactive is a
 * prompt that repaints the same way and restores the terminal on every exit
 * path.
 */

export { Live, type LiveHandle, type LiveOpts } from "./live.ts"
export { text, confirm, PromptCancelled, type TextPromptOpts, type ConfirmOpts } from "./prompt.ts"
