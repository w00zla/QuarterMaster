-- The app keeps German and English texts only: every other language goes, its texts with it (cascade).
DELETE FROM "catalog"."localization_source" WHERE "lang" NOT IN ('de', 'en');
