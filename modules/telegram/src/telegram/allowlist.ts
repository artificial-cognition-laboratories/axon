/**
 * User allowlist.
 *
 * If TELEGRAM_ALLOWED_USERS is set, only those user IDs can interact with the
 * agent. Critical for personal bots — without this, anyone who finds your bot
 * can send messages to your agent.
 *
 * Set to a comma-separated list of Telegram user IDs:
 *   TELEGRAM_ALLOWED_USERS=123456789,987654321
 *
 * Find your user ID by messaging @userinfobot on Telegram.
 *
 * If unset, all users are allowed (suitable for public bots).
 */

let _allowlist: Set<number> | null = null

function allowlist(): Set<number> | null {
    if (_allowlist !== undefined) return _allowlist

    const raw = process.env.TELEGRAM_ALLOWED_USERS
    if (!raw?.trim()) {
        _allowlist = null
        return null
    }

    _allowlist = new Set(
        raw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
    )
    return _allowlist
}

export function isAllowed(userId: number): boolean {
    const list = allowlist()
    if (!list) return true  // no allowlist = open
    return list.has(userId)
}
