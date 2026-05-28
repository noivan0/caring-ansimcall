#!/usr/bin/env python3
"""
케어링 — 구형 번호 마이그레이션 스크립트
016/017/018/019 번호를 신규 KR_MOBILE 정규식으로 재검증
기존 사용자 DB의 phone 컬럼 E.164 형식 일괄 정비
운영: python3 scripts/migrate_legacy_phones.py --dry-run
"""
import re
import argparse

_KR_MOBILE_NEW = re.compile(r"^\+82(10|11|16|17|18|19)\d{7,8}$")


def normalize_legacy(phone: str) -> str:
    cleaned = re.sub(r"[\s\-\(\)]", "", phone)
    if cleaned.startswith("0"):
        cleaned = "+82" + cleaned[1:]
    if not cleaned.startswith("+"):
        cleaned = "+82" + cleaned
    return cleaned


def validate_and_migrate(phone: str) -> dict:
    normalized = normalize_legacy(phone)
    valid = bool(_KR_MOBILE_NEW.match(normalized))
    return {
        "original": phone,
        "normalized": normalized,
        "valid": valid,
        "error": None if valid else f"미지원 번호 형식: {normalized}",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    test_phones = [
        "01012345678", "01112345678", "01612345678",
        "01712345678", "01812345678", "01912345678",
        "+821012345678", "+821612345678",
    ]
    print(f"{'원본':<20} {'정규화':<18} {'유효':<6}")
    for p in test_phones:
        r = validate_and_migrate(p)
        print(f"{r['original']:<20} {r['normalized']:<18} {r['valid']!s:<6}")
