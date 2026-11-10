ALTER TABLE "catalog"."blueprint" ADD COLUMN "in_reward_pool" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."import" ADD COLUMN "default_composition_quality" integer;--> statement-breakpoint
ALTER TABLE "catalog"."item" ADD COLUMN "is_shop" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."item" ADD COLUMN "scu_per_piece" double precision;--> statement-breakpoint
ALTER TABLE "catalog"."item" ADD COLUMN "base_stats" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."location" ADD COLUMN "has_freight_elevator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog"."location" ADD COLUMN "has_refinery" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Fill the new columns of the rows imported so far from their raw records (what the app read there before);
-- the next import from a v7 snapshot sets them from the snapshot.
UPDATE "catalog"."location" l SET "has_freight_elevator" = true
	WHERE EXISTS (SELECT 1 FROM "catalog"."raw_record" r WHERE r."uuid" = l."uuid"
		AND r."data" -> 'amenities' @> '[{"_RecordId_": "a783bfb9-0f0a-491f-864b-945a49ef5da4"}]');--> statement-breakpoint
UPDATE "catalog"."item" i SET "is_shop" = true
	WHERE NOT EXISTS (SELECT 1 FROM "catalog"."raw_record" r WHERE r."uuid" = i."uuid");--> statement-breakpoint
UPDATE "catalog"."item" i SET "scu_per_piece" = v.micro / 1e6
	FROM "catalog"."raw_record" r, LATERAL (SELECT (jsonb_path_query_first(r."data",
		'$.Components[*] ? (@._Type_ == "SAttachableComponentParams").AttachDef.inventoryOccupancyVolume.microSCU'))::float8 AS micro) v
	WHERE r."uuid" = i."uuid" AND i."sub_type" = 'Harvestable' AND v.micro > 0;--> statement-breakpoint
UPDATE "catalog"."blueprint" b SET "in_reward_pool" = true
	FROM "catalog"."raw_record" r
	WHERE r."uuid" = b."uuid" AND r."path" IN (
		SELECT lower(substring(x->>'blueprintRecord' from 'libs/foundry/.*'))
		FROM "catalog"."raw_record" p, jsonb_array_elements(p."data"->'blueprintRewards') x
		WHERE p."type" = 'BlueprintPoolRecord' AND p."retired_at" IS NULL AND x->>'blueprintRecord' IS NOT NULL);--> statement-breakpoint
UPDATE "catalog"."import" SET "default_composition_quality" = (SELECT ("data"->>'defaultCompositionQuality')::int
	FROM "catalog"."raw_record" WHERE "type" = 'CraftingGlobalParams' LIMIT 1)
	WHERE "id" = (SELECT max("id") FROM "catalog"."import");
