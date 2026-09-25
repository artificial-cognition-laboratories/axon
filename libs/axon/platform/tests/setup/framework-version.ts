/**
 * The env var the preload resolves the published framework version into, and
 * ./user reads back synchronously.
 *
 * Its own module, not part of ./user, because the preload has to set the
 * variable BEFORE ./user can be evaluated: `user.ts` reads it at module scope
 * and throws when it is missing, so importing ./user to reach this name would
 * trip the very check it exists to satisfy.
 *
 * The lookup itself lives in `@arclabs/repo`'s Framework() — the local
 * registry seeder pins artifacts by the same rule, and two implementations of
 * "which version can actually be installed" is somewhere for them to disagree.
 */
export const PUBLISHED_VERSION_ENV = "AXON_TEST_PUBLISHED_FRAMEWORK_VERSION"
