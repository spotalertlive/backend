#!/bin/bash
echo "🚀 Deploying SpotAlert Backend..."

# 1️⃣ Make sure backend folder exists
cd ~/backend || { 
  echo "❌ backend folder missing"; 
  exit 1; 
}

# 2️⃣ Install dependencies
echo "📦 Installing backend dependencies..."
npm install --force

# 3️⃣ Ensure SQLite DB exists
echo "📁 Ensuring database exists..."
touch spotalert.db

# 4️⃣ Restart PM2 CLEANLY with env loaded
echo "🔁 Restarting PM2..."
pm2 delete backend 2>/dev/null
pm2 start server.js \
  --name backend \
  --env production \
  --update-env

# 5️⃣ Save PM2 state
pm2 save

echo "✅ Backend deployed successfully!"
echo "🌐 API running on port 3000"
