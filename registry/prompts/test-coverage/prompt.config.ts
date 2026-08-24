// test-coverage — a prompt package: one or more units of work, shareable on their own.
//
// Every top-level .vue/.md file in this folder is an invokable prompt.
// components/ holds fragments they compose and is never invokable itself.
export default definePrompt({
    description: "Find the untested code that matters and close the gaps worth closing.",
})
