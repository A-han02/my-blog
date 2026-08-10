const express = require('express');
const db = require('../db/init');
const { json, requireLogin, getCurrentUser } = require('./middleware');

const router = express.Router();

// ========== 关注/取关 ==========
// POST /follow/:userId - 登录后可切换关注状态
router.post('/follow/:userId', requireLogin, (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!targetId) return json(res, 400, null, '无效用户 ID');

  if (targetId === req.user.id) {
    return json(res, 400, null, '不能关注自己');
  }

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return json(res, 404, null, '用户不存在');

  // 已关注则取关
  const existing = db.prepare(
    'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?'
  ).get(req.user.id, targetId);

  if (existing) {
    db.prepare('DELETE FROM follows WHERE id = ?').run(existing.id);
    // 取关后若不再是互关，则删除好友关系
    const reverse = db.prepare(
      'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?'
    ).get(targetId, req.user.id);
    if (!reverse) {
      deleteFriend(req.user.id, targetId);
    }
    return json(res, 200, { success: true, isFollowing: false });
  }

  // 未关注则关注
  try {
    db.prepare(
      'INSERT INTO follows (follower_id, following_id) VALUES (?, ?)'
    ).run(req.user.id, targetId);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return json(res, 409, null, '您已经关注了该用户');
    }
    return json(res, 500, null, '操作失败，请稍后重试');
  }

  // 检查是否互关，互关则创建好友关系
  const reverse = db.prepare(
    'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?'
  ).get(targetId, req.user.id);
  if (reverse) {
    ensureFriend(req.user.id, targetId);
  }

  return json(res, 201, { success: true, isFollowing: true });
});

// GET /follow/:userId - 检查是否已关注某用户（支持未登录）
router.get('/follow/:userId', (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!targetId) return json(res, 400, null, '无效用户 ID');

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return json(res, 404, null, '用户不存在');

  const user = getCurrentUser(req);
  let isFollowing = false;
  if (user) {
    const row = db.prepare(
      'SELECT id FROM follows WHERE follower_id = ? AND following_id = ?'
    ).get(user.id, targetId);
    isFollowing = !!row;
  }

  json(res, 200, { isFollowing });
});

// ========== 关注列表 ==========
// GET /follows - 获取当前用户关注的人列表和粉丝列表
router.get('/follows', requireLogin, (req, res) => {
  const followingRows = db.prepare(
    'SELECT u.id, u.username, u.nickname, u.avatar FROM follows f ' +
    'JOIN users u ON f.following_id = u.id ' +
    'WHERE f.follower_id = ? ORDER BY f.created_at DESC'
  ).all(req.user.id);

  const followersRows = db.prepare(
    'SELECT u.id, u.username, u.nickname, u.avatar FROM follows f ' +
    'JOIN users u ON f.follower_id = u.id ' +
    'WHERE f.following_id = ? ORDER BY f.created_at DESC'
  ).all(req.user.id);

  json(res, 200, {
    following: formatUserList(followingRows),
    followers: formatUserList(followersRows)
  });
});

// ========== 好友列表 ==========
// GET /friends - 获取当前用户好友列表
router.get('/friends', requireLogin, (req, res) => {
  const rows = db.prepare(
    'SELECT u.id, u.username, u.nickname, u.avatar FROM friends f ' +
    'JOIN users u ON (f.user1_id = ? AND f.user2_id = u.id) ' +
    '   OR (f.user2_id = ? AND f.user1_id = u.id) ' +
    'ORDER BY f.created_at DESC'
  ).all(req.user.id, req.user.id);

  json(res, 200, { friends: formatUserList(rows) });
});

// ========== 发送消息 ==========
// POST /messages - 发送私信（需好友关系）
router.post('/messages', requireLogin, (req, res) => {
  const { receiverId, content } = req.body;
  const targetId = parseInt(receiverId, 10);
  if (!targetId) return json(res, 400, null, '收信人 ID 无效');
  if (!content || !content.trim()) return json(res, 400, null, '消息内容不能为空');

  if (targetId === req.user.id) {
    return json(res, 400, null, '不能给自己发送消息');
  }

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return json(res, 404, null, '用户不存在');

  const isFriend = db.prepare(
    'SELECT id FROM friends WHERE (user1_id = ? AND user2_id = ?) ' +
    'OR (user2_id = ? AND user1_id = ?)'
  ).get(req.user.id, targetId, req.user.id, targetId);
  if (!isFriend) return json(res, 403, null, '只能给好友发送消息');

  const messageId = db.prepare(
    'INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)'
  ).run(req.user.id, targetId, content.trim()).lastInsertRowid;

  const msg = db.prepare(
    'SELECT m.*, s.nickname as senderNickname, s.avatar as senderAvatar ' +
    'FROM messages m JOIN users s ON m.sender_id = s.id ' +
    'WHERE m.id = ?'
  ).get(messageId);

  json(res, 201, {
    success: true,
    message: {
      id: msg.id,
      sender: { nickname: msg.senderNickname, avatar: msg.senderAvatar || null },
      content: msg.content,
      createdAt: msg.created_at,
      readAt: msg.read_at || null
    }
  });
});

// ========== 获取消息列表 ==========
// GET /messages - 获取消息列表（带 withUserId 则查看单对话，否则返回所有对话摘要）
router.get('/messages', requireLogin, (req, res) => {
  const withUserId = parseInt(req.query.withUserId, 10);

  if (withUserId) {
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(withUserId);
    if (!target) return json(res, 404, null, '用户不存在');
    return getConversation(req, res, withUserId);
  }

  // 所有对话的最新一条消息摘要
  const summarySql =
    'SELECT m.id, m.sender_id, m.receiver_id, m.content, m.read_at, m.created_at ' +
    'FROM messages m ' +
    'JOIN (' +
    '  SELECT MAX(id) as max_id ' +
    '  FROM messages ' +
    '  WHERE sender_id = ? OR receiver_id = ? ' +
    '  GROUP BY CASE ' +
    '    WHEN sender_id = ? THEN receiver_id ' +
    '    ELSE sender_id ' +
    '  END' +
    ') latest ON m.id = latest.max_id ' +
    'ORDER BY m.created_at DESC';

  const rows = db.prepare(summarySql).all(req.user.id, req.user.id, req.user.id);

  const messages = rows.map(r => {
    const senderId = r.sender_id;
    const sender = db.prepare('SELECT nickname, avatar FROM users WHERE id = ?').get(senderId);
    const receiverId = r.receiver_id;
    const receiver = db.prepare('SELECT nickname, avatar FROM users WHERE id = ?').get(receiverId);
    return {
      id: r.id,
      senderId,
      senderNickname: sender ? sender.nickname : '',
      senderAvatar: sender ? (sender.avatar || null) : null,
      receiverId,
      receiverNickname: receiver ? receiver.nickname : '',
      receiverAvatar: receiver ? (receiver.avatar || null) : null,
      content: r.content,
      createdAt: r.created_at,
      readAt: r.read_at || null
    };
  });

  json(res, 200, { messages });
});

// ========== 特定对话详情 ==========
// GET /messages/:userId - 获取与指定用户的全部消息
router.get('/messages/:userId', requireLogin, (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!targetId) return json(res, 400, null, '无效用户 ID');

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return json(res, 404, null, '用户不存在');

  getConversation(req, res, targetId);
});

// ========== 标记已读 ==========
// POST /messages/read/:userId - 将来自某用户的全部消息标记为已读
router.post('/messages/read/:userId', requireLogin, (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (!targetId) return json(res, 400, null, '无效用户 ID');

  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!target) return json(res, 404, null, '用户不存在');

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE messages SET read_at = ? WHERE sender_id = ? AND receiver_id = ?"
  ).run(now, targetId, req.user.id);

  json(res, 200, { success: true });
});

// ========== 未读消息数 ==========
// GET /messages/unread-count - 获取当前用户未读消息数
router.get('/messages/unread-count', requireLogin, (req, res) => {
  const row = db.prepare(
    "SELECT COUNT(*) as c FROM messages WHERE receiver_id = ? AND (read_at IS NULL OR read_at = '')"
  ).get(req.user.id);

  json(res, 200, { unreadCount: row.c });
});

// ========== 内部辅助函数 ==========

function formatUserList(rows) {
  return rows.map(r => ({
    id: r.id,
    username: r.username,
    nickname: r.nickname,
    avatar: r.avatar || null
  }));
}

function getConversation(req, res, targetId) {
  const rows = db.prepare(
    'SELECT m.id, m.sender_id, m.receiver_id, m.content, m.read_at, m.created_at ' +
    'FROM messages m ' +
    'WHERE (m.sender_id = ? AND m.receiver_id = ?) ' +
    '   OR (m.sender_id = ? AND m.receiver_id = ?) ' +
    'ORDER BY m.created_at ASC'
  ).all(req.user.id, targetId, targetId, req.user.id);

  const messages = rows.map(r => {
    const sender = db.prepare('SELECT nickname, avatar FROM users WHERE id = ?').get(r.sender_id);
    const receiver = db.prepare('SELECT nickname, avatar FROM users WHERE id = ?').get(r.receiver_id);
    return {
      id: r.id,
      senderId: r.sender_id,
      senderNickname: sender ? sender.nickname : '',
      senderAvatar: sender ? (sender.avatar || null) : null,
      receiverId: r.receiver_id,
      receiverNickname: receiver ? receiver.nickname : '',
      receiverAvatar: receiver ? (receiver.avatar || null) : null,
      content: r.content,
      createdAt: r.created_at,
      readAt: r.read_at || null
    };
  });

  json(res, 200, { messages });
}

// 确保好友关系存在
function ensureFriend(id1, id2) {
  try {
    db.prepare(
      'INSERT INTO friends (user1_id, user2_id) VALUES (?, ?)'
    ).run(Math.min(id1, id2), Math.max(id1, id2));
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      // 好友关系已存在，忽略
    } else {
      throw err;
    }
  }
}

// 删除好友关系
function deleteFriend(id1, id2) {
  db.prepare(
    'DELETE FROM friends WHERE (user1_id = ? AND user2_id = ?) ' +
    'OR (user2_id = ? AND user1_id = ?)'
  ).run(id1, id2, id1, id2);
}

module.exports = router;
