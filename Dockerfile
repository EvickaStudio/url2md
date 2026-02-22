FROM mcr.microsoft.com/playwright:v1.55.0-noble

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=512"

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && \
    npm cache clean --force && \
    rm -rf /tmp/*

COPY server.js openapi.json ./
COPY src ./src

USER pwuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
