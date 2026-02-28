# Web Proxy – Deployment Guide

## Local Development
1. Clone the repository.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and adjust values.
4. Start with `npm start` (or `npm run dev` for nodemon).
5. Visit `http://localhost:3000`.

## Deploy to VPS (Ubuntu 20.04+)
1. Transfer files to your server.
2. Install Node.js (v18+) and npm.
3. Run `npm install --production`.
4. Use PM2 to keep the app alive:
