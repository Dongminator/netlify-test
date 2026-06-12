const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'db.json');

let db = null;

function load() {
  if (!db) {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
  return db;
}

function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

module.exports = { load, save };
