/**
 * src/middleware/i18n.js — 다국어 지원 미들웨어
 *
 * 언어 감지 우선순위:
 *   1. ?lang 쿼리 파라미터 (예: ?lang=ko)
 *   2. Accept-Language 헤더 (예: Accept-Language: ja-JP, ja;q=0.9)
 *   3. 기본값: 'ko' (한국어)
 *
 * 지원 언어: ko, en, ja
 *
 * 사용법:
 *   req.t('ivr.greeting')                     → 번역된 문자열
 *   req.t('notification.medication_reminder', { medication: '혈압약' })
 *   req.lang                                  → 현재 언어 코드
 */

'use strict';

const path = require('path');

const SUPPORTED_LANGUAGES = ['ko', 'en', 'ja'];
const DEFAULT_LANGUAGE    = 'ko';

// 번역 데이터 캐시
const translations = {};

/**
 * 번역 파일 로드 (lazy + cached)
 * @param {string} lang
 * @returns {object}
 */
function loadTranslation(lang) {
  if (!translations[lang]) {
    try {
      const filePath = path.join(__dirname, '..', 'i18n', `${lang}.json`);
      translations[lang] = require(filePath);
    } catch {
      // 파일 없으면 빈 객체
      translations[lang] = {};
    }
  }
  return translations[lang];
}

/**
 * 중첩 키 접근 (예: 'ivr.greeting')
 * @param {object} obj
 * @param {string} key — dot notation
 * @returns {string|undefined}
 */
function getNestedValue(obj, key) {
  return key.split('.').reduce((acc, k) => {
    if (acc && typeof acc === 'object') return acc[k];
    return undefined;
  }, obj);
}

/**
 * 템플릿 변수 치환 (예: '{{medication}}' → 실제값)
 * @param {string} template
 * @param {object} vars
 * @returns {string}
 */
function interpolate(template, vars = {}) {
  if (!template || typeof template !== 'string') return template || '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return vars[key] !== undefined ? vars[key] : `{{${key}}}`;
  });
}

/**
 * Accept-Language 헤더에서 언어 코드 추출
 * @param {string} header — 예: 'ko-KR,ko;q=0.9,en;q=0.8'
 * @returns {string|null}
 */
function parseAcceptLanguage(header) {
  if (!header) return null;

  // Accept-Language 파싱: 우선순위 순으로 정렬
  const langs = header
    .split(',')
    .map(part => {
      const [langTag, q = 'q=1'] = part.trim().split(';');
      const quality = parseFloat((q.split('=')[1] || '1'));
      // 언어 태그에서 기본 언어 코드 추출 (예: 'ko-KR' → 'ko')
      const code = langTag.trim().split('-')[0].toLowerCase();
      return { code, quality };
    })
    .sort((a, b) => b.quality - a.quality);

  // 지원 언어와 매칭
  for (const { code } of langs) {
    if (SUPPORTED_LANGUAGES.includes(code)) return code;
  }
  return null;
}

/**
 * i18n 미들웨어 팩토리
 * @returns {Function} Express 미들웨어
 */
function i18nMiddleware() {
  // 미리 모든 번역 로드
  SUPPORTED_LANGUAGES.forEach(loadTranslation);

  return (req, _res, next) => {
    // 언어 감지
    const queryLang  = req.query && req.query.lang;
    const headerLang = parseAcceptLanguage(req.headers && req.headers['accept-language']);

    let lang = DEFAULT_LANGUAGE;
    if (queryLang && SUPPORTED_LANGUAGES.includes(queryLang.toLowerCase())) {
      lang = queryLang.toLowerCase();
    } else if (headerLang) {
      lang = headerLang;
    }

    req.lang = lang;
    const dict = loadTranslation(lang);
    // 폴백: 기본 한국어
    const fallbackDict = lang !== DEFAULT_LANGUAGE ? loadTranslation(DEFAULT_LANGUAGE) : {};

    /**
     * 번역 함수
     * @param {string} key   — dot notation (예: 'ivr.greeting')
     * @param {object} [vars] — 치환 변수 (예: { medication: '혈압약' })
     * @returns {string}
     */
    req.t = (key, vars = {}) => {
      const value = getNestedValue(dict, key)
                 || getNestedValue(fallbackDict, key)
                 || key;
      return interpolate(value, vars);
    };

    next();
  };
}

module.exports = { i18nMiddleware, parseAcceptLanguage, interpolate, SUPPORTED_LANGUAGES };
