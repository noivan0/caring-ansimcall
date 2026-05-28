# /health/live + /health/ready 헬스엔드포인트 운영 가이드

> 버전: 1.0.0  
> 작성일: 2026-05-27  
> 출처: nova-learn 통합 패턴 (t_d422a0dc → t_bc0b22d5 문서화)  
> 적용 서비스: 케어링(caring-api) FastAPI 서버

---

## 개요

K8s/컨테이너 환경에서 두 개의 헬스 프로브를 분리 운영합니다:

| 엔드포인트 | 목적 | 체크 대상 | 인증 |
|---|---|---|---|
| `GET /health/live` | Liveness probe — 프로세스 생존 확인 | 없음 (항상 200) | 불필요 |
| `GET /health/ready` | Readiness probe — 트래픽 수신 가능 여부 | DB 연결 상태 | 불필요 |

---

## 개발자 가이드

### 엔드포인트 명세

#### GET /health/live
프로세스가 살아있는지만 확인합니다. DB가 다운되어도 200을 반환합니다.

```
Response 200
{
  "status": "alive",
  "service": "caring-api"
}
```

#### GET /health/ready
DB(PostgreSQL) 연결 상태를 확인하고, 트래픽 수신 가능 여부를 반환합니다.

```
Response 200 — 정상
{
  "status": "ready",
  "service": "caring-api",
  "db": "ok"          // DB 연결 성공
}

Response 200 — DB URL 없음(개발환경 등)
{
  "status": "ready",
  "service": "caring-api",
  "db": "skipped"
}

Response 503 — DB 연결 실패
{
  "status": "not_ready",
  "service": "caring-api",
  "db": "error"
}
```

### 구현 위치
- `src/api/main.py` — `/health`, `/health/live`, `/health/ready` 구현
- `tests/test_health_probe.py` — 전체 시나리오 테스트 (7개 케이스)

---

## 운영자 가이드

### K8s probe 설정 권장값

```yaml
# K8s Deployment 예시
livenessProbe:
  httpGet:
    path: /health/live
    port: 8000
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health/ready
    port: 8000
  initialDelaySeconds: 15
  periodSeconds: 5
  failureThreshold: 3
```

### 모니터링 알림 기준
- `/health/ready` 503 연속 3회 → DB 연결 문제 알림 발생
- `/health/live` 응답 없음 → pod 재시작 트리거

### 장애 대응
1. `/health/ready` 503 시: DB 연결풀 상태 점검 (`SELECT 1` 직접 실행)
2. `/health/live` 200 + `/health/ready` 503: DB 문제이므로 앱 재시작 불필요 — DB 복구 후 자동 회복
3. `/health/live` 응답 없음: 앱 프로세스 문제 — pod 재시작

---

## 보안 가이드

### STRIDE 위협 분석 (헬스 엔드포인트)

| 위협 | 설명 | 대응 |
|---|---|---|
| **Information Disclosure** | 에러 메시지에 DB 연결 정보 노출 | `db=error` 메시지만 반환, 상세 예외 미노출 |
| **DoS** | 헬스 엔드포인트 반복 호출로 DB 부하 | connect_timeout=3s 설정, K8s probe 주기 합리적 설정 |
| **Spoofing** | 외부에서 헬스 상태 조작 | 헬스 엔드포인트는 GET 전용, 인증 불필요하지만 쓰기 불가 |

### 적용된 보안 조치
- `connect_timeout=3` 설정으로 DB 연결 hang 방지 (I/O timeout 가드)
- 에러 시 상세 예외 로그는 서버 사이드만, 응답엔 `"db": "error"` 최소 노출
- `debug=False` 설정으로 스택트레이스 외부 노출 차단

---

## 통합 패턴 (nova-learn 학습 결과)

### Pattern 1: Redis 연결풀 싱글톤 [weight=0.92 GOLD]

프로덕션에서 매 요청 신규 Redis 연결 생성은 절대 금지입니다.

```python
# 금지 패턴 — 매 헬스체크마다 신규 연결
async def bad_check():
    client = redis.createClient()
    await client.connect()
    await client.ping()
    await client.quit()  # 연결 고갈 위험

# 표준 패턴 — module-level 싱글톤 재사용
import redis.asyncio as aioredis
redis_pool = aioredis.Redis(
    host="redis", port=6379,
    socket_connect_timeout=2,  # 필수
    socket_timeout=1,          # 필수
)

async def good_check():
    return await redis_pool.ping()  # pool 재사용
```

현재 `/health/ready`는 DB만 체크합니다. Redis 의존성 추가 시 위 패턴을 적용하세요.

### Pattern 2: 헬스 의존성 체크셋 통일 [weight=0.88 SILVER]

여러 마이크로서비스가 동일 의존성(DB, Redis 등)을 체크해야 K8s 라우팅이 정확합니다.
서비스별 체크셋이 다르면 장애 발생 시 오판 라우팅이 발생합니다.

```python
# 향후 Redis 추가 시 이 패턴으로 확장
@router.get("/health/ready")
async def readiness():
    checks = {}
    try:
        await db.execute("SELECT 1")
        checks["db"] = "ok"
    except Exception as e:
        checks["db"] = f"fail: {e}"
    try:
        await redis_pool.ping()
        checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"fail: {e}"
    if any("fail" in v for v in checks.values()):
        raise HTTPException(503, detail=checks)
    return {"status": "ready", **checks}
```

### Pattern 3: 헬스체크 I/O timeout 가드 [weight=0.85 SILVER]

모든 헬스체크 I/O에 1-2s timeout 가드가 필수입니다. 미설정 시 K8s pod 교체 루프 진입 가능.

```python
# 현재 적용된 설정 (src/api/main.py)
engine = create_engine(
    db_url,
    pool_pre_ping=True,
    connect_args={"connect_timeout": 3}  # 필수
)
```

---

## Survivorship Bias 경계

현재 학습 근거는 코드 정적 분석 + 패턴 추론입니다.
실제 K8s 클러스터 고부하 테스트는 미시행입니다.

- 스테이징 부하 테스트 후 weight GOLD 격상 가능
- 실증 전 확신도: 80% 수준 유지

---

## DreamCycle 전파 현황

| 타겟 | 전파 내용 | 상태 |
|---|---|---|
| nova-dev | FastAPI /health/ready Redis ping 추가 (P1) | 예정 (다음 스프린트) |
| nova-qa | 헬스 비대칭 감사 체크리스트 추가 (P1) | 예정 |
| nova-cso | 헬스엔드포인트 timeout STRIDE 체크 (P2) | 예정 |
