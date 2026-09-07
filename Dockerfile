FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npx playwright install --with-deps chromium && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

EXPOSE 3000
CMD ["npm", "start"]
