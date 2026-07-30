// The runtime's handle over a compiled cognet artifact — the LOADER, not the
// runtime. Everything that executes inside a brain (host, clock, ecs, air)
// lives in @arcforge/cognet, which is public; this side stays private.
export { Cognet, type CognetT } from "./cognet"
