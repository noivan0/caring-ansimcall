/**
 * src/sockets/alertSocket.js — 실시간 알림/위치 Socket.IO 핸들러
 *
 * 보호자 앱이 노인의 실시간 위치 및 건강 이벤트를 구독하는 채널.
 *
 * 이벤트:
 *   클라이언트 → 서버:
 *     guardian:subscribe   { elderId }   — 노인 구독 시작
 *     guardian:unsubscribe { elderId }   — 구독 해제
 *
 *   서버 → 클라이언트 (라우터에서 io.to().emit() 직접 발행):
 *     location:update   { elderId, latitude, longitude, isInSafeZone, ts }
 *     sos:triggered     { elderId, eventId, location }
 *     sos:resolved      { eventId, resolvedBy }
 *     health:alert      { elderId, alerts, vital }
 *     safe_zone:exit    { elderId, zoneName, location }
 *
 * 방(room) 이름 규칙:
 *   guardian:<elderId>   — 해당 노인에 대해 구독 중인 보호자 집합
 */

'use strict';

const jwt = require('jsonwebtoken');
const db  = require('../models/db');

/**
 * @param {import('socket.io').Server} io
 */
module.exports = function alertSocket(io) {
  // alertSocket 은 별도 네임스페이스 없이 기본 '/'를 chatSocket과 공유.
  // io.use 인증은 chatSocket에서 이미 등록됨 — 재등록 불필요.
  // 이 모듈은 이벤트 핸들러만 추가한다.

  io.on('connection', (socket) => {
    // ── 노인 구독 ────────────────────────────────────────────
    socket.on('guardian:subscribe', async ({ elderId }) => {
      if (!elderId) return;

      // 보호자-노인 관계 확인
      const rel = await db.query(
        `SELECT 1 FROM guardian_relationships
         WHERE guardian_user_id = $1 AND elder_id = $2 AND consent_status = 'accepted'`,
        [socket.userId, elderId]
      ).catch(() => null);

      if (!rel?.rows.length) {
        socket.emit('error', { code: 'NO_RELATIONSHIP' });
        return;
      }

      socket.join(`guardian:${elderId}`);
      socket.emit('guardian:subscribed', { elderId });
    });

    // ── 구독 해제 ────────────────────────────────────────────
    socket.on('guardian:unsubscribe', ({ elderId }) => {
      if (!elderId) return;
      socket.leave(`guardian:${elderId}`);
    });
  });
};
