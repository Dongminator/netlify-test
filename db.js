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

// 自动分队: how many teams an event is split into. It used to be a hardcoded 3
// here; it is now **per event**, in `events.team_count`, because the club plays
// 2, 3 and 4 team formats and a 板凳 makes no sense in the first and last of
// them. These are the only three values the column may hold — the CHECK in
// db/schema.sql is the backstop, `normalizeTeamCount` is what nothing gets past.
const TEAM_COUNTS = [2, 3, 4];
const DEFAULT_TEAM_COUNT = 3;

// The team names, in the order the teams are filled, are UI text and live in
// server.js/event.ejs — this layer knows only the numbers. For the record:
//   2 → ♠️ 黑桃, ♥️ 红桃
//   3 → ♠️ 黑桃, ♥️ 红桃, 🪑 板凳
//   4 → ♠️ 黑桃, ♥️ 红桃, ♣️ 梅花, ♦️ 方片
// The **last** team is the overflow in every layout (see `pickTeam`), which is
// what makes the 3-team one's last team a bench.

// A submitted 队伍数量, coerced to one of the three. An absent or unparseable
// value is the default rather than an error — every row written before the
// column existed reads as 3 — but a *stated* one that is not 2, 3 or 4 throws,
// the same shape as `normalizeVisibility`, so nothing unnormalized reaches the
// column.
function normalizeTeamCount(value) {
  if (value == null || value === '') return DEFAULT_TEAM_COUNT;
  const count = Number(value);
  if (!TEAM_COUNTS.includes(count)) throw new Error('队伍数量必须为 2、3 或 4');
  return count;
}

// Places per team, **one number per team**: everybody who is coming split
// `teamCount` ways — 均分, with the remainder handed out from the **first** team
// forward. Returns an array indexed by team - 1.
//
//   9 in 2 teams → [5, 4]        黑桃 5, 红桃 4
//   9 in 3 teams → [3, 3, 3]     an even split needs no remainder
//   9 in 4 teams → [3, 2, 2, 2]  黑桃 takes the odd body
//   25 in 3 teams → [9, 8, 8]
//
// Forwards, the mirror of `guestQuota`'s backwards, and for the same reason:
// 黑桃 is the first team filled at check-in, so the extra body lands where the
// arrivals are already going rather than being held for a team nobody has
// reached yet. It used to be one number for every team — the total rounded
// **up** — which is a size no even split can be true of: 9 in four teams gave
// four teams of 3, i.e. room for 12, so the display promised places the event
// did not have and the last team was left standing empty.
//
// **Who is coming is 已报名人数 + 试训批准人数** — the event's confirmed signups
// plus its approved 试训/Guest, the two numbers the club actually maintains. The
// waitlist is deliberately **not** in it — a waitlisted member has no place at
// the event yet, so they are nobody's teammate until they are promoted, at which
// point the size grows on its own.
//
// Derived on every read and never stored, like everything else about a team, so
// the teams re-size as members sign up, withdraw or are promoted and as guests
// are approved — the same way correcting `startAt` re-prices 迟到罚款. Nobody is
// ever re-allocated by it: see `pickTeam`.
//
// null — nobody is allocated at all, which leaves `event_checkins.team_no` NULL —
// is what an event with nobody on it at all answers, and nothing else: the first
// signup makes it [1, 0, 0]. `capacity` (人数上限) has no part in this any more;
// it caps the roster, it does not size the teams. A team's number can legitimately
// be 0 (fewer people coming than teams), and only the **last** team is ever filled
// past its own — it is the overflow, see `pickTeam`.
function teamSizes(signedUp, approvedGuests = 0, teamCount = DEFAULT_TEAM_COUNT) {
  const total = Number(signedUp) + Number(approvedGuests);
  if (!Number.isFinite(total) || total <= 0) return null;
  const sizes = new Array(teamCount).fill(Math.floor(total / teamCount));
  for (let i = 0, extra = total % teamCount; extra > 0; i++, extra--) sizes[i] += 1;
  return sizes;
}

// 试训/Guest. The two kinds, stored uppercase in `event_guests.type` and
// constrained by a CHECK in db/schema.sql, so these strings must stay in sync
// with it. 试训 and Guest are the labels server.js renders them as — this layer
// names them by keyword, the same arrangement as `users.role`.
const GUEST_TRIAL = 'TRIAL';
const GUEST_GUEST = 'GUEST';
const GUEST_TYPES = [GUEST_TRIAL, GUEST_GUEST];

// How many 试训/Guest an event can actually hold. Members may request as many as
// they like; this caps the **approved** rows, and it is the reason every approval
// runs under the event lock — counting and then writing is exactly what two
// admins tapping 批准 at once would interleave. Not a constraint in
// db/schema.sql, which cannot express "three rows per event".
const MAX_EVENT_GUESTS = 3;

// A submitted 试训/Guest type, coerced to one of the column's two keywords.
// Throws rather than storing anything else — the CHECK in db/schema.sql would
// refuse it as a 500 further down.
function normalizeGuestType(value) {
  const upper = String(value == null ? '' : value).trim().toUpperCase();
  if (!GUEST_TYPES.includes(upper)) throw new Error('类型必须为试训或 Guest');
  return upper;
}

// The guest's name is free text typed by a member and is rendered on the event
// page, so it is trimmed, required, and capped at something a name can fit in.
function normalizeGuestName(value) {
  const name = String(value == null ? '' : value).trim();
  if (!name) throw new Error('请填写试训/Guest 的姓名');
  if (name.length > 40) throw new Error('姓名最多 40 个字');
  return name;
}

// How many 试训/Guest places each team gets: **均分, and the remainder handed out
// from the last team backwards**. Returns an array indexed by team - 1.
//
//   2 teams, 1 guest  → [0, 1]      红桃 takes the odd one
//   3 teams, 2 guests → [0, 1, 1]   板凳 then 红桃
//   4 teams, 3 guests → [0, 1, 1, 1] 方片 then 梅花 then 红桃
//
// Backwards, because 黑桃 is the first team filled at check-in: a place held back
// there is the one most likely to be wanted by an arriving member, and with fewer
// guests than teams the remainder never reaches it at all.
function guestQuota(count, teamCount) {
  const quota = new Array(teamCount).fill(Math.floor(count / teamCount));
  for (let team = teamCount, extra = count % teamCount; extra > 0; team--, extra--) {
    quota[team - 1] += 1;
  }
  return quota;
}

// 自动分队 — where the 试训/guest places land. A trialist or a guest has no
// account, so they can never sign up, never check in and are never on the
// roster; `gsffc.event_guests` is the only record of them, and the **approved**
// rows of it are what this places. This rule replaced a hardcoded 1 → bench /
// 2 → bench + one playing team / 3 → one each that only ever described a
// 3-team event.
//
// It is two steps, and neither is a draw. **How many** places each team gets is
// `guestQuota` — 均分 with the remainder from the back. **Which guest** takes
// which is 申请时间 order (`requestedAt`) poured down the teams in the order they
// are filled at check-in (黑桃 → 红桃 → …), so the earliest request lands in the
// first team that has a place for one.
//
// **A playing team that is already full takes no guest**: the place goes to the
// last team instead, which is the overflow in every layout (see `pickTeam`) and
// is the only uncapped one. A guest placed into a team already holding its own
// number of members would otherwise push it one past it — which is what happens whenever
// members were allocated before the guest was approved, i.e. every guest approved
// after people have started checking in. `taken` is what makes that visible here:
// the number of **members** already holding a place in each team, a Map of
// team → count, from the caller that has them — `rowToEvent` from the roster,
// `pickTeam` from its own count query. It is members only; the guest places this
// function is deciding are added on top of it as they are placed, so two guests
// can never be given the same last place.
//
// Everything here is derived on every read, like the team size and unlike
// `event_checkins.team_no`, so both callers must reach the same answer from the
// same rows: that is why the placement is 申请时间 and arithmetic rather than
// anything random, and why the bump is decided from the same check-in counts
// `pickTeam` — which has to leave those places free — reads under the lock.
//
// `guests` is the event's approved rows (`rowToGuest` shape, any order — they are
// sorted here), `sizes` is the event's `teamSizes` — one place count per team, so
// the fullness test is against **this** team's own number — and `teamCount` its
// 队伍数量. Returns those same guests each with a `team`, sorted by it — the order
// they are read down the team list.
function eventGuests(guests = [], sizes = null, taken = new Map(), teamCount = DEFAULT_TEAM_COUNT) {
  const list = Array.isArray(guests) ? guests : [];
  if (!list.length) return [];
  const stamp = g => (g.requestedAt ? new Date(g.requestedAt).getTime() : 0);
  // 申请时间 order — the queue the places are handed out down. Ties break on the
  // id, so the order is total and both callers get the same one.
  const queue = list.slice().sort((a, b) => stamp(a) - stamp(b) || a.id - b.id);
  const quota = guestQuota(queue.length, teamCount);
  // The guest places handed out so far, so the second guest sees the first one's.
  const held = new Map();
  const place = wanted => {
    // The last team is the overflow: it is never full and never bumps anybody on.
    if (wanted === teamCount) return teamCount;
    const room = sizes ? sizes[wanted - 1] : 0;
    const used = (taken.get(wanted) || 0) + (held.get(wanted) || 0);
    return used < room ? wanted : teamCount;
  };
  const placed = [];
  let next = 0;
  for (let team = 1; team <= teamCount; team++) {
    for (let i = 0; i < quota[team - 1]; i++) {
      const guest = queue[next++];
      const actual = place(team);
      held.set(actual, (held.get(actual) || 0) + 1);
      placed.push({ ...guest, team: actual });
    }
  }
  // Stable, so guests sharing a team keep their 申请时间 order inside it.
  return placed.sort((a, b) => a.team - b.team);
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
function rowToEvent(row, roster = [], guestRows = []) {
  if (!row) return null;
  const startAt = String(row.start_at || '');
  const endAt = String(row.end_at || '');
  // 队伍数量 — the admin's choice, 2/3/4. Rows written before the column existed
  // read as the default, exactly as `visibility` reads as 'ALL'.
  const teamCount = row.team_count != null ? Number(row.team_count) : DEFAULT_TEAM_COUNT;
  // 自动分队 — the roster grouped by the team each member drew at check-in, always
  // `teamCount` arrays so an empty team is an empty array, not a hole. Hoisted out
  // of the object below because the guest places are decided against it: a full
  // playing team takes no guest — see `eventGuests`.
  const teams = Array.from({ length: teamCount }, (_, i) =>
    roster.filter(s => s.team === i + 1).map(s => s.email));
  // 试训/Guest — the approved rows are the ones that hold a place; the pending
  // ones are requests waiting for an admin and count for nothing yet.
  const approvedGuests = guestRows.filter(g => g.approvedAt);
  // 已报名人数 + 试训批准人数 — see `teamSizes`. Both halves are right here, so the
  // sizes cost no query of their own.
  const sizes = teamSizes(
    roster.filter(s => s.status === SIGNED_UP).length, approvedGuests.length, teamCount);
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
    checkins: roster.filter(s => s.checkedInAt).map(s => s.email),
    // 自动分队. `teamCount` is the one stored piece — the admin's 队伍数量 — and
    // the other two are read-only views like the three arrays above: `teamSizes`
    // is 已报名人数 + 试训批准人数 split `teamCount` ways, **one number per team**
    // (null when nobody is coming at all), and `teams` is the roster grouped by
    // team (built above).
    teamCount,
    teamSizes: sizes,
    teams,
    // 试训/Guest, all three read-only views over `guestRows` — every request this
    // event has, the approved ones, and the approved ones placed into teams by
    // `eventGuests` (which is given how many members each team already holds, so a
    // full 黑桃/红桃 hands its guest to the bench instead of overflowing).
    // The placed guests are not in `teams` above and never will be: that is the
    // roster grouped by team, and a guest has no account and so no email in it.
    guestRequests: guestRows,
    approvedGuests,
    guests: eventGuests(approvedGuests, sizes,
      new Map(teams.map((members, i) => [i + 1, members.length])), teamCount)
  };
}

// One 试训/Guest row. `approvedAt` being non-null is the whole difference between
// a pending request and a place at the event, so everything downstream tests it
// rather than a separate status column.
function rowToGuest(row) {
  if (!row) return null;
  return {
    // BIGSERIAL comes back from pg as a string to protect precision it will never
    // need here; a number is what the routes and the templates want.
    id: Number(row.id),
    type: row.type,
    name: row.name,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    // Both NULL together — a CHECK in db/schema.sql holds the pair.
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null
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
    // 自动分队: 1..the event's `teamCount`, drawn when the member checked in. null for a
    // check-in made before the feature existed, and for one on an event that had
    // no team size to fill against at all — see `teamSizes`.
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
      // 试训/Guest: the member's **pending** requests only. Nobody could cancel
      // them once the account is gone, and they would sit in every admin's review
      // dialog for good. An *approved* one is deliberately left: the club is
      // expecting that body, the teams are already sized around them, and the
      // address stays on the row exactly as `checked_in_by` keeps a deleted
      // admin's.
      await client.query(
        `DELETE FROM ${SCHEMA}.event_guests
         WHERE requested_by = $1 AND approved_at IS NULL`,
        [normalized]
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

// 试训/Guest for a set of events, as a Map of event id -> guest array. Approved
// rows come first and the pending requests after, each half oldest-decision
// first — 已批准 then 待批准, which is the order the event page renders the two
// lists in. `eventGuests` re-sorts the approved half into 申请时间 order itself
// rather than relying on this, since 自动分队 hands the places out down that
// queue and both callers of it have to reach the same answer. (`false` sorts
// before `true` in Postgres, so the CASE-free boolean works — same shape as
// `getRosters`.)
async function getEventGuests(ids, client = pool) {
  const byEvent = new Map(ids.map(id => [id, []]));
  if (!ids.length) return byEvent;
  const { rows } = await client.query(
    `SELECT * FROM ${SCHEMA}.event_guests
     WHERE event_id = ANY($1)
     ORDER BY (approved_at IS NULL), approved_at, requested_at, id`,
    [ids]
  );
  for (const row of rows) byEvent.get(row.event_id).push(rowToGuest(row));
  return byEvent;
}

async function getEvents() {
  const { rows } = await pool.query(
    `SELECT * FROM ${SCHEMA}.events ORDER BY start_at`
  );
  const ids = rows.map(r => r.id);
  // Two independent reads over the same set of ids — one round trip apiece, and
  // in parallel, so a page of events still costs a constant number of them.
  const [rosters, guests] = await Promise.all([getRosters(ids), getEventGuests(ids)]);
  return rows.map(row => rowToEvent(row, rosters.get(row.id), guests.get(row.id)));
}

async function getEvent(id) {
  const { rows } = await pool.query(
    `SELECT * FROM ${SCHEMA}.events WHERE id = $1`, [id]
  );
  if (!rows[0]) return null;
  const [rosters, guests] = await Promise.all([
    getRosters([rows[0].id]),
    getEventGuests([rows[0].id])
  ]);
  return rowToEvent(rows[0], rosters.get(rows[0].id), guests.get(rows[0].id));
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
// Deliberately leaves `event_guests` alone — a 试训/Guest is not a member's
// signup, and an approved one is a body the club is still expecting. Removing
// them is the review dialog's 移出, one at a time.
async function clearEventRoster(eventId) {
  return withEventLock(eventId, async (client) => {
    await client.query(`DELETE FROM ${SCHEMA}.event_checkins WHERE event_id = $1`, [eventId]);
    const { rowCount } = await client.query(
      `DELETE FROM ${SCHEMA}.event_signups WHERE event_id = $1`, [eventId]
    );
    return { removed: rowCount };
  });
}

// How many 试训/Guest this event has already approved. The count and the write
// that follows it are what the event lock is held for, so every caller below is
// inside `withEventLock`.
async function countApprovedGuests(client, eventId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS approved FROM ${SCHEMA}.event_guests
     WHERE event_id = $1 AND approved_at IS NOT NULL`,
    [eventId]
  );
  return rows[0].approved;
}

// 申请试训/Guest — a member asking for a place for somebody with no account.
// The row starts pending, which is what leaves it out of `event.approvedGuests`
// and out of the teams.
//
// **One per member per event**, counting the pending and the approved alike:
// there are only MAX_EVENT_GUESTS places, so one member queueing several would
// crowd the rest of the club out of a queue that is reviewed by hand. It is not
// a lifetime limit — cancelling a pending request frees the member's slot again,
// and 移出 hands an approved one back to them still holding it. Counted under the
// event lock for the same reason the approval cap is: count-then-write is exactly
// what a double submit interleaves.
//
// It applies to `requestEventGuest` **only** — an admin's 添加 (`addEventGuest`)
// records the admin as `requested_by` and is bounded by MAX_EVENT_GUESTS instead,
// so an admin adding all three guests themselves is not blocked by this.
// Returns { ok, reason, guest } — or null when there is no such event.
async function requestEventGuest(eventId, { type, name, requestedBy }) {
  const by = String(requestedBy || '').trim().toLowerCase();
  if (!by) throw new Error('requestedBy 不能为空');
  const guestType = normalizeGuestType(type);
  const guestName = normalizeGuestName(name);
  return withEventLock(eventId, async (client) => {
    const { rows: mine } = await client.query(
      `SELECT * FROM ${SCHEMA}.event_guests WHERE event_id = $1 AND requested_by = $2`,
      [eventId, by]
    );
    if (mine[0]) return { ok: false, reason: 'alreadyRequested', guest: rowToGuest(mine[0]) };
    const { rows } = await client.query(
      `INSERT INTO ${SCHEMA}.event_guests (event_id, type, name, requested_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [eventId, guestType, guestName, by]
    );
    return { ok: true, reason: null, guest: rowToGuest(rows[0]) };
  });
}

// 取消试训/Guest 申请 — a member taking their own request back. Three things can
// refuse it, and they are distinct because the page says different things about
// them: there is no such row, it is not this member's, or it has already been
// approved. **An approved place is no longer the member's to cancel** — the club
// is expecting that body and the teams are sized around it; only an admin can
// send it back to pending (`unapproveEventGuest`). Same shape as a checked-in
// member no longer being able to 取消报名.
// Returns { removed, reason, guest } — or null when there is no such event.
async function cancelEventGuest(eventId, guestId, email) {
  const normalized = String(email || '').trim().toLowerCase();
  return withEventLock(eventId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM ${SCHEMA}.event_guests WHERE id = $1 AND event_id = $2`,
      [guestId, eventId]
    );
    const guest = rows[0];
    if (!guest) return { removed: false, reason: 'missing', guest: null };
    if (guest.requested_by !== normalized) {
      return { removed: false, reason: 'notYours', guest: null };
    }
    if (guest.approved_at) {
      return { removed: false, reason: 'approved', guest: rowToGuest(guest) };
    }
    await client.query(`DELETE FROM ${SCHEMA}.event_guests WHERE id = $1`, [guestId]);
    return { removed: true, reason: null, guest: rowToGuest(guest) };
  });
}

// Admin 批准: a pending request becomes one of the event's places. The count and
// the update are one transaction under the event lock, so two admins approving at
// the same moment can never take the event past MAX_EVENT_GUESTS. Approving an
// already-approved row is idempotent rather than an error — the dialog can be
// double-tapped — and keeps the first approval's who and when.
// Returns { ok, reason, guest, approved } — or null when there is no such event.
async function approveEventGuest(eventId, guestId, adminEmail) {
  const by = String(adminEmail || '').trim().toLowerCase();
  return withEventLock(eventId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM ${SCHEMA}.event_guests WHERE id = $1 AND event_id = $2`,
      [guestId, eventId]
    );
    const guest = rows[0];
    if (!guest) return { ok: false, reason: 'missing', guest: null };
    if (guest.approved_at) return { ok: true, reason: null, guest: rowToGuest(guest) };
    const approved = await countApprovedGuests(client, eventId);
    if (approved >= MAX_EVENT_GUESTS) {
      return { ok: false, reason: 'full', guest: rowToGuest(guest), approved };
    }
    const { rows: done } = await client.query(
      `UPDATE ${SCHEMA}.event_guests SET approved_by = $3, approved_at = now()
       WHERE id = $1 AND event_id = $2 RETURNING *`,
      [guestId, eventId, by]
    );
    return { ok: true, reason: null, guest: rowToGuest(done[0]) };
  });
}

// Admin 移出: an approved place goes **back to the pending list** rather than
// being deleted. The request itself was the member's and is still theirs — so
// undoing the approval hands it back to them, cancellable again, instead of
// destroying it behind their back. It frees one of the MAX_EVENT_GUESTS places.
// Already-pending is idempotent, for the same reason approving twice is.
// Returns { ok, reason, guest } — or null when there is no such event.
async function unapproveEventGuest(eventId, guestId) {
  return withEventLock(eventId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM ${SCHEMA}.event_guests WHERE id = $1 AND event_id = $2`,
      [guestId, eventId]
    );
    const guest = rows[0];
    if (!guest) return { ok: false, reason: 'missing', guest: null };
    if (!guest.approved_at) return { ok: true, reason: null, guest: rowToGuest(guest) };
    const { rows: done } = await client.query(
      `UPDATE ${SCHEMA}.event_guests SET approved_by = NULL, approved_at = NULL
       WHERE id = $1 AND event_id = $2 RETURNING *`,
      [guestId, eventId]
    );
    return { ok: true, reason: null, guest: rowToGuest(done[0]) };
  });
}

// Admin 添加试训/Guest — the direct path, with no request behind it: the row is
// inserted already approved, so the admin is always `approved_by`. It is the same
// place an approval creates and counts against the same MAX_EVENT_GUESTS, which
// is why it takes the same lock.
//
// `requestedBy` is **who the guest is coming through** — a guest an admin adds is
// usually still somebody's, and the club needs to know whose, so the dialog asks
// for it and defaults to the admin. It only ever names the member; the admin
// stays the approver, so 添加 remains an approval with no request behind it.
// The one-request-per-member rule is deliberately **not** applied to it (it is
// `requestEventGuest`'s alone — see there): an admin adding places is bounded by
// MAX_EVENT_GUESTS instead, and refusing them because the member already has a
// pending row would block the very thing they are doing about it.
// Returns { ok, reason, guest, approved } — or null when there is no such event.
async function addEventGuest(eventId, { type, name, by, requestedBy }) {
  const admin = String(by || '').trim().toLowerCase();
  if (!admin) throw new Error('by 不能为空');
  // Empty means the admin themselves, which is what the field defaults to.
  const requester = String(requestedBy || '').trim().toLowerCase() || admin;
  const guestType = normalizeGuestType(type);
  const guestName = normalizeGuestName(name);
  return withEventLock(eventId, async (client) => {
    const approved = await countApprovedGuests(client, eventId);
    if (approved >= MAX_EVENT_GUESTS) {
      return { ok: false, reason: 'full', guest: null, approved };
    }
    const { rows } = await client.query(
      `INSERT INTO ${SCHEMA}.event_guests
         (event_id, type, name, requested_by, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
      [eventId, guestType, guestName, requester, admin]
    );
    return { ok: true, reason: null, guest: rowToGuest(rows[0]) };
  });
}

// 自动分队 — the team an arriving member joins, which is the club's rule exactly,
// in every one of the three layouts: **the teams are filled in pairs**, a random
// one of the pair while both have room and the one that still has room once the
// other is full, moving on to the next pair when neither does — and whatever is
// left over goes into the **last** team, which is therefore the overflow and is
// deliberately **uncapped**.
//
//   2 teams → the pair is 黑桃/红桃, and 红桃 is also the overflow
//   3 teams → 黑桃/红桃 first, then everybody else onto the 板凳
//   4 teams → 黑桃/红桃 first, then a random draw between 梅花/方片, 方片 last
//
// Uncapped, because the sizes count approved 试训/Guest who never check in, and
// members can withdraw after arriving to shrink them, so the app's check-ins can
// outrun the numbers the teams were sized from — and a member arriving must always
// land somewhere.
//
// **Each team is filled to its own number**, not to one shared size: `teamSizes`
// is an array (9 in four teams is 3/2/2/2), so 黑桃 taking the odd body is what
// stops the last team from being left empty while the others were sized as if
// there were more people coming than there are.
//
// The 试训/guest places are **already taken**: a trialist can never check in, so
// nothing else would ever hold the place back for them and the last member to
// arrive would take it. Counting them here is what makes the guest quota
// (`eventGuests`) true of the arrivals as well as of the display. The approved
// rows are read here rather than passed in, because which team a guest lands in
// depends on the very counts this function queries — a full team hands its guest
// to the overflow — and the page must not be shown a team the arrivals disagree
// with. The read is inside the lock with everything else, so an approval landing
// mid-check-in is serialised against it rather than being counted twice or not at
// all.
//
// The sizes are derived here rather than taken off the event row: they are
// 已报名人数 + 试训批准人数 split `event.team_count` ways, so both halves are rows
// this function has to read under the lock anyway. `event` is the locked row
// `withEventLock` hands over, which is where 队伍数量 comes from. Returns null when
// there is nobody at the event at all — see `teamSizes` — which is what leaves
// `team_no` NULL and allocates nobody. The caller must hold the event lock: this
// counts the rows and then writes one, so without it two members checking in at
// the same moment could both take the last place in a team.
async function pickTeam(client, eventId, event = {}) {
  const teamCount = event.team_count != null ? Number(event.team_count) : DEFAULT_TEAM_COUNT;
  const { rows: approved } = await client.query(
    `SELECT * FROM ${SCHEMA}.event_guests
     WHERE event_id = $1 AND approved_at IS NOT NULL
     ORDER BY requested_at, id`,
    [eventId]
  );
  const { rows: [{ confirmed }] } = await client.query(
    `SELECT COUNT(*)::int AS confirmed FROM ${SCHEMA}.event_signups
     WHERE event_id = $1 AND status = '${SIGNED_UP}'`,
    [eventId]
  );
  const sizes = teamSizes(confirmed, approved.length, teamCount);
  if (!sizes) return null;
  const { rows } = await client.query(
    `SELECT team_no, COUNT(*)::int AS taken FROM ${SCHEMA}.event_checkins
     WHERE event_id = $1 AND team_no IS NOT NULL
     GROUP BY team_no`,
    [eventId]
  );
  // Members only, which is what `eventGuests` needs; the guest places go on top.
  const taken = new Map(rows.map(r => [r.team_no, r.taken]));
  const guests = eventGuests(approved.map(rowToGuest), sizes, taken, teamCount);
  for (const g of guests) taken.set(g.team, (taken.get(g.team) || 0) + 1);
  // Against this team's own number, not one shared size — see `teamSizes`.
  const hasRoom = team => (taken.get(team) || 0) < sizes[team - 1];
  // Pairs, in order. An odd `teamCount` leaves its last team out of the loop —
  // which is right, since that one is the overflow and is answered below anyway.
  for (let a = 1; a + 1 <= teamCount; a += 2) {
    const b = a + 1;
    if (hasRoom(a) && hasRoom(b)) return a + crypto.randomInt(2);
    if (hasRoom(a)) return a;
    if (hasRoom(b)) return b;
  }
  return teamCount;
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
// The lock is also what makes the size `pickTeam` derives (the signups and the
// approved guests) a consistent snapshot rather than one a concurrent signup or
// approval could have moved under it.
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
        visibility, team_count)
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
      normalizeVisibility(event.visibility),
      normalizeTeamCount(event.teamCount)
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
         visibility = $11, team_count = $12
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
        normalizeVisibility(event.visibility),
        // 队伍数量 re-sizes the teams the moment it is saved — the size is derived
        // on every read — but nobody already allocated is ever moved, exactly as
        // when a signup or an approval changes it. Lowering it past a team that
        // already holds members leaves those members where they are.
        normalizeTeamCount(event.teamCount)
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
  TEAM_COUNTS, DEFAULT_TEAM_COUNT, normalizeTeamCount, teamSizes, guestQuota, eventGuests,
  GUEST_TRIAL, GUEST_GUEST, GUEST_TYPES, MAX_EVENT_GUESTS,
  VISIBLE_ALL, VISIBLE_ADMIN, normalizeVisibility, canSeeEvent,
  getUsers, getUserByEmail, verifyPassword, createUser, upsertUser, updateUser, deleteUser,
  setUserPhoto, getUserPhoto,
  getEvents, getEvent, createEvent, updateEvent, deleteEvent,
  signUpForEvent, withdrawFromEvent, clearEventRoster, checkInToEvent,
  requestEventGuest, cancelEventGuest, approveEventGuest, unapproveEventGuest, addEventGuest
};
