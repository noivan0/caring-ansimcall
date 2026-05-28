/**
 * src/services/IvrService.js — IVR 복약 STT/DTMF 파싱 서비스
 *
 * 기능:
 *   - parseIvrResponse(rawText): 한국어 음성 응답 파싱
 *   - processDtmf(digit): DTMF 키패드 입력 처리
 *   - checkConsecutiveMissed(userId, medicationName): 3일 연속 미복약 감지
 *
 * MedicationCallLog 모델:
 *   {date, time, medication, response_type, confirmed, raw_response, notified_family}
 */

'use strict';

const path     = require('path');
const Database = require('better-sqlite3');
const fs       = require('fs');

// DB 경로
const DB_PATH = process.env.IVR_CALL_LOG_DB_PATH
  || path.join(__dirname, '..', '..', 'data', 'ivr_call_logs.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// ── 응답 타입 상수 ─────────────────────────────────────────────
const RESPONSE_TYPE = {
  DTMF:        'DTMF',
  STT:         'STT',
  NO_RESPONSE: 'NO_RESPONSE',
};

// ── 확인 키워드 매핑 — KO / JA / EN 3개 언어 ────────────────────
//
// [HIGH BUG FIX] 한국어 includes() → whitelist Set + regex 앵커 교체
// 원인: includes('네') 가 '맑네요', '아니네요' 등에서 오탐 발생
// 해결: 한국어는 Set 정확 매칭 + regex 앵커(^네[.!,\s]?$) 보조
//       영어는 기존 \b 단어 경계 유지
//       일본어는 Set 정확 매칭으로 전환
// (근본 해결: konlpy/Mecab 형태소 분석 — 추후 P2 적용 예정)

// 한국어 확인 의사 whitelist (독립 발화 기준)
const KO_CONFIRM_SET = new Set([
  '네', '네.', '네,', '네!', '네요',
  '예', '예.', '예,', '예!',
  '맞아', '맞아요', '맞습니다', '맞죠',
  '응', '응.', '어', '어.',
  '그래', '그래요', '그렇죠',
  '알겠어요', '알겠습니다', '알겠어',
  '먹었어', '먹었어요', '먹었습니다',
  '복용했어요', '복용했습니다',
]);

// 한국어 부정 의사 whitelist
const KO_DENY_SET = new Set([
  '아니', '아니요', '아니오', '아뇨', '아닙니다', '아니에요',
  '안먹었어', '안 먹었어', '안먹었어요', '안 먹었어요',
  '못먹었어', '못 먹었어', '못먹었어요', '못 먹었어요',
  '모르겠어', '모르겠어요', '모르겠습니다',
  '아직', '아직요',
  '안 돼요', '안돼요', '싫어요',
]);

// 일본어 확인 Set (includes 대신 정확 매칭)
const JA_CONFIRM_SET = new Set([
  'はい', '飲みました', '飲んだ', '服用しました', 'のみました',
  'そうです', 'はい飲みました',
]);

// 일본어 부정 Set
const JA_DENY_SET = new Set([
  'いいえ', '飲んでいない', '飲んでません', 'まだ', 'わかりません',
  '飲んでいません', 'のんでいない',
]);

// 영어는 기존 \b 방식 유지 (단어 경계가 명확)
const EN_CONFIRMED_KEYWORDS = [
  'yes', 'took it', 'i took', 'taken', 'i have taken',
  'already took', 'did take', 'confirmed',
];
const EN_NOT_CONFIRMED_KEYWORDS = [
  'no', 'not yet', 'did not', "didn't", 'have not', "haven't",
  'forgot', 'i forgot', 'skip', 'skipped',
];

// ── STT 키워드 매칭 — 언어별 경계 처리 ──────────────────────────
/**
 * 키워드 매칭 함수 — 언어별 전략 분리.
 * - 한국어: whitelist Set 정확 매칭 + regex 앵커 보조
 * - 일본어: whitelist Set 정확 매칭
 * - 영어: 단어 경계(\b) 정규식
 * MEDIUM 해소: 'no'→'noted/knowledge', 'yes'→'yesterday' 오탐 방지.
 * HIGH 해소: '맑네요'→'네' includes 오탐 방지 (Set 교체).
 */
function classifyKorean(normalized) {
  if (KO_DENY_SET.has(normalized)) return 'DENY';
  if (KO_CONFIRM_SET.has(normalized)) return 'CONFIRM';
  // regex 앵커 보조 — Set 미포함 변형 대응
  if (/^네[.!,\s]?$/.test(normalized)) return 'CONFIRM';
  if (/^예[.!,\s]?$/.test(normalized)) return 'CONFIRM';
  if (/^아니/.test(normalized)) return 'DENY';
  return null; // UNKNOWN → 상위에서 NO_RESPONSE 처리
}

function classifyJapanese(normalized) {
  if (JA_DENY_SET.has(normalized)) return 'DENY';
  if (JA_CONFIRM_SET.has(normalized)) return 'CONFIRM';
  return null;
}

function matchesEnglishKeyword(normalizedText, keyword) {
  const kwLower = keyword.toLowerCase();
  const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + escaped + '\\b', 'i').test(normalizedText);
}

// 구버전 호환 (내부 사용 — parseIvrResponse 리팩터로 직접 사용 안 함)
function matchesKeyword(normalizedText, keyword) {
  const kwLower = keyword.toLowerCase();
  if (/^[a-zA-Z\s']+$/.test(kwLower)) {
    const escaped = kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b' + escaped + '\\b', 'i').test(normalizedText);
  }
  // 한/일어: 구버전 fallback (parseIvrResponse에서 직접 사용 안 함)
  return normalizedText.includes(kwLower);
}

let _db = null;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS medication_call_logs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          TEXT,
        date             TEXT NOT NULL,
        time             TEXT NOT NULL,
        medication       TEXT NOT NULL,
        response_type    TEXT NOT NULL CHECK(response_type IN ('DTMF','STT','NO_RESPONSE')),
        confirmed        INTEGER NOT NULL DEFAULT 0,
        raw_response     TEXT,
        notified_family  INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL
      )
    `);
  }
  return _db;
}

// ── MedicationCallLog CRUD ────────────────────────────────────
const MedicationCallLog = {

  /**
   * 통화 로그 저장
   * @param {object} logData
   * @returns {object} 저장된 로그
   */
  create(logData) {
    const db  = getDb();
    const now = new Date().toISOString();

    const {
      userId, date, time, medication,
      response_type, confirmed, raw_response,
      notified_family = false,
    } = logData;

    const result = db.prepare(`
      INSERT INTO medication_call_logs
        (user_id, date, time, medication, response_type, confirmed, raw_response, notified_family, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId        || null,
      date,
      time,
      medication,
      response_type,
      confirmed     ? 1 : 0,
      raw_response  || null,
      notified_family ? 1 : 0,
      now
    );

    return db.prepare('SELECT * FROM medication_call_logs WHERE id = ?').get(result.lastInsertRowid);
  },

  /**
   * 특정 사용자/약의 최근 N일간 미복약 로그 조회
   * @param {string} userId
   * @param {string} medication
   * @param {number} days
   * @returns {Array}
   */
  findRecentMissed(userId, medication, days = 3) {
    const db = getDb();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    return db.prepare(`
      SELECT * FROM medication_call_logs
      WHERE user_id   = ?
        AND medication = ?
        AND confirmed  = 0
        AND response_type != 'NO_RESPONSE'
        AND date >= ?
      ORDER BY date DESC, time DESC
    `).all(userId, medication, cutoffStr);
  },

  /**
   * 특정 사용자/약/날짜 로그 조회
   * @param {string} userId
   * @param {string} medication
   * @param {string} date — YYYY-MM-DD
   * @returns {Array}
   */
  findByDate(userId, medication, date) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM medication_call_logs
      WHERE user_id   = ?
        AND medication = ?
        AND date       = ?
      ORDER BY time DESC
    `).all(userId, medication, date);
  },

  /**
   * notified_family 플래그 업데이트
   * @param {number} id
   * @returns {boolean}
   */
  markFamilyNotified(id) {
    const db     = getDb();
    const result = db.prepare(
      'UPDATE medication_call_logs SET notified_family = 1 WHERE id = ?'
    ).run(id);
    return result.changes > 0;
  },

  // 테스트용: DB 인스턴스 초기화
  _resetDb(newDb) {
    _db = newDb;
  },

  _getDb: getDb,
};

// ── IVR 파싱 로직 ─────────────────────────────────────────────

/**
 * KO/JA/EN STT 응답 파싱 — 3개 언어 통합
 *
 * @param {string|null} rawText — 음성 인식 텍스트
 * @param {string} [lang='ko'] — 언어 힌트 ('ko'|'ja'|'en')
 * @returns {{ confirmed: boolean|null, response_type: string, lang: string }}
 *   - confirmed = true  → 복약 확인
 *   - confirmed = false → 미복약 또는 거부
 *   - confirmed = null  → NO_RESPONSE
 */
function parseIvrResponse(rawText, lang = 'ko') {
  // 빈 문자열 / null / undefined → NO_RESPONSE
  if (!rawText || rawText.trim() === '') {
    return { confirmed: null, response_type: RESPONSE_TYPE.NO_RESPONSE, lang };
  }

  const normalized = rawText.trim().toLowerCase().replace(/\s+/g, ' ');

  // [HIGH BUG FIX] 언어별 분류 함수로 교체 — includes() 오탐 방지
  if (lang === 'ko') {
    const result = classifyKorean(normalized);
    if (result === 'CONFIRM') return { confirmed: true,  response_type: RESPONSE_TYPE.STT, lang };
    if (result === 'DENY')    return { confirmed: false, response_type: RESPONSE_TYPE.STT, lang };
    return { confirmed: null, response_type: RESPONSE_TYPE.NO_RESPONSE, lang };
  }

  if (lang === 'ja') {
    const result = classifyJapanese(normalized);
    if (result === 'CONFIRM') return { confirmed: true,  response_type: RESPONSE_TYPE.STT, lang };
    if (result === 'DENY')    return { confirmed: false, response_type: RESPONSE_TYPE.STT, lang };
    return { confirmed: null, response_type: RESPONSE_TYPE.NO_RESPONSE, lang };
  }

  // 영어 (lang === 'en' 또는 기본)
  for (const keyword of EN_NOT_CONFIRMED_KEYWORDS) {
    if (matchesEnglishKeyword(normalized, keyword)) {
      return { confirmed: false, response_type: RESPONSE_TYPE.STT, lang };
    }
  }
  for (const keyword of EN_CONFIRMED_KEYWORDS) {
    if (matchesEnglishKeyword(normalized, keyword)) {
      return { confirmed: true, response_type: RESPONSE_TYPE.STT, lang };
    }
  }

  // 키워드 미매칭 → 판별 불가
  return { confirmed: null, response_type: RESPONSE_TYPE.NO_RESPONSE, lang };
}

/**
 * DTMF 키패드 입력 처리
 *
 * @param {string} digit — '1' 또는 '2'
 * @returns {{ confirmed: boolean|null, response_type: string }}
 */
function processDtmf(digit) {
  if (digit === '1') {
    return { confirmed: true,  response_type: RESPONSE_TYPE.DTMF };
  }
  if (digit === '2') {
    return { confirmed: false, response_type: RESPONSE_TYPE.DTMF };
  }
  // 기타 키 → NO_RESPONSE
  return { confirmed: null, response_type: RESPONSE_TYPE.NO_RESPONSE };
}

/**
 * 3일 연속 미복약 여부 확인
 *
 * 최근 3일간 매일 최소 1개의 '미복약(confirmed=false)' 로그가 있으면 true.
 *
 * @param {string} userId
 * @param {string} medication
 * @returns {boolean}
 */
function checkConsecutiveMissed(userId, medication) {
  const db = getDb();

  // 최근 3일 날짜 목록
  const today = new Date();
  const datesToCheck = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    datesToCheck.push(d.toISOString().split('T')[0]);
  }

  // 각 날짜에 미복약 로그가 있는지 확인
  for (const date of datesToCheck) {
    const rows = db.prepare(`
      SELECT id FROM medication_call_logs
      WHERE user_id   = ?
        AND medication = ?
        AND date       = ?
        AND confirmed  = 0
      LIMIT 1
    `).all(userId, medication, date);

    if (rows.length === 0) return false;
  }

  return true;
}

/**
 * IVR 응답 통합 처리
 *
 * DTMF 또는 STT 응답을 받아 DB에 저장하고,
 * 3일 연속 미복약 시 notified_family 플래그 설정.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.medication
 * @param {string} [params.rawText]  — STT 텍스트 (null이면 DTMF 또는 NO_RESPONSE)
 * @param {string} [params.dtmfDigit] — DTMF 입력 ('1' or '2')
 * @param {string} [params.date]    — YYYY-MM-DD (기본: 오늘)
 * @param {string} [params.time]    — HH:MM (기본: 현재 시각)
 * @returns {object} { log, notified_family, consecutive_missed }
 */
async function processIvrCall(params) {
  const {
    userId,
    medication,
    rawText,
    dtmfDigit,
    lang = 'ko',
    date = new Date().toISOString().split('T')[0],
    time = new Date().toTimeString().slice(0, 5),
  } = params;

  let parsed;

  if (dtmfDigit !== undefined && dtmfDigit !== null) {
    // DTMF 우선
    parsed = processDtmf(String(dtmfDigit));
  } else {
    // STT 파싱 — lang 전달
    parsed = parseIvrResponse(rawText, lang);
  }

  // 로그 먼저 저장 (3일 연속 체크는 현재 로그 포함해야 정확)
  const log = MedicationCallLog.create({
    userId,
    date,
    time,
    medication,
    response_type:  parsed.response_type,
    confirmed:      parsed.confirmed === true,
    raw_response:   rawText || (dtmfDigit ? `DTMF:${dtmfDigit}` : null),
    notified_family: false, // 우선 false로 저장, 이후 업데이트
  });

  // 3일 연속 미복약 체크 (미복약 시에만, 로그 저장 후)
  let notifiedFamily = false;
  let consecutiveMissed = false;

  if (parsed.confirmed === false) {
    consecutiveMissed = checkConsecutiveMissed(userId, medication);
    if (consecutiveMissed) {
      notifiedFamily = true;
      // notified_family 플래그 업데이트
      MedicationCallLog.markFamilyNotified(log.id);
    }
  }

  // 최신 로그 재조회 (notified_family 업데이트 반영)
  const db = getDb();
  const finalLog = db.prepare('SELECT * FROM medication_call_logs WHERE id = ?').get(log.id);

  return {
    log: finalLog || log,
    notified_family: notifiedFamily,
    consecutive_missed: consecutiveMissed,
    parsed,
  };
}

module.exports = {
  IvrService: {
    parseIvrResponse,
    processDtmf,
    checkConsecutiveMissed,
    processIvrCall,
  },
  MedicationCallLog,
  parseIvrResponse,
  processDtmf,
  checkConsecutiveMissed,
  processIvrCall,
  RESPONSE_TYPE,
  // [HIGH BUG FIX] 새 whitelist Set 내보내기 (테스트·외부 접근용)
  KO_CONFIRM_SET,
  KO_DENY_SET,
  JA_CONFIRM_SET,
  JA_DENY_SET,
  EN_CONFIRMED_KEYWORDS,
  EN_NOT_CONFIRMED_KEYWORDS,
  classifyKorean,
  classifyJapanese,
  // 구버전 호환 (일부 테스트에서 참조)
  CONFIRMED_KEYWORDS: EN_CONFIRMED_KEYWORDS,
  NOT_CONFIRMED_KEYWORDS: EN_NOT_CONFIRMED_KEYWORDS,
};
