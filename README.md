# 케어링 안심콜 (Caring Ansimcall)

> **MVP / Alpha** — A phone-based care reminder service for elderly parents, designed for adult children aged 40–60.

---

## 🇰🇷 소개 | 🇺🇸 Overview

**[한글]**
노인 부모님의 복약 알림과 안부 확인을 자동 전화 통화로 처리하는 서비스입니다.
자녀가 앱으로 일정을 설정하면, AI가 부모님께 직접 전화를 걸어 친근한 목소리로 약 복용을 안내하고 건강 상태를 확인합니다.

**[English]**
Caring Ansimcall is an automated phone-based medication reminder and wellness check service for elderly parents.
Adult children configure schedules via app; an AI voice agent calls parents directly to confirm medication and check in on their wellbeing.

---

## ✨ Key Features

| Feature | Description |
|---|---|
| 📞 Auto Call IVR | AI voice calls parents on schedule — no smartphone required for seniors |
| 💊 Medication Management | Individual or bundled medication schedules with flexible timing |
| 👨‍👩‍👧 Child Dashboard | Real-time call logs, confirmation status, and escalation alerts |
| 🚨 Escalation System | Missed call → child notification → caregiver alert chain |
| 📋 Compliance Logging | 5-year retention, Korean Personal Information Protection Act compliant |
| 🔒 Security | JWT HttpOnly/SameSite=Strict, OWASP ASVS compliant — CRITICAL 0 / HIGH 0 |

---

## 🧠 Design Principles

- **SDT (Self-Determination Theory)** — Autonomy-preserving UX for elderly users; no forced interaction patterns
- **Accessibility first** — Large fonts, high contrast (WCAG AA), voice-first interaction
- **Fogg Behavior Model** — Minimal friction for both elderly parents and adult children

---

## 🛠 Tech Stack

```
Backend   FastAPI · PostgreSQL · Redis · Twilio (IVR/SMS)
Auth      JWT (HttpOnly Cookie) · OAuth2
Infra     Docker · async SSE push notifications
Security  OWASP Top 10 · CRITICAL 0 / HIGH 0 (NOVA audit certified)
```

---

## 📱 App Preview

> MVP — UI design tokens defined. Backend API complete. Frontend in development.

**Design System**
- Primary: `#0EA5E9` (Sky Blue — trust & care)
- Background: `#FFFFFF` / Surface: `#F8FAFC`
- Font: Pretendard (Korean-optimized)

---

## 📌 Status

```
✅ Backend API complete
✅ IVR call flow designed (Twilio)
✅ Security audit passed (CRITICAL 0 / HIGH 0)
🔧 Frontend MVP in progress
⏳ Pending: .env credentials for deployment
```

---

## 🔗 Related

- [NOVA OSS](https://github.com/noivan0/NOVA) — Agent framework powering this app
- [noivan0 Portfolio](https://noivan0.github.io/noivan-portfolio/)
