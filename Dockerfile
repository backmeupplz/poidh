FROM oven/bun:1.4.4-alpine
RUN apk add --no-cache vips-tools
WORKDIR /app
COPY server.ts ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["bun", "server.ts"]
