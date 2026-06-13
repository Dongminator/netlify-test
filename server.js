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

// Express 4 doesn't catch async errors; route rejections go to the error handler
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

// `event.date` is a plain YYYY-MM-DD string, so "today" is produced in the same
// shape and every past/upcoming test is a lexical comparison.
const todayStr = () => new Date().toISOString().slice(0, 10);

// Signup and check-in times are real timestamps (unlike `event.date`), so they
// are formatted here rather than in the template: local time, minute precision,
// and the year dropped when it is the current one — the roster is a list of
// "when did this happen" notes, not a log.
function formatStamp(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const md = `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}年${md}`;
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
  const events = await db.getEvents();
  const today = todayStr();

  // ?month=YYYY-MM drives the grid; anything malformed falls back to this month.
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth();
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
    isCurrentMonth: year === now.getFullYear() && month === now.getMonth(),
    // The add-event modal reloads onto the new event's month with ?created=1,
    // which is what raises the success banner.
    created: req.query.created === '1',
    mapCenter,
    // What the modal's date field starts on: today when it is in view, so the
    // common case needs no picking, otherwise the 1st of the month being viewed.
    defaultDate: year === now.getFullYear() && month === now.getMonth() ? today : ymd(year, month, 1)
  });
}));

app.get('/event/:id', requireLogin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const users = await db.getUsers();
  const byEmail = new Map(users.map(u => [u.email, u]));
  // `event.roster` is already ordered — confirmed members first, then the
  // waitlist, each half oldest signup first — so the index inside each half is
  // the member's place in it.
  const toParticipant = (signup, i) => {
    const u = byEmail.get(signup.email);
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
    isPast: event.date < todayStr()
  });
}));

// Signing up for a full event is not refused: `db.signUpForEvent` records it as
// a WAITLIST signup instead, and the redirect carries ?joined=waitlist so the
// page can say so. The capacity decision is made under a row lock in there, not
// here, so two members racing for the last place can't both take it.
app.post('/event/:id/signup', requireLogin, wrap(async (req, res) => {
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
app.post('/event/:id/clear-signups', requireAdmin, wrap(async (req, res) => {
  const result = await db.clearEventRoster(req.params.id);
  if (!result) return res.status(404).render('404', { title: 'Not Found' });
  res.redirect(`/event/${req.params.id}`);
}));

// Copying an event no longer has a route of its own: the 复制 button opens the
// event modal prefilled and a week on, so the copy goes through POST /api/events
// like any other creation — with the admin able to adjust it before it is saved.

app.post('/event/:id/checkin', requireLogin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).json({ ok: false, message: '活动不存在' });
  if (!event.coords) return res.status(400).json({ ok: false, message: '该活动为线上活动，无需到场签到' });
  if (event.date < todayStr()) {
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
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok: false, message: '未获取到有效位置' });
  }
  const distance = Math.round(distanceMeters(lat, lng, event.coords.lat, event.coords.lng));
  if (distance > event.checkinRadius) {
    return res.status(403).json({
      ok: false,
      distance,
      message: `签到失败：你距离球场约 ${distance} 米，需在 ${event.checkinRadius} 米范围内`
    });
  }
  // The coordinates go in with the time, as the evidence behind the row.
  await db.checkInToEvent(event.id, email, { lat, lng, distance });
  res.json({ ok: true, distance, message: `签到成功！(距球场约 ${distance} 米)` });
}));

// The member list doubles as the admin bulk-add page, so both the plain GET and
// the post-submit render go through here.
async function renderMembers(res, { results = null, input = '' } = {}) {
  res.render('members', {
    title: '会员列表',
    members: await db.getUsers(),
    results,
    input
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
    // the photo is cleared in the modal, or when the URL fails to load.
    avatar: row.profile_photo || gravatar(row.email, 144),
    avatarFallback: gravatar(row.email, 144)
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

app.post('/members/add-users', requireAdmin, wrap(async (req, res) => {
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
  // Keep the pasted text only when something failed, so it can be corrected.
  await renderMembers(res, { results, input: results.some(r => !r.ok) ? req.body.users : '' });
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
  return null;
}

// JSON API — no delete; creating is admin-only, editing is not (POC)
app.get('/api/events', requireLoginApi, wrap(async (req, res) => {
  res.json(await db.getEvents());
}));

app.get('/api/events/:id', requireLoginApi, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).json({ ok: false, message: '活动不存在' });
  res.json(event);
}));

app.put('/api/events/:id', requireLoginApi, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).json({ ok: false, message: '活动不存在' });

  // `date`/`endDate`/`time` are derived from these two by `rowToEvent` and are
  // read-only — writing them would be silently dropped, so they are not listed.
  const EDITABLE_FIELDS = ['title', 'startAt', 'endAt', 'location', 'coords', 'description', 'capacity', 'checkinRadius'];
  for (const field of EDITABLE_FIELDS) {
    if (req.body[field] !== undefined) event[field] = req.body[field];
  }
  const error = validateEvent(event);
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
    checkinRadius: req.body.checkinRadius === undefined ? 10 : req.body.checkinRadius
  };
  const error = validateEvent(event);
  if (error) return res.status(400).json({ ok: false, message: error });

  res.status(201).json(await db.createEvent(event));
}));

app.use((req, res) => res.status(404).render('404', { title: 'Not Found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('404', { title: 'Server Error' });
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
