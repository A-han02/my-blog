const express = require('express');
const db = require('../db/init');
const { json, requireLogin, requireAuthor, getCurrentUser } = require('./middleware');

const router = express.Router();
const LIMIT = 20;

// 获取文章点赞数
router.get('/likes/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return json(res, 400, null, '无效文章 ID');

  // 使用 likes 表统计，不依赖 articles.like_count
  const countRow = db.prepare('SELECT COUNT(*) as c FROM likes WHERE article_id = ?').get(id);
  const count = countRow.c;

  // 检查当前用户是否已点赞
  const user = getCurrentUser(req);
  let liked = false;
  if (user) {
    const row = db.prepare('SELECT id FROM likes WHERE article_id = ? AND user_id = ?').get(id, user.id);
    liked = !!row;
  }

  json(res, 200, { count, liked });
});

// 点赞/取消点赞（需登录）
router.post('/likes/:id', requireLogin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return json(res, 400, null, '无效文章 ID');

  const article = db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
  if (!article) return json(res, 404, null, '文章不存在');

  const existing = db.prepare('SELECT id FROM likes WHERE article_id = ? AND user_id = ?').get(id, req.user.id);
  if (existing) {
    // 取消点赞
    db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
    json(res, 200, { action: 'unlike', liked: false });
  } else {
    // 点赞
    db.prepare('INSERT INTO likes (user_id, article_id) VALUES (?, ?)').run(req.user.id, id);
    json(res, 201, { action: 'like', liked: true });
  }
});

// 获取文章评论列表
router.get('/comments/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return json(res, 400, null, '无效文章 ID');

  const article = db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
  if (!article) return json(res, 404, null, '文章不存在');

  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const offset = (page - 1) * LIMIT;

  const totalRow = db.prepare('SELECT COUNT(*) as c FROM comments WHERE article_id = ?').get(id);
  const total = totalRow.c;

  const rows = db.prepare(
    'SELECT c.*, u.nickname, u.avatar FROM comments c ' +
    'JOIN users u ON c.user_id = u.id ' +
    'WHERE c.article_id = ? ORDER BY c.created_at ASC LIMIT ? OFFSET ?'
  ).all(id, LIMIT, offset);

  const comments = rows.map(r => ({
    id: r.id,
    content: r.content,
    author: { id: r.user_id, nickname: r.nickname, avatar: r.avatar || null },
    createdAt: r.created_at,
    parentId: r.parent_id
  }));

  json(res, 200, { comments, total, page, totalPages: Math.max(1, Math.ceil(total / LIMIT)) });
});

// 发表评论（需登录）
router.post('/comments/:id', requireLogin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return json(res, 400, null, '无效文章 ID');

  const { content, parentId } = req.body;
  if (!content || !content.trim()) return json(res, 400, null, '评论内容不能为空');

  const article = db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
  if (!article) return json(res, 404, null, '文章不存在');

  const pid = parentId ? parseInt(parentId, 10) : null;
  if (pid) {
    const parent = db.prepare('SELECT id FROM comments WHERE id = ? AND article_id = ?').get(pid, id);
    if (!parent) return json(res, 400, null, '父评论不存在');
  }

  const commentId = db.prepare(
    'INSERT INTO comments (user_id, article_id, content, parent_id) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, id, content.trim(), pid).lastInsertRowid;

  const comment = db.prepare(
    'SELECT c.*, u.nickname, u.avatar FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?'
  ).get(commentId);

  json(res, 201, {
    comment: {
      id: comment.id,
      content: comment.content,
      author: { nickname: comment.nickname, avatar: comment.avatar || null },
      createdAt: comment.created_at,
      parentId: comment.parent_id || 0
    }
  });
});

// 删除评论（评论发布者、文章作者、管理员可删）
router.delete('/comments/:id', requireLogin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const comment = db.prepare('SELECT user_id, article_id FROM comments WHERE id = ?').get(id);
  if (!comment) return json(res, 404, null, '评论不存在');

  const article = db.prepare('SELECT author_id FROM articles WHERE id = ?').get(comment.article_id);
  const isArticleAuthor = article && article.author_id === req.user.id;
  const isCommentAuthor = comment.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';

  if (!isCommentAuthor && !isArticleAuthor && !isAdmin) {
    return json(res, 403, null, '无权删除该评论');
  }
  // 先删除子评论，再删除当前评论，避免 parent_id 外键约束失败
  db.prepare('DELETE FROM comments WHERE parent_id = ?').run(id);
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  json(res, 200, { success: true });
});

// 获取文章转发数
router.get('/shares/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return json(res, 400, null, '无效文章 ID');

  const countRow = db.prepare('SELECT COUNT(*) as c FROM shares WHERE article_id = ?').get(id);
  const count = countRow.c;

  const user = getCurrentUser(req);
  let shared = false;
  if (user) {
    const row = db.prepare('SELECT id FROM shares WHERE article_id = ? AND user_id = ?').get(id, user.id);
    shared = !!row;
  }

  json(res, 200, { count, shared });
});

// 转发文章（需登录）
router.post('/shares/:id', requireLogin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return json(res, 400, null, '无效文章 ID');

  const article = db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
  if (!article) return json(res, 404, null, '文章不存在');

  const { note } = req.body;

  const existing = db.prepare('SELECT id FROM shares WHERE article_id = ? AND user_id = ?').get(id, req.user.id);
  if (existing) {
    return json(res, 409, null, '您已经转发过这篇文章');
  }

  db.prepare('INSERT INTO shares (user_id, article_id, note) VALUES (?, ?, ?)').run(req.user.id, id, note || '');
  json(res, 201, { success: true, action: 'share' });
});

module.exports = router;
