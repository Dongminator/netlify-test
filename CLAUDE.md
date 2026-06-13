# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local test clone of the GSF soccer club member app (https://app.gsffc.org), built as a POC for
GPS-based event check-in. Express 4 + EJS server-rendered pages, PostgreSQL for data and sessions,
deployed to Netlify as a single serverless function. UI text is Chinese; code comments are English.

## Commands

```bash
npm install
npm start          # node server.js -> http://localhost:3000
netlify dev        # simulate the Netlify function + redirect setup locally (needs netlify-cli)
```

There is no test suite, linter, or build step. `public/` is served as-is.

## Database setup (manual — the app never provisions it)

`db/schema.sql` must be executed by hand against the target Postgres **before first run** — no code path
runs it, `db.js` only opens a pool and queries. Consequences to remember:

- Adding a column means editing `db/schema.sql` *and* applying it manually to every existing database.
- `db/schema.sql` is the shape of a **fresh** database. A database that already has data is moved
  forward by the files in [db/migrations/](db/migrations/), applied by hand and in order
  (`psql "$DATABASE_URL" -f db/migrations/001-…sql`); nothing tracks which have run, so each one is
  written to be safe to re-apply. Both files must be changed together — schema.sql for new installs,
  a migration for existing ones.
- `db/schema.sql` seeds only the three events; it seeds **no users**. Members are created from the
  "批量添加会员" modal on `/members` (paste `username:password` lines); its button and the modal
  itself only render for admins.
  Both `POST /members/add-users` and `POST /api/users` require an
  ADMIN session, so the very first account still has to be INSERTed by hand with a bcrypt hash — and
  then promoted with `UPDATE gsffc.users SET role = 'ADMIN' WHERE email = …`, or nobody can add anyone.
- Everything lives in the hardcoded `gsffc` schema (`SCHEMA` in [db.js](db.js#L6)); every query is
  prefixed with it. The `express-session` table is created automatically by `connect-pg-simple`
  (`createTableIfMissing: true`) in that same schema.
- `DATABASE_URL` must be a Postgres connection string (`postgres://…`), not a Supabase REST URL.

## Architecture

**Single app object, two entry points.** [server.js](server.js) builds and exports the Express app and
only calls `listen()` when `require.main === module`. On Netlify,
[netlify/functions/server.js](netlify/functions/server.js) wraps the same export with `serverless-http`
and sets `callbackWaitsForEmptyEventLoop = false` so the pg pool survives between invocations. Never
add top-level `listen()` or process-lifetime assumptions to `server.js`.

**Serverless bundling constraints** ([netlify.toml](netlify.toml)): esbuild can't trace EJS, so `ejs` is
in `external_node_modules` and `views/**` in `included_files`. Any new runtime-loaded file (new template
dir, data file) must be added to `included_files` or it will 500 only in production. [server.js](server.js#L15)
resolves the views dir from `__dirname` *or* `process.cwd()` for the same reason.

**Data shape.** `db.js` is the only module touching SQL. `rowToEvent` maps the flat row to the app's
event object: `lat`/`lng` columns collapse into `coords` (or `null` for online events) and
`checkin_radius` into `checkinRadius`.

**An event's when is `start_at`/`end_at`, `TIMESTAMP` *without* time zone.** A club schedule is a wall
clock — "16:00 at the pitch" — not an instant, so it must not move with the server's zone (UTC on
Netlify, local in dev); `TIMESTAMPTZ` would convert on the way in and out and push evening events across
midnight. For the same reason `db.js` **remaps pg type OID 1114 with `types.setTypeParser`** to hand the
value back as the string Postgres sent, trimmed to `'YYYY-MM-DDTHH:MM'`, instead of a JS `Date`: a `Date`
is a point in time and `JSON.stringify` calls `toISOString()` on it, so `/api/events` would answer
`2026-06-13T23:00:00.000Z` for a 16:00 event on a Pacific box and `16:00Z` on Netlify. That remap is
global to the `pg` module, but only 1114 is touched — the roster's `TIMESTAMPTZ` columns (1184) are real
instants and keep their `Date` parsing. Two `CHECK`s hold the shape: `end_at > start_at`, and
`date_trunc('minute', …) = …` so nothing ever stores seconds the minute-precision form can't show.

`rowToEvent` exposes the two columns as `startAt`/`endAt` and slices three **read-only** fields out of
them — `date`, `endDate` and `time` (`'16:00 - 18:00'`, the exact shape the old free-text column had,
which is why the calendar chip and its tooltip needed no rewrite). Same arrangement as
`signups`/`checkins` over `roster`: nothing writes through them, and they are deliberately absent from
`EDITABLE_FIELDS`. `event.date` is still what the calendar groups by and what is compared lexically
against the `todayStr()` helper (`new Date().toISOString().slice(0,10)`) to decide past vs. upcoming —
that test is still **day-granular**, so an event stays "upcoming" until the day after it ends. Since
`startAt`/`endAt` are fixed-width and identically formatted, every comparison on them (ordering,
end-after-start, in SQL and in JS and in the browser) is a plain string comparison.

**The roster is two tables, `gsffc.event_signups` and `gsffc.event_checkins`** — one row per member per
event, each carrying its own timestamp (`signed_up_at`, `checked_in_at`). They replaced a pair of JSON
string columns on `events` that held bare arrays of emails and recorded no times at all; migration 001
backfills them and drops the columns. Consequences:

- `rowToEvent` takes the event's signup rows as a second argument and hangs **`event.roster`** off the
  event — the ordered list of `{email, status, signedUpAt, promotedAt, checkedInAt, checkinDistance}`,
  with the check-in LEFT JOINed onto the signup it belongs to. `getRosters` fetches them for a whole
  page of events in one query, so `getEvents` costs two round trips, not N.
- `event.signups`, `event.waitlist` and `event.checkins` are **derived from `roster`**, arrays of bare
  emails. The first and last keep the exact shape the old columns had, which is why the templates and
  the JSON API needed no rewrite; `waitlist` is the new one. They are read-only views — nothing writes
  through them any more.
- **`db.updateEvent` no longer touches the roster.** Every roster write is its own function —
  `signUpForEvent`, `withdrawFromEvent`, `clearEventRoster`, `checkInToEvent` — and each of the first
  three runs inside `withEventLock`, a transaction holding `SELECT … FOR UPDATE` on the event row. That
  is what makes "is there room?" and "take the place" atomic: the old read-modify-write could lose a
  concurrent signup, and two members racing for the last place could both get it. Add roster writes as
  new functions in that shape; never mutate an array and re-save the event.
- `email` carries **no foreign key to `users`** (the seeds, and rosters migrated from the old columns,
  name members who may have no account), so `deleteUser` still cascades by hand — see below.

**Waitlist.** `event_signups.status` is `SIGNED_UP` or `WAITLIST`, constrained by a CHECK and mirrored by
`db.SIGNED_UP`/`db.WAITLIST`. Signing up for a full event is never refused: `signUpForEvent` counts the
confirmed rows under the lock and records a `WAITLIST` row instead, and the route redirects to
`?joined=waitlist` so the page can say so. `promoteFromWaitlist` is the only way back up — one
`UPDATE … FROM (SELECT … ORDER BY signed_up_at LIMIT room)`, so the database decides who is next rather
than a read-then-write — and it is called from **every path that can free a place**: a withdrawal
(`withdrawFromEvent`, and only when the leaver held a confirmed place), an admin raising `capacity`
(`updateEvent`, in the same transaction as the edit), and a member being deleted (`deleteUser`). A new
path that frees a place must call it too, holding the event lock. `promoted_at` records the moment and
stays NULL for a signup that was confirmed from the start. Lowering `capacity` deliberately demotes
**nobody**: a confirmed place is never taken back, so the event just sits over capacity until enough
members withdraw. Ordering everywhere is `signed_up_at` — the waitlist is served strictly first-come.

**Calendar view.** `/calendar` renders a month grid built server-side by `buildMonthGrid` in
[server.js](server.js#L118): weeks start on **Sunday** (leftmost column), always 6 rows so the card keeps
a constant height while paging, and the leading/trailing cells come from the neighbouring months. The
month shown comes from `?month=YYYY-MM` (anything malformed falls back to the current month). All the
date arithmetic uses local-time `new Date(y, m, d)` — never `new Date('YYYY-MM-DD')`, which parses as
UTC and lands a day early west of Greenwich. Styling lives in [public/css/calendar.css](public/css/calendar.css)
on the brand tokens declared at the top of [public/css/main.css](public/css/main.css); those tokens are
the club blue ramp, and only steps 600+ have enough contrast for text on white.

The grid **is** the page: there is no list of upcoming/past events any more, and
[header.ejs](views/partials/header.ejs) special-cases `path === '/calendar'` to put `.page-full` on
`<body>` and swap the wrapper to `.container-fluid`. The `.page-full` rules in calendar.css pin the body
to the viewport (`overflow:hidden`), hide the site footer, and make `.main-content → .cal → .cal-grid →
.cal-week` a flex chain — every link of it needs `min-height: 0`, or the rows refuse to shrink and the
sixth week is pushed off the bottom instead of the rows sharing the height. `.cal-day` therefore drops
its `min-height` on this page and scrolls internally when a day holds more chips than fit.

**Creating and editing events.** One form serves both: [views/partials/event-modal.ejs](views/partials/event-modal.ejs)
holds the markup *and* its script, and each page includes it with a `formEvent` local — `null` from the
"添加活动" button on `/calendar` (POSTs to `/api/events`, `requireAdminApi` → `db.createEvent`, which
generates the 24-char hex id), the event itself from the "编辑" button on `/event/:id` (pre-filled, PUTs
to `/api/events/:id`). Both buttons render only for admins. Change the form once, in the partial; the
including page supplies `formEvent`, `mapCenter` and `defaultDate`, nothing else.

**`formEvent` decides what the modal *can* do; `data-event-modal` on the button decides what it does on
this click.** The script holds a `MODES` map — `create` always, plus `edit` and `copy` when `formEvent`
is set — and each mode carries its endpoint, method, title, submit label and where to go afterwards
(`reload` the event page, `/event/<new id>` for a copy, `/calendar?month=…&created=1` for a creation).
A button opening the modal names its mode (`data-event-modal="edit"` / `"copy"`); one without the
attribute, like 添加活动 on `/calendar`, leaves the render-time mode alone. The listeners are bound to
the buttons themselves, not to `document`, so they run before Bootstrap's data-api handler shows the
dialog and the title is already right when it appears. `setMode` calls `form.reset()`, which restores
every field to the value the server rendered — that *is* the prefill for a copy, so only the date is
then moved on a week (`addWeek`, local-time arithmetic, same reason as the calendar grid). It also
means switching modes never leaves a cancelled copy's edits in the 编辑 form. Any new field that
needs a mode-specific value goes in `setMode`, after the reset.

The modal carries a Leaflet picker — click the map or drag the pin to set `coords`, drag the green dot on
the rim of the radius circle to resize it, plus lat/lng/`checkinRadius` boxes that stay in sync both ways —
and clearing lat/lng sends `coords: null`, i.e. an online event with no check-in. The rim handle keeps its
last bearing (`handleBearing`) so it stays where it was dropped, and writes `radiusInput.value` directly
during the drag: setting `.value` fires no `input` event, which is what stops `drawPoint` from repositioning
the handle out from under the cursor. **There is no separate search box: the 地点 field is the geocoder
input**, hitting **Nominatim** (`nominatim.openstreetmap.org/search`, same project as the tiles, no API
key). Picking a result fills 地点 and moves the pin — unconditionally, since the member picked it; the
value written is `placeLabel()`, the place's name plus the two components after it, because
`display_name` is the whole postal chain down to "United States" and unreadable in a form field (the
list still shows the full string, which is what makes two same-named parks distinguishable). It runs as
you type, 300ms after the last keystroke — note that Nominatim's policy for the public instance actually
**forbids autocomplete** and caps it at a request a second, so the guards are load-bearing: a 2-character
minimum, the same trimmed text is never queried twice in a row, and each request aborts the one before
it. A sequence number, not the abort, is what stops a slow earlier reply overwriting a later one. Enter
passes `force` to re-run a query the debounce would skip, and is `preventDefault`ed because the box lives
inside the event form. Swapping to a geocoder built for type-ahead (Photon, LocationIQ) is a change of URL
and result-field names only. 地点 is still an ordinary free-text field, so `blur` closes the list —
paired with a `mousedown` `preventDefault` on the list, without which Safari (which doesn't focus a button
on click) would tear it down before the click landed. The results list is in normal flow, not an absolute
dropdown: the modal body is a scroll container and would clip an overlay. It is a **sibling** of the
`.field-inline-sm` wrapper around label+input, not a child — under `sm` that class makes its children one
flex row and the list would join the line.

**开始时间 and 结束时间 are two `datetime-local` inputs that need no conversion at all.** `start_at` and
`end_at` are stored in exactly the form the control carries — `'YYYY-MM-DDTHH:MM'` — so the EJS preamble
drops them straight into `value=` and the submit handler sends them back as `startAt`/`endAt` with only a
`slice(0, 16)` to trim the `:00` seconds some browsers append. Nothing is stitched or parsed on the way
through, and `date`/`time` are derived server-side, so they are not in the body. The pair sits in one
`form-row`, `col-sm-6` each: side by side from `sm` up, stacked on a phone where `.field-inline-sm` puts
each label on its input's line, keeping it two rows rather than four.

**结束时间 trails 开始时间 by `DEFAULT_HOURS` (2) until it is set by hand.** `syncEnd` has no "touched"
flag — the end counts as the automatic one exactly while it equals `addHours(lastStart, DEFAULT_HOURS)`,
where `lastStart` is the start the current value was derived from, so a hand-set end survives however
many times the start is nudged afterwards. The one override is a start pushed to or past its own end,
which nothing could save: that snaps back to the default rather than raising an error the admin has to
fix. `addHours` is local-time `new Date(y, m, d, h + n, min)` arithmetic like `addWeek` — an evening
kick-off plus two hours is legitimately the next day, and `end_at` carrying a different date to
`start_at` is normal, not an error. It is bound to both `input` (fires per segment while typing, and the
value reads `''` until every segment is filled — hence the `DT_RE` guard) and `change` (the native
calendar). `setMode` resets `lastStart` after `form.reset()`, and a copy moves **both** ends on by a
week so the event keeps its length.

The modal is `modal-dialog-scrollable`, but Bootstrap's rules for that put `max-height`/`overflow:hidden` on
`.modal-content` and `overflow-y:auto` on `.modal-body`, and the `<form>` in between is the actual flex item.
[calendar.css](public/css/calendar.css) gives that form `display:flex; flex-direction:column; min-height:0;
overflow:hidden` to join the two halves up — without `min-height:0` it refuses to shrink and the content
simply clips the footer instead of the body scrolling. Any new element wrapped around the body needs the
same treatment. `mapCenter` is the latest
event with coords on `/calendar` and the event's own point on `/event/:id`, both falling back to
`DEFAULT_MAP_CENTER`. The map is built on Bootstrap's `shown.bs.modal`, because Leaflet measures a
`display:none` container as 0×0; that handler waits for `window.load` since jQuery only loads in the
footer. **`leaflet.js` is loaded once, in [views/partials/header.ejs](views/partials/header.ejs)** — an
admin viewing an event has the check-in map and the picker on one page, and a second copy of the library
would swap `L` out from under whichever map was built first. It is deliberately not `defer`red: the
inline map scripts run during parsing.

Creating navigates to `/calendar?month=<new event's month>&created=1`, and that flag is what renders the
green banner the page's script removes after 5 seconds; editing just reloads the event page. Either way
the result comes from one fresh server render instead of being patched into the DOM. `validateEvent` is
shared by both routes; extend it rather than adding a second set of checks.

**Signup roster.** The 报名名单 block is an avatar grid (`.roster` in [public/css/event.css](public/css/event.css)),
not a list: each member is their `profilePhoto` — or the gravatar fallback — over their name, and the
grid is `repeat(auto-fill, minmax(4rem, 1fr))` so the same markup fills a phone screen and the narrow
`col-md-4` sidebar without a breakpoint. A check-in renders as a green ring plus a tick badge on the
avatar (with a legend under the grid) rather than a per-row 已签到 label. There is deliberately **no
card around it**: the border plus `.card-body` padding cost roughly a whole column of avatars in that
sidebar, so the count is a plain `.roster-head` with a hairline under it. The `<img>` is `object-fit:
cover` because a stored `profile_photo` is an arbitrary URL at an arbitrary aspect ratio, unlike the
square gravatar; the gravatar fallback is requested at `s=144` for a 48px box, i.e. sized for a 2–3×
phone screen, so changing the CSS size means revisiting that number in `/event/:id` **and** the
`width`/`height` attributes on the `<img>` in [views/event.ejs](views/event.ejs). The grid has room for
a name and nothing else, so the two timestamps ride in the `title` tooltip — `server.js`'s `formatStamp`
renders them (local time, minute precision, year dropped when it is this year) and the template never
sees a raw `Date`.

**候补名单 is a second copy of that grid**, below the roster and rendered only when somebody is waiting.
Same markup, three differences: the avatar is dimmed (`.is-waitlisted`, `opacity` on the `<img>` alone so
the badge and name keep their contrast), the tick badge's corner carries `.roster-queue` — the member's
1-based place in the queue — and the whole thing is skipped when `waitlist` is empty. `/event/:id` builds
both grids from `event.roster` with one `toParticipant` mapper, so a field added for one is in the other.
The signup button reads the viewer's own row: 报名 when there is room, **加入候补名单** (`btn-warning`)
when there is not, 退出候补 with their place when they are already waiting, 取消报名 when confirmed —
all four posting to the same two routes, since `withdraw` deletes whichever kind of signup you hold.

**Event page actions.** Everything the page can do is one divider-separated stack of full-width buttons
(`.event-actions` in [public/css/event.css](public/css/event.css)), mirroring the production app:
报名/取消报名 for everyone, then 编辑活动, 清空报名 and 复制 for admins only. The title row
carries no buttons. The stack sits **outside and after the `.row`**, not inside the `col-md-8` details
column, so it lands below the roster in both layouts — details beside the roster on `md+`, then
details → roster → buttons stacked on a phone. Moving it back into a column puts the buttons above the
roster on a phone. 清空报名 is a plain form POST gated by `requireAdmin` (the
HTML guard, which re-reads the role), not by `isAdmin` in the template — that local only decides what
renders — and confirmed with an inline `onsubmit` `confirm()`. `POST /event/:id/clear-signups` calls
`db.clearEventRoster`, which drops the waitlist and the check-ins along with the signups: a check-in
from someone off the roster means nothing, and a queue with nobody ahead of it is noise.

**复制 has no route of its own.** It opens the same event modal in `copy` mode — every field prefilled
from this event, the date a week on, editable before it is saved — so the copy is an ordinary
`POST /api/events` (`requireAdminApi`) landing on the new event page. The copy starts with a fresh id and
an empty roster because `createEvent` only writes the event row; the roster is not part of the form.
The old `POST /event/:id/copy-next-week` route and the server's `addDays` helper are gone with it, as
is the `nextWeekDate` render local. There is still no delete route.

**Check-in flow.** Browser `watchPosition` → `POST /event/:id/checkin` with `{lat, lng}` →
server recomputes haversine distance against `event.coords` and rejects beyond `event.checkinRadius`.
The identical `distanceMeters` helper exists twice, in [server.js](server.js#L97) and inline in
[views/event.ejs](views/event.ejs#L180); the client copy only enables/disables the button — the server
copy is authoritative. What the server accepts is written by `db.checkInToEvent` as an `event_checkins`
row: the time, plus the coordinates and the distance it just computed, as the evidence behind it.
Checking in twice keeps the first row, so `checked_in_at` is always the moment of arrival. The route
reads the member's own `event.roster` entry, so a **waitlisted** member is refused (there is no place to
arrive at yet) as distinctly from one who never signed up. Withdrawing deletes the check-in with the
signup. `event_checkins.checked_in_by` exists in the schema for an admin checking somebody else in;
nothing writes it yet.

**Async errors.** Express 4 doesn't catch rejected promises, so every async route is wrapped in the
`wrap()` helper. New async routes must use it or failures will hang the request.

**Auth.** Session cookie only — no JWTs, no refresh tokens. `requireLogin` redirects HTML routes to
`/login` (storing `returnTo`); `requireLoginApi` returns 401 JSON for `/api/*` and the check-in endpoint.

**Roles.** Two, stored uppercase in `users.role` and constrained by a CHECK: `MEMBER` (the default) and
`ADMIN`. `req.session.user.role` is a copy taken at login and used **only for rendering** (hiding nav
links); it can be 30 days stale, so it is never the authorization check. `requireAdmin` /
`requireAdminApi` (both built by `adminGuard` in [server.js](server.js#L60)) re-read the row from the
database on every admin request and refresh the session copy, so a demotion takes effect at once.
Member-only traffic keeps its current query count. Gate new admin routes with these, never with
`req.session.user.role`.

**User writes go through `db.upsertUser`** ([db.js](db.js#L64)) — insert-or-update-password keyed on
email, writing `name`/`position`/`role` only when supplied, so a password reset never clobbers an
admin's role. That's what makes it serve both the bulk
add form on `/members` and (in future) a member changing their own password: pass just email + password and
the existing profile is preserved. Prefer extending it over adding new user-write SQL. The older
`db.createUser` stays only because `POST /api/users` depends on its duplicate-key 409.

**Member list.** [views/members.ejs](views/members.ejs) + [public/css/members.css](public/css/members.css),
which reuses the `.page-head` / `.card-surface` / `.btn-brand` helpers that happen to live in
`calendar.css` (every stylesheet is loaded on every page). The table is phone-first: `#` drops below
`sm`, 账号 and 加入时间 drop below `md`, and the email is repeated inside the name cell for the widths
where its own column is hidden — so a new column needs a matching `d-none d-*-table-cell` decision.
The row action is an icon-only pencil (`.icon-btn`, 44px on touch screens) because a text button
widened the table past a phone viewport. Both modals stack their footer buttons full-width under `sm`,
and `.modal .form-control` is forced to 16px there: anything smaller makes iOS Safari zoom on focus.

Under `sm`, a form field marked `.field-inline-sm` puts its label on the same line as the input, which
takes roughly a third off the form's height; the rule lives in `calendar.css` and both modals (event
and user) use it, so it is deliberately *not* scoped to an id. A `.form-text` hint inside such a field
is hidden there — it would otherwise land in the middle of that flex row — so the placeholder has to
carry the same information. `.page-head` also shrinks under `sm`, on every page that uses it.

`db.updateUser` is the edit-only counterpart, behind `PUT /api/users/:email` and the per-row
pencil modal on `/members`. It never inserts and needs no password, so a blank password box means
"keep the current one"; `name`/`position`/`profilePhoto` are written only when the key is present, and an
empty `position`/`profilePhoto` string clears the column. It cannot change `role` — promotion is still a
manual SQL update.

**Avatars.** `users.profile_photo` is a TEXT column holding the *URL* of the member's picture (nothing is
uploaded or stored by this app). Every function returning a user row maps it through `rowToUser`, which
renames it to `profilePhoto` — the name the form, the JSON API and the templates all use; `getUserByEmail`
is the exception, it hands back the raw row (it carries `password_hash` too) so `/profile` reads
`row.profile_photo` there. `db.js`'s `normalizePhoto` restricts writes to `http(s)://…` or a site-relative
`/…` path, because the value goes straight into an `<img src>`. Empty means "no photo", and every render
falls back to `gravatar(email)` — so a member without one looks exactly as before. The photo is a URL the
member typed and can 404, so `/profile` also carries the gravatar in `data-fallback` and swaps to it from
`onerror`; `.profile-avatar` is `object-fit: cover`, since the picture won't be square.

**Nothing in the UI sets that URL.** The edit form used to carry a 头像链接 box and it was deliberately
removed: the modal now omits `profilePhoto` from the PUT body entirely, and because `db.updateUser` only
writes keys that are present, an edit leaves the column untouched. `PUT /api/users/:email` still accepts
the key (`server.js` passes it through when sent) and `db.updateUser` still writes it, so the column is
set by hand in SQL, or by re-adding an input. The pages keep rendering the value and their `data-photo`
attributes; the saved row that comes back from the PUT still carries the unchanged photo, so the
`user-updated` handlers that patch the avatar keep working.

**Deleting a member** is `db.deleteUser`, behind `DELETE /api/users/:email` (`requireAdminApi`, and the
route additionally refuses the session's own email — deleting yourself would destroy the session doing
it and could leave nobody able to manage members). **An `ADMIN` row can never be deleted**: the route
re-reads the target with `db.getUserByEmail` and answers 403 when its role is `ADMIN`, which also covers
the self case. Removing an admin therefore means demoting them to `MEMBER` in SQL first — the same manual
update that promotes. Nothing in `db/schema.sql` points a foreign key at
`users`, so the function does the cascading by hand: in one transaction it deletes the row, then the
member's `event_checkins` and `event_signups` rows (a leftover would render as a raw address on the event
page and still count against capacity) — and because that can free confirmed places, it locks each event
it emptied a place in and runs `promoteFromWaitlist` there before committing. Afterwards it sweeps the
member's `gsffc.session` rows so an already-signed-in browser stops working. That sweep is best-effort — the session table is created lazily
by `connect-pg-simple`, so a failure is logged, not thrown. `/profile` already tolerates the account
vanishing under a live session (it destroys the session and redirects to `/login`).

**Profile page.** The member's name in the navbar links to `/profile`, which renders their own row
(read fresh from the database, not from the session copy) and an "编辑" button opening the *same*
form admins get. That form lives in [views/partials/user-edit-modal.ejs](views/partials/user-edit-modal.ejs) —
markup and script together, like `event-modal.ejs`. It binds to every `.edit-user` button on the page
(`data-email` / `data-name` / `data-position`), PUTs to `/api/users/:email`, and on success
dispatches a `user-updated` CustomEvent on `document` carrying the saved row. The partial deliberately
knows nothing about the including page's DOM: `members.ejs` listens for that event to patch its table row,
`profile.ejs` to patch the card, the avatar and the navbar name. Change the form once, in the partial —
including the `data-*` attributes, which every `.edit-user` button on every page has to supply.

Its footer also carries a "删除用户" button, rendered only when `user.role === 'ADMIN'` (rendering-only,
as everywhere — the route re-reads the role) and hidden by the open handler when the row being edited is
the viewer's own **or is itself an `ADMIN`** (`data-role` on the button); either case makes it invisible
on `/profile`. It arms on the first click and
sends the DELETE on the second, with the warning in the modal's own alert box rather than a native
`confirm()`, which stacks badly over a modal on a phone. Success dispatches `user-deleted` with
`detail.email` under the same contract as `user-updated`: `members.ejs` drops the row, renumbers the `#`
column (it is a position, not an id) and rewrites the header count.

The card is phone-first the way the member table is: below `sm` the 账号 and 姓名 rows
(`.profile-field-dup`) are hidden because the identity block at the top already shows both, the avatar
and the paddings shrink, and the label/value pairs stay side by side — stacking them is what makes a
card *taller*. On a phone the navbar collapses, which would bury the profile link behind the hamburger,
so [header.ejs](views/partials/header.ejs) renders it twice: `.navbar-profile` sits outside the collapse
below `lg`, the `.nav-user` item inside it takes over at `lg`. Both spans are `.nav-user-name`, so
anything renaming the user in place must write to **all** of them.

**The navbar is exactly one row tall on a phone**, and [main.css](public/css/main.css) keeps it that
way: `--gsf-navbar-h` (56px, 70px from `lg`) sets both the bar's `min-height` and the `padding-top`
the body reserves for it, so the two can't drift. Below `lg` the container is `flex-wrap: nowrap` —
Bootstrap otherwise wraps the hamburger onto a second line on a 320px screen, making the bar taller
than the reserved space and hiding the top of the page under it. The brand holds its width and the
member's name is the item that shrinks (`flex: 1 1 auto` + `min-width: 0`); at 320px even that isn't
enough, so `.brand-short`/`.brand-full` swap in a shorter club name below 360px. The open menu is
`position: absolute` under the bar rather than in flow, for the same reason: expanding it must not
change the navbar's height. Anything added to the bar has to fit that single row.

Because a member edits their own row through it, `PUT /api/users/:email` is gated by
`requireSelfOrAdminApi`, not `requireAdminApi`: the target email matching the session's is allowed
through, everything else is delegated to the admin guard (so the role is still re-read from the
database). This is only safe because `db.updateUser` can't write `role` — a self-service write that
could would be self-promotion. Gate any future user-write route the same way, or keep it admin-only.

**An `ADMIN` row's password and name are writable only by that admin.** When the target email is not
the session's, `PUT /api/users/:email` re-reads the row and, if its role is `ADMIN`, accepts nothing
but `position` — a non-empty `password`, a `name` different from the stored one, or any
`profilePhoto` answers 403 (the form always resubmits the current name, so an unchanged one is not
treated as an edit). This is the same shape as the delete rule: an admin is edited or removed by
demoting them in SQL first. The modal mirrors it by `disabled`-ing 密码 and 姓名 and showing an info
box on those rows, and leaves the locked keys out of the PUT body entirely — rendering only, as
always. It reads the viewer's own address from `data-self-email` on **the modal element**, not from
the 删除用户 button, which only renders for admins.

## POC caveats deliberately left in

- `POST /members/add-users` and `POST /api/users` require `ADMIN`, and `PUT /api/users/:email`
  requires `ADMIN` for anyone but yourself, but an
  admin there can still reset any **non-admin** member's password — or delete that account outright
  through `DELETE /api/users/:email`, irreversibly and with no soft-delete — and nothing records who did it. A member
  changing their own password on `/profile` is likewise not asked for the current one. `GET /add-user`
  and `GET /member-list` are now just redirects to `/members` for old bookmarks, so they need no gate
  of their own.
- Creating an event is admin-only, and the "编辑" button only renders for admins, but the route behind it
  (`PUT /api/events/:id`) is still `requireLoginApi` — **any** logged-in member can edit any event by
  calling it directly, which now includes raising `capacity` to promote themselves off the waitlist.
  There is no delete route at all.
- **Being promoted off the waitlist is silent.** There is no mail, no push, nothing: the member finds
  out by opening the event page. Nothing displays `promoted_at` either, though it is recorded.
- A signup carries no cut-off. `POST /event/:id/signup` will still take a signup for an event whose date
  has passed — only the template hides the button — and 报名截止 times exist just in the description text.
- `SESSION_SECRET` falls back to a hardcoded string.
- Browser geolocation requires HTTPS or localhost; testing on a phone needs ngrok/cloudflared, or use
  DevTools → Sensors to fake coordinates.
