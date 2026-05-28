/**
 * src/middleware/relationship.js — 보호자-노인 관계 검증 미들웨어
 *
 * checkRelationship:
 *   - 노인 본인이거나,
 *   - 승인된 보호자이거나,
 *   - 관리자인 경우에만 next()
 *
 * 라우트 핸들러에서 직접 callback 호출:
 *   await checkRelationship(req, res, async () => { ... })
 */

'use strict';

const db = require('../models/db');

/**
 * 요청자가 해당 노인(elderId)에 대해 접근 권한이 있는지 확인.
 *
 * @param {object}   req
 * @param {object}   res
 * @param {Function} callback — 권한 확인 후 실행할 핸들러
 */
async function checkRelationship(req, res, callback) {
  const { elderId } = req.params;
  const userId   = req.user.id;
  const userRole = req.user.role;

  // 노인 본인 접근
  if (userRole === 'elder') {
    // elders 테이블에서 user_id 확인
    const elderRow = await db.query(
      'SELECT id FROM elders WHERE id = $1 AND user_id = $2',
      [elderId, userId]
    );
    if (!elderRow.rows.length) {
      return res.status(403).json({ error: 'FORBIDDEN', message: '본인 정보에만 접근할 수 있습니다.' });
    }
    return callback();
  }

  // 보호자 접근 — 승인된 guardian_relationships 확인
  if (userRole === 'guardian') {
    const relRow = await db.query(
      `SELECT id FROM guardian_relationships
       WHERE guardian_user_id = $1 AND elder_id = $2 AND consent_status = 'accepted'`,
      [userId, elderId]
    );
    if (!relRow.rows.length) {
      return res.status(403).json({
        error: 'NO_RELATIONSHIP',
        message: '해당 노인과의 보호자 관계가 없습니다.',
      });
    }
    return callback();
  }

  // 관리자 등 기타 역할 (향후 확장)
  return res.status(403).json({ error: 'FORBIDDEN' });
}

module.exports = { checkRelationship };
