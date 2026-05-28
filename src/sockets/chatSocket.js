/**
 * src/sockets/chatSocket.js — 실시간 채팅 Socket.IO 핸들러
 *
 * 이벤트:
 *   클라이언트 → 서버:
 *     chat:join   { roomId }             — 채팅방 입장
 *     chat:leave  { roomId }             — 채팅방 퇴장
 *     chat:message { roomId, content, type }  — 메시지 전송
 *     chat:typing { roomId }             — 타이핑 중 표시
 *     chat:read   { roomId, messageId }  — 읽음 처리
 *
 *   서버 → 클라이언트:
 *     chat:message  { id, senderId, content, type, sentAt }
 *     chat:typing   { userId, roomId }
 *     chat:read     { userId, roomId, messageId }
 *
 * 인증: 핸드셰이크 auth.token (Access JWT)
 */

'use strict';

const jwt = require('jsonwebtoken');
const db  = require('../models/db');

/**
 * @param {import('socket.io').Server} io
 */
module.exports = function chatSocket(io) {
  // 인증 미들웨어 (Socket.IO 전용)
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('MISSING_TOKEN'));

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || process.env.SECRET_KEY, { issuer: 'senior-care' });
      if (payload.type !== 'access') return next(new Error('INVALID_TOKEN_TYPE'));
      socket.userId = payload.sub;
      socket.tokenExp = payload.exp; // [SC 2.2.1] 만료 시각 저장
      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`[채팅] 연결: userId=${socket.userId}`);

    // [SC 2.2.1 WCAG] 세션 만료 경고 — T-60초에 'session:expiring' 이벤트 발행
    // 노인 사용자: 60초 경고창 + "10분 연장" 버튼 표시 (클라이언트 처리)
    if (socket.tokenExp) {
      const secsLeft = Math.max(0, socket.tokenExp - Math.floor(Date.now() / 1000));
      const warnAt   = Math.max(0, (secsLeft - 60) * 1000); // 60초 전에 경고
      const expireAt = secsLeft * 1000;

      // 60초 전 경고 이벤트
      const warnTimer = setTimeout(() => {
        socket.emit('session:expiring', {
          message: '세션이 곧 만료됩니다. 연장하시겠습니까?',
          secsLeft: 60,
          extend: true, // 클라이언트: "10분 연장" 버튼 표시
        });
      }, warnAt);

      // 만료 시 강제 disconnection
      const expireTimer = setTimeout(() => {
        socket.emit('session:expired', { message: '세션이 만료되었습니다. 다시 로그인해 주세요.' });
        socket.disconnect(true);
      }, expireAt);

      // 연결 해제 시 타이머 정리
      socket.on('disconnect', () => {
        clearTimeout(warnTimer);
        clearTimeout(expireTimer);
      });
    }


    // ── 채팅방 입장 ──────────────────────────────────────────
    socket.on('chat:join', async ({ roomId }) => {
      if (!roomId) return;

      // 참가자 확인
      const check = await db.query(
        'SELECT 1 FROM chat_participants WHERE room_id=$1 AND user_id=$2',
        [roomId, socket.userId]
      ).catch(() => null);

      if (!check?.rows.length) {
        socket.emit('error', { code: 'NOT_IN_ROOM' });
        return;
      }

      socket.join(`room:${roomId}`);
      socket.emit('chat:joined', { roomId });
    });

    // ── 채팅방 퇴장 ──────────────────────────────────────────
    socket.on('chat:leave', ({ roomId }) => {
      socket.leave(`room:${roomId}`);
    });

    // ── 메시지 전송 ───────────────────────────────────────────
    socket.on('chat:message', async ({ roomId, content, type = 'text', mediaUrl }) => {
      if (!roomId || !content) return;

      try {
        const result = await db.query(
          `INSERT INTO chat_messages (room_id, sender_id, type, content, media_url, sent_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           RETURNING *`,
          [roomId, socket.userId, type, content, mediaUrl || null]
        );

        const msg = result.rows[0];

        // 방 전체에 브로드캐스트
        io.to(`room:${roomId}`).emit('chat:message', {
          id:       msg.id,
          roomId:   msg.room_id,
          senderId: msg.sender_id,
          type:     msg.type,
          content:  msg.content,
          mediaUrl: msg.media_url,
          sentAt:   msg.sent_at,
        });
      } catch (err) {
        console.error('[채팅] 메시지 저장 실패:', err.message);
        socket.emit('error', { code: 'MESSAGE_SAVE_FAILED' });
      }
    });

    // ── 타이핑 중 ────────────────────────────────────────────
    socket.on('chat:typing', ({ roomId }) => {
      if (!roomId) return;
      socket.to(`room:${roomId}`).emit('chat:typing', {
        userId: socket.userId,
        roomId,
      });
    });

    // ── 읽음 처리 ────────────────────────────────────────────
    socket.on('chat:read', async ({ roomId, messageId }) => {
      if (!roomId || !messageId) return;

      await db.query(
        `INSERT INTO chat_read_receipts (room_id, user_id, message_id, read_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (room_id, user_id) DO UPDATE
           SET message_id = $3, read_at = NOW()`,
        [roomId, socket.userId, messageId]
      ).catch(() => null);

      socket.to(`room:${roomId}`).emit('chat:read', {
        userId:    socket.userId,
        roomId,
        messageId,
      });
    });

    // ── 연결 해제 ────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[채팅] 연결 해제: userId=${socket.userId}`);
    });
  });
};
