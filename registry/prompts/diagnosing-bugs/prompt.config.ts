// diagnosing-bugs — a prompt package: one or more units of work, shareable on their own.
//
// Every top-level .vue/.md file in this folder is an invokable prompt.
// components/ holds fragments they compose and is never invokable itself.
//
// Adapted from mattpocock/skills (MIT). See README.md for attribution.
export default definePrompt({
    description: "Six-phase discipline for hard bugs — build a red-capable loop before theorising.",
})
