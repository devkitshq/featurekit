-- No SDK ever sent a sketch, so the column was always null.
ALTER TABLE "evaluation_summaries" DROP COLUMN IF EXISTS "unique_sketch";
