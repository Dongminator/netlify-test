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

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.path = req.path;
  next();
});

// Express 4 doesn't catch async errors; route rejections go to the error handler
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

// Same avatar scheme as the production app (hackathon-starter gravatar helper)
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
  req.session.user = { email: user.email, name: user.name };
  const dest = req.session.returnTo || '/calendar';
  delete req.session.returnTo;
  res.redirect(dest);
}));

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/calendar', requireLogin, wrap(async (req, res) => {
  const events = await db.getEvents();
  const today = new Date().toISOString().slice(0, 10);
  res.render('calendar', {
    title: '活动日历',
    upcoming: events.filter(e => e.date >= today),
    past: events.filter(e => e.date < today).reverse()
  });
}));

app.get('/event/:id', requireLogin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const users = await db.getUsers();
  const checkins = event.checkins;
  const participants = event.signups.map(email => {
    const u = users.find(x => x.email === email);
    return {
      name: u ? u.name : email,
      position: u && u.position ? u.position : '',
      avatar: gravatar(email),
      checkedIn: checkins.includes(email)
    };
  });
  res.render('event', {
    title: event.title,
    event,
    participants,
    signedUp: event.signups.includes(req.session.user.email),
    checkedIn: checkins.includes(req.session.user.email),
    isPast: event.date < new Date().toISOString().slice(0, 10)
  });
}));

app.post('/event/:id/signup', requireLogin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const email = req.session.user.email;
  if (!event.signups.includes(email) && event.signups.length < event.capacity) {
    event.signups.push(email);
    await db.updateEvent(event);
  }
  res.redirect(`/event/${event.id}`);
}));

app.post('/event/:id/withdraw', requireLogin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const i = event.signups.indexOf(req.session.user.email);
  if (i !== -1) {
    event.signups.splice(i, 1);
    const j = event.checkins.indexOf(req.session.user.email);
    if (j !== -1) event.checkins.splice(j, 1);
    await db.updateEvent(event);
  }
  res.redirect(`/event/${event.id}`);
}));

app.post('/event/:id/checkin', requireLogin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).json({ ok: false, message: '活动不存在' });
  if (!event.coords) return res.status(400).json({ ok: false, message: '该活动为线上活动，无需到场签到' });
  if (event.date < new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ ok: false, message: '活动已结束，无法签到' });
  }
  const email = req.session.user.email;
  if (!event.signups.includes(email)) {
    return res.status(400).json({ ok: false, message: '请先报名再签到' });
  }
  if (event.checkins.includes(email)) {
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
  event.checkins.push(email);
  await db.updateEvent(event);
  res.json({ ok: true, distance, message: `签到成功！(距球场约 ${distance} 米)` });
}));

// POC only: let any member move the event location / resize the check-in
// radius from the event page, so GPS check-in can be tested from anywhere.
app.post('/event/:id/settings', requireLogin, wrap(async (req, res) => {
  const event = await db.getEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  const radius = Math.round(Number(req.body.radius));
  if (Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
    event.coords = { lat, lng };
  }
  if (Number.isFinite(radius) && radius > 0) {
    event.checkinRadius = radius;
  }
  await db.updateEvent(event);
  res.redirect(`/event/${event.id}`);
}));

app.get('/member-list', requireLogin, wrap(async (req, res) => {
  res.render('members', { title: '会员列表', members: await db.getUsers() });
}));

app.post('/api/users', requireLoginApi, wrap(async (req, res) => {
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

// JSON API — read & update only (demo: no create/delete)
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

  const EDITABLE_FIELDS = ['title', 'date', 'time', 'location', 'coords', 'description', 'capacity', 'checkinRadius'];
  for (const field of EDITABLE_FIELDS) {
    if (req.body[field] !== undefined) event[field] = req.body[field];
  }
  if (typeof event.title !== 'string' || !event.title.trim()
    || typeof event.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(event.date)) {
    return res.status(400).json({ ok: false, message: 'title 和 date (YYYY-MM-DD) 为必填项' });
  }
  event.capacity = Number(event.capacity);
  if (!Number.isInteger(event.capacity) || event.capacity < 0) {
    return res.status(400).json({ ok: false, message: 'capacity 必须为非负整数' });
  }
  if (event.coords !== null
    && (typeof event.coords !== 'object'
      || !Number.isFinite(event.coords.lat) || !Number.isFinite(event.coords.lng))) {
    return res.status(400).json({ ok: false, message: 'coords 必须为 null 或 {lat, lng}' });
  }
  event.checkinRadius = Number(event.checkinRadius);
  if (!Number.isInteger(event.checkinRadius) || event.checkinRadius <= 0) {
    return res.status(400).json({ ok: false, message: 'checkinRadius 必须为正整数' });
  }

  await db.updateEvent(event);
  res.json(await db.getEvent(event.id));
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
