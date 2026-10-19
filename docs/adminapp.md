# Admin web UI

Requirements: `docs/requirements.md` "Admin web UI". Commands: `CLAUDE.md`.

- **API** (`src/adminapp/main.ts`, Hono): one process, bound to `127.0.0.1` by default (in the container
  `0.0.0.0`, published on the host's loopback only), HTTP basic auth for everything (API and static SPA).
  Read endpoints under `/api` (`queries.ts`, response types in `api-types.ts`); writing endpoints
  (`/api/import/catalog`, `/api/import/localization`) take the file as raw body, are a dry run unless
  `dryRun=0`, and require the header `X-Quartermaster: 1` (CSRF protection: a foreign form cannot set it).
  Serves `adminapp/dist` with SPA fallback. Both imports use the same functions as the CLIs
  (`docs/catalog-sources.md`).
- **SPA** (`adminapp/`): look and building blocks taken from BindSight (design tokens, fonts, `Dropdown`,
  `ColumnHead` + `tableColumns.ts` resizable/sortable grid tables), shared classes in
  `adminapp/src/styles/ui.css` (the user web app and the companion import them too). GUI text is English and
  terse. Game texts follow the language picker (`lang.ts`). Catalog lists load completely and filter/sort in
  the browser; the text search runs on the server. Help texts live in `adminapp/src/help.ts` (`HelpTip`);
  technical values (keys, class names, hashes) are only shown in tooltips (`Tooltip`). Ordering rule: by
  priority where there is one, else by amount (largest first), else alphabetical. Item type icons:
  `adminapp/src/typeIcons.ts`.
- **User data** (`src/adminapp/users.ts`, read-only, tested in `test/admin-users.db.test.ts`): tabs Orgs
  (`GET /api/orgs[/:guildId]`: bot presence, settings, active/inactive members, batches shared there by
  active members, last history row naming the org; detail with the roster and the shared stock per material)
  and Users (`GET /api/users[/:userId]`: everyone in `app_user`, `web.session` or `web.api_token`; stored
  batches, SCU, pieces, refinery jobs, blueprints, last action, last web login, companion token; detail with
  memberships, stock per material, running jobs, blueprints and the newest 20 history rows). Names
  (`userNames`): the newest web session's Discord profile, else the companion token's, else the org nickname,
  else only the ID. Overview panel "User data checks" (`GET /api/checks`, every check listed also without
  hits): stock of retired materials, stock at retired locations, registered retired blueprints, refinery jobs
  ready for over 7 days (`OVERDUE_DAYS`), jobs outside the UEX refineries. Needs the web column grants of
  `deploy/db-roles.sh` in production. Not smoke-tested yet.
- Tab **3rd Party**: see `docs/ext.md`.
