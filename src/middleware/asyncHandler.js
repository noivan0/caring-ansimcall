/**
 * src/middleware/asyncHandler.js — 비동기 라우트 에러 래퍼
 *
 * async 라우트 핸들러에서 throw된 에러를 Express 전역 에러 핸들러로 전달.
 * 미사용 시 unhandled promise rejection 발생.
 *
 * 사용 예:
 *   router.get('/path', asyncHandler(async (req, res) => { ... }))
 */

'use strict';

/**
 * @param {Function} fn — async 라우트 핸들러
 * @returns {Function} — Express 미들웨어
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
