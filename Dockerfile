FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Install Playwright browsers and their system dependencies
RUN npx playwright install --with-deps chromium

COPY . .

CMD ["npm", "start"]