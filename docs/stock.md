# Stock, history and the crafting check

The data the bot, the user web app and the companion share. Requirements and the reasons behind the model:
`docs/requirements.md` "Stock". Schema: `src/db/schema/app.ts` (see `docs/bot.md` "Schemas" for the
whole `app`/`bot`/`web` split).

## Stock service (`src/stock/service.ts`)

- The only code that writes `app.stock_batch` and `app.stock_journal`: `add`, `refineStart`,
  `refineSetDuration`, `refineDone`, `refineRemove`, `remove`, `adjust`, `move`, `split`, `share`. Each runs
  in one transaction, locks the source batch (`FOR UPDATE`), compares amounts in SQL, deletes a batch at 0
  (directly: an update to 0 violates `quantity > 0`) and returns the journal rows plus the resulting batch.
  Refusals are `StockError(code)`; callers map the code to a message. Optional `expected` (the quantity the
  user saw) aborts with `batchChanged` instead of booking against a changed batch.
- Rights live in the service, from an `Actor` (`userId`, the org `guildId` or null, `source`): **only the
  owner changes a batch** (remove, adjust, move, split, share, give; also without any org). Every batch
  belongs to one user (`owner_user_id`; the batch has no org columns). Decided 2026-10-09; the officer role
  is gone everywhere.
- **Sharing**: `share(batchId, guildIds)` sets the orgs the whole batch is offered in (`app.stock_share`,
  cascade-deleted with the batch; new orgs need the owner as an active member, taking back always works;
  history `share`/`unshare` per org).
- **Splitting**: `split(batchId, amount)` (unshared batches only, `sharedSplit` otherwise; less than all)
  moves a part into a batch of its own with a random `lot` (part of the merge key: new bookings go to the
  lot-less main batch).
- `move` changes the place (a lot stays a lot; a new target batch takes the source's shares, an existing
  one keeps its own) or gives (`toOwnerUserId`, an active member of `actor.guildId`; lands unshared in the
  recipient's main batch; history `give` with that org). The journal holds quantities only (no org
  columns; move/split/refine pairs share a `group_id`).

## Refinery jobs

- Personal (also a CHECK) and **refined materials only** (no ores anywhere since migration `0025`): a job's
  batch is the material with its expected yield as quantity, **not stock yet** (`materialTotal`, the API's
  totals, the crafting check and the org board count `stored` batches only).
- A job is a **work order** (migration `0013`): `refineStart` takes a station and an optional
  `durationSeconds` (→ `refine_ends_at`; `refineSetDuration` sets it later or clears it, no journal or
  history) for the whole job and 1–30 rows (resource, quality, expected yield), journaled as `add`; every row
  is a batch sharing a new `refine_job` UUID (part of the merge key: the same material and quality within a
  job add up, other jobs stay apart). Only at refineries (`notRefinery`, see `docs/ext.md`).
- A yield is corrected by `adjust` (history refinery adjust). `refineDone` takes the job ID and exactly its
  batches (else `batchChanged`), each with the amount handed out ("0": nothing stored): each becomes
  `stored` at the same place and quality (merging into an existing batch), one journal group per job.
  `refineRemove` (a job that will not come out) takes exactly its batches too and removes them.
- `(state = 'refining') = (refine_job IS NOT NULL)` (CHECK); stored batches have every job field NULL. The
  job fields are not part of `BatchKey` and not journaled; `loadBatches` returns them as `refine`.

## What is bookable

- Resources used in a recipe and items used in a recipe (never ores), and **ship components**: items whose
  type is in `COMPONENT_TYPES` (`src/catalog/components.ts`: the 13 types the component blueprints produce
  plus missiles, racks, turrets, interdiction devices, EMPs), crafted or not (`componentItemSql`). Of the
  items sharing a name, type, size and grade (ship-bound, turret, low-poly and derelict variants of one part:
  414 of 1243 in 4.10) only the plain part counts: a blueprint's output first, else the shortest class name;
  items without a name are left as they are (2026-10-19). Not retired; locations per
  `selectableLocationSql()`.
- **FPS gear** (2026-10-22) counts as gear like the ship components (`componentItemSql`, the same `component`
  flag and rules): items whose type and sub type are in `FPS_TYPES` (`src/catalog/components.ts`): personal
  weapons (Small/Medium/Large, knives, gadgets like the multitool, tractor and salvage tools, binoculars),
  attachments (optics, barrels, underbarrels, multitool heads), mining gadgets, armor (helmet, torso, arms,
  legs, backpack, undersuit). No consumables: grenades, magazines, medpens and food stay out (attachments stack in the game: booked by count). The plain-part
  rule also drops their AI and test variants. The check looks items up by type and name (index of migration
  `0030`; without it, one evaluation over 4300 items took 1.1 s).
- Components are `kind = 'item'`, always quality `COMPONENT_QUALITY` (0; others refused with
  `invalidQuality`), instead optional **stats** (migration `0027`: `stats` jsonb on `stock_batch`, part of
  the merge key, and `stock_journal`; in the history's `details.stats`): `{crafted property UUID: text}`,
  the gain as the crafting check shows it, not the tooltip's absolute value: a multiplier as its change in
  percent (one decimal, "12.5" = +12.5 %), additive steps whole (power pips). Only gains (a crafted
  component is never recorded worse than a looted one), only the stats their blueprints' slots can improve
  (`componentStats`: Cooler = Coolant Rating + Integrity, …; flat ranges left out), each within its bounds.
- Bounds (`src/stock/component-stats.ts`, pure, tested in `test/component-stats.test.ts`): `statBounds` per
  blueprint (a slot without any range changes nothing, decided 2026-10-22: most armor's "Panel Covering"
  names the damage mitigation with `valueRanges: [null]` and hid the other slot's range), from no change to what Q1000 makes of the stat (decided 2026-10-22: each slot's modifier at the
  end of its highest range): a gain (min 0, e.g. coolant +20 %) or a drop (max 0: recoil 1.4 at Q0 → 0.6 at
  Q1000 = −40 %, quantum fuel burn −20 %; `statBest` gives the end that counts), combined with the planner's
  unverified `combine` assumption (multipliers multiply, steps add up; community tools disagree; one
  IcePlunge craft with both slots at Q1000 decides: 26.57 = product, 26.40 = sum), the percent rounded away
  from 0; `checkStats` drops "0" and sorts the keys (else `invalidStats`), so the same stats merge;
  `unionBounds` over several blueprints; `statValue`, `statValueText` ("+12.5 %" / "+1").
- `add` sets stats, `adjust` changes them (`stats`: the whole new set, `{}` = none, omitted = unchanged;
  other stats re-key the batch with a move_out/move_in pair into an existing batch with those stats, which
  keeps its shares, or a new one, which takes this one's; history adjust with `details.statsFrom`);
  move/split/merge carry them with the key.
- `materialCatalog` lists each component's `stats` (`{uuid, name, nameKey, kind, min, max, base, tooltip}`,
  Integrity last; `base` = the unmodified value as the game's tooltip shows it, from the item's
  `base_stats` (crafted property key → value), which the extractor reads from the item's DataCore record by the
  jsonpaths in `src/stock/component-base.ts` (evaluated in TypeScript, `src/stock/jsonpath.ts`): Integrity, Coolant Rating, Power Pips,
  Max. Shield Strength, Quantum Speed (× 1e-6), Quantum Fuel Burn (× 1000), the radar assist distances, FPS
  fire rate (a looping fire sequence's pace where the first fire mode has no rate; charged and parallel
  first actions unchecked against a tooltip; places tried in order, `BasePath.fallbacks`), armor temperatures and radiation dissipation, armor damage mitigation (1 − the multiplier in
  the linked damage record, a second record found by its path); null for the rest; `tooltip` =
  `value`, or `change`/`negatedChange` where the tooltip shows the change in percent (from the property's
  display transformation: impact force, recoil; no base needed); API consumers convert the tooltip's
  values with them) and marks them `component` with a
  unique `label` ("Name · Cooler · S3 · B Industrial": the type instead of a manufacturer, the class name
  where that still collides; FPS gear with its sub type and without a size but on attachments, personal weapons without their
  class: "Name · Helmets · Light", "Name · Attachment · Barrel · S1"). `base_stats` holds every base an item's record
  has; `componentBaseValues` reads only those of the stats the item's blueprints change. `loadBatches` marks their batches (`PickableBatch.component`), the summary
  metrics (`stockMetricsSql` in `org-summary.ts`) count them as `components` apart from `items`. The bot does
  not tell them apart yet.

## Lookups and amounts

- `src/stock/lookup.ts` (no Discord): `locationCatalog` (selectable locations with label "Name ·
  planet/moon · system" and `short`, the name plus the system where it is ambiguous) and `materialCatalog`
  (bookable materials), both with `nameKey`, cached per language and reloaded after a newer catalog import
  (`importCache` in `src/db/import-cache.ts`); `pickableBatches(actor, pick)` (the actor's own batches,
  shared or not; `move` without refinery jobs, `refining` only own jobs; ordered by material, then quality
  descending); `searchWords`. `src/bot/pickers.ts` builds the Discord autocomplete choices from these.
- `src/stock/amount.ts`: `parseAmount` (SCU with point or comma, up to 6 decimals; items whole pieces;
  validated as text, never as float), `formatAmount` (NUMERIC text without trailing zeros).
- `src/stock/material-names.ts`: `findMaterial` (exact name, else a unique prefix; used by the bot's
  refinery lines).

## History

- `app.history` (migration `0011`): one row per stock, refinery or blueprint action, nothing else (no
  profile, token, login or roster changes). `source` (`bot`/`webapp`/`companion`), `category`
  (`stock`/`refinery`/`blueprint`) and `action` (CHECK per category: stock
  add/remove/adjust/move/split/share/unshare/give, refinery start/done/remove/adjust, blueprint
  add/remove), `actor_user_id`, `owner_user_id`, `to_owner_user_id` (a give), `guild_id` (the org involved),
  target (`target_kind` resource/item/blueprint + UUID), `details` jsonb (amount, quality, locations,
  adjust's `from`, stock's `sharedIn` (the orgs the batch was shared in then; read by the logs channel), the
  stats, refinery `jobId`, start's duration, done's `expectedYield`; old rows may carry ore fields or a
  `method`). User columns are plain Discord IDs without FKs (the history outlives the cleanup of users
  without data). Append-only by grants.
- Written in the same transaction as the change by `recordHistory` (`src/history/record.ts`): the stock
  service (`Actor.source`; a refining batch's remove/adjust is category refinery) and
  `addBlueprint`/`removeBlueprint` (only real changes). Sources: the bot passes `bot`, the web app
  `sourceOf(c)` = `companion` for API-token requests, else `webapp`.
- Read: `GET /api/history?lang&before` (`src/webapp/history.ts`): rows where the user is actor, owner or new
  owner, plus shares in the user's active orgs, newest first, 100 per page (`more`); names resolved per
  language. SPA `HistoryView.vue`: a sortable grid table (time, source, category, action, by, target,
  details), filters on the server (`source`, `category`, `action`, `by` = me | others), "Load more", reloads
  on stock/blueprint/resync messages. Notices (`webapp/src/history.ts`): the `history` messages except your
  own web app actions (bot, companion, gives to you, shares in your orgs), fetched in one go and shown as one
  toast per source × person × category × action that stays until closed (`notify` in `toasts.ts`; at most 5).

## Crafting check (`src/planner/`)

- Used by the user web app and `/qm-crafting`; the admin UI has none. `plan.ts`/`types.ts` are pure and
  shared by the web app's API and SPA and the bot: material totals with exact decimals (BigInt micro
  units), modifier curves per material quality, "N of M slots" choice, warnings. `load.ts` loads recipes
  from the DB (the default quality is the latest import's `default_composition_quality`, else 500). ASSUMPTION (unverified in game): modifiers of several slots on one stat multiply (`combine`).
- `src/planner/stock.ts`: `withQualityFloor`, `needsOf`, `coverageOf` over any batch with the `CoverBatch`
  fields (exact amounts via the planner's micro units); tested in `test/crafting-stock.test.ts`.
