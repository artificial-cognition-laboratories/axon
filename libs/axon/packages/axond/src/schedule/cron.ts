/** Five-field local-time cron helpers used by axond schedules. */
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const

function fieldMatches(expression: string, value: number, min: number, max: number): boolean {
    return expression.split(",").some(part => {
        const [base, stepText] = part.split("/")
        const step = stepText === undefined ? 1 : Number(stepText)
        if (!Number.isInteger(step) || step < 1) return false

        let from = min
        let to = max
        if (base !== "*") {
            const [fromText, toText] = base.split("-")
            from = Number(fromText)
            to = toText === undefined ? from : Number(toText)
            if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) return false
        }
        return value >= from && value <= to && (value - from) % step === 0
    })
}

/** Whether an expression has the supported five-field shape. */
export function isValidCron(expression: string): boolean {
    const fields = expression.trim().split(/\s+/)
    if (fields.length !== 5) return false
    return fields.every((field, index) => field.length > 0 && field.split(",").every(part => {
        const [base, stepText] = part.split("/")
        if (stepText !== undefined && (!/^\d+$/.test(stepText) || Number(stepText) < 1)) return false
        if (base === "*") return true
        const [fromText, toText] = base.split("-")
        if (!/^\d+$/.test(fromText) || (toText !== undefined && !/^\d+$/.test(toText))) return false
        const from = Number(fromText)
        const to = toText === undefined ? from : Number(toText)
        return from >= RANGES[index]![0] && to <= RANGES[index]![1] && from <= to
    }))
}

/** Whether a cron expression matches a local date. */
export function matches(expression: string, date: Date): boolean {
    const fields = expression.trim().split(/\s+/)
    if (fields.length !== 5 || !isValidCron(expression)) return false
    const [minute, hour, day, month, weekday] = fields
    return fieldMatches(minute!, date.getMinutes(), 0, 59)
        && fieldMatches(hour!, date.getHours(), 0, 23)
        && fieldMatches(day!, date.getDate(), 1, 31)
        && fieldMatches(month!, date.getMonth() + 1, 1, 12)
        && (fieldMatches(weekday!, date.getDay(), 0, 7) || (date.getDay() === 0 && fieldMatches(weekday!, 7, 0, 7)))
}

/** Find the next matching local minute after the supplied timestamp. */
export function nextRun(expression: string, from = Date.now()): number | null {
    if (!isValidCron(expression)) return null
    const cursor = new Date(from)
    cursor.setSeconds(0, 0)
    for (let minute = 1; minute <= 366 * 24 * 60; minute++) {
        cursor.setMinutes(cursor.getMinutes() + 1)
        if (matches(expression, cursor)) return cursor.getTime()
    }
    return null
}
