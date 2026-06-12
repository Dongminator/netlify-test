const path = require('path');
const express = require('express');
const session = require('express-session');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'gsf-test-secret',
  resave: false,
  saveUninitialized: false
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.path = req.path;
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function findEvent(id) {
  return store.load().events.find(e => e.id === id);
}

const CHECKIN_RADIUS_METERS = 10;

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

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = store.load().users.find(
    u => u.email === (email || '').trim().toLowerCase() && u.password === password
  );
  if (!user) {
    return res.status(401).render('login', { title: 'Login', error: '账号或密码错误' });
  }
  req.session.user = { email: user.email, name: user.name };
  const dest = req.session.returnTo || '/calendar';
  delete req.session.returnTo;
  res.redirect(dest);
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/calendar', requireLogin, (req, res) => {
  const events = [...store.load().events].sort((a, b) => a.date.localeCompare(b.date));
  const today = new Date().toISOString().slice(0, 10);
  res.render('calendar', {
    title: '活动日历',
    upcoming: events.filter(e => e.date >= today),
    past: events.filter(e => e.date < today).reverse()
  });
});

app.get('/event/:id', requireLogin, (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const users = store.load().users;
  const checkins = event.checkins || [];
  const participants = event.signups.map(email => {
    const u = users.find(x => x.email === email);
    return { name: u ? u.name : email, checkedIn: checkins.includes(email) };
  });
  res.render('event', {
    title: event.title,
    event,
    participants,
    signedUp: event.signups.includes(req.session.user.email),
    checkedIn: checkins.includes(req.session.user.email),
    isPast: event.date < new Date().toISOString().slice(0, 10)
  });
});

app.post('/event/:id/signup', requireLogin, (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const email = req.session.user.email;
  if (!event.signups.includes(email) && event.signups.length < event.capacity) {
    event.signups.push(email);
    store.save();
  }
  res.redirect(`/event/${event.id}`);
});

app.post('/event/:id/withdraw', requireLogin, (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const i = event.signups.indexOf(req.session.user.email);
  if (i !== -1) {
    event.signups.splice(i, 1);
    if (event.checkins) {
      const j = event.checkins.indexOf(req.session.user.email);
      if (j !== -1) event.checkins.splice(j, 1);
    }
    store.save();
  }
  res.redirect(`/event/${event.id}`);
});

app.post('/event/:id/checkin', requireLogin, (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) return res.status(404).json({ ok: false, message: '活动不存在' });
  if (!event.coords) return res.status(400).json({ ok: false, message: '该活动为线上活动，无需到场签到' });
  if (event.date < new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ ok: false, message: '活动已结束，无法签到' });
  }
  const email = req.session.user.email;
  if (!event.signups.includes(email)) {
    return res.status(400).json({ ok: false, message: '请先报名再签到' });
  }
  if (!event.checkins) event.checkins = [];
  if (event.checkins.includes(email)) {
    return res.json({ ok: true, message: '你已签到过了' });
  }
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok: false, message: '未获取到有效位置' });
  }
  const distance = Math.round(distanceMeters(lat, lng, event.coords.lat, event.coords.lng));
  if (distance > CHECKIN_RADIUS_METERS) {
    return res.status(403).json({
      ok: false,
      distance,
      message: `签到失败：你距离球场约 ${distance} 米，需在 ${CHECKIN_RADIUS_METERS} 米范围内`
    });
  }
  event.checkins.push(email);
  store.save();
  res.json({ ok: true, distance, message: `签到成功！(距球场约 ${distance} 米)` });
});

app.post('/event/:id/comment', requireLogin, (req, res) => {
  const event = findEvent(req.params.id);
  if (!event) return res.status(404).render('404', { title: 'Not Found' });
  const text = (req.body.text || '').trim();
  if (text) {
    event.comments.push({
      author: req.session.user.name,
      time: new Date().toISOString().slice(0, 16).replace('T', ' '),
      text
    });
    store.save();
  }
  res.redirect(`/event/${event.id}`);
});

app.get('/member-list', requireLogin, (req, res) => {
  res.render('members', { title: '会员列表', members: store.load().users });
});

app.use((req, res) => res.status(404).render('404', { title: 'Not Found' }));

app.listen(PORT, () => {
  console.log(`GSF test app running at http://localhost:${PORT}`);
});
