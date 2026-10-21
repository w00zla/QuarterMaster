# Third-party data (ext)

Requirements: `docs/requirements.md` "Third-party data". UEX data are community reports, not game data;
the game's DataCore has the refining method names only (`refiningprocess/*`), no factors, times, costs or
location bonuses (server-side).

- `src/ext/` (own process, `main.ts`; compose service `ext`): `uex.ts` pulls from the UEX API
  (`api.uexcorp.uk/2.0`, bearer `UEX_TOKEN`) at start and every 15 minutes, only endpoints that need no ID:
  `refineries_yields` (yield bonus in % per refinery terminal × ore), `refineries_methods` (the 9 methods,
  ratings 1–3 only), `terminals` (826, with system/planet/moon/station/city/outpost names and flags),
  `commodities` (205, no UUIDs: match by name; average prices, `id_parent` ore ↔ refined, flags),
  `commodities_prices_all` (buy/sell price, SCU in stock and demand, status 1–7 per commodity × terminal; ~1 MB),
  `commodities_raw_prices_all` (ore sell prices) and `items_prices_all` (buy/sell price per item × terminal with
  the game's `item_uuid`, no stock; ~6.4 MB). Not pulled: `commodities_status` (only the names of the status
  codes 1–7; 0 = not traded), the ID endpoints (`items`, `*_averages`, `*_history`, `routes`). Nothing reads
  the new endpoints yet (UI later).
- `ext.snapshot` (`src/db/schema/ext.ts`, migration `0008`, written by `store.ts`): one row per `source`
  (`uex`), endpoint and distinct response (`data` as received, SHA-256 of it); a fetch with the same content
  as the endpoint's latest row only moves its `checked_at`, so the rows are the history of changes. The three
  price endpoints keep their latest row only (`storeSnapshot(…, latestOnly)` deletes the older ones: several
  changes a day, MBs each), as does `commodities` (it holds average prices). Nothing references this schema.
- **Refineries** (`refineries.ts`): the terminals of the latest yields snapshot are matched to selectable
  catalog locations by English name within the same system (`(System)` and a trailing `Station` dropped; UEX
  has no UUIDs, the gateway names exist in two systems, the record keys are misleading). `refineStart`
  refuses other locations (`notRefinery`), the web app's refinery picker lists only these (`refinery` flag in
  `GET /api/catalog`); without any snapshot every selectable location counts. Yield bonuses are matched to
  catalog ores by `oreKey` of the English name (the game says "Hephaestanite (R)", "Raw Ice", UEX
  "Hephaestanite (Raw)", "Ice (Raw)") and kept for the ore's refined material: `yields` per location in
  `GET /api/catalog`, shown in the web app's refinery picker and on each running job ("Bonus +5 %"). Cached
  per snapshot ID and location/ore catalog.
- **Refining methods** (`ext.refining_method`, seeded by migration `0009`): code (UEX's: DIN, FRX, …), the
  game's name key (`refinery_ui_processingtype_*`), yield %, seconds per SCU, source + game version (since
  `0015`: measured from in-game quotes at CRU-L1, 4.10.1; yield by the method's yield tier 31.5/38.25/45 %,
  time = 8 s/SCU × speed 1/2/6 × tier 1/4/16, the 8 s a stopgap: the measured base differs per ore).
  Corrections only by a new migration. `refiningMethods(db, lang)`, used by the admin UI only (no job
  estimates since the refinery books refined materials).
- Admin UI tab **3rd Party** (`ThirdPartyView.vue`, `GET /api/ext/uex`): pull status per endpoint, refinery
  terminals with their catalog match, yield bonus matrix, methods (UEX ratings and our values joined by code).
