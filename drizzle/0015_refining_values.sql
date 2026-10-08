-- Refining method values measured from in-game quotes (CRU-L1, 2026-10-07/08, 3 quotes) instead of the scminer.rocks
-- seed of 0009. Yield by the method's yield tier: wasteful 31.5 %, normal 38.25 %, careful 45 % (exact for every row).
-- Time = base x speed (fast 1, normal 2, slow 6) x yield tier (wasteful 1, normal 4, careful 16); the base per SCU
-- differs with the ores (about 7 to 9.8 s measured), 8 s taken for all until it is measured per ore.
UPDATE "ext"."refining_method" AS m SET "yield_pct" = v.yield_pct, "seconds_per_scu" = v.seconds_per_scu,
	"source" = 'in-game quotes CRU-L1', "game_version" = '4.10.1'
FROM (VALUES
	('XCR', 31.5, 8), ('COR', 31.5, 16), ('KZW', 31.5, 48),
	('GAS', 38.25, 32), ('EST', 38.25, 64), ('TND', 38.25, 192),
	('PYR', 45, 128), ('FRX', 45, 256), ('DIN', 45, 768)
) AS v (code, yield_pct, seconds_per_scu)
WHERE m."code" = v.code;
