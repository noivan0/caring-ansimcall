# 케어링 (Caring Ansimcall) Dockerfile
FROM node:20-alpine

WORKDIR /app

# bcrypt 네이티브 빌드용
RUN apk add --no-cache python3 make g++

# 의존성 설치 (레이어 캐시 최적화)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# 소스 복사
COPY src/ ./src/
COPY public/ ./public/

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3001}/api/v1/health || exit 1

CMD ["node", "src/app.js"]
