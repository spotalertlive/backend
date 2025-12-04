#!/bin/bash
echo "🚀 Deploying SpotAlert Backend..."

# 1️⃣ Make sure backend folder exists
cd ~/backend || { 
  echo "❌ backend folder missing"; 
  exit 1; 
}

# 2️⃣ Install ONLY required dependencies (safe)
echo "📦 Installing backend dependencies..."
npm install --force

# 3️⃣ Ensure SQLite DB + uploads folder exist
echo "📁 Ensuring required folders exist..."
mkdir -p uploads
touch spotalert.db

# 4️⃣ Restart PM2 in clean mode
echo "🔁 Restarting PM2..."
pm2 delete backend 2>/dev/null
pm2 start server.js --name backend

# 5️⃣ Save PM2 state so it auto-starts after reboot
pm2 save

echo "✅ Backend deployed successfully!"
echo "🌐 Running on port 3000"
