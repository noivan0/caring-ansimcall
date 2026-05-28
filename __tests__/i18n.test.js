/**
 * __tests__/i18n.test.js — 다국어 미들웨어 테스트
 */
'use strict';

const { parseAcceptLanguage, interpolate, i18nMiddleware, SUPPORTED_LANGUAGES } = require('../src/middleware/i18n');

// ────────────────────────────────────────────────────────────────
// parseAcceptLanguage
// ────────────────────────────────────────────────────────────────
describe('parseAcceptLanguage', () => {
  test('ko-KR → ko', () => {
    expect(parseAcceptLanguage('ko-KR,ko;q=0.9,en;q=0.8')).toBe('ko');
  });

  test('ja-JP → ja', () => {
    expect(parseAcceptLanguage('ja-JP,ja;q=0.9')).toBe('ja');
  });

  test('en-US → en', () => {
    expect(parseAcceptLanguage('en-US,en;q=0.9')).toBe('en');
  });

  test('지원 안 하는 언어 → null', () => {
    expect(parseAcceptLanguage('zh-CN,zh;q=0.9')).toBeNull();
  });

  test('null → null', () => {
    expect(parseAcceptLanguage(null)).toBeNull();
  });

  test('빈 문자열 → null', () => {
    expect(parseAcceptLanguage('')).toBeNull();
  });

  test('여러 언어 중 지원 언어 선택 (우선순위 고려)', () => {
    // zh 지원 안 됨, en 지원됨
    expect(parseAcceptLanguage('zh;q=0.9,en;q=0.8')).toBe('en');
  });
});

// ────────────────────────────────────────────────────────────────
// interpolate
// ────────────────────────────────────────────────────────────────
describe('interpolate', () => {
  test('변수 치환', () => {
    expect(interpolate('{{medication}} 복약 시간입니다.', { medication: '혈압약' }))
      .toBe('혈압약 복약 시간입니다.');
  });

  test('여러 변수 치환', () => {
    expect(interpolate('{{elderName}}님이 {{count}}일 연속 미복약', { elderName: '홍길동', count: 3 }))
      .toBe('홍길동님이 3일 연속 미복약');
  });

  test('없는 변수 → {{key}} 유지', () => {
    expect(interpolate('{{없는변수}} 테스트', {}))
      .toBe('{{없는변수}} 테스트');
  });

  test('변수 없는 템플릿', () => {
    expect(interpolate('변수 없는 문자열')).toBe('변수 없는 문자열');
  });

  test('null 템플릿 → 빈 문자열', () => {
    expect(interpolate(null)).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────
// SUPPORTED_LANGUAGES
// ────────────────────────────────────────────────────────────────
describe('SUPPORTED_LANGUAGES', () => {
  test('ko, en, ja 포함', () => {
    expect(SUPPORTED_LANGUAGES).toContain('ko');
    expect(SUPPORTED_LANGUAGES).toContain('en');
    expect(SUPPORTED_LANGUAGES).toContain('ja');
  });
});

// ────────────────────────────────────────────────────────────────
// i18nMiddleware — req.t 함수
// ────────────────────────────────────────────────────────────────
describe('i18nMiddleware — req.t', () => {
  function makeReq(query = {}, headers = {}) {
    return { query, headers };
  }
  function makeRes() {
    return {};
  }

  test('?lang=ko → ko 번역', () => {
    const middleware = i18nMiddleware();
    const req = makeReq({ lang: 'ko' }, {});
    middleware(req, makeRes(), () => {});
    expect(req.lang).toBe('ko');
    expect(req.t('ivr.goodbye')).toContain('감사합니다');
  });

  test('?lang=en → en 번역', () => {
    const middleware = i18nMiddleware();
    const req = makeReq({ lang: 'en' }, {});
    middleware(req, makeRes(), () => {});
    expect(req.lang).toBe('en');
    expect(req.t('ivr.goodbye')).toContain('Thank you');
  });

  test('?lang=ja → ja 번역', () => {
    const middleware = i18nMiddleware();
    const req = makeReq({ lang: 'ja' }, {});
    middleware(req, makeRes(), () => {});
    expect(req.lang).toBe('ja');
    expect(req.t('ivr.goodbye')).toContain('ありがとう');
  });

  test('Accept-Language: ja → ja 번역', () => {
    const middleware = i18nMiddleware();
    const req = makeReq({}, { 'accept-language': 'ja-JP,ja;q=0.9' });
    middleware(req, makeRes(), () => {});
    expect(req.lang).toBe('ja');
  });

  test('쿼리 파라미터 우선 (Accept-Language보다)', () => {
    const middleware = i18nMiddleware();
    const req = makeReq({ lang: 'en' }, { 'accept-language': 'ja-JP' });
    middleware(req, makeRes(), () => {});
    expect(req.lang).toBe('en');
  });

  test('지원 안 하는 lang → 기본값 ko', () => {
    const middleware = i18nMiddleware();
    const req = makeReq({ lang: 'zh' }, {});
    middleware(req, makeRes(), () => {});
    expect(req.lang).toBe('ko');
  });

  test('키 없으면 → 키 자체 반환', () => {
    const middleware = i18nMiddleware();
    const req = makeReq({ lang: 'ko' }, {});
    middleware(req, makeRes(), () => {});
    expect(req.t('nonexistent.key')).toBe('nonexistent.key');
  });

  test('변수 치환 with req.t', () => {
    const middleware = i18nMiddleware();
    const req = makeReq({ lang: 'ko' }, {});
    middleware(req, makeRes(), () => {});
    const result = req.t('notification.medication_reminder', { medication: '혈압약' });
    expect(result).toContain('혈압약');
  });
});
