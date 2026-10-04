# 字幕校对平台 —— 一键启动镜像
FROM node:20-bookworm-slim

# better-sqlite3 使用预编译二进制；保留构建工具链以应对极少数需要本地编译的环境
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 优先拷贝依赖清单以利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 拷贝应用代码
COPY src ./src
COPY public ./public

# 数据目录（SQLite 数据库与上传的视频文件），由卷持久化
RUN mkdir -p /data/videos
ENV DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0 \
    MAX_UPLOAD_MB=2048

EXPOSE 3000

# 容器启动即自动建表、初始化数据
CMD ["node", "src/server.js"]
