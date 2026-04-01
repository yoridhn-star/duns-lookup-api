# ── Base image ────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

# ── System dependencies for Playwright Chromium + Xvfb ───────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Xvfb (virtual framebuffer)
    xvfb \
    # Chromium system libs (Playwright will install its own binary but needs these)
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libcairo2 \
    libglib2.0-0 \
    libdbus-1-3 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    # Font support
    fonts-liberation \
    fonts-noto-color-emoji \
    # Process management
    procps \
    && rm -rf /var/lib/apt/lists/*

# ── App directory ─────────────────────────────────────────────────────────────
WORKDIR /app

# ── Install Node dependencies first (cached layer) ───────────────────────────
COPY package.json ./
RUN npm install --omit=dev

# ── Install Playwright Chromium binary ───────────────────────────────────────
RUN npx playwright install chromium

# ── Copy application source ───────────────────────────────────────────────────
COPY server.js ./

# ── Environment defaults ──────────────────────────────────────────────────────
ENV PORT=3001
ENV DISPLAY=:99
ENV NODE_ENV=production

# ── Expose port ───────────────────────────────────────────────────────────────
EXPOSE ${PORT}

# ── Entrypoint: start Xvfb then the Node server ──────────────────────────────
# We use a small shell script so Xvfb has time to initialise before Node starts.
CMD Xvfb :99 -screen 0 1280x720x24 -nolisten tcp & \
    sleep 1 && \
    DISPLAY=:99 node server.js
