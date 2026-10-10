# Requirements

## Tenancy

- The bot runs on **multiple Discord servers**.
- **One Discord server = one org.** All data is scoped per server (`guild_id` in the schema from day one).

## Roles & permissions

Two levels, mapped to Discord per server (the officer role was dropped on 2026-10-09: unnecessary complexity, see "Stock"):

- **Member:** holds one of the configured member roles. Books their own stock and blueprints, shares stock in the org, gives stock to other members.
- **Admin:** has the Discord permission `Manage Server`. Configures the bot (member roles, base language, `#logs` channel).

Roles are configured per server and stored bot-side (role **IDs**, not names).

## Users without an org

- Users can work with the app without belonging to any org: personal stock, blueprint registry, profile. Access outside a server: the user web app with Discord login (see "Web apps").
- On a server, commands always require one of the org's member roles, also for personal stock.
- **Users without an org are first-class:** every feature is built for them in the same step, not added later. Goal (not decided in detail): eventually open the web app **and the bot** to individual users entirely (no org needed; for the bot probably user-installable commands in DMs and on any server).

## Settings

Three levels, all stored bot-side:

- **Per server:** base language, member roles, `#logs` channel and level.
- **Per user (global):** e.g. language override (instead of the client locale), RSI handle.
- **Per user × server:** membership (active/inactive), e.g. a default location.

Only the structure is fixed for now; individual settings are added when a feature needs them.

## Bot interaction

- **Options search, modals ask, panels show** (decided 2026-10-09, replaces "everything as options"): a command's options are only what has to be searched (material, batch, blueprint, location, member, job), at most two, all with autocomplete; never booleans, amounts or qualities. Everything typed or decided (amount, quality, sharing, duration, ore rows) comes in a **modal** opened right after the command, with defaults from the context (amount "all", the server's org ticked under "Share in"). Lists and results are ephemeral **panels** (Components V2) with scope buttons, paging and a link to the user web app. Lookups that only show something (`find`, `who`) stay plain options.
- **Submitting a modal is the confirmation** (like the web app's dialogs): no Confirm button afterwards. The modal shows what it acts on ("**Metal** Q500", then "1 SCU · Station · shared in Org"); the amount it showed is sent along as `expected`, so a batch that changed meanwhile is refused. Exception: the refinery start goes through a preview (its ore lines are resolved first).
- **Results** take two or three lines and say nothing twice: what happened (amount bold, material, quality), the batch as it is now (place · shares; its amount only where it differs from what was booked, e.g. added to an existing batch or what is left; or "empty"), and in small print the material in your stock, only where that is more than this batch.
- Modals hold at most five inputs and cannot be opened in answer to a modal; anything with more steps runs through a button on the panel. A modal must be the first answer within 3 s: before it only cached lookups and single-row reads.
- Everything is ephemeral; the user web app does what needs a table (split, merge, crafting check, history). Later: the web app as a Discord Activity (after its go-live).
- The web app link sits on every panel and result, and on the "not a member" / "not set up" errors (the web app also works without an org).
- **Every root command has the prefix `qm-`** (`/qm-setup`, `/qm-profile`, `/qm-stock`, `/qm-bp`, `/qm-refinery`): avoids collisions with other bots, and typing `/qm` lists all of ours. Admin and user commands are separate roots, because Discord's visibility default (`default_member_permissions`) applies per root command only; the bot still checks permissions itself (server admins can override the visibility).
- **Command names are English** in every language; descriptions and options are localized (so members can tell each other commands across languages).
- Bulk entry of blueprints/materials stays minimal for now (single entries via autocomplete). Separate helper tools for detecting blueprints and materials will follow; an import interface is designed then.
- **No tickets.** Everyone books their own stock.
- **Custom emojis for UX** (materials, states, actions, quality etc.) as **application emojis** (uploaded to the bot application, usable on every server without hosting them there). Emoji IDs differ between the dev and the prod application → resolve by name at startup, never hardcode IDs; keep the source images in the repo. Custom emojis work in messages, embeds, buttons and select options, but **not in autocomplete choices** (plain text only). Unverified: whether rendering in interaction replies needs "Use External Emojis" for `@everyone` in the channel — test on the dev server.

## Blueprint registry

- Global per user; **visible to the org** (unlike personal stock): `/qm-bp list member:` (a string option with autocomplete over active org members, by display name or RSI handle; Discord's user picker would offer everyone on the server) and `/qm-bp who` show what active org members registered. Default blueprints are not registered ("everyone has it").
- Each game blueprint is registered on its own, also variants with the same name and recipe; labels tell them apart (size, grade + class, manufacturer, else differing tokens of the blueprint key).
- `/qm-bp list` is grouped by blueprint category group (alphabetical, "other" last), alphabetical within; 20 per page with buttons.
- Autocomplete searches the name in the user's language and in English (all words must match); names starting with the first word come first.

## Refinery in the bot

- `/qm-refinery start station` opens a modal: duration (optional, as on the terminal: "2h 30m", "45m", minutes; empty = open) and the ores as text, **one line per ore**: `<name> <quality> <SCU> [expected yield]` (numbers read from the right, names may be abbreviated: "heph raw", "HEPH (RAW)", both languages; up to 30 lines). No refining method in the bot: no estimates there (decided 2026-10-09). The yield stays optional (in a hurry in game).
- Submitting shows a **preview** (recognized rows, faulty lines with the reason); **Register** books the work order exactly as previewed, **Edit** reopens the modal with the text, **Cancel** drops it. The draft lives in memory (`state.ts`, 10 min).
- `/qm-refinery time job` sets or clears the time left of a running job (end = now + time left; no journal, no history: no stock changes). The web app and the companion's API (`POST /api/refinery/duration`) do the same; the companion is meant to set it from the terminal's PROCESSING screen (not built).
- `/qm-refinery done job` opens a modal prefilled with one line per ore ("Quantanium 820: 5.69"); only the numbers are the user's, the lines are checked in order; submitting books.
- `/qm-refinery list` shows your running jobs (station, countdown, "ready" or "duration open", ores).
- The companion app's OCR fills the same work order (station, rows, end) as a draft the user registers.

## Stock

- **Every batch belongs to one user** (who has it in game; one character, one inventory): the same stock in every org, and usable without any org. Decided 2026-10-09 (replaces the officer model): in game players hand mats to each other and the holder collects or consumes them; officers confirming every consumption would be unmanageable.
- **Only the owner changes a batch:** add, remove (consume), adjust, move, share, take back, give. Nobody else, in no role.
- **Sharing** offers the **whole batch in any number of the owner's orgs** at once (`app.stock_share`, one row per batch × org; changed 2026-10-09 from "one org per batch"): it stays the owner's, those orgs' members see it, the owner takes it back per org any time. Whoever asks first (outside the app) gets it given; it disappears everywhere then (one batch). The owner must be an active member of each org; someone who leaves keeps their batches, the org no longer sees them (filtered, nothing rebooked).
- **Splitting** (unshared batches only) moves a part into a batch of its own (`lot` UUID in the merge key), e.g. 5 SCU into 3 + 2 to share them in different orgs, like splitting a stack in the game inventory. New bookings of the same material, quality and place go to the main batch (if that one is shared, so is what is added); a part stays apart until used up (no merging back yet). Moving a part keeps its lot; a part moved into a new batch takes the shares along, into an existing one gets that one's.
- **Giving** hands a batch (or part of it) to another user: only an active member of the org the action happens in; no acceptance step; the recipient gets it unshared and learns of it through the history notices.
- **Unshared stock is private:** only its owner sees it (not the logs channel). Shared stock is visible to the org's members; `find`/`list` for other people show what they share only.
- **Views:** your own stock = everything you own, shared batches marked with their org; an org = what its active members shared there; "All" (web app) = both. The overview counts your shared stock in your own tiles and in the org's.
- **Bookable:** resources used in any recipe, their ores (via the refinery only), and items used in recipes (harvestables). No crafted products.
- **Amounts** are entered and shown in SCU for resources (decimal point or comma), pieces for items. Smaller units (cSCU/µSCU) may follow.
- **Corrections:** `adjust` sets a batch to a counted amount (journal action `adjust` with the signed difference); owner only, like everything.
- **Removing:** without an amount the whole batch is removed.
- **Confirmation:** every change of existing stock is confirmed before it is booked: in the bot by submitting its modal (see "Bot interaction"), in the web app in a dialog. Adding new stock is booked from its form right away.
- **Lists:** `/qm-stock list` groups by material (location in every line; scopes personal, this org, all); `find` searches what is shared in the org plus the caller's own stock, best quality first.
- **Display:** every batch shows whether it is shared (bot results "shared in Org A, Org B", autocomplete "Org (owner)"; the web app: "Shared · Org A, Org B") or not ("personal"/"Pers."); a give leaves this out (the recipient gets it unshared anyway). Results after a booking: see "Bot interaction"; list headers show the material total.
- **Quality is mandatory** on every booking (crafting depends on it). Different quality = different batch.
- **Locations are mandatory** and come from the game data (`StarMapObject` records: stations and landing zones with a name; not jump points, not unfinished "WIP" objects). No ships as locations. Shown as "Name · planet/moon · system".
- A batch has a **state**: `stored` or `refining`.
  - **Refinery jobs are always personal and unshared** (each player manages their own jobs); the refined result can be shared afterwards.
  - Ores exist in stock **only** as `refining` (stored ore would only sit temporarily in ships or bags, which are not tracked); refined resources only as `stored`. Ores come in via `/qm-refinery start` only, never via `/qm-stock add`.
  - `refining` only at **refineries**: the locations of the UEX refinery terminals (community data, see "Third-party data"), matched to catalog locations by name; while there is no UEX data yet, every station counts. The game data has no refinery flag.
  - A refinery job is a **work order** as in the game: one refinery, one duration, and several ores (rarely just one; each ore and quality is a row, i.e. a batch of its own). Bot and web app always enter jobs this way.
  - Completing a refinery job: always the whole work order (the game hands it out at once). Per row the user enters the refined quantity as shown in the game ("0" when nothing came out); the quality stays the ore's (input = output, kept simple). Every ore batch of the job is consumed and a `stored` batch of the refined resource is created at the same location (journal rows with one group ID for the job). The refined quantity is prefilled with the row's expected yield, an estimate the user corrects to what the game shows.
  - Basis for a later ore management (ETA, yield statistics). The refining method is not stored (decided 2026-10-08).

## Discord setup

- Privileged intent: **Server Members** only (roster sync). No Message Content, no Presence.
- Bot permissions (invite via OAuth2 URL Generator, scopes `bot` + `applications.commands`): View Channels, Send Messages, Embed Links, Attach Files (planned for file exports into channels) = `52224`. Never Administrator.
- Interaction replies need no channel permissions; channel permissions only matter for `#logs` and other channel posts. `/qm setup` checks them on the chosen channel (channel overwrites can override role permissions).

## Logs channel

- Any text channel the admin picks (stored by ID); there is no fixed channel name. UI texts say "Logs", never `#logs`.

- Per server: channel (stored by ID, chosen via channel select) and level: `off` | `org`. There is no level for personal bookings: unshared stock is private.
- Level `org` (decided 2026-10-09, after the ownership model): what happens to the org's offer: sharing and taking back in this org, gives among its members (the recipient is named only in the org the give happened in; other orgs the batch was shared in read "gave away"), and add/remove/adjust/move/merge on batches shared in this org at that moment. Never: unshared stock, refinery jobs (personal), blueprints (the companion registers dozens at once). No source tag (the web app's history has it).
- One line per change in the server's base language, people as mentions (rendered as names, never pinging), several lines per message. The source is `app.history`; a new channel or level starts at the newest row (the past is never posted). A channel the bot cannot use loses its lines (no backlog flood later).

## Localization

- The bot is multi-language from day one.
- Supported languages (for now): **German (`de`)** and **English (`en`)**.
- **Private output** (ephemeral replies, wizards, DMs): language follows the user's Discord client locale (`interaction.locale`).
- **Base language per Discord server:** configured per server in the bot (stored bot-side). Used for all **public output** (`#logs`, board, ticket embeds, anything several people see).
  - Default until configured: **English**.
  - Who may change it: **Admin** (see role model).
  - Do not use Discord's `guildLocale` for this: it can only be set on Community servers and is `en-US` everywhere else.
- Mapping of user locale: `de` → German, everything else → English (fallback).

## Web apps

Two web apps, **separate processes** (and separate from the bot) sharing one codebase and database. Deployed with Docker Compose on a VM; Caddy on the same VM terminates TLS. The apps listen on the host's loopback only.

### Admin web UI (built)

- A single superuser via HTTP basic auth.
- Reachable from outside on its own port through Caddy (`:8443` → `127.0.0.1:3001`), never on the Node port directly.
- Browses the game catalog (blueprints, resources, items, localization, imports) and runs the catalog and localization imports (file upload, always a dry run first).
- Game texts follow a language picker; the UI itself is English.
- Tabs **Orgs** and **Users** (built 2026-10-09, read-only): orgs with bot state, settings, roster and what is shared there; users (also without any org) with a rough look at their data (stock per material, refinery jobs, blueprints, latest history, last web login, companion token). No admin actions on user data (deletion, revoking sessions/tokens): those would need write access to schema `web`.
- Overview panel **User data checks**: stock of retired materials or at retired locations, registered retired blueprints, refinery jobs ready for over a week, jobs outside the UEX refineries.
- Tab **3rd Party**: the UEX data (pull status, refinery terminals with their catalog match, yield bonuses per refinery × ore, refining methods).

### User web app (in progress)

- Alternative to the bot for users (the bot's UX is at its limits): personal stock, blueprints, org stock.
- Login with **Discord OAuth2** (users only; the admin UI keeps its own access).
- Same rights as in the bot: the web app builds the stock service's `Actor` and adds no rights logic of its own.
- **Membership comes from the roster**, not from Discord at request time: the active `app.member` row.
- **The bot need not have seen a user first** (users without any org, servers without `/qm-setup`): the login creates the `app_user` row. Sessions have **no FK to `app_user`**, and every authenticated request upserts the row when it is missing: the roster cleanup deletes `app_user` once it holds no data and does not know about sessions (the cleanup stays as it is).
- The roster is only as fresh as the bot's sync. Safeguards:
  - full roster sync on every new gateway session, not only at startup (built);
  - no freshness guard any more (dropped 2026-10-09 with the officer role, unnecessary complexity): membership is the active roster row; the bot leaving a server deactivates its members, so the org is gone for them. Risk accepted: during a bot outage someone who lost the role keeps seeing and sharing in the org until the next sync.

### Display in the user web app

- **Quality levels:** below 500 "⊘" (not usable), one "★" per 100 from 500 to 999, "♛" at 1000, shown before the value without "Q" ("★★★ 720"). Table columns keep the values aligned (the level right before a fixed four-digit field). The quality filter (stock, refinery) works in these tiers: a range slider "Quality" from ⊘ to ♛, the value range in parentheses ("★★–★★★★ (600–899)"). The bot still shows "Q820".
- Refinery jobs: a table with one group per work order (station, totals, time left; the ores below), with the stock table's filters; the refinery picker and every ore row show the refinery's **UEX yield bonus** for the ore ("Bonus +5 %").
- **Refinery job estimates:** starting a job offers an optional **method** (decided 2026-10-08: only to prefill, never stored); picking one prefills the duration (from the job's total SCU) and each ore row's expected yield from the method's community values (yield %, time per SCU) and the station bonus, and the user may overwrite them (e.g. with the terminal's quote). Duration and expected yields are stored with the job: the table shows expected yields and the time left ("ready" once over); finishing a job starts from the expected yields (the quality stays the ore's). Two jobs never merge (the same ore, place and quality within one job add up). Estimates only: the real numbers are computed by the game server.
- **Adding** (stock, refinery job, blueprint) happens in a toggle panel below the view's head, without a confirmation (the toast says what was booked), with Clear; a successful add closes the panel. Remove, move, adjust, finishing a job and removing a blueprint keep their confirmation dialog; remove and move start with "everything" checked.
- Dialog buttons always in one row in the footer; table actions are icon buttons; table filters have a neutral placeholder ("Filter…").

## Third-party data

- **UEX** (community reports, not game data; bearer token): refinery yield bonuses per terminal × ore and the refining methods, pulled every hour. Raw responses are kept as history (a new row only when the content changed).
- Used for: which locations have a refinery, and the yield bonus shown in the web app.
- **Refining method values** (yield %, time per SCU) exist neither in the game data nor at UEX: measured from in-game quotes (since migration `0015`; the scminer.rocks seed of `0009` was far off) and stored statically (`ext.refining_method`, seeded by a migration, corrected by later ones). Costs are not kept.

## Crafting check

- In the user web app only (the admin UI has none). Not a planner: a list of blueprints, each with a count (1–99), its own material qualities (never below the recipe's minimum) and the resulting stat changes, plus per material what the stock you can see (yours and what is shared in your orgs) covers at the card's quality. Each card on its own: no totals across cards, nothing reserved.
- Kept in the browser (localStorage) only.
- The math is shared code (`src/planner/`) meant to be reused by the bot.
