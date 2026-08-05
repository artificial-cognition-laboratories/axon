// document — a prompt package: one or more units of work, shareable on their own.
//
// Every top-level .vue/.md file in this folder is an invokable prompt.
// components/ holds fragments they compose and is never invokable itself.
export default definePrompt({
    description: "Write documentation that answers the question the reader arrived with.",
})
