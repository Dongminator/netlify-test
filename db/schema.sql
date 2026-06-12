-- GSF demo: schema + seed data (PostgreSQL).
-- All objects live in the hardcoded `gsffc` schema.
-- Executed on every server start; ON CONFLICT DO NOTHING keeps it idempotent.

CREATE SCHEMA IF NOT EXISTS gsffc;

CREATE TABLE IF NOT EXISTS gsffc.users (
  email         TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  position      TEXT,
  joined        TEXT
);

CREATE TABLE IF NOT EXISTS gsffc.events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  date        TEXT NOT NULL,
  time        TEXT,
  location    TEXT,
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  description TEXT,
  capacity    INTEGER NOT NULL DEFAULT 0,
  signups     TEXT NOT NULL DEFAULT '[]',
  checkins    TEXT NOT NULL DEFAULT '[]'
);

-- Events with physical locations only (online events excluded for now).
INSERT INTO gsffc.events (id, title, date, time, location, lat, lng, description, capacity, signups) VALUES
  ('6a2a24a22e8d92aecd66b520', '周六例行训练赛 11v11', '2026-06-13', '16:00 - 18:00',
   '2065 Tarob Ct, Milpitas, CA 95035', 37.4045892, -121.8907831,
   '本周六例行训练赛，11人制对抗。请穿好球鞋护腿板，自带水。报名截止周五晚10点，人数不足改为小场。', 22,
   '["dike@gsffc.org","kevin@gsffc.org","lifeng@gsffc.org","demo@gsffc.org","donglin@gsffc.org"]'),
  ('8c4d46c44a0fb4caef88d742', '校联杯小组赛 GSF vs SBK', '2026-06-20', '14:00 - 16:00',
   'Stanford IM Field', 37.43053, -122.15917,
   '校联杯小组赛第二轮，对阵老对手SBK。赛前30分钟到场热身，统一主场白色球衣。', 18,
   '["dike@gsffc.org","lifeng@gsffc.org"]'),
  ('5f1b13a11d7c81aabc55a409', '赛季总结烧烤聚会', '2026-05-30', '12:00 - 15:00',
   'Cuesta Park, Mountain View', 37.37758, -122.06965,
   '春季赛季总结+烧烤，家属欢迎。俱乐部提供肉和饮料，可自带拿手菜。', 40,
   '["dike@gsffc.org","kevin@gsffc.org","donglin@gsffc.org"]')
ON CONFLICT (id) DO NOTHING;
