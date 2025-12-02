#!/bin/bash
echo "🚀 Deploying SpotAlert Backend..."

cd ~/backend || { echo "❌ backend folder missing"; exit 1; }

# Install dependencies ONLY
npm install --force

# Ensure uploads folder exists
mkdir -p uploads

# Restart PM2 cleanly
pm2 delete backend 2>/dev/null
pm2 start server.js --name backend

pm2 save
