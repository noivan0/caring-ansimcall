# ── Stage 1: 의존성 설치 ───────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# 네이티브 빌드 의존성 (bcrypt, pg)
RUN apk add --no-cache python3 make g++ libc6-compat

COPY package.json package-lock.json* ./

# production 의존성만 설치 (prisma CLI 포함)
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# ── Stage 2: 프리즈마 클라이언트 생성 (있을 때만) ────────────────
FROM node:20-alpine AS prisma-gen

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

# prisma/schema.prisma 존재 시 클라이언트 생성
COPY prisma* ./prisma/
RUN [ -f "prisma/schema.prisma" ] && npx prisma generate || echo "Prisma schema not found, skipping"

# ── Stage 3: 실행 이미지 ───────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000

# 보안: non-root 사용자
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nodeapp

# 의존성 복사
COPY --from=prisma-gen --chown=nodeapp:nodejs /app/node_modules ./node_modules

# 소스 복사
COPY --chown=nodeapp:nodejs src/ ./src/
COPY --chown=nodeapp:nodejs package.json ./

# Prisma client (생성된 경우)
COPY --from=prisma-gen --chown=nodeapp:nodejs /app/node_modules/.prisma ./node_modules/.prisma

USER nodeapp

EXPOSE 8000

# 헬스체크: GET /ping
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT||8000) + '/ping', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/app.js"]
