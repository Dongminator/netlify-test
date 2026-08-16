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

// 自动分队: an event is always split into this many teams. The number lives here
// and nowhere else — `db/schema.sql` deliberately carries no CHECK on
// `event_checkins.team_no`, so this module is what keeps that column to 1..3.
// `pickTeam` fills the first two and treats the last as the overflow, so a
// different count is a change to that function, not just to this constant.
const TEAM_COUNT = 3;

// Places per team: the event's headcount split three ways, rounded **up**, so 25
// gives teams of 9 (9 + 9 + 7). Derived on every read and never stored, which is
// what lets an admin correct an event's 总人数 and have its teams re-size with it.
//
// 总人数 is the number when it has been recorded, and 人数上限 (`capacity`) is the
// fallback when it has not — an event always has one, so teams can be filled from
// the first check-in without waiting for an admin to type the real headcount in.
// The fallback is on **null only**: a recorded 0 is "nobody came", an answer, not
// a blank, and it sizes no teams. null (nobody is allocated at all) is therefore
// left for the event that has neither — no 总人数 and `capacity` 0, the column's
// own default.
function teamSize(totalHeadcount, capacity) {
  const total = Number(totalHeadcount ?? capacity);
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.ceil(total / TEAM_COUNT);
}

// 自动分队 — the guests' names down the teams: A, B, C… Past Z a guest is
// numbered instead; an event with 26 more bodies than places is well past
// anything the club does.
const GUEST_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 自动分队 — the 试训/guest places. A trialist or a guest has no account, so they
// can never sign up, never check in and are never on the roster: the only trace
// of them is 总人数 counting bodies that 人数上限 does not. Their number is
// therefore exactly that difference, and their teams are hardcoded rather than
// drawn —
//
//   1 guest  → the bench
//   2 guests → the bench, plus the last place in one of the two playing teams
//   3 guests → one each
//
// — with anything past three going onto the bench, which is already the overflow
// for members. The difference only means something when the event has both
// numbers: an event with no 人数上限 (`capacity` 0, the column's default) has no
// member baseline to subtract from, so it has no guests either, and neither does
// one whose 总人数 has not been recorded yet.
//
// **A playing team that is already full takes no guest**: the place goes to the
// bench instead. Only the bench is uncapped, so a guest hardcoded into 黑桃/红桃
// would otherwise push it to `size + 1` — which is exactly what happens whenever
// members were allocated before the guests existed, i.e. every event whose 总人数
// is filled in or corrected upwards after people have started checking in
// (`teamSize` then re-sizes the teams, but nobody is ever re-allocated). `taken`
// is what makes that visible here: the number of **members** already holding a
// place in each team, a Map of team → count, from the caller that has them —
// `rowToEvent` from the roster, `pickTeam` from its own count query. It is
// members only; the guest places this function is deciding are added on top of it
// as they are placed, so two guests can never be given the same last place.
//
// Derived on every read like everything else about a team, which is what rules
// out drawing the second guest's playing team at random: a fresh draw would move
// between renders, and `pickTeam` — which has to leave that place free — would
// disagree with the page showing it. It comes from the event's own id instead,
// so it is fixed for one event without being the same team on every event. Being
// bumped to the bench is not a fresh draw: it is decided from the same check-in
// rows both callers read, so both agree, and it only ever moves one way.
//
// Returns `[{ label, team }]` ordered by team, so the labels read A, B, C down
// the list. The label is all this layer names them: 试训Guest A is UI text.
function eventGuests(eventId, totalHeadcount, capacity, taken = new Map()) {
  const total = Number(totalHeadcount);
  const cap = Number(capacity);
  if (totalHeadcount == null || !Number.isFinite(total) || !(cap > 0)) return [];
  const count = Math.max(0, total - cap);
  if (!count) return [];
  const size = teamSize(totalHeadcount, capacity);
  const id = String(eventId || '');
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum += id.charCodeAt(i);
  const first = 1 + (sum % 2);
  const order = [TEAM_COUNT, first, 3 - first];
  // The guest places handed out so far, so the second guest sees the first one's.
  const held = new Map();
  const place = wanted => {
    // The bench is the overflow: it is never full and never bumps anybody on.
    if (wanted === TEAM_COUNT) return TEAM_COUNT;
    const used = (taken.get(wanted) || 0) + (held.get(wanted) || 0);
    return size && used < size ? wanted : TEAM_COUNT;
  };
  return Array.from({ length: count }, (_, i) => {
    const team = place(order[i] != null ? order[i] : TEAM_COUNT);
    held.set(team, (held.get(team) || 0) + 1);
    return team;
  })
    .sort((a, b) => a - b)
    .map((team, i) => ({ label: GUEST_LABELS[i] || String(i + 1), team }));
}

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
  // 自动分队 — the roster grouped by the team each member drew at check-in, always
  // TEAM_COUNT arrays so an empty team is an empty array, not a hole. Hoisted out
  // of the object below because the guest places are decided against it: a full
  // playing team takes no guest — see `eventGuests`.
  const teams = Array.from({ length: TEAM_COUNT }, (_, i) =>
    roster.filter(s => s.team === i + 1).map(s => s.email));
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
    // 总人数（包含试训、guest）— recorded by hand, never derived from `roster`.
    // NULL is "not recorded" and stays distinct from 0 ("nobody came"), so it is
    // passed through as null rather than defaulted like `checkinRadius` above.
    totalHeadcount: row.total_headcount != null ? row.total_headcount : null,
    // 'ALL', 'ADMIN', or the one member's email — see `canSeeEvent`. Rows
    // written before the column existed read as 'ALL', the open default.
    visibility: row.visibility || VISIBLE_ALL,
    roster,
    signups: roster.filter(s => s.status === SIGNED_UP).map(s => s.email),
    waitlist: roster.filter(s => s.status === WAITLIST).map(s => s.email),
    checkins: roster.filter(s => s.checkedInAt).map(s => s.email),
    // 自动分队, both read-only views like the three arrays above: `teamSize` is
    // computed from 总人数, or from `capacity` until that is recorded, and `teams`
    // is the roster grouped by team (built above).
    teamSize: teamSize(row.total_headcount, row.capacity),
    teams,
    // The 试训/guest places, `[{ label, team }]` — see `eventGuests`, which is
    // given how many members each team already holds so a full 黑桃/红桃 hands its
    // guest to the bench instead of overflowing. They are not in `teams` above and
    // never will be: that is the roster grouped by team, and a guest has no
    // account and so no email to appear in it.
    guests: eventGuests(row.id, row.total_headcount, row.capacity,
      new Map(teams.map((members, i) => [i + 1, members.length])))
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
    checkinDistance: row.distance_m != null ? row.distance_m : null,
    // The admin who checked this member in on their behalf (代签到). NULL for
    // the ordinary case — a member who checked themselves in — so a non-null
    // value *is* the "this was a proxy check-in" flag the roster renders.
    checkedInBy: row.checked_in_by || null,
    // 自动分队: 1..TEAM_COUNT, drawn when the member checked in. null for a
    // check-in made before the feature existed, and for one on an event that had
    // no team size to fill against at all — see `teamSize`.
    team: row.team_no != null ? row.team_no : null
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
            c.checked_in_at, c.distance_m, c.checked_in_by, c.team_no
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

// Withdraw a member. The place they free is handed to the head of the waitlist
// in the same transaction.
//
// **Arriving is final: a member who has checked in can no longer withdraw.**
// Their check-in is the event's record that they turned up — it carries the
// moment, the distance, their 分队 allocation and their line in 罚款统计 — and
// deleting the signup would take all of it with it, which is a member erasing
// their own $10 by tapping 取消报名 after the fact. `checkInToEvent` holds this
// same event lock, so a check-in racing a withdrawal is serialised against the
// read below and cannot slip in after it. The way out of a checked-in signup is
// the admin's 清空报名, or SQL.
// Returns { removed, status, promoted, checkedIn } — or null when there is no
// such event. `checkedIn` is the one refusal that is not "you weren't signed up".
async function withdrawFromEvent(eventId, email) {
  const normalized = String(email || '').trim().toLowerCase();
  return withEventLock(eventId, async (client, event) => {
    const { rows: arrived } = await client.query(
      `SELECT 1 FROM ${SCHEMA}.event_checkins WHERE event_id = $1 AND email = $2`,
      [eventId, normalized]
    );
    if (arrived[0]) return { removed: false, status: null, promoted: [], checkedIn: true };
    const { rows } = await client.query(
      `DELETE FROM ${SCHEMA}.event_signups WHERE event_id = $1 AND email = $2
       RETURNING status`,
      [eventId, normalized]
    );
    if (!rows[0]) return { removed: false, status: null, promoted: [], checkedIn: false };
    // No check-in row to delete alongside it: the guard above is what makes that
    // true, so a withdrawal can no longer destroy one.
    // Only a confirmed place can free one up; a waitlister leaving changes
    // nothing but the queue behind them.
    const promoted = rows[0].status === SIGNED_UP
      ? await promoteFromWaitlist(client, eventId, event.capacity)
      : [];
    return { removed: true, status: rows[0].status, promoted, checkedIn: false };
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

// 自动分队 — the team an arriving member joins, which is the club's rule exactly:
// teams 1 and 2 are filled first (a random one of the two while both have room,
// the one that still has room once the other is full), and once neither does,
// everybody else goes into the last team. That last one is therefore the
// overflow and is deliberately **uncapped**: 总人数 counts trialists and guests
// who never check in, so the app's check-ins can outrun the number the teams
// were sized from, and a member arriving must always land somewhere.
//
// The 试训/guest places are **already taken**: a trialist can never check in, so
// nothing else would ever hold the place back for them and the last member to
// arrive would take it. Counting them here is what makes "2 guests → 板凳组一个，
// 红桃/黑桃最后一个checkin名额给另一个guest" true of the arrivals as well as of
// the display. They are derived here rather than passed in, because which team a
// guest lands in now depends on the very counts this function queries — a full
// playing team hands its guest to the bench (see `eventGuests`), and the page
// must not be shown a team the arrivals disagree with.
//
// Takes the event row the lock handed over, since the size and the guests both
// come out of 总人数/人数上限. Returns null when there is no size to fill against —
// see `teamSize`, i.e. an event with neither number — which is what leaves
// `team_no` NULL and allocates nobody. The caller must hold the event lock from
// `withEventLock`: this counts the rows and then writes one, so without it two
// members checking in at the same moment could both take the last place in a team.
async function pickTeam(client, eventId, event) {
  const size = teamSize(event.total_headcount, event.capacity);
  if (!size) return null;
  const { rows } = await client.query(
    `SELECT team_no, COUNT(*)::int AS taken FROM ${SCHEMA}.event_checkins
     WHERE event_id = $1 AND team_no IS NOT NULL
     GROUP BY team_no`,
    [eventId]
  );
  // Members only, which is what `eventGuests` needs; the guest places go on top.
  const taken = new Map(rows.map(r => [r.team_no, r.taken]));
  const guests = eventGuests(eventId, event.total_headcount, event.capacity, taken);
  for (const g of guests) taken.set(g.team, (taken.get(g.team) || 0) + 1);
  const hasRoom = team => (taken.get(team) || 0) < size;
  if (hasRoom(1) && hasRoom(2)) return crypto.randomInt(2) + 1;
  if (hasRoom(1)) return 1;
  if (hasRoom(2)) return 2;
  return TEAM_COUNT;
}

// Record an arrival. The route has already checked that the member is confirmed
// and inside the radius; the coordinates and the distance it computed are stored
// as the evidence behind the row. Checking in twice keeps the first time, so
// `checked_in_at` is always the moment of arrival.
// `by` is the admin who did it on the member's behalf (代签到) and is left NULL
// for a member checking themselves in — the coordinates then belong to whoever
// `by` names, since they are the one who was actually at the pitch.
//
// This runs inside `withEventLock`, unlike the plain INSERT it used to be: 自动分队
// is decided here, and picking a team means counting the teams first — a
// read-then-write that two simultaneous arrivals would otherwise interleave.
// The lock also hands over the event row, which is where the team size comes from.
// Returns { checkedInAt, team, created } — `created` false when the member was
// already checked in, carrying that first row's time and team — or null when
// there is no such event.
async function checkInToEvent(eventId, email, { lat, lng, distance, by } = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  const proxy = String(by || '').trim().toLowerCase();
  return withEventLock(eventId, async (client, event) => {
    const team = await pickTeam(client, eventId, event);
    const { rows } = await client.query(
      `INSERT INTO ${SCHEMA}.event_checkins
         (event_id, email, lat, lng, distance_m, checked_in_by, team_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id, email) DO NOTHING
       RETURNING checked_in_at, team_no`,
      [
        eventId,
        normalized,
        Number.isFinite(lat) ? lat : null,
        Number.isFinite(lng) ? lng : null,
        Number.isFinite(distance) ? Math.round(distance) : null,
        // Checking yourself in is not a proxy check-in, however the caller phrased it.
        proxy && proxy !== normalized ? proxy : null,
        team
      ]
    );
    if (rows[0]) {
      return { checkedInAt: rows[0].checked_in_at, team: rows[0].team_no, created: true };
    }
    // Already checked in — the row that was there wins, team included, so a
    // double submit can never move somebody to another team.
    const { rows: existing } = await client.query(
      `SELECT checked_in_at, team_no FROM ${SCHEMA}.event_checkins
       WHERE event_id = $1 AND email = $2`,
      [eventId, normalized]
    );
    return existing[0]
      ? { checkedInAt: existing[0].checked_in_at, team: existing[0].team_no, created: false }
      : { checkedInAt: null, team: null, created: false };
  });
}

// Insert a new event. The id is generated here — the seeded rows use 24-char
// hex ids (the shape the production app's Mongo ids had), so new ones match.
// A fresh event always starts with empty signup/check-in lists.
async function createEvent(event) {
  const { rows } = await pool.query(
    `INSERT INTO ${SCHEMA}.events
       (id, title, start_at, end_at, location, lat, lng, description, capacity, checkin_radius,
        total_headcount, visibility)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
      // `?? null` and not `|| null`: 0 is a legitimate recorded headcount.
      event.totalHeadcount ?? null,
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
         total_headcount = $11, visibility = $12
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
        event.totalHeadcount ?? null,
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
  pool, ROLES, MEMBER, ADMIN, SIGNED_UP, WAITLIST, TEAM_COUNT, teamSize, eventGuests,
  VISIBLE_ALL, VISIBLE_ADMIN, normalizeVisibility, canSeeEvent,
  getUsers, getUserByEmail, verifyPassword, createUser, upsertUser, updateUser, deleteUser,
  setUserPhoto, getUserPhoto,
  getEvents, getEvent, createEvent, updateEvent, deleteEvent,
  signUpForEvent, withdrawFromEvent, clearEventRoster, checkInToEvent
};
