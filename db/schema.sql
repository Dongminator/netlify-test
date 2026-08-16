-- GSF demo: schema + seed data (PostgreSQL).
-- All objects live in the hardcoded `gsffc` schema.
-- Nothing in the app runs this file — apply it by hand before the first run.
-- This is the only DDL there is; there are no migration files. CREATE … IF NOT
-- EXISTS and ON CONFLICT DO NOTHING keep it safe to re-apply, so an existing
-- database is moved forward by running it again — anything that is not a fresh
-- create (a new column, a changed CHECK) is applied by hand in psql alongside it.

CREATE SCHEMA IF NOT EXISTS gsffc;

CREATE TABLE IF NOT EXISTS gsffc.users (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  position      TEXT,
  joined        TEXT,
  role          TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('MEMBER', 'ADMIN')),
  -- URL of the member's photo, e.g.
  -- https://raw.githubusercontent.com/gsffc/gsffc.github.io/refs/heads/main/assets/img/teams/GSF/donglin.jpg
  -- A photo uploaded from the edit-user modal lives in gsffc.user_photos and
  -- this column holds its own URL, '/photos/<email>?v=<upload time>'.
  -- NULL falls back to the gravatar built from the email.
  profile_photo TEXT
);

-- Avatars uploaded from the edit-user modal. The bytes are kept out of `users`
-- on purpose: every page that lists members SELECTs that table (the event page
-- reads all of them to build the roster), and a base64 picture per row would be
-- megabytes of query result nobody looks at. `users.profile_photo` keeps its
-- documented shape — a URL — and server.js serves this row from it.
--
-- `updated_at` is the cache key: the stored URL carries it as ?v=, so a new
-- upload is a new URL and no browser can go on showing the old picture.
-- Unlike the roster tables this one *does* carry a foreign key: a photo can
-- only ever belong to an account, so deleting the member takes it along.
CREATE TABLE IF NOT EXISTS gsffc.user_photos (
  email      TEXT PRIMARY KEY REFERENCES gsffc.users(email) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  bytes      BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `start_at` and `end_at` replace the old `date` + free-text `time` pair.
--
-- TIMESTAMP *without* time zone, deliberately: a club schedule is a wall clock
-- ("16:00 at the pitch"), not an instant, and it must not shift with whatever
-- timezone the server happens to run in (UTC on Netlify, local in dev).
-- TIMESTAMPTZ would convert on the way in and back out and move evening events
-- across midnight. db.js remaps this type to a plain 'YYYY-MM-DDTHH:MM' string
-- rather than a JS Date for the same reason — see the setTypeParser call there.
--
-- The app never stores seconds (the form is a minute-precision datetime-local),
-- and the CHECK below is what keeps it that way, so two events at the same
-- displayed time really are equal.
--
-- `date`, `endDate` and `time` still exist as read-only derived fields on the
-- app's event object (db.js `rowToEvent`), which is why the calendar kept working.
-- `visibility` is who may see the event at all — not a rendering flag: an event
-- the viewer cannot see is absent from the calendar and from /api/events, and
-- its page 404s. Exactly three shapes, and the CHECK is what keeps it to them:
--   'ALL'    — every signed-in member (the default, i.e. every existing row)
--   'ADMIN'  — administrators only
--   an email — that one member, and nobody else
-- Administrators always see everything regardless, which is what stops an event
-- from being created that nobody left can manage. The address is stored
-- lowercase and carries no foreign key to `users`, for the same reason
-- `event_signups.email` doesn't: the seeds may name members without accounts.
CREATE TABLE IF NOT EXISTS gsffc.events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  start_at    TIMESTAMP NOT NULL,
  end_at      TIMESTAMP NOT NULL,
  location    TEXT,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  description TEXT,
  capacity    INTEGER NOT NULL DEFAULT 0,
  checkin_radius INTEGER NOT NULL DEFAULT 10,
  -- 总人数（包含试训、guest）: the headcount the admin records by hand, counting
  -- everyone who turned up — trialists and guests included — not just the members
  -- who signed up in the app. Deliberately NOT derived from the roster and never
  -- written by a signup or a check-in; the roster count and this one answer
  -- different questions and are shown side by side. NULL means "not recorded",
  -- which is what every event reads as until an admin fills it in, and is why the
  -- column is nullable with no default rather than NOT NULL DEFAULT 0 — a 0 would
  -- claim nobody came.
  -- It is also what sizes 自动分队: three teams of ceil(total_headcount / 3) each,
  -- computed on the fly, never stored — see `event_checkins.team_no`. While it is
  -- NULL the teams are sized off `capacity` instead, so an event has teams from
  -- its first check-in without waiting for an admin to record the real number.
  total_headcount INTEGER,
  visibility  TEXT NOT NULL DEFAULT 'ALL',
  CONSTRAINT events_end_after_start CHECK (end_at > start_at),
  CONSTRAINT events_visibility_shape CHECK (visibility IN ('ALL', 'ADMIN') OR visibility LIKE '%@%')
);

-- One row per member per event. `signed_up_at` is both the audit trail and the
-- ordering key: the roster is shown oldest-first, and the waitlist is served in
-- that same order when a place frees up.
--
-- `status` is the "type" of the signup. A member joining a full event is
-- recorded as WAITLIST and promoted to SIGNED_UP automatically — by a withdrawal
-- (db.js `withdrawFromEvent`), by an admin raising `capacity` (`updateEvent`) or
-- by a member being deleted (`deleteUser`). `promoted_at` records when that
-- happened and stays NULL for a signup that was confirmed from the start.
--
-- `email` deliberately carries no foreign key to `users`: the seeds below name
-- members that may not have accounts yet. db.js `deleteUser` cascades by hand.
CREATE TABLE IF NOT EXISTS gsffc.event_signups (
  event_id     TEXT NOT NULL REFERENCES gsffc.events(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'SIGNED_UP' CHECK (status IN ('SIGNED_UP', 'WAITLIST')),
  signed_up_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at  TIMESTAMPTZ,
  PRIMARY KEY (event_id, email)
);

-- One row per check-in. `checked_in_at` is the arrival time; the coordinates and
-- the distance the server computed are kept as the evidence behind it.
-- A member may only check in while SIGNED_UP, and withdrawing deletes the row.
--
-- `checked_in_by` is 代签到: the admin who checked this member in on their
-- behalf, from POST /event/:id/checkin-for. NULL for the ordinary case — a
-- member checking themselves in — so a non-null value *is* the flag the event
-- page's 代 badge tests. When it is set, `lat`/`lng`/`distance_m` are the
-- **admin's** position, because the admin is the one who was at the pitch and
-- passed the geofence. No foreign key, for the same reason `email` has none.
--
-- `team_no` is 自动分队: the team this member was allocated to at the moment they
-- checked in, 1..3. The allocation is *random*, which is exactly why it is the
-- one part of the feature that has to be stored — the team count (always 3) and
-- the team size (ceil(events.total_headcount / 3), or of `capacity` while 总人数
-- is NULL) are derived on every read and never written, so correcting an event's
-- 总人数 re-sizes its teams and no column can drift out of agreement with the
-- number it was computed from. Same arrangement as 迟到罚款.
--
-- It rides on the check-in rather than living in a table of its own because a
-- member is allocated *by arriving*: withdrawing, 清空报名, deleting the member
-- and deleting the event all drop the check-in row and take the allocation with
-- it, so there is no new cascade anywhere. NULL means "not allocated" — a
-- check-in recorded before this feature existed, or one on an event with no team
-- size to fill against at all (no `total_headcount` and `capacity` 0).
CREATE TABLE IF NOT EXISTS gsffc.event_checkins (
  event_id      TEXT NOT NULL REFERENCES gsffc.events(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  distance_m    INTEGER,
  checked_in_by TEXT,
  team_no       SMALLINT,
  PRIMARY KEY (event_id, email)
);

-- Picking the next member off the waitlist, and counting the confirmed ones
-- against `capacity`, are the two hot queries; both are (event_id, status)
-- ordered by signup time.
CREATE INDEX IF NOT EXISTS event_signups_queue_idx
  ON gsffc.event_signups (event_id, status, signed_up_at);
