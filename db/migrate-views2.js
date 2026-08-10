const db = require('./db/init');
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS views (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      user_id    INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY(article_id) REFERENCES articles(id)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_views_article ON views(article_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_views_user ON views(user_id);');
  console.log('views table created/indexed');
} catch (e) {
  console.error('Error creating views table:', e.message);
}
