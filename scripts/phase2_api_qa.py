#!/usr/bin/env python3
"""케어링 Phase2 — API QA"""
import sys, requests

BASE = "http://localhost:8001"
ERRORS, PASSES = [], []

def test(label, fn):
    try:
        fn(); PASSES.append(label); print(f"[PASS] {label}")
    except AssertionError as e:
        ERRORS.append(f"[FAIL] {label}: {e}"); print(f"[FAIL] {label}: {e}")
    except Exception as e:
        ERRORS.append(f"[ERROR] {label}: {e}"); print(f"[ERROR] {label}: {e}")

def t1_ping():
    r = requests.get(f"{BASE}/ping", timeout=5).json()
    assert r.get("status") == "ok", f"ping 실패: {r}"

def t2_health_ok():
    r = requests.get(f"{BASE}/health", timeout=5)
    assert r.status_code in [200, 206], f"health 실패: {r.status_code}"

def t3_ui_serves_html():
    r = requests.get(f"{BASE}/app", timeout=10)
    assert r.status_code == 200, f"UI 실패: {r.status_code}"
    assert "DOCTYPE" in r.text.upper(), "HTML DOCTYPE 없음"

def t4_static_assets():
    # CSS/JS가 인라인이면 OK
    r = requests.get(f"{BASE}/app", timeout=10)
    html = r.text
    assert "<style" in html.lower() or "stylesheet" in html.lower(), "CSS 없음"

test("ping 응답", t1_ping)
test("health 엔드포인트", t2_health_ok)
test("UI HTML 서빙", t3_ui_serves_html)
test("CSS 스타일 존재", t4_static_assets)

print(f"\nPASS={len(PASSES)} FAIL={len(ERRORS)}")
for e in ERRORS: print(e)
sys.exit(1 if ERRORS else 0)
