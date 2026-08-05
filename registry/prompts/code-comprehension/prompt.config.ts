// code-comprehension — a prompt package: one or more units of work, shareable on their own.
//
// Every top-level .vue/.md file in this folder is an invokable prompt.
// components/ holds fragments they compose and is never invokable itself.
export default definePrompt({
    description: "Understand a specific piece of code well enough to change it, and say what you're unsure of.",
})
