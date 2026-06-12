const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const SCHEMA_FILE = path.join(__dirname, 'db', 'schema.sql');
// All tables live in this hardcoded schema; every query below is prefixed with it.
const SCHEMA = 'gsffc';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined
});

async function init() {
  await pool.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    time: row.time,
    location: row.location,
    coords: row.lat != null && row.lng != null ? { lat: row.lat, lng: row.lng } : null,
    description: row.description,
    capacity: row.capacity,
    checkinRadius: row.checkin_radius != null ? row.checkin_radius : 10,
    signups: JSON.parse(row.signups),
    checkins: JSON.parse(row.checkins)
  };
}

async function getUsers() {
  const { rows } = await pool.query(
    `SELECT email, name, position, joined FROM ${SCHEMA}.users ORDER BY joined`
  );
  return rows;
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
     RETURNING email, name, position, joined`,
    [username, bcrypt.hashSync(password, 10), username]
  );
  return rows[0];
}

async function getEvents() {
  const { rows } = await pool.query(
    `SELECT * FROM ${SCHEMA}.events ORDER BY date`
  );
  return rows.map(rowToEvent);
}

async function getEvent(id) {
  const { rows } = await pool.query(
    `SELECT * FROM ${SCHEMA}.events WHERE id = $1`, [id]
  );
  return rowToEvent(rows[0]);
}

async function updateEvent(event) {
  await pool.query(
    `UPDATE ${SCHEMA}.events SET
       title = $2, date = $3, time = $4, location = $5,
       lat = $6, lng = $7, description = $8, capacity = $9,
       signups = $10, checkins = $11, checkin_radius = $12
     WHERE id = $1`,
    [
      event.id,
      event.title,
      event.date,
      event.time,
      event.location,
      event.coords ? event.coords.lat : null,
      event.coords ? event.coords.lng : null,
      event.description,
      event.capacity,
      JSON.stringify(event.signups || []),
      JSON.stringify(event.checkins || []),
      event.checkinRadius || 10
    ]
  );
}

module.exports = { init, pool, getUsers, getUserByEmail, verifyPassword, createUser, getEvents, getEvent, updateEvent };
