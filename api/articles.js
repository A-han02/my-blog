const express = require('express');
const db = require('../db/init');
const { json, requireLogin, requireAuthor, getCurrentUser } = require('./middleware');
const { render, excerpt: genExcerpt } = require('../utils/markdown');

const router = express.Router();
const LIMIT = 10;

// 分类标签
const CATEGORIES = ['新手指南', '技术教程', '生活随笔', '工具推荐', '学习笔记', '其他'];

// 分类标签列表
router.get('/categories', (req, res) => {
  json(res, 200, { categories: CATEGORIES });
});

// 公开文章列表（仅 published，公开可见）
router.get('/', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const offset = (page - 1) * LIMIT;
  const category = req.query.category || '';

  // 仅 published + visibility = public
  let whereClause = "WHERE a.status = 'published' AND a.visibility = 'public'";
  const params = [];
  if (category) {
    whereClause += ' AND a.category = ?';
    params.push(category);
  }

  const totalRow = db.prepare(
    "SELECT COUNT(*) as c FROM articles a JOIN users u ON a.author_id = u.id " + whereClause
  ).get(...params);
  const total = totalRow.c;

  const rows = db.prepare(
    "SELECT a.id, a.title, a.category, a.content, a.created_at, a.visibility, u.id as uid, u.nickname, u.avatar, " +
    "(SELECT COUNT(*) FROM likes WHERE article_id = a.id) as like_count, " +
    "(SELECT COUNT(*) FROM comments WHERE article_id = a.id) as comment_count, " +
    "(SELECT COUNT(*) FROM views WHERE article_id = a.id) as view_count " +
    "FROM articles a JOIN users u ON a.author_id = u.id " +
    whereClause +
    " ORDER BY a.created_at DESC LIMIT ? OFFSET ?"
  ).all(...params, LIMIT, offset);

  const articles = rows.map(r => ({
    id: r.id,
    title: r.title,
    category: r.category,
    excerpt: genExcerpt(r.content),
    createdAt: r.created_at,
    visibility: r.visibility,
    likeCount: parseInt(r.like_count || '0', 10),
    commentCount: parseInt(r.comment_count || '0', 10),
    viewCount: parseInt(r.view_count || '0', 10),
    author: { id: r.uid, nickname: r.nickname, avatar: r.avatar || null }
  }));

  json(res, 200, {
    articles,
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / LIMIT))
  });
});

// 文章详情（权限校验）
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return json(res, 400, null, '无效文章 ID');

  const article = db.prepare(
    "SELECT a.*, u.nickname, u.bio, u.avatar, u.role " +
    "FROM articles a JOIN users u ON a.author_id = u.id " +
    "WHERE a.id = ?"
  ).get(id);

  if (!article) return json(res, 404, null, '文章不存在');

  // 草稿：仅作者或管理员可见
  if (article.status === 'draft') {
    const user = getCurrentUser(req);
    if (!user || user.id !== article.author_id || user.role !== 'admin') {
      return json(res, 404, null, '文章不存在');
    }
  }

  // 已下架：仅作者或管理员可见
  if (article.status === 'takedown') {
    const user = getCurrentUser(req);
    if (!user || user.id !== article.author_id || user.role !== 'admin') {
      return json(res, 404, null, '文章不存在');
    }
  }

  // visibility = private：仅作者可见
  if (article.visibility === 'private') {
    const user = getCurrentUser(req);
    if (!user || user.id !== article.author_id || user.role !== 'admin') {
      return json(res, 403, null, '文章为私密，仅作者可见');
    }
  }

  // visibility = friends：仅好友可见
  if (article.visibility === 'friends') {
    const user = getCurrentUser(req);
    if (!user) return json(res, 403, null, '请先登录');
    if (user.id !== article.author_id && user.role !== 'admin') {
      const isFriend = db.prepare(
        "SELECT id FROM friends WHERE (user1_id = ? AND user2_id = ?) OR (user2_id = ? AND user1_id = ?)"
      ).get(user.id, article.author_id, user.id, article.author_id);
      if (!isFriend) return json(res, 403, null, '文章仅限好友观看');
    }
  }

  const authorCount = db.prepare(
    'SELECT COUNT(*) as c FROM articles WHERE author_id = ? AND status = ? AND visibility = ?'
  ).get(article.author_id, 'published', 'public').c;

  // 记录浏览量（每个用户每篇文章只记一次，防止重复刷新刷量）
  const viewerId = getCurrentUser(req)?.id || null;
  const existingView = db.prepare(
    'SELECT id FROM views WHERE article_id = ? AND user_id = ?'
  ).get(id, viewerId);
  if (!existingView) {
    db.prepare('INSERT INTO views (article_id, user_id) VALUES (?, ?)').run(id, viewerId);
  }

  json(res, 200, {
    article: {
      id: article.id,
      title: article.title,
      category: article.category,
      tags: article.tags,
      content: article.content,
      contentHtml: render(article.content),
      visibility: article.visibility,
      publishAt: article.publish_at,
      createdAt: article.created_at,
      updatedAt: article.updated_at,
      author: {
        id: article.author_id,
        nickname: article.nickname,
        bio: article.bio,
        avatar: article.avatar || null,
        articleCount: authorCount
      }
    }
  });
});

// 发布文章（含分类、标签、状态、可见性、定时发布）
router.post('/', requireLogin, (req, res) => {
  const { title, content, category, tags, status, visibility, publishAt } = req.body;
  if (!title || !content) return json(res, 400, null, '标题和内容不能为空');
  const cat = (category && category !== '其他') ? category : '其他';
  const tagStr = tags ? tags.join(',') : '';
  const st = (status === 'draft') ? 'draft' : 'published';
  const vis = (visibility === 'private' || visibility === 'friends') ? visibility : 'public';
  const pubAt = publishAt ? new Date(publishAt).toISOString() : new Date().toISOString();

  const id = db.prepare(
    "INSERT INTO articles (author_id, title, content, category, tags, status, visibility, publish_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(req.user.id, title.trim(), content.trim(), cat, tagStr, st, vis, pubAt).lastInsertRowid;

  const article = db.prepare('SELECT id, title, created_at, status, visibility, publish_at FROM articles WHERE id = ?').get(id);
  json(res, 201, { article: { id, title: article.title, createdAt: article.created_at, status: article.status, visibility: article.visibility, publishAt: article.publish_at } });
});

// 编辑文章
router.put('/:id', requireLogin, requireAuthor, (req, res) => {
  const { title, content, category, tags, status, visibility, publishAt } = req.body;
  if (!title || !content) return json(res, 400, null, '标题和内容不能为空');
  const id = parseInt(req.params.id, 10);
  const cat = (category && category !== '其他') ? category : '其他';
  const tagStr = tags ? tags.join(',') : '';
  const vis = (visibility === 'private' || visibility === 'friends') ? visibility : 'public';
  const pubAt = publishAt ? new Date(publishAt).toISOString() : new Date().toISOString();
  db.prepare(
    "UPDATE articles SET title = ?, content = ?, category = ?, tags = ?, status = ?, visibility = ?, publish_at = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title.trim(), content.trim(), cat, tagStr, status || 'published', vis, pubAt, id);
  json(res, 200, { success: true });
});

// 删除文章
router.delete('/:id', requireLogin, requireAuthor, (req, res) => {
  const id = parseInt(req.params.id, 10);
  // 先清理关联数据，避免外键约束失败
  db.prepare('DELETE FROM likes WHERE article_id = ?').run(id);
  db.prepare('DELETE FROM comments WHERE article_id = ?').run(id);
  db.prepare('DELETE FROM shares WHERE article_id = ?').run(id);
  db.prepare('DELETE FROM delete_logs WHERE article_id = ?').run(id);
  db.prepare('DELETE FROM articles WHERE id = ?').run(id);
  json(res, 200, { success: true });
});

module.exports = router;
