#!/usr/bin/env python3
"""케어링 Phase4 — 코드 감사"""
import sys
from pathlib import Path

BASE = Path("/root/.hermes/projects/senior-care")
ERRORS, WARNINGS = [], []

def check_file(rel, label, checks):
    p = BASE / rel
    if not p.exists():
        ERRORS.append(f"[FAIL] {label}: 없음"); return
    c = p.read_text(errors='replace')
    for pat, msg, is_error in checks:
        found = pat in c
        if is_error and not found: ERRORS.append(f"[FAIL] {label}: {msg}")
        elif not is_error and found: ERRORS.append(f"[FAIL] {label}: {msg}")

check_file("src/app.js", "app.js", [
    ("express()", "Express 앱 없음", True),
    ("app.listen", "서버 listen 없음", True),
    ("/ping", "ping 라우터 없음", True),
    ("eval(", "eval() 보안", False),
])

ui = BASE / "public/index.html"
if ui.exists():
    s = ui.stat().st_size
    print(f"[OK] index.html: {s:,}bytes")
    if s < 10000: ERRORS.append(f"[FAIL] index.html 너무 작음: {s}bytes")
    c = ui.read_text(errors='replace')
    if "onclick=" in c: WARNINGS.append("[WARN] onclick 인라인 사용 — addEventListener로 교체 권장")
else:
    ERRORS.append("[FAIL] public/index.html 없음")

# bcryptjs 폴백 확인
bcrypt = BASE / "node_modules/bcrypt/index.js"
if bcrypt.exists():
    c = bcrypt.read_text(errors='replace')
    if "bcryptjs" in c:
        print("[OK] bcrypt: bcryptjs 폴백 적용됨")
    else:
        WARNINGS.append("[WARN] bcrypt: 네이티브 바인딩 — HMG 차단 가능")

print(f"ERRORS={len(ERRORS)} WARNINGS={len(WARNINGS)}")
for w in WARNINGS: print(w)
for e in ERRORS: print(e)
sys.exit(1 if ERRORS else 0)
