#!/usr/bin/env python3
"""케어링 Phase1 — 서버 헬스체크"""
import sys, requests

BASE = "http://localhost:8001"
ERRORS = []

def check(label, url, method="GET", expect_keys=None):
    try:
        r = requests.get(url, timeout=10) if method=="GET" else requests.post(url, json={}, timeout=10)
        if r.status_code >= 500:
            ERRORS.append(f"[FAIL] {label}: HTTP {r.status_code}")
            return None
        print(f"[OK] {label}: {r.status_code}")
        if expect_keys:
            d = r.json()
            for k in expect_keys:
                if k not in d: ERRORS.append(f"[FAIL] {label}: missing '{k}'")
        return r
    except Exception as e:
        ERRORS.append(f"[ERROR] {label}: {e}")
        return None

check("ping", f"{BASE}/ping", expect_keys=["status"])
check("health", f"{BASE}/health")
r = requests.get(f"{BASE}/app", timeout=10)
if r and r.status_code == 200 and "DOCTYPE" in r.text.upper():
    print("[OK] UI /app: HTML 정상")
else:
    ERRORS.append(f"[FAIL] UI /app")

if ERRORS:
    for e in ERRORS: print(e)
    sys.exit(1)
print("[PASS] Phase1 케어링 헬스체크 완료")
sys.exit(0)
