#!/usr/bin/env python3
"""케어링 Phase3 — UI QA"""
import sys, requests

BASE = "http://localhost:8001"
ERRORS = []

r = requests.get(f"{BASE}/app", timeout=10)
if r.status_code != 200:
    print(f"[FAIL] UI 로드: {r.status_code}"); sys.exit(1)

html = r.text

def check(label, cond):
    if not cond: ERRORS.append(f"[FAIL] {label}"); print(f"[FAIL] {label}")
    else: print(f"[OK] {label}")

check("DOCTYPE", "DOCTYPE" in html.upper())
check("meta viewport", "viewport" in html)
check("온보딩 3단계", html.count("step") >= 3 or html.count("onboard") >= 1 or "단계" in html)
check("localStorage 사용", "localStorage" in html)
check("복약 기록 UI", any(k in html for k in ["medication","복약","약","medicine"]))
check("안부 메시지", any(k in html for k in ["안부","message","template","메시지"]))
check("통화하기", "tel:" in html or "phone" in html.lower() or "전화" in html)
check("addEventListener 방식", "addEventListener" in html)
check("onclick 인라인 없음", "onclick=" not in html)
check("블루 기조색", "#0369A1" in html or "#0EA5E9" in html or "#2563EB" in html or "--color-primary" in html)
check("한국어 UI", any(k in html for k in ["부모","어르신","케어","보호자"]))
check("미디어쿼리 반응형", "@media" in html)

if ERRORS:
    print(f"\n[FAIL] UI QA: {len(ERRORS)}개 문제")
    for e in ERRORS: print(e)
    sys.exit(1)
print(f"\n[PASS] Phase3 케어링 UI QA 완료")
sys.exit(0)
