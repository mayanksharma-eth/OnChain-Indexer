FROM node:22-alpine
WORKDIR /app
RUN npm install -g pnpm@10.14.0

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

ENV NODE_ENV=production
