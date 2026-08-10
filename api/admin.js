const express = require('express');
const db = require('../db/init');
const { json, requireAdmin } = require('./middleware');

const router = express.Router();
const LIMIT = 20;

// Admin article list (including takedowns)
router.get('/articles', requireAdmin, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const offset = (page - 1) * LIMIT;

  const total = db.prepare('SELECT COUNT(*) as c FROM articles').get().c;
  const rows = db.prepare(
    "SELECT a.id, a.title, a.status, a.created_at, u.nickname " +
    "FROM articles a JOIN users u ON a.author_id = u.id " +
    "ORDER BY a.created_at DESC LIMIT ? OFFSET ?"
  ).all(LIMIT, offset);

  const articles = rows.map(r => ({
    id: r.id,
    title: r.title,
    status: r.status,
    author: { nickname: r.nickname },
    createdAt: r.created_at
  }));

  json(res, 200, {
    articles,
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / LIMIT))
  });
});

// Take down article
router.post('/articles/:id/takedown', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const article = db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
  if (!article) return json(res, 404, null, '文章不存在');
  db.prepare("UPDATE articles SET status = 'takedown' WHERE id = ?").run(id);
  json(res, 200, { success: true });
});

// 恢复文章
router.post('/articles/:id/restore', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const article = db.prepare('SELECT id FROM articles WHERE id = ?').get(id);
  if (!article) return json(res, 404, null, '文章不存在');
  db.prepare("UPDATE articles SET status = 'published' WHERE id = ?").run(id);
  json(res, 200, { success: true });
});

module.exports = router;
