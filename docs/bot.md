# Discord bot

Requirements and the interaction model: `docs/requirements.md` ("Roles & permissions", "Bot interaction",
"Logs channel", …). Commands to run and register it: `CLAUDE.md`.

## Schemas

- `app` (`src/db/schema/app.ts`): the data the bot, the web app and the companion manage: `org` (one per
  server, member role IDs), `app_user` (global per user; RSI handle), `member` (user × org, the roster; PK
  `(guild_id, user_id)`), `stock_batch` (one row = one batch of one owner, merge key `UNIQUE NULLS NOT
  DISTINCT` incl. `refine_job`, `lot` and `stats`, deleted at 0; global per user, no org), `stock_share`
  (batch × org it is offered in), `stock_journal` (append-only, copy of the batch key without the lot,
  `group_id` for pairs, no org), `user_blueprint` (per user; default blueprints are not stored), `history`
  (see `docs/stock.md`).
- `bot` (`src/db/schema/bot.ts`): bot-only configuration and state: `guild` (base language, `#logs` channel
  + level, board channel/message/style/title/subtitle, presence: `left_at` set on `GuildDelete`, cleared on
  `GuildCreate`, reconciled with the guild cache on `ClientReady`; `logs_after` = the last `app.history` row
  the logs channel handled), `user_config` (language override), `status_quote` (the status texts, 1–128
  characters, edited in the admin UI).
- `web` (`src/db/schema/web.ts`): the user web app's state (`session`, `user_setting`, `api_token`; no FK
  to `app_user`).
- `bot` and `web` reference `app`, never the other way round. Discord IDs are `text` with a format CHECK.
  Nothing is deleted except batches at 0 (and expired sessions). Rules a CHECK cannot express (crafting
  inputs only, refinery jobs only at refineries, selectable non-retired locations) live in the stock
  service.
- **Migrations applied in production are frozen** (see `CLAUDE.md`).

## Structure (`src/bot/`)

- `main.ts` (client with intents `Guilds` + `GuildMembers` (privileged, enabled in the developer portal), DB
  connection, routes `InteractionCreate`, member events → roster), `interactions.ts` (router),
  `registry.ts` (`BotCommand`: registration JSON + `execute`/`autocomplete`/`component`/`modal`,
  `modalSubcommands`, `ephemeral` defaults to true; `bySubcommand` dispatch; handlers get `db` in their
  context), `ui.ts` (`customId` (checks Discord's 100 characters), `panel` (Components V2 reply),
  `webAppButton`/`webAppRow` (link from `WEBAPP_ORIGIN`, none when unset; a path from `webAppPath` makes it a
  deep link), `textField`/`textValue` for modals), `lang.ts`, `commands.ts` (the command list),
  `commands/*.ts` (one file per root command), `register.ts` (bulk overwrite: an empty list removes all
  registered commands), `errors.ts`, `i18n.ts`, `state.ts`, `status.ts` (`StatusRotator`: from `ClientReady`
  every 10 minutes a random text from `bot.status_quote` as the custom status, never the same twice in a row
  unless it is the only one; read fresh each time, no texts = no status; set again on every `ShardReady`/
  `ShardResume`, since a new gateway session starts without it; one status for every server, no language).
- **UI model**: options are only what has to be searched (autocomplete, at most two), everything typed comes
  in a modal opened right after the command, lists and results are ephemeral panels (Components V2,
  `ReplyContent.flags` = `IsComponentsV2`, the router adds Ephemeral). Submitting a modal books (it is the
  confirmation; the amount it showed goes along as `expected`); the refinery start has a preview first.
  Results take 2–3 lines and repeat nothing.
- The router defers a command that has not replied after 2 s (Discord's limit is 3 s), **except
  subcommands listed in `modalSubcommands`** (`''` = a command without subcommands): a modal is only allowed
  as the first answer, so those must answer within 3 s (only cached lookups and single-row reads before
  `ctx.showModal`). Handlers reply via `ctx.reply` only, never `interaction.reply` directly.
- Components and modal submits are routed by custom ID `<command name>:<rest>` to that command's
  `component` / `modal` handler, which answers with `interaction.update` or a reply. A modal submit cannot
  open another modal: more steps go through a button. Context of a modal travels in its custom ID; only
  what does not fit sits in `state.ts` (short-lived per-user state, in memory, 10 min: the refinery drafts).
- `UserError(key, vars, { webApp })` → friendly ephemeral message in the user's language, not logged
  (`webApp`: with the web app link); any other error → generic message + log.
- Texts: de/en dictionaries in `i18n.ts` (same keys enforced by type and test); game texts from the catalog.
  Command names English, descriptions localized (`localizedDescription`; Discord shows them in the client's
  language). Private output follows `lang.ts` (the `/qm-profile` override in `bot.user_config`, else
  `userLang(interaction.locale)`); public output (logs channel, board) uses the server's base language from
  `bot.guild` (never Discord's guildLocale).

## Roster and access

- `roster.ts`: `app.member` rows exist only for current holders of a member role (bots never). Losing the
  role or leaving the server deletes the row unless stock or journal rows reference it, then it stays with
  `active = false`; the `app_user` row goes too, but only once it holds no data at all (no member row,
  blueprint, personal stock, journal row, RSI handle or `bot.user_config`): users can work without any org.
- `roster-keeper.ts` (`RosterKeeper`): full syncs on `ShardReady` and `ShardResume` (discord.js drops the
  member events Discord replays before RESUMED), on joining a server, on `GuildAvailable` after an outage,
  after role changes in `/qm-setup` (`requestFullSync`), when a configured role is deleted, every 6 h, and
  5 min after a failed sync or member event. Per guild, syncs and member events run one after another; a
  request while another waits joins it; member list fetches of a guild are at least 31 s apart (gateway
  opcode 8 is rate-limited to about one per 30 s). The bot leaving a server deactivates its members. The
  caller's row is also synced on every `requireMember` call. Servers without `/qm-setup` have no org.
- `access.ts`: `requireMember(db, interaction)` for every command that needs org membership: refuses outside
  servers, before setup (`error.notSetUp`) and without a role (`error.notMember`). Admins (Manage Server) are
  not members by that alone.

## Commands

All root commands are prefixed `qm-`.

- **`/qm-setup`** (`commands/setup.ts`, `settings.ts`): admins only (`default_member_permissions` Manage
  Server plus an own check on every interaction), an ephemeral Components V2 panel with one section per area
  (👥 members, 🌐 language, 📜 logs, 📋 board) and six selects (member roles, base language, `#logs` channel,
  logs level `off`/`stock`/`blueprints`/`all`, board channel, board style `list`/`table`) plus a "Board title"
  button (modal: title, empty = the org name, and an optional subtitle). Each change is saved at once and
  redraws the panel; shows whether the bot has View/Send/Embed/Attach in the `#logs` channel and View/Send in
  the board channel. A change of language, board channel, style or title re-renders that board.
- **`/qm-bp`** (`commands/blueprints.ts`, `blueprints.ts`): add/remove/list/who; list (20 per page) and who
  (60 names per page) are panels, paging in the custom ID. The blueprint catalog with labels is cached per
  language (`importCache`), because autocomplete must answer within 3 s; autocomplete values are blueprint
  UUIDs, free text that was not picked is refused. Autocomplete handlers get `(interaction, lang, db)` and
  must not write.
- **`/qm-res`** (`commands/stock.ts`; until 2026-10-20 `/qm-stock`): `add material location` (modal: amount, quality, "Share in"
  checkboxes of your active orgs, this server's ticked), `remove|adjust|share batch`, `move batch to`,
  `give batch member` (own roster autocomplete, active members only), each a modal with the batch as its head
  and the amount prefilled ("all", adjust: the current amount, "0" allowed); `list [material]` (panel:
  Personal / this org / All, 20 lines per page) and `find material [min_quality]`. The booking logic
  (`bookAdd`, `bookChange`, `bookShare`, `listLines`) takes no Discord objects and is tested on its own.
  `StockError` codes map to `stock.err.<code>`. Splitting and merging are not in the bot. `/qm-res` offers
  and lists only materials and items, like the web app's resources tab.
- **`/qm-gear`** (same file, `stockCommandOf` with the area `COMPS`; until 2026-10-20 `/qm-comps`, then
  `/qm-comp`): "Ausrüstung"/"Gear", for now the ship components, the same subcommands as `/qm-res` (option `component`, `find` without a minimum quality), like the web app's tab Ausrüstung.
  Named by their unique label (`MaterialEntry.label`), stats instead of a quality (`statsText`). `add` and
  `adjust` carry one multi-line field "Stats" (`statLines`: one line per stat the blueprint can improve,
  "Coolant Rating (max. +20.0 %): 0", the current values on adjust; `parseStatLines` takes the number after
  each colon, "%" allowed, an empty field = none) instead of a field per stat: a modal holds at most 5
  elements and tractor beams carry 5 stats. Looted-only components get no such field. Other stats on
  `adjust` answer "Stats changed" with the batch as it is now.
- **`/qm-refinery`** (`commands/refinery.ts`, parsing in `refinery-lines.ts`; personal, no member role
  needed): `create station` (modal: optional duration, material lines `<name> <quality> <yield SCU>` read from
  the right, resolved with `findMaterial` over the resources in de and en) → preview panel (Register / Edit /
  Cancel), `time job`, `done job` (modal prefilled with "Name quality: yield" lines), `remove job` (a confirm
  panel), `list`.
- **`/qm-profile`** (`commands/profile.ts`; no org needed): modal with RSI handle and language (follow
  Discord / English / Deutsch); the `app_user` row is only created when there is something to store.
- **`/qm-crafting blueprint`** (`commands/crafting.ts`; no org needed): the web app's crafting check for one
  blueprint: a modal with count (1–99) and one material quality per slot (empty = the game default, raised to
  each slot's minimum), then a panel with the needs per material against your stock plus what is shared in
  your active orgs (stored only), stats, warnings, buttons "Change" and the `/crafting?add=` deep link.
- **`/qm-help`** (`commands/help.ts`): every other command and its subcommands with their localized
  descriptions; commands with `default_member_permissions` only for users holding those permissions.

## Logs channel (`logs.ts`, `LogsPoster`)

Polls `app.history` every 30 s per server with a channel and a level other than `off` (`logRows`: level
`stock` = share/unshare/give with `guild_id` = the server, and stock add/remove/adjust/move/merge/give whose
`details.sharedIn` holds it; `blueprints` = blueprint add/remove by the server's active members; `all` =
both). One line per row in the server's base language (`logLine`, people as mentions, `allowedMentions`
none), packed into messages of ≤ 2000 characters; then `logs_after` moves forward (only if `/qm-setup` did not
reset it meanwhile). Components show their label and stats instead of a quality; an adjust that changed
their stats shows old → new stats. A new channel or level sets `logs_after` to the newest row, so the past is never posted.
Discord errors other than an unusable channel are retried next round; an unusable channel's lines are skipped.

## Board (`board.ts`, `BoardPoster`)

One message per org in its board channel, edited in place, in the server's base language: title
(`board_title` or the org name) with the server icon as thumbnail and the optional subtitle, the figures of
the web app's org tile (`orgMetrics` in `src/stock/org-summary.ts`; resources and items as one figure "x SCU /
y pcs" with their kinds and locations together, components apart), the shared materials (`orgMaterials`: total,
best quality with its level, holder count; resources and items in one section like the web app's resources view,
best quality first; components in a section of their own without quality, largest first; 10 lines per section,
"+n more"), buttons "All resources" (`qm-res:org`, member
check, materials and items) and "All gear" (`qm-gear:org`), deep links Resources/Gear/Blueprints (five
buttons, Discord's limit per row), "Updated <t:…:R>". Style
`list` (text lines) or `table` (code-block tables: amounts right-aligned, the stars last, names cut at 22
characters, backticks replaced). Only stored stock shared in the org by active members; never unshared stock,
refinery jobs or holder names. Rendered only for orgs marked as changed (`LISTEN qm_changes`; `/qm-setup`, a
newer catalog import, the start and every listener reconnect mark all); every 30 s the marked ones are
rendered and compared with what was shown, edited only on a difference; a deleted message is posted again;
another board channel gets a new message, the old one stays where it was. Not tested beyond the dev server.
