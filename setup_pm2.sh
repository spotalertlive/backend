#!/bin/bash
# ===========================================
# SpotAlert Backend PM2 Auto-Setup (FINAL v6)
# ===========================================

echo "🚀 Starting SpotAlert backend setup..."

# Navigate to backend folder
cd ~/spotalertlive || { echo "❌ Folder not found"; exit 1; }

# Install Node 18 LTS (required for AWS SDK + ES Modules)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs sqlite3

# Install PM2 globally
sudo npm install -g pm2

# Install backend dependencies
npm install --force

# Ensure uploads folder exists
mkdir -p uploads

# Load environment variables
if [ -f "final.env" ]; then
  echo "🔐 Loading environment variables..."
  export $(grep -v '^#' final.env | xargs)
fi

# Stop old PM2 app (if exists)
pm2 delete spotalert 2>/dev/null

# Start backend with production mode
echo "▶️ Starting SpotAlert backend..."
pm2 start server.js --name "spotalert" --env production

# Enable PM2 auto-start
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu

echo ""
echo "✅ SpotAlert backend running!"
echo "🌐 API available at: http://54.159.59.142:3000"
echo "🟢 Health: http://54.159.59.142:3000/health"
