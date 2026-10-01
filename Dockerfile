FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Ticketmaster blocks Playwright's bundled Chromium and headless browsers, so prices are read in
# Google Chrome running in a virtual display (Google Chrome for Linux is amd64 only)
RUN npx playwright install --with-deps chrome \
    && apt-get update && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/opt/google/chrome/chrome

COPY . .

CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1920x1080x24", "npm", "start"]
