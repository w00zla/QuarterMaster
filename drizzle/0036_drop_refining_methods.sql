DROP TABLE "ext"."refining_method" CASCADE;--> statement-breakpoint
DELETE FROM "ext"."snapshot" WHERE "source" = 'uex' AND "endpoint" IN ('refineries_yields', 'refineries_methods');
