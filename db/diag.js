const db = require('./init');

// 1. 检查所有表
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name).join(', '));

// 2. 检查 comments 表结构
try {
  const cols = db.prepare("PRAGMA table_info(comments)").all();
  console.log('Comments columns:', cols.map(c => c.name + '(' + c.type + ')').join(', '));
} catch (e) {
  console.log('Comments table ERROR:', e.message);
}

// 3. 检查 articles 表中有 id=5 的记录
try {
  const art = db.prepare("SELECT id, title, status, visibility FROM articles WHERE id = 5").get();
  console.log('Article id=5:', art ? JSON.stringify(art) : 'NOT FOUND');
} catch (e) {
  console.log('Article id=5 ERROR:', e.message);
}

// 4. 检查用户 1 是否存在
try {
  const user = db.prepare("SELECT id, username, role FROM users WHERE id = 1").get();
  console.log('User id=1:', user ? JSON.stringify(user) : 'NOT FOUND');
} catch (e) {
  console.log('User id=1 ERROR:', e.message);
}

// 5. 测试插入评论
try {
  const stmt = db.prepare("INSERT INTO comments (user_id, article_id, content, parent_id) VALUES (?, ?, ?, ?)");
  const info = stmt.run(1, 5, 'test comment from script', 0);
  console.log('Insert comment:', info);
} catch (e) {
  console.log('Insert comment ERROR:', e.code, e.message);
}

// 6. 查询评论
try {
  const rows = db.prepare("SELECT c.*, u.nickname FROM comments c JOIN users u ON c.user_id = u.id WHERE c.article_id = 5").all();
  console.log('Comments for article 5:', rows.map(r => JSON.stringify(r)).join('\n'));
} catch (e) {
  console.log('Query comments ERROR:', e.message);
}

console.log('DIAGNOSTIC DONE');
