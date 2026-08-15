require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Resolve the views dir for both local runs (__dirname) and bundled serverless
// functions, where included files land relative to the working directory.
const viewsDir = [path.join(__dirname, 'views'), path.join(process.cwd(), 'views')]
  .find(p => fs.existsSync(p)) || path.join(__dirname, 'views');

app.set('view engine', 'ejs');
app.set('views', viewsDir);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Express 4 doesn't catch async errors; route rejections go to the error handler
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Page locals, set *before* the session store. The 500 handler at the bottom
// renders 404.ejs, and header.ejs reads `path` and `user` — so a failure inside
// the session store (an unreachable database, most often) used to throw
// "path is not defined" from the template and bury the real cause. These are the
// safe defaults; the middleware after session() fills in the signed-in user.
app.use((req, res, next) => {
  res.locals.user = null;
  res.locals.path = req.path;
  next();
});

// Deployment smoke test, mounted before the session middleware so it still
// answers when the session store is exactly what is broken. Reports whether the
// function can reach Postgres and see the gsffc schema, and never echoes the
// password back.
app.get('/healthz', wrap(async (req, res) => {
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DATABASE_URL || '';
  const out = { ok: false, databaseUrlSet: Boolean(url), clubTimezone: CLUB_TIMEZONE };
  try {
    const parsed = new URL(url);
    out.host = parsed.hostname;
    out.port = parsed.port || '5432';
    out.database = parsed.pathname.replace(/^\//, '');
    out.username = parsed.username;
    out.sslmode = parsed.searchParams.get('sslmode') || null;
  } catch {
    out.urlParseError = 'DATABASE_URL is not a valid postgres:// URL';
  }
  try {
    const { rows } = await db.pool.query(
      "select current_database() as db, (select count(*) from information_schema.tables where table_schema = 'gsffc') as gsffc_tables"
    );
    out.ok = true;
    out.connectedTo = rows[0].db;
    out.gsffcTables = Number(rows[0].gsffc_tables);
  } catch (err) {
    out.error = { message: err.message, code: err.code, syscall: err.syscall, address: err.address };
  }
  res.status(out.ok ? 200 : 503).json(out);
}));

app.use(session({
  store: new PgSession({
    pool: db.pool,
    schemaName: 'gsffc',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'gsf-test-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // stay signed in for 30 days
}));

app.use(wrap(async (req, res, next) => {
  // Sessions created before roles existed carry no `role`. Backfill it once so
  // an admin who was already signed in still sees the admin nav without having
  // to log out; after that the copy is free for the life of the session.
  if (req.session.user && !req.session.user.role) {
    const fresh = await db.getUserByEmail(req.session.user.email);
    req.session.user.role = fresh ? fresh.role : db.MEMBER;
  }
  res.locals.user = req.session.user || null;
  res.locals.path = req.path;
  next();
}));

function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requireLoginApi(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: '请先登录' });
  }
  next();
}

// Admin gate. The session carries a copy of `role` for rendering, but it is only
// as fresh as the last login — and the cookie lives 30 days — so the role is
// re-read from the database here. That keeps a demotion effective immediately
// while leaving ordinary member traffic at its current query count.
function adminGuard({ api }) {
  return wrap(async (req, res, next) => {
    if (!req.session.user) {
      if (api) return res.status(401).json({ ok: false, message: '请先登录' });
      req.session.returnTo = req.originalUrl;
      return res.redirect('/login');
    }
    const fresh = await db.getUserByEmail(req.session.user.email);
    req.session.user.role = fresh ? fresh.role : db.MEMBER;
    if (!fresh || fresh.role !== db.ADMIN) {
      if (api) return res.status(403).json({ ok: false, message: '需要管理员权限' });
      return res.status(403).render('404', { title: 'Forbidden' });
    }
    next();
  });
}

const requireAdmin = adminGuard({ api: false });
const requireAdminApi = adminGuard({ api: true });

// Editing a member row: your own is self-service (the profile page), anyone
// else's is an admin power. The delegated branch still re-reads the role from
// the database, so this only widens who may write their *own* row — and
// `db.updateUser` cannot touch `role`, so it can't be used to self-promote.
function requireSelfOrAdminApi(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, message: '请先登录' });
  }
  const target = String(req.params.email || '').trim().toLowerCase();
  if (target === req.session.user.email) return next();
  return requireAdminApi(req, res, next);
}

// The viewer, in the shape `db.canSeeEvent` wants — with the role re-read from
// the database rather than taken from the session's copy, which can be 30 days
// stale. Event visibility is an access decision, so it gets the same treatment
// as `adminGuard`: one query, and the session copy refreshed along the way so a
// demoted admin stops seeing admin-only events at once.
// Pass `role` when the caller has already read the row (the event page reads
// every member to build its roster, so the viewer's fresh row is already in
// hand) and this costs nothing at all.
async function viewer(req, role) {
  const email = req.session.user.email;
  if (role === undefined) {
    const fresh = await db.getUserByEmail(email);
    role = fresh ? fresh.role : db.MEMBER;
  }
  req.session.user.role = role;
  return { email, role };
}

// What an event's visibility says, for the badge on its page and the calendar
// chip's tooltip. `nameOf` turns the stored address into the member's name when
// there is an account behind it. Null for an ordinary, everyone-can-see event.
function visibilityLabel(event, nameOf) {
  if (!event || !event.visibility || event.visibility === db.VISIBLE_ALL) return null;
  if (event.visibility === db.VISIBLE_ADMIN) return '仅管理员可见';
  const name = nameOf ? nameOf(event.visibility) : '';
  return `仅 ${name || event.visibility} 可见`;
}

// Fallback avatar scheme, same as the production app (hackathon-starter gravatar
// helper). Used whenever a member has no `profile_photo` of their own; `size` is
// a gravatar parameter and has no equivalent for a stored photo, which is sized
// by the <img> box it lands in.
function gravatar(email, size = 80) {
  const hash = crypto.createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=retro`;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Event times are stored as a naive wall clock ('YYYY-MM-DDTHH:MM') because the
// club reads them as its own local time — but the process may well be running in
// UTC (it is, on Netlify), so a wall clock is not yet an instant. `CLUB_TIMEZONE`
// is the zone they are read in, and everything that compares an event against
// `Date.now()` — or renders a real timestamp — goes through the helpers below.
// Set it if the club is not in California.
const CLUB_TIMEZONE = process.env.CLUB_TIMEZONE || 'America/Los_Angeles';

// Offset in ms between the club's wall clock and UTC at a given instant — which
// is what makes this DST-aware rather than a fixed number.
function zoneOffset(epoch) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TIMEZONE,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(epoch)).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second);
  return asUTC - epoch;
}

// 'YYYY-MM-DDTHH:MM' read in the club's zone -> epoch ms, NaN if unparseable.
// The offset is looked up twice because it depends on the very instant being
// solved for: the first pass is a guess, the second lands it on the right side
// of a DST change.
function clubEpoch(wall) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(wall || ''));
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return guess - zoneOffset(guess - zoneOffset(guess));
}

// "Today" in the club's zone, in the same YYYY-MM-DD shape as `event.date`, so
// every past/upcoming test stays a lexical comparison. It is emphatically *not*
// `new Date().toISOString()`: that is today in **UTC**, which after 17:00 in
// California is already tomorrow — an evening event was marked 已结束 while it
// was still hours away.
const clubDate = epoch => new Date(epoch + zoneOffset(epoch)).toISOString().slice(0, 10);
const todayStr = () => clubDate(Date.now());

// An event is over when it *ends*, not when its date rolls over: with the end
// time now stored, "已结束" and the closed check-in can both be exact. Falls
// back to the date if `endAt` is unparseable.
function hasEnded(event) {
  const end = clubEpoch(event.endAt);
  return Number.isFinite(end) ? end < Date.now() : event.date < todayStr();
}

// Check-in opens an hour before kick-off and closes when the event ends, the
// same instant that raises the 已结束 badge. The page counts down to this one,
// so the button and the route agree on when it opens.
const CHECKIN_LEAD_MS = 60 * 60 * 1000;
const checkinOpensAt = event => clubEpoch(event.startAt) - CHECKIN_LEAD_MS;

// The half of a check-in that is about *being there*: the window has to be open,
// and the posted position has to fall inside the event's radius. Both routes go
// through it — a member checking themselves in, and an admin checking somebody
// else in (代签到), where the position belongs to the admin, who is the one at
// the pitch. Keeping it in one place is what stops the proxy path from quietly
// becoming a looser one. Answers `{lat, lng, distance}` when the caller really
// is at the field, or `{status, body}` — the refusal to send back — when not.
function atTheField(event, body) {
  // Too early. The button is disabled until this instant as well, so hitting
  // this means either a hand-rolled request or a browser clock running fast.
  const opensAt = checkinOpensAt(event);
  if (Number.isFinite(opensAt) && Date.now() < opensAt) {
    return {
      status: 403,
      body: { ok: false, opensAt, message: '签到尚未开放：活动开始前 1 小时才能签到' }
    };
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { status: 400, body: { ok: false, message: '未获取到有效位置' } };
  }
  const distance = Math.round(distanceMeters(lat, lng, event.coords.lat, event.coords.lng));
  if (distance > event.checkinRadius) {
    return {
      status: 403,
      body: {
        ok: false,
        distance,
        message: `签到失败：你距离球场约 ${distance} 米，需在 ${event.checkinRadius} 米范围内`
      }
    };
  }
  return { lat, lng, distance };
}

// 迟到罚款. Kick-off is a wall clock with no seconds, but a check-in is a real
// timestamp that has them — so "late" starts at kick-off + FINE_GRACE_MS, i.e.
// a check-in anywhere inside the starting minute is still on time (the club's
// rule: for a 19:50 kick-off, up to 19:50:58 is not late). Past that there is
// one boundary, FINE_TIER_MS after kick-off, and that instant itself is still
// the cheaper side of it. A member who never checked in owes the higher fine
// too, which is why absence and the far tier share FINE_VERY_LATE.
const FINE_GRACE_MS = 59 * 1000;
const FINE_TIER_MS = 5 * 60 * 1000;
const FINE_LATE = 5;
const FINE_VERY_LATE = 10;

// What one confirmed member owes for this event, and by how much they were
// late. `ended` is the caller's `hasEnded`: absence only costs once the event
// is over — before that a member who has not checked in has simply not arrived
// yet — so a live event fines nobody for not being there. An unparseable
// kick-off fines nobody at all, the same fallback every other gate takes.
// `lateMs` is null whenever there is no lateness to name.
function lateness(event, checkedInAt, ended) {
  if (!checkedInAt) return { fine: ended ? FINE_VERY_LATE : 0, lateMs: null };
  const late = new Date(checkedInAt).getTime() - clubEpoch(event.startAt);
  if (!Number.isFinite(late) || late < FINE_GRACE_MS) return { fine: 0, lateMs: null };
  return { fine: late <= FINE_TIER_MS ? FINE_LATE : FINE_VERY_LATE, lateMs: late };
}

// How late, for the roster tooltip. Seconds are shown under a minute only, so
// a 12-minute arrival reads "迟到 12 分钟" rather than "12 分 3 秒".
function lateLabel(ms) {
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  return min ? `迟到 ${min} 分钟` : `迟到 ${total} 秒`;
}

// Signup and check-in times are real timestamps (unlike `event.date`), so they
// are formatted here rather than in the template: club-local time, minute
// precision, in the app's one display shape — `m/dd/yy HH:MM`, the same one the
// event page's 时间 row uses. The shift is what makes them club-local:
// `getHours()` would read them in the *process's* zone, which is UTC on Netlify,
// and a 22:23 check-in would be shown to the member as 05:23.
function formatStamp(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const local = new Date(d.getTime() + zoneOffset(d.getTime()));
  return `${local.getUTCMonth() + 1}/${pad2(local.getUTCDate())}/`
    + `${String(local.getUTCFullYear()).slice(2)} `
    + `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
}

// Fallback centre for the add-event picker map when no event has coords yet.
const DEFAULT_MAP_CENTER = { lat: 37.4045892, lng: -121.8907831 };

const pad2 = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

// Month grid for the calendar view. Weeks start on Sunday, and the grid is
// padded with the tail of the previous month and the head of the next one so
// every row holds 7 cells. Always 6 rows: the grid then keeps a constant height
// as the user pages between months instead of jumping around.
function buildMonthGrid(year, month, events, today) {
  const byDate = new Map();
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  // Local-time Date arithmetic only — never `new Date('YYYY-MM-DD')`, which
  // parses as UTC and can land on the wrong day west of Greenwich.
  const cursor = new Date(year, month, 1 - new Date(year, month, 1).getDay());
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = ymd(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
      days.push({
        date,
        day: cursor.getDate(),
        weekday: cursor.getDay(),
        inMonth: cursor.getMonth() === month,
        isToday: date === today,
        isPast: date < today,
        events: byDate.get(date) || []
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(days);
  }
  return weeks;
}

app.get('/', (req, res) => res.redirect('/calendar'));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/calendar');
  res.render('login', { title: 'Login', error: null });
});

app.post('/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  const user = await db.getUserByEmail((email || '').trim().toLowerCase());
  if (!user || !db.verifyPassword(user, password || '')) {
    return res.status(401).render('login', { title: 'Login', error: '账号或密码错误' });
  }
  req.session.user = { email: user.email, name: user.name, role: user.role };
  const dest = req.session.returnTo || '/calendar';
  delete req.session.returnTo;
  res.redirect(dest);
}));

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/calendar', requireLogin, wrap(async (req, res) => {
  const me = await viewer(req);
  const isAdmin = me.role === db.ADMIN;
  // Restricted events are not merely hidden from the grid — they are dropped
  // here, before anything is built out of them, so nothing downstream (a count,
  // a tooltip, the picker's map centre) can leak one.
  const events = (await db.getEvents()).filter(e => db.canSeeEvent(e, me));
  const today = todayStr();
  // The add-event modal's 指定成员 picker. Only admins see the modal at all, so
  // only they pay for the extra query.
  const members = isAdmin
    ? (await db.getUsers()).map(u => ({ email: u.email, name: u.name }))
    : [];
  const nameOf = email => {
    const m = members.find(u => u.email === email);
    return m ? m.name : '';
  };
  // What the chip's lock icon and tooltip say. Set on the event objects
  // themselves because `buildMonthGrid` hands the very same ones to the grid.
  for (const e of events) e.visibilityNote = visibilityLabel(e, nameOf);

  // ?month=YYYY-MM drives the grid; anything malformed falls back to this month.
  // "This month" comes out of the club-local date, not the process's own clock —
  // in UTC a December evening in California is already next year's January.
  const thisYear = Number(today.slice(0, 4));
  const thisMonth = Number(today.slice(5, 7)) - 1;
  let year = thisYear;
  let month = thisMonth;
  const requested = /^(\d{4})-(\d{2})$/.exec(req.query.month || '');
  if (requested) {
    const y = Number(requested[1]);
    const m = Number(requested[2]) - 1;
    if (y >= 1970 && y <= 9999 && m >= 0 && m <= 11) {
      year = y;
      month = m;
    }
  }
  const prev = new Date(year, month - 1, 1);
  const next = new Date(year, month + 1, 1);

  // Where the add-event modal's picker map opens: the latest event that has a
  // check-in point, so the club's usual fields are already on screen.
  const located = events.filter(e => e.coords);
  const mapCenter = located.length ? located[located.length - 1].coords : DEFAULT_MAP_CENTER;

  res.render('calendar', {
    title: '活动日历',
    weeks: buildMonthGrid(year, month, events, today),
    monthLabel: `${year}年${month + 1}月`,
    prevMonth: `${prev.getFullYear()}-${pad2(prev.getMonth() + 1)}`,
    nextMonth: `${next.getFullYear()}-${pad2(next.getMonth() + 1)}`,
    isCurrentMonth: year === thisYear && month === thisMonth,
    // The add-event modal reloads onto the new event's month with ?created=1,
    // which is what raises the success banner.
    created: req.query.created === '1',
    // Same idea for the other direction: POST /event/:id/delete sends the admin
    // back here, onto the month the deleted event was in, with ?deleted=1.
    deleted: req.query.deleted === '1',
    mapCenter,
    // The 指定成员 options in the event modal; empty for a non-admin, who never
    // renders the modal.
    members,
    // What the modal's date field starts on: today when it is in view, so the
    // common case needs no picking, otherwise the 1st of the month being viewed.
    defaultDate: year === thisYear && month === thisMonth ? today : ymd(year, month, 1)
  });
}));

app.get('/event/:id', requireLogin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const users = await db.getUsers();
  const byEmail = new Map(users.map(u => [u.email, u]));
  // The viewer's own row is already in that map, so the freshly-read role the
  // visibility rule needs costs no extra query here. An event the viewer may
  // not see answers exactly as a missing one does — a 403 would confirm it
  // exists, which is the one thing a hidden event must not do.
  const mineRow = byEmail.get(req.session.user.email);
  const me = await viewer(req, mineRow ? mineRow.role : db.MEMBER);
  if (!db.canSeeEvent(event, me)) return res.status(404).render('404', { title: 'Not Found' });
  // Needed before the roster is built, not just at render: whether the event is
  // over is what turns "has not checked in yet" into "did not turn up".
  const isPast = hasEnded(event);
  // `event.roster` is already ordered — confirmed members first, then the
  // waitlist, each half oldest signup first — so the index inside each half is
  // the member's place in it.
  const toParticipant = (signup, i) => {
    const u = byEmail.get(signup.email);
    // Only a confirmed place can be late to it: a waitlisted member was never
    // due at the event, so they are outside the fine rules entirely.
    const { fine, lateMs } = signup.status === db.SIGNED_UP
      ? lateness(event, signup.checkedInAt, isPast)
      : { fine: 0, lateMs: null };
    return {
      email: signup.email,
      name: u ? u.name : signup.email,
      position: u && u.position ? u.position : '',
      // Drawn at 48px in the roster grid, so the gravatar fallback is asked for
      // enough pixels to stay sharp on a phone's 2–3× screen.
      avatar: (u && u.profilePhoto) || gravatar(signup.email, 144),
      checkedIn: !!signup.checkedInAt,
      signedUpAt: formatStamp(signup.signedUpAt),
      checkedInAt: formatStamp(signup.checkedInAt),
      // 代签到: the admin who checked this member in for them, by name — null
      // for the ordinary self check-in, which is what the roster's 代 badge
      // tests. An admin who has since been deleted leaves their address behind,
      // which is still a truer answer than dropping the fact of the proxy.
      checkedInBy: signup.checkedInBy
        ? ((byEmail.get(signup.checkedInBy) || {}).name || signup.checkedInBy)
        : null,
      // 0 when nothing is owed; 5 or 10 otherwise. `lateLabel` is empty for a
      // member who never checked in — there is no arrival to be late by.
      fine,
      lateLabel: lateMs === null ? '' : lateLabel(lateMs),
      place: i + 1
    };
  };
  const participants = event.roster.filter(s => s.status === db.SIGNED_UP).map(toParticipant);
  const waitlist = event.roster.filter(s => s.status === db.WAITLIST).map(toParticipant);
  const mine = event.roster.find(s => s.email === req.session.user.email) || null;
  res.render('event', {
    title: event.title,
    event,
    // Centre for the admin edit modal's picker: this event's own check-in point
    // when it has one, so opening the modal shows the field already in place.
    mapCenter: event.coords || DEFAULT_MAP_CENTER,
    participants,
    waitlist,
    signedUp: !!mine && mine.status === db.SIGNED_UP,
    waitlisted: !!mine && mine.status === db.WAITLIST,
    // 1-based place in the queue, so a waitlisted member is told how many are
    // ahead of them rather than just that they are waiting.
    myPlace: mine && mine.status === db.WAITLIST
      ? waitlist.findIndex(p => p.email === mine.email) + 1
      : 0,
    checkedIn: !!mine && !!mine.checkedInAt,
    myCheckinAt: formatStamp(mine && mine.checkedInAt),
    // Set by the redirect from POST /event/:id/signup when the event was full.
    joinedWaitlist: req.query.joined === 'waitlist',
    isPast,
    // The 罚款 panel, which exists only on a finished event: the fines are not
    // final until nobody can still arrive. Null before that, so the template
    // has one test rather than a length check per tier. Both tiers are always
    // present, empty list and all, so the panel says who owes $5 *and* who owes
    // $10 even when one of them is nobody.
    fines: isPast
      ? [FINE_LATE, FINE_VERY_LATE].map(amount => ({
        amount,
        names: participants.filter(p => p.fine === amount).map(p => p.name)
      }))
      : null,
    // The event's three instants, plus the clock the server measured them
    // against: the page counts down against `Date.now()` corrected by the
    // difference, so a phone whose clock is off doesn't offer a button the route
    // will refuse (or hide one it would accept). All three are on the page so an
    // event that opens, starts or ends while it sits open moves the status badge
    // and the button itself, rather than leaving a stale page behind. Kick-off
    // is the one the route does *not* gate on — check-in stays open past it —
    // but it is when the button turns urgent and the fines start.
    checkinOpensAt: checkinOpensAt(event),
    eventStartsAt: clubEpoch(event.startAt),
    checkinClosesAt: clubEpoch(event.endAt),
    serverNow: Date.now(),
    // Non-null only for a restricted event — the badge beside the title.
    visibilityNote: visibilityLabel(event, email => {
      const u = byEmail.get(email);
      return u ? u.name : '';
    }),
    // Options for the 指定成员 picker in the admin edit modal.
    members: me.role === db.ADMIN ? users.map(u => ({ email: u.email, name: u.name })) : []
  });
}));

// Signing up for a full event is not refused: `db.signUpForEvent` records it as
// a WAITLIST signup instead, and the redirect carries ?joined=waitlist so the
// page can say so. The capacity decision is made under a row lock in there, not
// here, so two members racing for the last place can't both take it.
app.post('/event/:id/signup', requireLogin, wrap(async (req, res) => {
  // An event you may not see is one you may not join, and it answers as a
  // missing one rather than as a refusal. Withdrawing deliberately carries no
  // such check — a member whose event was restricted after they signed up must
  // still be able to take their place back out of it.
  const event = await db.getEvent(req.params.id);
  if (!event || !db.canSeeEvent(event, await viewer(req))) {
    return res.status(404).render('404', { title: 'Not Found' });
  }
  const result = await db.signUpForEvent(req.params.id, req.session.user.email);
  if (!result) return res.status(404).render('404', { title: 'Not Found' });
  const waitlisted = result.created && result.status === db.WAITLIST;
  res.redirect(`/event/${req.params.id}${waitlisted ? '?joined=waitlist' : ''}`);
}));

// Leaving also drops the member's check-in, and hands the place they held to the
// head of the waitlist — both inside `db.withdrawFromEvent`'s transaction.
app.post('/event/:id/withdraw', requireLogin, wrap(async (req, res) => {
  const result = await db.withdrawFromEvent(req.params.id, req.session.user.email);
  if (!result) return res.status(404).render('404', { title: 'Not Found' });
  res.redirect(`/event/${req.params.id}`);
}));

// Wipe an event's roster. Destructive and admin-only — the waitlist and the
// check-ins go with the signups, since a check-in from someone no longer on the
// list is meaningless and a waitlist with nobody ahead of it is noise.
// A finished event's roster is the record of who actually turned up, so it is
// frozen the minute the event ends — the same instant that raises 已结束 and
// closes the check-in. The button is gone from the page by then; this catches a
// hand-crafted POST, and lands back on the event so the admin sees it unchanged.
app.post('/event/:id/clear-signups', requireAdmin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  if (hasEnded(event)) return res.redirect(`/event/${req.params.id}`);
  const result = await db.clearEventRoster(req.params.id);
  if (!result) return res.status(404).render('404', { title: 'Not Found' });
  res.redirect(`/event/${req.params.id}`);
}));

// Delete an event outright. Admin-only and irreversible — the roster goes with
// it through the tables' ON DELETE CASCADE. The event page it was invoked from
// is gone, so it lands on the calendar showing the month the event was in, with
// ?deleted=1 raising the banner there.
// Frozen once the event has ended, like clearing its roster: a past event is the
// club's record of it, and deleting takes the signups and check-ins with it.
app.post('/event/:id/delete', requireAdmin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  if (hasEnded(event)) return res.redirect(`/event/${req.params.id}`);
  const deleted = await db.deleteEvent(req.params.id);
  if (!deleted) return res.status(404).render('404', { title: 'Not Found' });
  res.redirect(`/calendar?month=${deleted.date.slice(0, 7)}&deleted=1`);
}));

// Copying an event no longer has a route of its own: the 复制 button opens the
// event modal prefilled and a week on, so the copy goes through POST /api/events
// like any other creation — with the admin able to adjust it before it is saved.

app.post('/event/:id/checkin', requireLogin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).json({ ok: false, message: '活动不存在' });
  // Same answer as a missing event, for the same reason as the signup route.
  if (!db.canSeeEvent(event, await viewer(req))) {
    return res.status(404).json({ ok: false, message: '活动不存在' });
  }
  if (!event.coords) return res.status(400).json({ ok: false, message: '该活动为线上活动，无需到场签到' });
  if (hasEnded(event)) {
    return res.status(400).json({ ok: false, message: '活动已结束，无法签到' });
  }
  const email = req.session.user.email;
  const mine = event.roster.find(s => s.email === email);
  if (!mine) {
    return res.status(400).json({ ok: false, message: '请先报名再签到' });
  }
  // A waitlisted member has no place at the event yet, so there is nothing to
  // check in to; they become eligible the moment they are promoted.
  if (mine.status === db.WAITLIST) {
    return res.status(400).json({ ok: false, message: '你在候补名单中，补位成功后才能签到' });
  }
  if (mine.checkedInAt) {
    return res.json({ ok: true, message: '你已签到过了' });
  }
  const where = atTheField(event, req.body);
  if (where.status) return res.status(where.status).json(where.body);
  // The coordinates go in with the time, as the evidence behind the row.
  await db.checkInToEvent(event.id, email, where);
  res.json({ ok: true, distance: where.distance, message: `签到成功！(距球场约 ${where.distance} 米)` });
}));

// 代签到 — an admin standing at the pitch checking in a member who can't do it
// themselves (a dead phone, no signal, no app). It is deliberately *not* a way
// around the geofence: every gate the member's own check-in passes is applied
// here too, and the position measured and stored is the **admin's**, because the
// admin is the one who is actually there. What makes the row different is
// `checked_in_by`: the roster renders it as a 代 badge naming who did it, so a
// proxy check-in is never mistaken for the member having turned up with a phone.
// Fines are untouched by this — `lateness` reads `checked_in_at` alone, so a
// member checked in late by an admin owes exactly what they would have owed.
app.post('/event/:id/checkin-for', requireAdminApi, wrap(async (req, res) => {
  // No `canSeeEvent` here, like every other admin-only route: an admin sees
  // every event, so the rule could only ever pass.
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).json({ ok: false, message: '活动不存在' });
  if (!event.coords) return res.status(400).json({ ok: false, message: '该活动为线上活动，无需到场签到' });
  if (hasEnded(event)) return res.status(400).json({ ok: false, message: '活动已结束，无法签到' });
  const target = String(req.body.email || '').trim().toLowerCase();
  const theirs = event.roster.find(s => s.email === target);
  if (!theirs) return res.status(400).json({ ok: false, message: '该成员未报名本次活动' });
  if (theirs.status === db.WAITLIST) {
    return res.status(400).json({ ok: false, message: '该成员在候补名单中，补位成功后才能签到' });
  }
  if (theirs.checkedInAt) return res.json({ ok: true, email: target, message: '该成员已签到过了' });
  const where = atTheField(event, req.body);
  if (where.status) return res.status(where.status).json(where.body);
  await db.checkInToEvent(event.id, target, { ...where, by: req.session.user.email });
  res.json({
    ok: true,
    email: target,
    distance: where.distance,
    message: `代签到成功！(距球场约 ${where.distance} 米)`
  });
}));

// The member list doubles as the admin bulk-add page, so both the plain GET and
// the post-submit render go through here.
async function renderMembers(res) {
  const members = await db.getUsers();
  res.render('members', {
    title: '会员列表',
    // The edit modal opens on the member's avatar, so every row carries the
    // gravatar to fall back to. It can only be built here — it is an md5 of the
    // address — and it is asked for 192px because the modal draws it at 96.
    members: members.map(m => ({ ...m, avatarFallback: gravatar(m.email, 192) }))
  });
}

// The signed-in member's own record, reached from their name in the navbar.
// Read fresh from the database rather than from the session copy, which holds
// only email/name/role and can be up to 30 days stale.
app.get('/profile', requireLogin, wrap(async (req, res) => {
  const row = await db.getUserByEmail(req.session.user.email);
  // The account was deleted (or renamed) out from under a live session.
  if (!row) return req.session.destroy(() => res.redirect('/login'));
  req.session.user.name = row.name;
  req.session.user.role = row.role;
  res.render('profile', {
    title: '个人资料',
    profile: {
      email: row.email,
      name: row.name,
      position: row.position,
      joined: row.joined,
      role: row.role,
      // getUserByEmail hands back the raw row (it carries password_hash too),
      // so this is the one place the column keeps its snake_case name.
      profilePhoto: row.profile_photo || ''
    },
    // The member's own photo when they have set one, gravatar otherwise. The
    // fallback goes along too: the page swaps back to it without a reload when
    // the photo is cleared in the modal, or when the URL fails to load. 192px
    // covers both boxes it lands in — 72 on the card, 96 in the edit modal.
    avatar: row.profile_photo || gravatar(row.email, 192),
    avatarFallback: gravatar(row.email, 192)
  });
}));

app.get('/members', requireLogin, wrap(async (req, res) => {
  await renderMembers(res);
}));

// Bulk add / reset members by pasting "username:password" lines. Split on the
// first colon only, so passwords may themselves contain ':'.
function parseUserLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const i = line.indexOf(':');
      if (i === -1) return { line, error: '缺少冒号，格式应为 username:password' };
      const email = line.slice(0, i).trim();
      const password = line.slice(i + 1);
      if (!email) return { line, error: '账号为空' };
      if (!password) return { line, error: '密码为空' };
      return { line, email, password };
    });
}

// Old URLs that are gone; keep them working for bookmarks.
app.get('/add-user', (req, res) => res.redirect('/members'));
app.get('/member-list', (req, res) => res.redirect('/members'));

// Answers JSON to the modal's fetch rather than re-rendering /members: rendering
// the result of the POST left the browser sitting on /members/add-users, so a
// refresh re-submitted the whole paste. Same reason it carries the API guard.
app.post('/members/add-users', requireAdminApi, wrap(async (req, res) => {
  const parsed = parseUserLines(req.body.users);
  const results = [];
  for (const item of parsed) {
    if (item.error) {
      results.push({ line: item.line, ok: false, message: item.error });
      continue;
    }
    try {
      const user = await db.upsertUser({ email: item.email, password: item.password });
      results.push({
        line: item.line,
        ok: true,
        email: user.email,
        message: user.inserted ? '已创建' : '已更新密码'
      });
    } catch (err) {
      console.error(err);
      results.push({ line: item.line, ok: false, message: err.message });
    }
  }
  res.json({ ok: results.length > 0 && results.every(r => r.ok), results });
}));

// Same capability as the bulk-add form, so it carries the same gate — leaving it
// open would make the page-level check cosmetic.
app.post('/api/users', requireAdminApi, wrap(async (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!username || !password) {
    return res.status(400).json({ ok: false, message: 'username 和 password 为必填项' });
  }
  try {
    const user = await db.createUser(username, password);
    res.status(201).json(user);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, message: '用户已存在' });
    }
    throw err;
  }
}));

// Backs the per-member edit modal on /members and the same form on
// /profile. Only the keys present in the body are written, so an empty password
// box keeps the current password.
app.put('/api/users/:email', requireSelfOrAdminApi, wrap(async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  const patch = { email };
  if (req.body.password) patch.password = req.body.password;
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.position !== undefined) patch.position = req.body.position;
  if (req.body.profilePhoto !== undefined) patch.profilePhoto = req.body.profilePhoto;

  // An admin's credentials and identity are theirs alone: nobody else — not even
  // another admin — may change an ADMIN row's password or name, only 场上位置.
  // The role is re-read from the database, like every other admin check; the
  // modal's data-role and the session copy are rendering only. The form always
  // resubmits the current name, so only an actual change is refused.
  if (email !== req.session.user.email) {
    const target = await db.getUserByEmail(email);
    if (!target) return res.status(404).json({ ok: false, message: '用户不存在' });
    if (target.role === db.ADMIN) {
      const renaming = patch.name !== undefined
        && String(patch.name).trim() !== String(target.name || '').trim();
      if (patch.password || renaming || patch.profilePhoto !== undefined) {
        return res.status(403).json({
          ok: false,
          message: '管理员的密码和姓名只能由本人修改，其他人只能修改场上位置'
        });
      }
      delete patch.password;
      delete patch.name;
      delete patch.profilePhoto;
    }
  }

  let user;
  try {
    user = await db.updateUser(patch);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }
  if (!user) return res.status(404).json({ ok: false, message: '用户不存在' });
  // An admin renaming themselves would otherwise keep the old name in the navbar
  // until the next login, since the session only holds a copy.
  if (req.session.user.email === user.email) req.session.user.name = user.name;
  res.json({ ok: true, user });
}));

// An uploaded avatar is bytes in `gsffc.user_photos`; `users.profile_photo`
// keeps its documented shape and holds the URL below. The upload is limited to
// what a picture can be, and the *magic bytes* decide the type rather than the
// Content-Type header — the value is handed straight back to a browser as an
// image, so nothing may be stored that isn't one. The modal downscales to a
// 512px square JPEG before sending, so the limit here is headroom, not a target.
const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

// Serve a stored avatar. Gated like every other member-facing route, but with a
// bare 401 rather than `requireLogin`: this is an <img> src, and a redirect to
// /login would both render as a broken image and leave the picture's URL in
// `returnTo` as where to go after signing in. The stored URL carries the upload
// time as ?v=, so each upload is a distinct URL and this response can be cached
// for good — a replaced picture is simply never requested again.
app.get('/photos/:email', wrap(async (req, res) => {
  if (!req.session.user) return res.sendStatus(401);
  const photo = await db.getUserPhoto(req.params.email);
  if (!photo) return res.sendStatus(404);
  res.set('Content-Type', photo.mime);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(photo.bytes);
}));

// Backs the pencil on the avatar in the edit-user modal: the picked file is
// resized in the browser and POSTed here as raw image bytes (no multipart, no
// upload library). Same gate as the PUT above — your own row is self-service,
// anyone else's is an admin power — and the same rule for an admin's row.
app.post('/api/users/:email/photo',
  requireSelfOrAdminApi,
  express.raw({ type: PHOTO_TYPES, limit: PHOTO_MAX_BYTES }),
  wrap(async (req, res) => {
    const email = String(req.params.email || '').trim().toLowerCase();
    // An admin's identity is theirs alone, exactly as for the password and the
    // name: the role is re-read here, never taken from the session copy.
    if (email !== req.session.user.email) {
      const target = await db.getUserByEmail(email);
      if (!target) return res.status(404).json({ ok: false, message: '用户不存在' });
      if (target.role === db.ADMIN) {
        return res.status(403).json({ ok: false, message: '管理员的头像只能由本人修改' });
      }
    }
    // express.raw leaves an empty object when the Content-Type didn't match.
    const mime = sniffImage(req.body);
    if (!mime) return res.status(415).json({ ok: false, message: '只能上传图片文件' });
    const user = await db.setUserPhoto(email, { mime, bytes: req.body });
    if (!user) return res.status(404).json({ ok: false, message: '用户不存在' });
    res.json({ ok: true, user });
  }));

// Backs the "删除用户" button in the edit modal. Admin-only — unlike the PUT
// above there is no self-service branch: deleting your own account would destroy
// the session doing the deleting, and the last admin could lock everyone out of
// member management (there is no UI for promoting a replacement).
app.delete('/api/users/:email', requireAdminApi, wrap(async (req, res) => {
  const email = String(req.params.email || '').trim().toLowerCase();
  if (email === req.session.user.email) {
    return res.status(400).json({ ok: false, message: '不能删除自己的账号' });
  }
  // No admin may be deleted, by anyone. The modal hides the button for admin
  // rows, but that is rendering only — the role is re-read here so a direct
  // call can't get past it. Demote to MEMBER in SQL first if it really has to go.
  const target = await db.getUserByEmail(email);
  if (!target) return res.status(404).json({ ok: false, message: '用户不存在' });
  if (target.role === 'ADMIN') {
    return res.status(403).json({ ok: false, message: '不能删除管理员账号' });
  }
  const user = await db.deleteUser(email);
  if (!user) return res.status(404).json({ ok: false, message: '用户不存在' });
  res.json({ ok: true, user });
}));

// A stored start/end: local wall clock to the minute, in the exact shape an
// <input type="datetime-local"> carries. The fixed width is what lets the rest
// of the app compare these lexically, so nothing looser may be written.
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function isRealDateTime(value) {
  const m = typeof value === 'string' && DATETIME_RE.exec(value);
  if (!m) return false;
  const [y, mo, d, hh, mi] = m.slice(1).map(Number);
  if (hh > 23 || mi > 59) return false;
  // The regex accepts things like 2026-02-31; round-tripping through Date does
  // not. Local-time constructor, as everywhere else here.
  const probe = new Date(y, mo - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === mo - 1 && probe.getDate() === d;
}

// Shared by create and update: coerces the numeric fields in place and returns
// the first problem found, or null when the event is safe to write.
function validateEvent(event) {
  if (typeof event.title !== 'string' || !event.title.trim()) {
    return 'title 为必填项';
  }
  if (!isRealDateTime(event.startAt)) {
    return 'startAt 必须为 YYYY-MM-DDTHH:MM 格式的有效时间';
  }
  if (!isRealDateTime(event.endAt)) {
    return 'endAt 必须为 YYYY-MM-DDTHH:MM 格式的有效时间';
  }
  // Both are the same fixed-width format, so string order is time order — and
  // this is the same rule the events_end_after_start CHECK enforces in SQL.
  if (event.endAt <= event.startAt) {
    return '结束时间必须晚于开始时间';
  }
  event.capacity = Number(event.capacity);
  if (!Number.isInteger(event.capacity) || event.capacity < 0) {
    return 'capacity 必须为非负整数';
  }
  if (event.coords !== null
    && (typeof event.coords !== 'object'
      || !Number.isFinite(event.coords.lat) || !Number.isFinite(event.coords.lng))) {
    return 'coords 必须为 null 或 {lat, lng}';
  }
  event.checkinRadius = Number(event.checkinRadius);
  if (!Number.isInteger(event.checkinRadius) || event.checkinRadius <= 0) {
    return 'checkinRadius 必须为正整数';
  }
  // 总人数（包含试训、guest）is optional and stays optional: an empty box means
  // "not recorded" and is coerced to null, which is what every event carries
  // until an admin fills it in. `Number('')` is 0, so the empty cases have to be
  // caught *before* the coercion or a blank field would record a headcount of 0.
  if (event.totalHeadcount === undefined || event.totalHeadcount === null
    || (typeof event.totalHeadcount === 'string' && !event.totalHeadcount.trim())) {
    event.totalHeadcount = null;
  } else {
    event.totalHeadcount = Number(event.totalHeadcount);
    if (!Number.isInteger(event.totalHeadcount) || event.totalHeadcount < 0) {
      return 'totalHeadcount 必须为非负整数或留空';
    }
  }
  // Coerced in place to one of the column's three shapes, so what the routes
  // then hand to `db.createEvent`/`updateEvent` is already normalized.
  try {
    event.visibility = db.normalizeVisibility(event.visibility);
  } catch (err) {
    return err.message;
  }
  return null;
}

// The half of the visibility check that needs the database: a visibility naming
// a member only means something if that member exists — a typo would otherwise
// create an event literally nobody but an admin can see. Returns the complaint,
// or null when the value is fine.
async function checkVisibilityTarget(visibility) {
  if (visibility === db.VISIBLE_ALL || visibility === db.VISIBLE_ADMIN) return null;
  return (await db.getUserByEmail(visibility)) ? null : `找不到成员 ${visibility}`;
}

// JSON API — no delete; creating is admin-only, editing is not (POC)
app.get('/api/events', requireLoginApi, wrap(async (req, res) => {
  const me = await viewer(req);
  res.json((await db.getEvents()).filter(e => db.canSeeEvent(e, me)));
}));

app.get('/api/events/:id', requireLoginApi, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event || !db.canSeeEvent(event, await viewer(req))) {
    return res.status(404).json({ ok: false, message: '活动不存在' });
  }
  res.json(event);
}));

app.put('/api/events/:id', requireLoginApi, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event || !db.canSeeEvent(event, await viewer(req))) {
    return res.status(404).json({ ok: false, message: '活动不存在' });
  }
  // A finished event is fixed: it exists and can be read, so this is a 400 and
  // not the 404 a hidden one answers. It also closes the last way its roster
  // could still move — raising `capacity` promotes off the waitlist.
  if (hasEnded(event)) {
    return res.status(400).json({ ok: false, message: '活动已结束，无法修改' });
  }

  // `date`/`endDate`/`time` are derived from these two by `rowToEvent` and are
  // read-only — writing them would be silently dropped, so they are not listed.
  const EDITABLE_FIELDS = ['title', 'startAt', 'endAt', 'location', 'coords', 'description', 'capacity', 'checkinRadius', 'totalHeadcount', 'visibility'];
  for (const field of EDITABLE_FIELDS) {
    if (req.body[field] !== undefined) event[field] = req.body[field];
  }
  const error = validateEvent(event) || await checkVisibilityTarget(event.visibility);
  if (error) return res.status(400).json({ ok: false, message: error });

  await db.updateEvent(event);
  res.json(await db.getEvent(event.id));
}));

// Backs the "添加活动" modal on /calendar. Creating events is an admin power, so
// unlike the edit route above this one is gated — and gated by re-reading the
// role, never by the session's copy.
app.post('/api/events', requireAdminApi, wrap(async (req, res) => {
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const event = {
    title: str(req.body.title),
    startAt: str(req.body.startAt),
    endAt: str(req.body.endAt),
    location: str(req.body.location),
    description: str(req.body.description),
    capacity: req.body.capacity,
    // New events are created without a check-in point; it is picked afterwards
    // from the event page's test-settings card.
    coords: req.body.coords === undefined ? null : req.body.coords,
    checkinRadius: req.body.checkinRadius === undefined ? 10 : req.body.checkinRadius,
    // Left null by `validateEvent` when the form's box was blank, which is the
    // normal case for an event that has not happened yet.
    totalHeadcount: req.body.totalHeadcount,
    // Open to every member unless the form says otherwise.
    visibility: req.body.visibility === undefined ? db.VISIBLE_ALL : req.body.visibility
  };
  const error = validateEvent(event) || await checkVisibilityTarget(event.visibility);
  if (error) return res.status(400).json({ ok: false, message: error });

  res.status(201).json(await db.createEvent(event));
}));

app.use((req, res) => res.status(404).render('404', { title: 'Not Found' }));

app.use((err, req, res, next) => {
  console.error(err);
  // A body rejected by express.raw/json never reaches its route, so the size
  // limit would otherwise surface as a bare "服务器错误" — which tells an admin
  // whose photo was refused nothing about why.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, message: '文件太大，请换一张更小的图片' });
  }
  res.status(500);
  // An /api/* caller wants JSON, not a page it can't parse.
  if (req.path.startsWith('/api/')) {
    return res.json({ ok: false, message: '服务器错误' });
  }
  // The error page is itself a template render and can fail in turn — on a
  // database outage the session middleware throws before the locals are set.
  // Falling back to text is what keeps the original error visible instead of
  // being replaced by "path is not defined" from header.ejs.
  res.render('404', { title: 'Server Error' }, (renderErr, html) => {
    if (!renderErr) return res.send(html);
    console.error(renderErr);
    res.type('text').send('Server Error');
  });
});

// Only start a long-running server when executed directly (local dev / a
// container host). On Netlify the app is driven by netlify/functions/server.js.
// The database schema is provisioned separately from db/schema.sql.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`GSF test app running at http://localhost:${PORT}`);
  });
}

module.exports = app;
