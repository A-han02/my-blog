const express = require('express');
const db = require('../db/init');
const { render } = require('../utils/markdown');
const { json, getCurrentUser } = require('./middleware');

const router = express.Router();
const LIMIT = 10;

router.get('/', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) {
      return json(res, 400, null, '请输入搜索关键词');
    }

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const offset = (page - 1) * LIMIT;
    const pattern = '%' + q + '%';

    // 搜索文章（标题 / 内容）
    const totalRow = db.prepare(
      "SELECT COUNT(*) as c FROM articles " +
      "WHERE (title LIKE ? OR content LIKE ?) AND status = 'published' AND visibility = 'public'"
    ).get(pattern, pattern);
    const totalArticles = totalRow.c;

    const articleRows = db.prepare(
      "SELECT a.id, a.title, a.category, a.content, a.created_at, u.id as uid, u.nickname, u.avatar, " +
      "(SELECT COUNT(*) FROM likes WHERE article_id = a.id) as like_count, " +
      "(SELECT COUNT(*) FROM comments WHERE article_id = a.id) as comment_count, " +
      "(SELECT COUNT(*) FROM views WHERE article_id = a.id) as view_count " +
      "FROM articles a JOIN users u ON a.author_id = u.id " +
      "WHERE (a.title LIKE ? OR a.content LIKE ?) AND a.status = 'published' AND a.visibility = 'public' " +
      "ORDER BY a.created_at DESC LIMIT ? OFFSET ?"
    ).all(pattern, pattern, LIMIT, offset);

    // 搜索用户（昵称）
    const userRows = db.prepare(
      "SELECT id, nickname, avatar, created_at FROM users WHERE nickname LIKE ? LIMIT 20"
    ).all(pattern);

    const highlight = (text, keyword) => {
      if (!keyword || !text) return text || '';
      const re = new RegExp('(' + keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      return text.replace(re, '<mark class="bg-amber-200 px-1 rounded">$1</mark>');
    };

    const articles = articleRows.map(r => ({
      id: r.id,
      title: highlight(r.title, q),
      category: r.category || '其他',
      excerpt: highlight(r.content ? r.content.substring(0, 200) : '', q),
      createdAt: r.created_at,
      likeCount: parseInt(r.like_count || '0', 10),
      commentCount: parseInt(r.comment_count || '0', 10),
      viewCount: parseInt(r.view_count || '0', 10),
      author: { nickname: r.nickname, avatar: r.avatar || null }
    }));

    const users = userRows.map(u => ({
      id: u.id,
      nickname: highlight(u.nickname, q),
      avatar: u.avatar || null
    }));

    json(res, 200, {
      keyword: q,
      articles,
      users,
      total: totalArticles,
      totalUsers: userRows.length,
      page,
      totalPages: Math.max(1, Math.ceil(totalArticles / LIMIT))
    });
  } catch (err) {
    console.error('[Search Error]', err);
    json(res, 500, null, '搜索服务暂时不可用，请稍后重试');
  }
});

module.exports = router;
