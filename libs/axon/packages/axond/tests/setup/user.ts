/**
 * Staging identities and framework resolution, shared with the platform suite.
 *
 * RE-EXPORTED rather than copied. These are facts about one thing — the seeded
 * staging database (apps/backend/supabase/seed.sql) and this repo's layout —
 * and a second copy is a second thing to update when a seed id or the repo
 * root moves. The relative reach is deliberate and narrow: both are test
 * directories inside one workspace, never a published surface, so this crosses
 * no package boundary a consumer can see.
 *
 * The supervision tests moved here when supervision did (platform builds, the
 * daemon runs), and they still need exactly the fixtures they were written
 * against.
 */
export {
    TEST_USER,
    OTHER_USER,
    TEST_VERSION,
    TEST_FRAMEWORK,
    TEST_FRAMEWORK_PUBLISHED,
    scopedName,
} from "../../../../platform/tests/setup/user"
