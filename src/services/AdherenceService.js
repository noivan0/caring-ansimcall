/**
 * senior-care 복약순응도(Adherence) 서비스
 * WHO + MMAS-8 척도 기반 임상 근거
 * Health Belief Model 기반 심리적 개입
 * 다약제(Polypharmacy) 안전 체크
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/senior_care.db');

// ============================
// 복약순응도 등급 (WHO 기준)
// ============================
const ADHERENCE_LEVELS = {
  HIGH:     { min: 90, label: '고순응', label_en: 'High Adherence',     action: 'maintain' },
  MODERATE: { min: 70, label: '중순응', label_en: 'Moderate Adherence', action: 'encourage' },
  LOW:      { min: 0,  label: '저순응', label_en: 'Low Adherence',      action: 'intervene' },
};

// 고위험 약물 조합 (Polypharmacy 안전 체크)
const HIGH_RISK_COMBINATIONS = [
  { drugs: ['warfarin', '와파린'], plus: ['aspirin', 'nsaid', '아스피린', '이부프로펜'], risk: '출혈 위험 증가' },
  { drugs: ['digoxin', '디곡신'], plus: ['amiodarone', '아미오다론'], risk: '심장독성 위험' },
  { drugs: ['metformin', '메트포르민'], plus: ['contrast', '조영제'], risk: '젖산증 위험' },
  { drugs: ['lithium', '리튬'], plus: ['nsaid', '이부프로펜'], risk: '리튬 독성 위험' },
  { drugs: ['ssri', '항우울제'], plus: ['tramadol', '트라마돌'], risk: '세로토닌 증후군 위험' },
];

// ============================
// AdherenceService
// ============================
class AdherenceService {
  constructor(dbPath = DB_PATH) {
    this.db = new Database(dbPath);
    this._initTable();
  }

  _initTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS adherence_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        calculated_at TEXT NOT NULL,
        period_days INTEGER DEFAULT 30,
        total_scheduled INTEGER DEFAULT 0,
        total_taken INTEGER DEFAULT 0,
        adherence_pct REAL DEFAULT 0,
        level TEXT DEFAULT 'low',
        miss_pattern TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS medication_barriers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        barrier_type TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        raw_response TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  /**
   * 복약순응도 점수 계산 (최근 N일 기준)
   * WHO 기준: 복약횟수 / 처방횟수 × 100
   */
  calcAdherenceScore(userId, periodDays = 30) {
    const db = this.db;

    // 최근 N일 복약 기록 조회
    const logs = db.prepare(`
      SELECT confirmed, date(created_at) as log_date,
             strftime('%w', created_at) as weekday,
             strftime('%H', created_at) as hour
      FROM medication_call_logs
      WHERE user_id = ? AND created_at >= datetime('now', ? || ' days')
      ORDER BY created_at
    `).all(userId, `-${periodDays}`);

    const totalScheduled = periodDays; // 1일 1회 기준 (설정에 따라 조정 가능)
    const totalTaken = logs.filter(l => l.confirmed === 1).length;
    const adherencePct = totalScheduled > 0
      ? Math.round((totalTaken / totalScheduled) * 100 * 10) / 10
      : 0;

    // 순응도 등급
    let level = 'low';
    if (adherencePct >= ADHERENCE_LEVELS.HIGH.min) level = 'high';
    else if (adherencePct >= ADHERENCE_LEVELS.MODERATE.min) level = 'moderate';

    // 미복약 패턴 분석 (요일별/시간대별)
    const missedLogs = logs.filter(l => l.confirmed !== 1);
    const missByWeekday = {};
    const missByHour = {};
    for (const log of missedLogs) {
      missByWeekday[log.weekday] = (missByWeekday[log.weekday] || 0) + 1;
      missByHour[log.hour] = (missByHour[log.hour] || 0) + 1;
    }

    const worstWeekday = Object.entries(missByWeekday).sort((a, b) => b[1] - a[1])[0];
    const worstHour    = Object.entries(missByHour).sort((a, b) => b[1] - a[1])[0];

    const missPattern = {
      by_weekday: missByWeekday,
      by_hour: missByHour,
      worst_weekday: worstWeekday ? `요일코드 ${worstWeekday[0]} (${worstWeekday[1]}회 누락)` : null,
      worst_hour: worstHour ? `${worstHour[0]}시대 (${worstHour[1]}회 누락)` : null,
    };

    // DB 저장
    db.prepare(`
      INSERT INTO adherence_scores
        (user_id, calculated_at, period_days, total_scheduled, total_taken, adherence_pct, level, miss_pattern)
      VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?)
    `).run(userId, periodDays, totalScheduled, totalTaken, adherencePct, level, JSON.stringify(missPattern));

    const levelInfo = ADHERENCE_LEVELS[level.toUpperCase()] || ADHERENCE_LEVELS.LOW;

    return {
      user_id: userId,
      period_days: periodDays,
      total_scheduled: totalScheduled,
      total_taken: totalTaken,
      adherence_pct: adherencePct,
      level,
      level_label: levelInfo.label,
      miss_pattern: missPattern,
      action_required: levelInfo.action,
      family_alert: level === 'low',
      doctor_referral_msg: level === 'low'
        ? '최근 복약순응도가 낮습니다. 담당의 상담을 권장합니다.'
        : null,
      source: 'WHO 복약순응도 기준 + MMAS-8 척도',
    };
  }

  /**
   * Health Belief Model 기반 장벽(barrier) 감지
   * IVR 음성 응답에서 미복약 이유 파싱
   */
  detectPerceivedBarrier(userId, rawResponse) {
    if (!rawResponse) return null;

    const text = rawResponse.toLowerCase();
    let barrierType = null;

    const BARRIER_KEYWORDS = {
      'schedule_conflict': ['바빠서', '바쁜', '시간이', '출근', '외출', '약속'],
      'forgetfulness':     ['깜빡', '잊어', '몰랐', '기억'],
      'side_effects':      ['속이', '메스', '어지러', '토할', '불편', '부작용'],
      'financial':         ['돈', '비싸', '못사', '약이 없'],
      'denial':            ['안먹어도', '괜찮아', '필요없', '안 먹어도'],
    };

    for (const [type, keywords] of Object.entries(BARRIER_KEYWORDS)) {
      if (keywords.some(kw => text.includes(kw))) {
        barrierType = type;
        break;
      }
    }

    if (barrierType) {
      this.db.prepare(`
        INSERT INTO medication_barriers (user_id, barrier_type, detected_at, raw_response)
        VALUES (?, ?, datetime('now'), ?)
      `).run(userId, barrierType, rawResponse);

      const BARRIER_MESSAGES = {
        'schedule_conflict': '바쁘실 때는 알람 시간을 조정해보세요.',
        'forgetfulness':     '복약 알림 시간을 더 자주 설정해드릴까요?',
        'side_effects':      '부작용이 느껴지신다면 담당의에게 꼭 알려주세요.',
        'financial':         '복지약국 할인제도를 안내해드릴게요.',
        'denial':            '꾸준한 복약이 건강 유지에 중요합니다.',
      };

      return {
        detected: true,
        barrier_type: barrierType,
        intervention_message: BARRIER_MESSAGES[barrierType],
        source: 'Health Belief Model — perceived_barrier 분류',
      };
    }

    return { detected: false, barrier_type: null };
  }

  /**
   * 다약제(Polypharmacy) 안전 체크
   * medications 배열 > 5개 → 고위험 플래그
   * 고위험 약물 조합 기초 체크
   */
  checkPolypharmacy(medications = []) {
    const polypharmacyFlag = medications.length >= 5;
    const warnings = [];

    const medLower = medications.map(m => m.toLowerCase());

    for (const combo of HIGH_RISK_COMBINATIONS) {
      const hasDrug = combo.drugs.some(d => medLower.some(m => m.includes(d)));
      const hasPlus = combo.plus.some(d => medLower.some(m => m.includes(d)));
      if (hasDrug && hasPlus) {
        warnings.push({
          drugs: [...combo.drugs, ...combo.plus],
          risk: combo.risk,
          severity: 'high',
        });
      }
    }

    return {
      polypharmacy_flag: polypharmacyFlag,
      medication_count: medications.length,
      high_risk_combinations: warnings,
      alert_message: polypharmacyFlag
        ? `복용 중인 약이 ${medications.length}가지입니다. 담당의와 약물 조합을 검토하세요.`
        : null,
      source: 'WHO Polypharmacy 가이드라인 (5종 이상 기준)',
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { AdherenceService, ADHERENCE_LEVELS };
