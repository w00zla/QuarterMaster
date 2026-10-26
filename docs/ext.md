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
  codes 1–7; 0 = not traded), the ID endpoints (`items`, `*_averages`, `*_history`, `routes`).
  `commodities_raw_prices_all` is read by nothing yet.
- **Trading** (`trade.ts`, read by the web app: `docs/webapp.md`): `terminals`, `commodities`,
  `commodities_prices_all` and `items_prices_all` per catalog material. Commodities are matched to catalog
  resources (not retired, ores too) by `nameKey` of the English name (lower case, only letters and digits:
  exact names, unlike `oreKey`), items by `item_uuid` (the game's UUID). Harvestables (items of sub type
  `Harvestable`, booked in pieces; none of them in `items_prices_all`) are matched to commodities by name as
  well, their prices (offers and averages; stock and demand stay SCU) scaled to one piece by the item's
  inventory volume (`SAttachableComponentParams.AttachDef.inventoryOccupancyVolume.microSCU` in its
  `raw_record`: 1000 µSCU each in 4.x, Janalite 1.8 M/SCU = 1,800 aUEC per piece; decided 2026-10-26).
  Price 0 = not traded on that side, left out. Fields: `price_sell`/`scu_sell`/`scu_sell_avg` = what the terminal pays and takes when the
  player sells (its demand), `price_buy`/`scu_buy`/`scu_buy_avg` = what it asks and has in stock when the
  player buys (UEX's docs only say "last"/"average"; read from the field names and UEX's site); `commodities`'
  `price_sell`/`price_buy` = UEX's averages (items have none, `items_prices_all` no stock);
  `date_modified` unix seconds. Per material: min/max per side, terminals per side, the latest date, every
  offer best price first. A terminal is split into its place (station, city or outpost field, else the
  last part of UEX's "<shop> - <place>" name) and its shop (the rest; the company when the name is only the
  place): `terminalPlace`. Cached per snapshot ID of the four endpoints and the resource catalog.
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
- Admin UI page **UEX** (`/uex`, `ThirdPartyView.vue`, `GET /api/ext/uex`): pull status per endpoint, refinery
  terminals with their catalog match, yield bonus matrix, methods (UEX ratings and our values joined by code).
  Trade coverage (`GET /api/ext/uex/trade`, `getUexTrade` in `src/adminapp/queries.ts`, tested in
  `test/admin-uex-trade.db.test.ts`): terminals and price rows, commodities matched to catalog resources (as
  `trade.ts` does: `nameKey` of the English name of non-retired resources) and the unmatched names, resources
  without a commodity, items with a price (by UUID) vs. the gear items (by `components.ts`); "priced" = in
  `tradeData` (a price > 0 on one side), counts from the newest snapshots. The endpoints' freshness also shows
  on the admin's Status page.
