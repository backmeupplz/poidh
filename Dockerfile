FROM oven/bun:1.4.5-alpine@sha256:da816670775f4c2b4e990b6b1847cf5540dcdc721a42033dd331ce7a88ba6a3b
RUN apk add --no-cache vips-tools font-noto-emoji
COPY fonts /usr/share/fonts/geist
WORKDIR /app
COPY server.ts ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["bun", "server.ts"]
