// accessibility — a prompt package: one or more units of work, shareable on their own.
//
// Every top-level .vue/.md file in this folder is an invokable prompt.
// components/ holds fragments they compose and is never invokable itself.
export default definePrompt({
    description: "Make an interface work by keyboard, screen reader, and at high zoom.",
})
