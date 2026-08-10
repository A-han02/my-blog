// 新增 views 表，记录文章浏览量
const db = require('./init');

try {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='views'").get();
  if (!exists) {
    db.exec(`
      CREATE TABLE views (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL,
        user_id    INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY(article_id) REFERENCES articles(id)
      )
    `);
    db.exec('CREATE INDEX idx_views_article ON views(article_id);');
    db.exec('CREATE INDEX idx_views_user ON views(user_id);');
    console.log('Table "views" created');
  } else {
    console.log('Table "views" already exists');
  }
} catch (e) {
  console.error('Error creating views table:', e.message);
}
