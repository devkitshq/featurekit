/** The schema featurekit uses when none is configured. */
export const DEFAULT_SCHEMA = "public";

/**
 * Lowercase, unquoted Postgres identifiers only. A name that needs quoting would
 * have to be quoted identically in the `search_path`, in Drizzle's migrations
 * table and in pg_partman's config, and one place getting it wrong is a schema
 * that half works.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function isValidSchemaName(name: string): boolean {
  return SCHEMA_NAME.test(name) && !name.startsWith("pg_");
}
