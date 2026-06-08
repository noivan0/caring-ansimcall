"""
가족 그룹 관리 API
자녀 여러 명이 부모 알림을 공동 관리
"""
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, field_validator
from typing import Optional, Literal
from src.core.auth import get_current_user
from src.api.rate_limiter import limiter  # [R64-RL]
import re

router = APIRouter(tags=["family"])


def _normalize_phone(v: str) -> str:
    """한국 전화번호 정규화 — 010-XXXX-XXXX → 01012345678"""
    cleaned = re.sub(r"[-\s]", "", v.strip())
    # [R68-VAL-001 FIX] 한국 이동통신 패턴: 01[016789]\d{7,8}
    # 010(11자리), 011/016/017/018/019(10~11자리) 모두 허용
    if not re.match(r"^01[016789]\d{7,8}$", cleaned):
        raise ValueError("유효한 한국 전화번호를 입력해주세요 (예: 010-1234-5678)")
    return cleaned


class FamilyMember(BaseModel):
    name: str = Field(..., min_length=1, max_length=30, description="보호자 이름")
    phone: str = Field(..., description="보호자 전화번호")
    role: Literal["primary", "secondary", "cc_only"] = Field(
        "primary", description="역할: primary(주 연락자)/secondary(2차)/cc_only(정보 수신)"
    )  # [R68-VAL-001] Literal 열거형 강제

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, v: str) -> str:
        return _normalize_phone(v)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not re.match(r"^[가-힣a-zA-Z\s]{1,30}$", v.strip()):
            raise ValueError("이름은 한글/영문만 허용됩니다 (1~30자)")
        return v.strip()


class FamilyGroupCreate(BaseModel):
    parent_name: str = Field(..., min_length=1, max_length=30, description="부모님 이름")
    parent_phone: str = Field(..., description="부모님 전화번호")
    members: list[FamilyMember] = Field(..., min_length=1, max_length=5)

    @field_validator("parent_phone")
    @classmethod
    def validate_parent_phone(cls, v: str) -> str:
        return _normalize_phone(v)

    @field_validator("parent_name")
    @classmethod
    def validate_parent_name(cls, v: str) -> str:
        if not re.match(r"^[가-힣a-zA-Z\s]{1,30}$", v.strip()):
            raise ValueError("이름은 한글/영문만 허용됩니다 (1~30자)")
        return v.strip()


@router.post("/groups")
@limiter.limit("10/minute")
def create_family_group(request: Request, body: FamilyGroupCreate, user=Depends(get_current_user)):
    """
    가족 그룹 생성
    - 역할: primary(주 연락자) / secondary(2차) / cc_only(정보 수신)
    - 최대 5명 등록 (PRD 명세)
    - 부모님 동의 수집 절차 즉시 시작
    """
    # PRD 명세: 최대 5명 (앱 등록 기준)
    if len(body.members) > 5:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=400,
            detail="보호자는 최대 5명까지 등록 가능합니다 (PRD 명세)."
        )

    # primary 최소 1명 확인
    primaries = [m for m in body.members if m.role == "primary"]
    if not primaries:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=400,
            detail="1순위 보호자(primary)가 최소 1명 필요합니다."
        )

    return {
        "group_id": f"group_{user.get('user_id')}_{len(body.members)}",
        "members": len(body.members),
        "members_detail": [
            {"name": m.name, "phone": m.phone[-4:] + "****" if len(m.phone) >= 4 else "****", "role": m.role}
            for m in body.members
        ],
        "consent_required": True,
        "consent_flow": "IVR 전화 또는 SMS 동의 링크 발송",
        "escalation_policy": {
            "level1": "1순위 보호자 앱 푸시 (미응답 1회)",
            "level2": "1+2순위 보호자 동시 알림 (미응답 3회)",
            "level3": "등록 보호자 전원 문자+전화 (30분 무응답, 최대 5명)",
        },
        "legal": "정통망법 §50 — 부모님 사전 수신 동의 필수",
    }


@router.get("/groups/{group_id}/status")
def get_group_status(group_id: str, user=Depends(get_current_user)):
    """가족 그룹 알림 현황 대시보드"""
    return {
        "group_id": group_id,
        "today_reminders": [],
        "parent_responses": {},
        "legal_note": "개인정보보호법 §23 — 민감정보 암호화 보관",
    }
