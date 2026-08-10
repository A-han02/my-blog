const db = require('./init');
console.log('DB loaded, running migration...');

const artCols = db.prepare("PRAGMA table_info(articles)").all();
const colNames = artCols.map(c => c.name);

if (!colNames.includes('publish_at')) {
  db.prepare("ALTER TABLE articles ADD COLUMN publish_at TEXT DEFAULT '2026-01-01T00:00:00Z'").run();
  console.log('Added publish_at column');
} else {
  console.log('publish_at already exists');
}

if (!colNames.includes('visibility')) {
  db.prepare("ALTER TABLE articles ADD COLUMN visibility TEXT DEFAULT 'public'").run();
  console.log('Added visibility column');
} else {
  console.log('visibility already exists');
}

const updated = db.prepare("UPDATE articles SET publish_at = datetime('now') WHERE publish_at IS NULL OR publish_at = '2026-01-01T00:00:00Z'").run();
console.log('Updated publish_at for ' + updated.changes + ' rows');

const check = db.prepare("SELECT id, title, status, visibility, publish_at FROM articles LIMIT 1").get();
console.log('Verification:', JSON.stringify(check));
console.log('Migration DONE');
