const db = require('../db/init');

function json(res, code, data, message) {
  res.status(code).json({
    success: code === 200 || code === 201,
    ...data,
    ...(message && { message })
  });
}

function getCurrentUser(req) {
  if (!req.session || !req.session.userId) return null;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  return row || null;
}

function requireLogin(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) return json(res, 401, null, '请先登录');
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = getCurrentUser(req);
  if (!user || user.role !== 'admin') {
    return json(res, 403, null, '仅管理员可操作');
  }
  req.user = user;
  next();
}

function requireAuthor(req, res, next) {
  const id = parseInt(req.params.id, 10);
  if (!id) return json(res, 400, null, '无效文章 ID');
  const article = db.prepare('SELECT author_id FROM articles WHERE id = ?').get(id);
  if (!article) return json(res, 404, null, '文章不存在');
  if (article.author_id !== req.user.id && req.user.role !== 'admin') {
    return json(res, 403, null, '无权操作他人文章');
  }
  next();
}

module.exports = { json, getCurrentUser, requireLogin, requireAdmin, requireAuthor };
