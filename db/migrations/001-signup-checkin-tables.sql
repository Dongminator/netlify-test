-- Migration 001 — move rosters out of the two JSON columns on `gsffc.events`
-- and into real tables, so a signup and a check-in each carry their own time.
--
-- Apply by hand, once, to a database created before those tables existed:
--   psql "$DATABASE_URL" -f db/migrations/001-signup-checkin-tables.sql
-- A database provisioned from the current db/schema.sql already has them and
-- does not need this file. It is safe to re-run either way: the backfill is
-- skipped once the old columns are gone.

BEGIN;

CREATE TABLE IF NOT EXISTS gsffc.event_signups (
  event_id     TEXT NOT NULL REFERENCES gsffc.events(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'SIGNED_UP' CHECK (status IN ('SIGNED_UP', 'WAITLIST')),
  signed_up_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at  TIMESTAMPTZ,
  PRIMARY KEY (event_id, email)
);

CREATE INDEX IF NOT EXISTS event_signups_queue_idx
  ON gsffc.event_signups (event_id, status, signed_up_at);

CREATE TABLE IF NOT EXISTS gsffc.event_checkins (
  event_id      TEXT NOT NULL REFERENCES gsffc.events(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  distance_m    INTEGER,
  checked_in_by TEXT,
  PRIMARY KEY (event_id, email)
);

-- Separately, for a database that ran an earlier copy of this file.
ALTER TABLE gsffc.event_checkins ADD COLUMN IF NOT EXISTS checked_in_by TEXT;

-- The backfill has to be dynamic SQL: once the columns are dropped the
-- statements below no longer parse, which would break re-running the file.
DO $migrate$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'gsffc' AND table_name = 'events' AND column_name = 'signups'
  ) THEN
    -- The old format recorded no times at all, so every migrated row is stamped
    -- "now". The position in the JSON array was the only ordering there was, and
    -- it is preserved as a millisecond offset — that is what the roster order and
    -- the waitlist order are read from afterwards.
    -- An event whose list was longer than its capacity (the old signup route
    -- could not do that, but an admin lowering `capacity` could) keeps the first
    -- `capacity` members and lands the overflow on the waitlist, oldest first.
    EXECUTE $sql$
      INSERT INTO gsffc.event_signups (event_id, email, status, signed_up_at)
      SELECT e.id,
             s.email,
             CASE WHEN s.ord <= e.capacity THEN 'SIGNED_UP' ELSE 'WAITLIST' END,
             now() + (s.ord * interval '1 millisecond')
      FROM gsffc.events e
      CROSS JOIN LATERAL json_array_elements_text(e.signups::json)
        WITH ORDINALITY AS s(email, ord)
      ON CONFLICT (event_id, email) DO NOTHING
    $sql$;

    -- Only the fact of the check-in survives the old format; lat/lng/distance
    -- stay NULL for these rows. A check-in by somebody who is not on the signup
    -- list is dropped rather than migrated — the new tables treat a check-in as
    -- belonging to a signup, and the event page reads it through that join.
    EXECUTE $sql$
      INSERT INTO gsffc.event_checkins (event_id, email, checked_in_at)
      SELECT e.id, c.email, now() + (c.ord * interval '1 millisecond')
      FROM gsffc.events e
      CROSS JOIN LATERAL json_array_elements_text(e.checkins::json)
        WITH ORDINALITY AS c(email, ord)
      WHERE EXISTS (
        SELECT 1 FROM gsffc.event_signups s
        WHERE s.event_id = e.id AND s.email = c.email
      )
      ON CONFLICT (event_id, email) DO NOTHING
    $sql$;
  END IF;
END
$migrate$;

ALTER TABLE gsffc.events DROP COLUMN IF EXISTS signups;
ALTER TABLE gsffc.events DROP COLUMN IF EXISTS checkins;

COMMIT;
