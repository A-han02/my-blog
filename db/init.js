const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'blog.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

// 建表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE,
    password   TEXT NOT NULL,
    nickname   TEXT DEFAULT '',
    bio        TEXT DEFAULT '',
    avatar     TEXT DEFAULT '',
    role       TEXT DEFAULT 'user' CHECK(role IN ('user','admin')),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS articles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id  INTEGER NOT NULL,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    category   TEXT DEFAULT '其他',
    tags       TEXT DEFAULT '',
    status     TEXT DEFAULT 'published' CHECK(status IN ('draft','published','takedown')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(author_id) REFERENCES users(id)
  );
`);

// 迁移：对已存在的旧表添加缺失列
try {
  const colCheck = db.prepare("PRAGMA table_info(articles)").all();
  const hasCategory = colCheck.some(c => c.name === 'category');
  const hasTags = colCheck.some(c => c.name === 'tags');
  if (!hasCategory) {
    db.prepare("ALTER TABLE articles ADD COLUMN category TEXT DEFAULT '其他'").run();
    console.log('迁移：添加 category 列');
  }
  if (!hasTags) {
    db.prepare("ALTER TABLE articles ADD COLUMN tags TEXT DEFAULT ''").run();
    console.log('迁移：添加 tags 列');
  }
} catch (_) {}

// 迁移：对 users 表添加个人资料列
try {
  const userCols = db.prepare("PRAGMA table_info(users)").all();
  const hasGender = userCols.some(c => c.name === 'gender');
  const hasAge = userCols.some(c => c.name === 'age');
  const hasLocation = userCols.some(c => c.name === 'location');
  const hasBirthday = userCols.some(c => c.name === 'birthday');
  if (!hasGender) { db.prepare("ALTER TABLE users ADD COLUMN gender TEXT DEFAULT ''").run(); }
  if (!hasAge) { db.prepare("ALTER TABLE users ADD COLUMN age INTEGER DEFAULT 0").run(); }
  if (!hasLocation) { db.prepare("ALTER TABLE users ADD COLUMN location TEXT DEFAULT ''").run(); }
  if (!hasBirthday) { db.prepare("ALTER TABLE users ADD COLUMN birthday TEXT DEFAULT ''").run(); }
} catch (_) {}

// 建索引
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_articles_author   ON articles(author_id);
  CREATE INDEX IF NOT EXISTS idx_articles_status   ON articles(status);
  CREATE INDEX IF NOT EXISTS idx_articles_created  ON articles(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
`);

// 创建交互表：点赞
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS likes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      article_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(article_id) REFERENCES articles(id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_likes_article ON likes(article_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);');
  // 唯一约束：同一用户对同一文章只能赞一次（在已有表上无法加 UNIQUE，用应用层保证）
} catch (_) {}

// 创建交互表：评论
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      article_id INTEGER NOT NULL,
      content    TEXT NOT NULL,
      parent_id  INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(article_id) REFERENCES articles(id),
      FOREIGN KEY(parent_id) REFERENCES comments(id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);');
  // 将已有 parent_id=0 的记录修复为 NULL（0 不是有效的 comment id）
  try {
    db.prepare("UPDATE comments SET parent_id = NULL WHERE parent_id = 0").run();
  } catch (_) {}
} catch (_) {}

// 创建交互表：转发
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      article_id INTEGER NOT NULL,
      note       TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(article_id) REFERENCES articles(id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_shares_article ON shares(article_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);');
} catch (_) {}

// 创建删除日志表（审计用）
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delete_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      author_id  INTEGER NOT NULL,
      operator_id INTEGER NOT NULL,
      reason     TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(article_id) REFERENCES articles(id)
    );
  `);
} catch (_) {}

// 迁移：为 articles 表添加统计列 + 定时发布/权限列
try {
  const artCols = db.prepare("PRAGMA table_info(articles)").all();
  const colNames = artCols.map(c => c.name);
  if (!colNames.includes('like_count')) { db.prepare("ALTER TABLE articles ADD COLUMN like_count INTEGER DEFAULT 0").run(); }
  if (!colNames.includes('comment_count')) { db.prepare("ALTER TABLE articles ADD COLUMN comment_count INTEGER DEFAULT 0").run(); }
  if (!colNames.includes('share_count')) { db.prepare("ALTER TABLE articles ADD COLUMN share_count INTEGER DEFAULT 0").run(); }
  if (!colNames.includes('publish_at')) { db.prepare("ALTER TABLE articles ADD COLUMN publish_at TEXT DEFAULT '2026-01-01T00:00:00Z'").run(); }
  if (!colNames.includes('visibility')) { db.prepare("ALTER TABLE articles ADD COLUMN visibility TEXT DEFAULT 'public'").run(); }
  // 同步更新已有行的 publish_at
  db.prepare("UPDATE articles SET publish_at = datetime('now') WHERE publish_at IS NULL OR publish_at = '2026-01-01T00:00:00Z'").run();
} catch (e) {
  console.error('[Migration Error]', e.message);
}

// 创建关注表
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS follows (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      follower_id  INTEGER NOT NULL,
      following_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(follower_id, following_id),
      FOREIGN KEY(follower_id) REFERENCES users(id),
      FOREIGN KEY(following_id) REFERENCES users(id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);');
} catch (_) {}

// 创建好友表（互关后自动成为好友）
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS friends (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user1_id   INTEGER NOT NULL,
      user2_id   INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user1_id, user2_id),
      FOREIGN KEY(user1_id) REFERENCES users(id),
      FOREIGN KEY(user2_id) REFERENCES users(id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_friends_u1 ON friends(user1_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_friends_u2 ON friends(user2_id);');
} catch (_) {}

// 创建消息表
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id  INTEGER NOT NULL,
      receiver_id INTEGER NOT NULL,
      content    TEXT NOT NULL,
      read_at    TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(sender_id) REFERENCES users(id),
      FOREIGN KEY(receiver_id) REFERENCES users(id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);');
} catch (_) {}

// 创建默认管理员
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';
const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);
if (!exists) {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare(
    'INSERT INTO users (username, password, nickname, role, bio) VALUES (?, ?, ?, ?, ?)'
  ).run(
    ADMIN_USERNAME,
    hash,
    '系统管理员',
    'admin',
    '社区管理员，负责内容审核'
  );
  console.log('管理员账号创建:', ADMIN_USERNAME + '/' + ADMIN_PASSWORD);
}

// 创建示例文章（中文内容）
const count = db.prepare('SELECT COUNT(*) as c FROM articles').get();
if (count.c === 0) {
  const adminId = db.prepare('SELECT id FROM users WHERE role = ?').get('admin').id;
  const sampleHash = bcrypt.hashSync('123456', 10);
  db.prepare(
    'INSERT INTO users (username, password, nickname, bio) VALUES (?, ?, ?, ?)'
  ).run('demo', sampleHash, '小博主', '热爱写作的社区作者');

  const samples = [
    {
      title: '欢迎来到博客社区',
      category: '新手指南',
      tags: '博客,社区,入门',
      content: `# 欢迎来到博客社区\n\n这是一个**面向所有访客开放**的公共博客社区平台。\n\n## 你可以做什么\n\n1. 注册账号，发布 Markdown 文章\n2. 浏览其他用户的文章\n3. 搜索你感兴趣的内容\n4. 编辑个人资料\n\n## Markdown 示例\n\n下面是代码块的示例：\n\n\`\`\`javascript\nconsole.log("你好，世界！");\n\`\`\`\n\n> 开始写博客，记录你的思想。`
    },
    {
      title: 'Node.js 入门指南',
      category: '技术教程',
      tags: 'Node.js,JavaScript,后端',
      content: `# Node.js 入门指南\n\nNode.js 是一个基于 **Chrome V8 引擎**的 JavaScript 运行时。\n\n## 为什么选择 Node.js\n\n- 事件驱动、非阻塞 I/O\n- 统一的 JavaScript 全栈开发\n- 丰富的 npm 生态\n\n## 第一个程序\n\n\`\`\`javascript\nconst http = require('http');\nconst server = http.createServer((req, res) => {\n  res.end('Hello Node.js');\n});\nserver.listen(3000);\n\`\`\`\n\n就是这么简单，一个 HTTP 服务器就搭建好了。\n\n> 继续学习 Express 框架，可以让开发更高效。`
    },
    {
      title: 'SQLite 数据库使用技巧',
      category: '技术教程',
      tags: 'SQLite,数据库,后端',
      content: `# SQLite 数据库使用技巧\n\nSQLite 是一个轻量级的嵌入式数据库，非常适合中小型项目。\n\n## 核心特性\n\n- **零配置**：无需安装数据库服务\n- **单文件**：所有数据存在一个文件中\n- **事务支持**：完整的 ACID 特性\n\n## 常用 SQL 语句\n\n\`\`\`sql\nCREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO users (name) VALUES ('Alice');\nSELECT * FROM users WHERE name = 'Alice';\n\`\`\`\n\n使用 better-sqlite3 可以同步调用，代码更简洁。\n\n> 适合学习数据库基础，再进阶到 PostgreSQL 或 MySQL。`
    }
  ];

  for (const s of samples) {
    db.prepare(
      "INSERT INTO articles (author_id, title, content, category, tags) VALUES (?, ?, ?, ?, ?)"
    ).run(adminId, s.title, s.content, s.category, s.tags);
  }
  console.log('示例文章创建完成（3篇中文）');
}

module.exports = db;
