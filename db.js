const crypto = require('crypto');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');

// `events.start_at` / `end_at` are TIMESTAMP *without* time zone — a wall clock
// ("16:00 at the pitch"), which is what a club schedule actually means. By
// default node-postgres turns that into a JS Date built in the Node process's
// own timezone, and a Date is a point in time: `JSON.stringify` calls
// `toISOString()` on it, so the events API would answer 2026-06-13T23:00:00.000Z
// for a 16:00 event on a Pacific machine and 16:00Z on Netlify (UTC) — the same
// row reading differently per host. Handing the value back as the string
// Postgres sent, trimmed to 'YYYY-MM-DDTHH:MM', keeps it a wall clock end to
// end: it is what the JSON API emits, what <input type="datetime-local">
// consumes and returns, and a fixed width so `date`/past/upcoming comparisons
// stay lexical. Only OID 1114 is remapped; the roster's TIMESTAMPTZ columns
// (1184) are real instants and keep their Date parsing.
types.setTypeParser(1114, value => value.slice(0, 16).replace(' ', 'T'));

// All tables live in this hardcoded schema; every query below is prefixed with it.
// The schema itself is provisioned manually from db/schema.sql — not by this code.
const SCHEMA = 'gsffc';

// The only two roles. Stored uppercase and constrained by a CHECK in
// db/schema.sql, so these strings must stay in sync with that constraint.
const MEMBER = 'MEMBER';
const ADMIN = 'ADMIN';
const ROLES = [MEMBER, ADMIN];

// The two kinds of signup, stored uppercase in `event_signups.status` and
// constrained by a CHECK in db/schema.sql. A member who signs up for a full
// event is recorded as WAITLIST and promoted to SIGNED_UP when a place frees up.
const SIGNED_UP = 'SIGNED_UP';
const WAITLIST = 'WAITLIST';

// The two keyword values of `events.visibility`; anything else in that column is
// a single member's email address. Constrained by a CHECK in db/schema.sql, so
// these strings must stay in sync with it.
const VISIBLE_ALL = 'ALL';
const VISIBLE_ADMIN = 'ADMIN';

// Direct Postgres connection (Supabase or any Postgres). This must be a
// Postgres connection string (postgres://...), NOT the Supabase REST API URL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL || undefined
});

// `roster` is the event's `event_signups` rows, already ordered (see
// `getRosters`). The three flat email arrays are derived from it rather than
// queried: `signups` and `checkins` keep the shape the templates and the JSON
// API had when the rosters lived in two JSON columns, and `waitlist` is the new
// one. `roster` is what the event page reads — it carries the timestamps.
//
// `startAt`/`endAt` are the stored columns, local wall clock to the minute
// ('YYYY-MM-DDTHH:MM'); `date`, `endDate` and `time` are sliced back out of them
// and are **read-only views**, the same arrangement as `signups`/`checkins` over
// `roster`. `date` is what the calendar groups by and what every past/upcoming
// test compares lexically against `todayStr()`, and `time` keeps the exact shape
// the old free-text column had ('16:00 - 18:00'), which is why the calendar chip
// and its tooltip needed no rewrite. Nothing writes through them.
function rowToEvent(row, roster = []) {
  if (!row) return null;
  const startAt = String(row.start_at || '');
  const endAt = String(row.end_at || '');
  return {
    id: row.id,
    title: row.title,
    startAt,
    endAt,
    date: startAt.slice(0, 10),
    endDate: endAt.slice(0, 10),
    time: `${startAt.slice(11, 16)} - ${endAt.slice(11, 16)}`,
    location: row.location,
    coords: row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null,
    description: row.description,
    capacity: row.capacity,
    checkinRadius: row.checkin_radius != null ? row.checkin_radius : 10,
    // 'ALL', 'ADMIN', or the one member's email — see `canSeeEvent`. Rows
    // written before the column existed read as 'ALL', the open default.
    visibility: row.visibility || VISIBLE_ALL,
    roster,
    signups: roster.filter(s => s.status === SIGNED_UP).map(s => s.email),
    waitlist: roster.filter(s => s.status === WAITLIST).map(s => s.email),
    checkins: roster.filter(s => s.checkedInAt).map(s => s.email)
  };
}

function rowToSignup(row) {
  return {
    email: row.email,
    status: row.status,
    signedUpAt: row.signed_up_at,
    // NULL unless the signup started on the waitlist and was moved up later.
    promotedAt: row.promoted_at,
    checkedInAt: row.checked_in_at || null,
    checkinDistance: row.distance_m != null ? row.distance_m : null
  };
}

// Coerce a submitted visibility into one of the column's three shapes: the two
// keywords (uppercased, so a form posting 'all' still lands on 'ALL') or a
// single lowercase email address. Throws on anything else rather than storing
// it — the CHECK in db/schema.sql would refuse it as a 500 further down.
function normalizeVisibility(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return VISIBLE_ALL;
  const upper = raw.toUpperCase();
  if (upper === VISIBLE_ALL || upper === VISIBLE_ADMIN) return upper;
  const email = raw.toLowerCase();
  if (!email.includes('@')) throw new Error('可见范围必须为 ALL、ADMIN 或某个成员的账号');
  return email;
}

// **The** rule for who may see an event, applied by every route that hands one
// out (the calendar, the event page, the JSON API) and by every route that
// writes to its roster. `user` is `{email, role}` — and `role` must be the one
// re-read from the database, not the session's 30-day-old copy: this is an
// access decision, not a rendering one.
//
// An administrator sees everything, whatever the column says. Without that an
// admin could publish an event only one member can see and then be unable to
// edit, clear or delete it — and the member could do none of those either.
function canSeeEvent(event, user) {
  if (!event) return false;
  if (!user || !user.email) return false;
  if (user.role === ADMIN) return true;
  const visibility = event.visibility || VISIBLE_ALL;
  if (visibility === VISIBLE_ALL) return true;
  if (visibility === VISIBLE_ADMIN) return false;
  return visibility === String(user.email).trim().toLowerCase();
}

async function getUsers() {
  const { rows } = await pool.query(
    `SELECT email, name, position, joined, role, profile_photo FROM ${SCHEMA}.users ORDER BY joined`
  );
  return rows.map(rowToUser);
}

// The `profile_photo` column is exposed to the app as `profilePhoto`, the name
// the edit form and the JSON API use; everything else passes straight through.
function rowToUser(row) {
  if (!row) return null;
  const { profile_photo: profilePhoto, ...rest } = row;
  return { ...rest, profilePhoto: profilePhoto || null };
}

// Photos are rendered straight into an <img src>, so keep the column to values
// that can only ever be a picture: an absolute http(s) URL or a site-relative
// path. Empty means "no photo" and clears the column.
function normalizePhoto(value) {
  const url = String(value == null ? '' : value).trim();
  if (!url) return null;
  if (!/^(https?:\/\/|\/)/i.test(url)) throw new Error('头像链接必须以 http://、https:// 或 / 开头');
  return url;
}

// Where an uploaded avatar is served from. `v` is the moment it was stored, so
// every upload is a *new* URL: nothing — browser, CDN, or the member's own
// phone — can go on showing the picture it replaced. The value passes
// `normalizePhoto` unchanged, since it is a site-relative path like any other.
const photoUrl = (email, version) => `/photos/${encodeURIComponent(email)}?v=${version}`;

// Store the member's uploaded picture and point their `profile_photo` at it.
// The bytes go in `user_photos`, never in `users`: that table is read whole by
// every page listing members, and a picture per row would ride along with it.
// The two writes are one transaction — a photo row nothing points at would
// never be served, and a URL with no row behind it renders as a broken image.
// Returns the updated user row, or null when there is no such member.
async function setUserPhoto(email, { mime, bytes }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('email 不能为空');
  if (!mime || !bytes || !bytes.length) throw new Error('图片内容为空');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Users first: the FK on `user_photos` would reject an unknown member with a
    // constraint error, and "no such member" is a 404, not a 500.
    const { rows } = await client.query(
      `UPDATE ${SCHEMA}.users SET profile_photo = $2 WHERE email = $1
       RETURNING email, name, position, joined, role, profile_photo`,
      [normalized, photoUrl(normalized, Date.now())]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      `INSERT INTO ${SCHEMA}.user_photos (email, mime, bytes, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (email) DO UPDATE SET
         mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, updated_at = now()`,
      [normalized, mime, bytes]
    );
    await client.query('COMMIT');
    return rowToUser(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// The stored picture itself, for GET /photos/:email. Null when the member never
// uploaded one — their `profile_photo` is then either empty or somebody else's
// URL, and the page falls back to the gravatar.
async function getUserPhoto(email) {
  const { rows } = await pool.query(
    `SELECT mime, bytes, updated_at FROM ${SCHEMA}.user_photos WHERE email = $1`,
    [String(email || '').trim().toLowerCase()]
  );
  return rows[0] || null;
}

async function getUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT * FROM ${SCHEMA}.users WHERE email = $1`, [email]
  );
  return rows[0] || null;
}

function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}

async function createUser(username, password) {
  const { rows } = await pool.query(
    `INSERT INTO ${SCHEMA}.users (email, password_hash, name)
     VALUES ($1, $2, $3)
     RETURNING email, name, position, joined, role, profile_photo`,
    [username, bcrypt.hashSync(password, 10), username]
  );
  return rowToUser(rows[0]);
}

// Create the member, or update the password of an existing one. `name`,
// `position` and `role` are only written when supplied, so calling this with just
// an email and a password works as a password reset and leaves the profile — and
// crucially the role — untouched. New members default to MEMBER.
// Returns the row plus `inserted` (true = created, false = updated).
async function upsertUser({ email, password, name, position, role }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('email 不能为空');
  if (!password) throw new Error('password 不能为空');
  const normalizedRole = role ? String(role).trim().toUpperCase() : null;
  if (normalizedRole && !ROLES.includes(normalizedRole)) {
    throw new Error(`role 必须为 ${ROLES.join(' 或 ')}`);
  }
  const { rows } = await pool.query(
    `INSERT INTO ${SCHEMA}.users (email, password_hash, name, position, joined, role)
     VALUES ($1, $2, $3, $4, $5, COALESCE($7, '${MEMBER}'))
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       name = COALESCE($6, ${SCHEMA}.users.name),
       position = COALESCE(EXCLUDED.position, ${SCHEMA}.users.position),
       role = COALESCE($7, ${SCHEMA}.users.role)
     RETURNING email, name, position, joined, role, profile_photo, (xmax = 0) AS inserted`,
    [
      normalized,
      bcrypt.hashSync(String(password), 10),
      name || normalized.split('@')[0],
      position || null,
      new Date().toISOString().slice(0, 10),
      name || null,
      normalizedRole
    ]
  );
  return rowToUser(rows[0]);
}

// Edit an existing member. Unlike `upsertUser` this never inserts and never
// requires a password: every field is optional and only the ones supplied are
// written, so the admin edit form can leave the password box blank to keep the
// current one. `position` is the one field that can be cleared — passing an
// empty string writes NULL, while omitting the key leaves it alone. `profilePhoto`
// behaves the same way, so clearing the box in the form removes the photo and
// falls the member back to their gravatar.
// Returns the updated row, or null when no such member exists.
async function updateUser({ email, password, name, position, profilePhoto }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('email 不能为空');
  // `name` is NOT NULL in the schema, so blanking it is rejected rather than
  // silently ignored — the admin would otherwise think the change was saved.
  const newName = name === undefined ? null : String(name).trim();
  if (newName !== null && !newName) throw new Error('姓名不能为空');
  const setPosition = position !== undefined;
  const setPhoto = profilePhoto !== undefined;
  const { rows } = await pool.query(
    `UPDATE ${SCHEMA}.users SET
       password_hash = COALESCE($2, password_hash),
       name = COALESCE($3, name),
       position = CASE WHEN $4::boolean THEN $5 ELSE position END,
       profile_photo = CASE WHEN $6::boolean THEN $7 ELSE profile_photo END
     WHERE email = $1
     RETURNING email, name, position, joined, role, profile_photo`,
    [
      normalized,
      password ? bcrypt.hashSync(String(password), 10) : null,
      newName,
      setPosition,
      setPosition ? (String(position).trim() || null) : null,
      setPhoto,
      setPhoto ? normalizePhoto(profilePhoto) : null
    ]
  );
  return rowToUser(rows[0]);
}

// Remove a member for good. The only foreign key pointing at `users` is
// `user_photos` (their uploaded avatar, which goes with the row); the roster
// tables carry none, so nothing else cascades on its own: the member's signups
// and check-ins would survive
// (rendering as a raw address on the event page and still counting against
// capacity), and their `express-session` rows would keep an already-signed-in
// browser working. Both are cleaned up here, the event rows in the same
// transaction as the delete — and every confirmed place the deletion frees is
// handed to the waitlist before that transaction commits.
// Returns the deleted row, or null when no such member exists.
async function deleteUser(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('email 不能为空');
  const client = await pool.connect();
  let deleted = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM ${SCHEMA}.users WHERE email = $1
       RETURNING email, name, position, joined, role, profile_photo`,
      [normalized]
    );
    deleted = rowToUser(rows[0]);
    if (deleted) {
      await client.query(
        `DELETE FROM ${SCHEMA}.event_checkins WHERE email = $1`, [normalized]
      );
      const { rows: gone } = await client.query(
        `DELETE FROM ${SCHEMA}.event_signups WHERE email = $1
         RETURNING event_id, status`,
        [normalized]
      );
      // Only the events where they held a confirmed place have room to fill.
      // The lock is taken here, after the deletes, for the same reason every
      // other roster write takes it: `promoteFromWaitlist` counts and then
      // writes, and the count must not go stale in between.
      const freed = [...new Set(gone.filter(r => r.status === SIGNED_UP).map(r => r.event_id))];
      for (const eventId of freed) {
        const { rows: locked } = await client.query(
          `SELECT capacity FROM ${SCHEMA}.events WHERE id = $1 FOR UPDATE`, [eventId]
        );
        if (locked[0]) await promoteFromWaitlist(client, eventId, locked[0].capacity);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  if (deleted) {
    // Best effort: the account is already gone, and losing the session sweep is
    // not worth failing the request over (the table is created lazily by
    // connect-pg-simple, so it may not exist yet on a fresh database).
    try {
      await pool.query(
        `DELETE FROM ${SCHEMA}.session WHERE sess -> 'user' ->> 'email' = $1`,
        [normalized]
      );
    } catch (err) {
      console.error('deleteUser: session cleanup failed', err.message);
    }
  }
  return deleted;
}

// Rosters for a set of events, as a Map of event id -> signup array. Confirmed
// members come first and the waitlist after, each half oldest signup first — the
// order the roster is rendered in, and the order the waitlist is served in.
// (`false` sorts before `true` in Postgres, so the CASE-free boolean works.)
// The check-in is a LEFT JOIN rather than a second query: every check-in belongs
// to a signup, and joining keeps the two halves of a member's record together.
async function getRosters(ids, client = pool) {
  const byEvent = new Map(ids.map(id => [id, []]));
  if (!ids.length) return byEvent;
  const { rows } = await client.query(
    `SELECT s.event_id, s.email, s.status, s.signed_up_at, s.promoted_at,
            c.checked_in_at, c.distance_m
     FROM ${SCHEMA}.event_signups s
     LEFT JOIN ${SCHEMA}.event_checkins c
       ON c.event_id = s.event_id AND c.email = s.email
     WHERE s.event_id = ANY($1)
     ORDER BY (s.status = '${WAITLIST}'), s.signed_up_at, s.email`,
    [ids]
  );
  for (const row of rows) byEvent.get(row.event_id).push(rowToSignup(row));
  return byEvent;
}

async function getEvents() {
  const { rows } = await pool.query(
    `SELECT * FROM ${SCHEMA}.events ORDER BY start_at`
  );
  const rosters = await getRosters(rows.map(r => r.id));
  return rows.map(row => rowToEvent(row, rosters.get(row.id)));
}

async function getEvent(id) {
  const { rows } = await pool.query(
    `SELECT * FROM ${SCHEMA}.events WHERE id = $1`, [id]
  );
  if (!rows[0]) return null;
  const rosters = await getRosters([rows[0].id]);
  return rowToEvent(rows[0], rosters.get(rows[0].id));
}

// Every roster write runs in here: a transaction holding a row lock on the event
// so the capacity arithmetic (count the confirmed signups, decide SIGNED_UP vs
// WAITLIST, promote the next in line) cannot interleave with another member's
// signup or withdrawal. `fn` receives the client and the locked event row.
// Returns null — without calling `fn` — when there is no such event.
async function withEventLock(eventId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM ${SCHEMA}.events WHERE id = $1 FOR UPDATE`, [eventId]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const result = await fn(client, rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Move the longest-waiting members up while there is room under `capacity`, and
// return the emails promoted (in order). Called from every path that can free a
// place: a withdrawal, a member being deleted, and an admin raising the capacity.
// The ordering is decided by the database inside one UPDATE, so the choice of
// who is next can't be made stale by a concurrent write; the caller must already
// hold the event lock from `withEventLock`.
async function promoteFromWaitlist(client, eventId, capacity) {
  const { rows: [{ confirmed }] } = await client.query(
    `SELECT COUNT(*)::int AS confirmed FROM ${SCHEMA}.event_signups
     WHERE event_id = $1 AND status = '${SIGNED_UP}'`,
    [eventId]
  );
  const room = capacity - confirmed;
  if (room <= 0) return [];
  const { rows } = await client.query(
    `UPDATE ${SCHEMA}.event_signups s
     SET status = '${SIGNED_UP}', promoted_at = now()
     FROM (SELECT email FROM ${SCHEMA}.event_signups
           WHERE event_id = $1 AND status = '${WAITLIST}'
           ORDER BY signed_up_at, email
           LIMIT $2) AS next
     WHERE s.event_id = $1 AND s.email = next.email
     RETURNING s.email, s.signed_up_at`,
    [eventId, room]
  );
  return rows
    .sort((a, b) => (a.signed_up_at < b.signed_up_at ? -1 : 1))
    .map(r => r.email);
}

// Sign a member up, or put them on the waitlist when the event is already full.
// Idempotent: signing up twice returns the existing row untouched, so a double
// submit can't move somebody to the back of the queue.
// Returns { status, created } — or null when there is no such event.
async function signUpForEvent(eventId, email) {
  const normalized = String(email || '').trim().toLowerCase();
  return withEventLock(eventId, async (client, event) => {
    const { rows: existing } = await client.query(
      `SELECT status FROM ${SCHEMA}.event_signups WHERE event_id = $1 AND email = $2`,
      [eventId, normalized]
    );
    if (existing[0]) return { status: existing[0].status, created: false };
    const { rows: [{ confirmed }] } = await client.query(
      `SELECT COUNT(*)::int AS confirmed FROM ${SCHEMA}.event_signups
       WHERE event_id = $1 AND status = '${SIGNED_UP}'`,
      [eventId]
    );
    const status = confirmed < event.capacity ? SIGNED_UP : WAITLIST;
    await client.query(
      `INSERT INTO ${SCHEMA}.event_signups (event_id, email, status) VALUES ($1, $2, $3)`,
      [eventId, normalized, status]
    );
    return { status, created: true };
  });
}

// Withdraw a member. Their check-in goes with the signup — it would otherwise
// count someone who is no longer on the roster — and the place they free is
// handed to the head of the waitlist in the same transaction.
// Returns { removed, status, promoted } — or null when there is no such event.
async function withdrawFromEvent(eventId, email) {
  const normalized = String(email || '').trim().toLowerCase();
  return withEventLock(eventId, async (client, event) => {
    const { rows } = await client.query(
      `DELETE FROM ${SCHEMA}.event_signups WHERE event_id = $1 AND email = $2
       RETURNING status`,
      [eventId, normalized]
    );
    if (!rows[0]) return { removed: false, status: null, promoted: [] };
    await client.query(
      `DELETE FROM ${SCHEMA}.event_checkins WHERE event_id = $1 AND email = $2`,
      [eventId, normalized]
    );
    // Only a confirmed place can free one up; a waitlister leaving changes
    // nothing but the queue behind them.
    const promoted = rows[0].status === SIGNED_UP
      ? await promoteFromWaitlist(client, eventId, event.capacity)
      : [];
    return { removed: true, status: rows[0].status, promoted };
  });
}

// Admin "清空报名": drop the whole roster, waitlist and check-ins included.
async function clearEventRoster(eventId) {
  return withEventLock(eventId, async (client) => {
    await client.query(`DELETE FROM ${SCHEMA}.event_checkins WHERE event_id = $1`, [eventId]);
    const { rowCount } = await client.query(
      `DELETE FROM ${SCHEMA}.event_signups WHERE event_id = $1`, [eventId]
    );
    return { removed: rowCount };
  });
}

// Record an arrival. The route has already checked that the member is confirmed
// and inside the radius; the coordinates and the distance it computed are stored
// as the evidence behind the row. Checking in twice keeps the first time, so
// `checked_in_at` is always the moment of arrival.
// Returns the check-in time, or null if there already was one.
async function checkInToEvent(eventId, email, { lat, lng, distance } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ${SCHEMA}.event_checkins (event_id, email, lat, lng, distance_m)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (event_id, email) DO NOTHING
     RETURNING checked_in_at`,
    [
      eventId,
      String(email || '').trim().toLowerCase(),
      Number.isFinite(lat) ? lat : null,
      Number.isFinite(lng) ? lng : null,
      Number.isFinite(distance) ? Math.round(distance) : null
    ]
  );
  return rows[0] ? rows[0].checked_in_at : null;
}

// Insert a new event. The id is generated here — the seeded rows use 24-char
// hex ids (the shape the production app's Mongo ids had), so new ones match.
// A fresh event always starts with empty signup/check-in lists.
async function createEvent(event) {
  const { rows } = await pool.query(
    `INSERT INTO ${SCHEMA}.events
       (id, title, start_at, end_at, location, lat, lng, description, capacity, checkin_radius, visibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      crypto.randomBytes(12).toString('hex'),
      event.title,
      event.startAt,
      event.endAt,
      event.location,
      event.coords ? event.coords.lat : null,
      event.coords ? event.coords.lng : null,
      event.description,
      event.capacity,
      event.checkinRadius || 10,
      normalizeVisibility(event.visibility)
    ]
  );
  return rowToEvent(rows[0]);
}

// The roster is no longer part of the event row, so this writes the event's own
// fields only. Raising `capacity` is the one edit with a roster consequence:
// the places it creates go straight to the head of the waitlist, in the same
// transaction, and the promoted emails come back to the caller. Lowering it does
// **not** demote anybody — a place already confirmed is never taken back, so the
// event simply stays over capacity until enough members withdraw.
// Returns { promoted }, or null when there is no such event.
async function updateEvent(event) {
  return withEventLock(event.id, async (client) => {
    await client.query(
      `UPDATE ${SCHEMA}.events SET
         title = $2, start_at = $3, end_at = $4, location = $5,
         lat = $6, lng = $7, description = $8, capacity = $9, checkin_radius = $10,
         visibility = $11
       WHERE id = $1`,
      [
        event.id,
        event.title,
        event.startAt,
        event.endAt,
        event.location,
        event.coords ? event.coords.lat : null,
        event.coords ? event.coords.lng : null,
        event.description,
        event.capacity,
        event.checkinRadius || 10,
        normalizeVisibility(event.visibility)
      ]
    );
    return { promoted: await promoteFromWaitlist(client, event.id, Number(event.capacity)) };
  });
}

// Admin "删除活动": the event row and everything hanging off it. No lock and no
// hand-rolled cascade — unlike `users`, both roster tables carry a real
// `REFERENCES gsffc.events(id) ON DELETE CASCADE`, so the signups, the waitlist
// and the check-ins go with the row in the same statement. There is no waitlist
// to promote afterwards: the event it queued for no longer exists.
// Returns the deleted event (so the caller knows which month to go back to), or
// null when there was no such event.
async function deleteEvent(id) {
  const { rows } = await pool.query(
    `DELETE FROM ${SCHEMA}.events WHERE id = $1 RETURNING *`, [id]
  );
  return rows[0] ? rowToEvent(rows[0]) : null;
}

module.exports = {
  pool, ROLES, MEMBER, ADMIN, SIGNED_UP, WAITLIST,
  VISIBLE_ALL, VISIBLE_ADMIN, normalizeVisibility, canSeeEvent,
  getUsers, getUserByEmail, verifyPassword, createUser, upsertUser, updateUser, deleteUser,
  setUserPhoto, getUserPhoto,
  getEvents, getEvent, createEvent, updateEvent, deleteEvent,
  signUpForEvent, withdrawFromEvent, clearEventRoster, checkInToEvent
};
