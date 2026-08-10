const express = require('express');
const bcrypt = require('bcryptjs');
const Busboy = require('busboy');
const path = require('path');
const fs = require('fs');
const db = require('../db/init');
const { json, getCurrentUser, requireLogin } = require('./middleware');

const router = express.Router();

// 上传目录
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- 注册 ----
router.post('/register', (req, res) => {
  const { username, password, nickname, bio } = req.body;
  if (!username || !password) return json(res, 400, null, '用户名和密码必填');
  if (username.length < 3 || username.length > 20) return json(res, 400, null, '用户名长度 3-20 字符');
  if (password.length < 6) return json(res, 400, null, '密码至少 6 位');

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return json(res, 409, null, '用户名已存在');

  const hash = bcrypt.hashSync(password, 10);
  const info = nickname || username;
  const id = db.prepare(
    "INSERT INTO users (username, password, nickname, bio) VALUES (?, ?, ?, ?)"
  ).run(username, hash, info, bio || '').lastInsertRowid;

  const user = db.prepare('SELECT id, username, nickname, bio, avatar, role FROM users WHERE id = ?').get(id);
  json(res, 201, { user: { ...user, avatar: user.avatar || null, articleCount: 0 } });
});

// ---- 登录 ----
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return json(res, 400, null, '用户名和密码必填');

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return json(res, 401, null, '用户名或密码错误');
  }

  req.session.userId = user.id;
  const safeUser = {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    bio: user.bio,
    avatar: user.avatar || null,
    role: user.role,
    gender: user.gender || '',
    age: parseInt(user.age || '0', 10),
    location: user.location || '',
    birthday: user.birthday || ''
  };
  const count = db.prepare('SELECT COUNT(*) as c FROM articles WHERE author_id = ? AND status = ?').get(user.id, 'published').c;
  json(res, 200, { user: { ...safeUser, articleCount: count } });
});

// ---- 登出 ----
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    json(res, 200, null, '已登出');
  });
});

// ---- 当前用户信息 ----
router.get('/me', (req, res) => {
  const user = getCurrentUser(req);
  if (!user) return json(res, 401, null, '未登录');
  const count = db.prepare('SELECT COUNT(*) as c FROM articles WHERE author_id = ? AND status = ?').get(user.id, 'published').c;
  json(res, 200, {
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      bio: user.bio,
      avatar: user.avatar || null,
      role: user.role,
      gender: user.gender || '',
      age: parseInt(user.age || '0', 10),
      location: user.location || '',
      birthday: user.birthday || '',
      articleCount: count
    }
  });
});

// ---- 更新个人资料 ----
router.put('/profile', requireLogin, (req, res) => {
  const { nickname, bio, gender, age, location, birthday } = req.body;
  const safeAge = (age !== undefined && age !== null) ? parseInt(age, 10) : 0;
  db.prepare(
    'UPDATE users SET nickname = ?, bio = ?, gender = ?, age = ?, location = ?, birthday = ? WHERE id = ?'
  ).run(
    nickname || '',
    bio || '',
    gender || '',
    safeAge >= 0 ? safeAge : 0,
    location || '',
    birthday || '',
    req.user.id
  );
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  json(res, 200, {
    user: {
      id: updated.id,
      username: updated.username,
      nickname: updated.nickname,
      bio: updated.bio,
      avatar: updated.avatar || null,
      role: updated.role,
      gender: updated.gender || '',
      age: parseInt(updated.age || '0', 10),
      location: updated.location || '',
      birthday: updated.birthday || ''
    }
  });
});

// ---- 上传头像（使用 busboy） ----
router.post('/avatar', requireLogin, (req, res) => {
  const busboy = Busboy({ headers: req.headers });
  const ext = '.png';
  const name = `avatar-${req.session.userId}-${Date.now()}-${Math.floor(Math.random() * 1000)}${ext}`;
  const filePath = path.join(UPLOAD_DIR, name);

  let fileReceived = false;
  busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
    if (!/jpeg|jpg|png|gif|webp/i.test(mimetype)) {
      file.resume();
      return;
    }
    fileReceived = true;
    const writeStream = fs.createWriteStream(filePath);
    file.pipe(writeStream);
    writeStream.on('finish', () => {
      const avatarUrl = `/uploads/avatars/${name}`;
      db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
      json(res, 200, { avatarUrl });
    });
  });

  busboy.on('finish', () => {
    if (!fileReceived) {
      if (!res.headersSent) json(res, 400, null, '未选择文件');
    }
  });

  busboy.on('error', () => {
    if (!res.headersSent) json(res, 400, null, '上传失败');
  });

  req.pipe(busboy);
});

// ---- 当前用户的文章列表（支持筛选） ----
router.get('/my-articles', requireLogin, (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const category = (req.query.category || '').trim();
  const dateFrom = (req.query.dateFrom || '').trim();
  const dateTo = (req.query.dateTo || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = 15;
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE author_id = ?';
  const params = [req.user.id];

  if (keyword) {
    whereClause += ' AND title LIKE ?';
    params.push('%' + keyword + '%');
  }
  if (category) {
    whereClause += ' AND category = ?';
    params.push(category);
  }
  if (dateFrom) {
    whereClause += ' AND created_at >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    whereClause += ' AND created_at <= ?';
    params.push(dateTo + ' 23:59:59');
  }

  const totalRow = db.prepare(
    'SELECT COUNT(*) as c FROM articles ' + whereClause
  ).get(...params);
  const total = totalRow.c;

  const rows = db.prepare(
    'SELECT id, title, category, tags, status, visibility, like_count, comment_count, share_count, created_at, updated_at FROM articles ' +
    whereClause + ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(...params, limit, offset);

  json(res, 200, {
    articles: rows.map(r => ({
      id: r.id,
      title: r.title,
      category: r.category || '其他',
      tags: r.tags || '',
      status: r.status,
      visibility: r.visibility || 'public',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      likeCount: parseInt(r.like_count || '0', 10),
      commentCount: parseInt(r.comment_count || '0', 10),
      shareCount: parseInt(r.share_count || '0', 10)
    })),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit))
  });
});

// ---- 获取用户信息（用于查看他人主页） ----
router.get('/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return json(res, 400, null, '无效用户 ID');

  const user = db.prepare(
    'SELECT id, username, nickname, bio, avatar, role, gender, age, location, birthday FROM users WHERE id = ?'
  ).get(id);

  if (!user) return json(res, 404, null, '用户不存在');

  const count = db.prepare(
    'SELECT COUNT(*) as c FROM articles WHERE author_id = ? AND status = ?'
  ).get(id, 'published').c;

  json(res, 200, {
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      bio: user.bio,
      avatar: user.avatar || null,
      role: user.role,
      gender: user.gender || '',
      age: parseInt(user.age || '0', 10),
      location: user.location || '',
      birthday: user.birthday || '',
      articleCount: count
    }
  });
});

// ---- 用户主页：返回用户信息和已发布文章（搜索入口使用） ----
router.get('/user/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return json(res, 400, null, '无效用户 ID');

  const user = db.prepare(
    'SELECT id, nickname, bio, avatar, created_at FROM users WHERE id = ?'
  ).get(id);

  if (!user) return json(res, 404, { user: null });

  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit = 10;
  const offset = (page - 1) * limit;

  const totalRow = db.prepare(
    "SELECT COUNT(*) as c FROM articles WHERE author_id = ? AND status = ? AND visibility = 'public'"
  ).get(id, 'published');
  const total = totalRow.c;

  const rows = db.prepare(
    "SELECT a.id, a.title, a.category, a.content, a.created_at, " +
    "(SELECT COUNT(*) FROM likes WHERE article_id = a.id) as like_count, " +
    "(SELECT COUNT(*) FROM comments WHERE article_id = a.id) as comment_count, " +
    "(SELECT COUNT(*) FROM views WHERE article_id = a.id) as view_count " +
    "FROM articles a " +
    "WHERE a.author_id = ? AND a.status = ? AND a.visibility = 'public' " +
    "ORDER BY a.created_at DESC LIMIT ? OFFSET ?"
  ).all(id, 'published', limit, offset);

  const articles = rows.map(r => ({
    id: r.id,
    title: r.title,
    category: r.category || '其他',
    excerpt: r.content ? r.content.replace(/[#*`\n\r]/g, '').substring(0, 150) : '',
    createdAt: r.created_at,
    likeCount: parseInt(r.like_count || '0', 10),
    commentCount: parseInt(r.comment_count || '0', 10),
    viewCount: parseInt(r.view_count || '0', 10)
  }));

  // 关注/粉丝数
  const followingCount = db.prepare(
    'SELECT COUNT(*) as c FROM follows WHERE follower_id = ?'
  ).get(id).c;
  const followersCount = db.prepare(
    'SELECT COUNT(*) as c FROM follows WHERE following_id = ?'
  ).get(id).c;

  // 当前登录用户是否已关注该用户
  const viewer = getCurrentUser(req);
  let isFollowing = false;
  let sameUser = false;
  if (viewer) {
    sameUser = viewer.id === id;
    if (!sameUser) {
      const row = db.prepare(
        'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?'
      ).get(viewer.id, id);
      isFollowing = !!row;
    }
  }

  json(res, 200, {
    user: {
      id: user.id,
      nickname: user.nickname,
      bio: user.bio || '',
      avatar: user.avatar || null,
      createdAt: user.created_at,
      followingCount: parseInt(followingCount, 10),
      followersCount: parseInt(followersCount, 10)
    },
    articles,
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    isFollowing,
    sameUser
  });
});

// ---- 批量删除文章（仅作者可删） ----
router.post('/batch-delete', requireLogin, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return json(res, 400, null, '请选择要删除的文章');
  }

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    'SELECT id, author_id FROM articles WHERE id IN (' + placeholders + ')'
  ).all(...ids);

  // 权限校验：仅删除属于当前用户或管理员操作
  const deletable = rows.filter(r => r.author_id === req.user.id || req.user.role === 'admin');
  if (deletable.length === 0) {
    return json(res, 403, null, '无权删除所选文章');
  }

  const deletedIds = deletable.map(r => r.id);
  const deletedPlaceholders = deletedIds.map(() => '?').join(',');

  // 记录删除日志
  for (const r of deletable) {
    db.prepare(
      'INSERT INTO delete_logs (article_id, author_id, operator_id) VALUES (?, ?, ?)'
    ).run(r.id, r.author_id, req.user.id);
  }

  // 先清理所有外键引用，避免 foreign_keys=ON 导致 DELETE 失败
  db.prepare('DELETE FROM likes WHERE article_id IN (' + deletedPlaceholders + ')').run(...deletedIds);
  db.prepare('DELETE FROM comments WHERE article_id IN (' + deletedPlaceholders + ')').run(...deletedIds);
  db.prepare('DELETE FROM shares WHERE article_id IN (' + deletedPlaceholders + ')').run(...deletedIds);
  db.prepare('DELETE FROM delete_logs WHERE article_id IN (' + deletedPlaceholders + ')').run(...deletedIds);

  // 执行删除
  db.prepare('DELETE FROM articles WHERE id IN (' + deletedPlaceholders + ')').run(...deletedIds);

  json(res, 200, { success: true, deletedCount: deletedIds.length, message: `成功删除 ${deletedIds.length} 篇文章` });
});

module.exports = router;
