// grilling — a prompt package: one or more units of work, shareable on their own.
//
// Every top-level .vue/.md file in this folder is an invokable prompt.
// components/ holds fragments they compose and is never invokable itself.
//
// Adapted from mattpocock/skills (MIT). See README.md for attribution.
export default definePrompt({
    description: "Stress-test a plan through a relentless one-question-at-a-time interview.",
})
