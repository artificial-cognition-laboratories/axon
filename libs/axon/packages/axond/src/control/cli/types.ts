import type { Renderer } from "@arcforge/arcline"
import type { AxondT } from "../../axond"
import type { AxonDaemon } from "../../client"
import type { FormatT } from "./format"

export type CliContext = { axond: AxondT; renderer: ReturnType<typeof Renderer>; format: FormatT; client: ReturnType<typeof AxonDaemon> }
