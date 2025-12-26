# 🚀 Deploy Guide: Paxi Governance to Railway

## 📋 Prerequisites

- GitHub account connected to Railway
- Railway account
- PostgreSQL database (Railway provides this)

## 🔧 Step-by-Step Deployment

### 1. **Prepare Your GitHub Repository**

Add these files to your repo root:

```
your-repo/
├── server.js
├── package.json
├── Dockerfile          ← NEW
├── .dockerignore       ← NEW
├── railway.toml        ← NEW (optional)
└── .env.example
```

### 2. **Create Dockerfile**

Copy the `Dockerfile` content to your repo. This dockerfile will:
- ✅ Use Node.js 18 slim image
- ✅ Download and install Paxid CLI automatically
- ✅ Install your Node.js dependencies
- ✅ Run health checks

### 3. **Create .dockerignore**

```plaintext
node_modules
npm-debug.log
.env
.git
.gitignore
README.md
.DS_Store
*.md
.vscode
.idea
```

### 4. **Create railway.toml (Optional)**

```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "Dockerfile"

[deploy]
startCommand = "node server.js"
healthcheckPath = "/health"
healthcheckTimeout = 100
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

### 5. **Push to GitHub**

```bash
git add Dockerfile .dockerignore railway.toml
git commit -m "Add Docker support for Paxid CLI"
git push origin main
```

### 6. **Deploy to Railway**

#### Option A: Via Railway Dashboard
1. Go to [Railway Dashboard](https://railway.app/dashboard)
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Choose your repository
5. Railway will auto-detect Dockerfile and deploy

#### Option B: Via Railway CLI
```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Link to project
railway link

# Deploy
railway up
```

### 7. **Add Environment Variables**

In Railway dashboard, add these variables:

```env
DATABASE_URL=<provided_by_railway_postgres>
NODE_ENV=production
PORT=8080
DEV_ADDRESSES=paxi1abc...,paxi1def...,paxi1ghi...,paxi1jkl...,paxi1mno...
CW20_CODE_ID=1
FRONTEND_URL=https://your-frontend.vercel.app
```

### 8. **Add PostgreSQL Database**

1. In Railway project, click **"New"** → **"Database"** → **"Add PostgreSQL"**
2. Railway will automatically set `DATABASE_URL` environment variable
3. Your app will connect automatically

### 9. **Verify Deployment**

Check logs in Railway dashboard:

```
✅ Paxi CLI Found: /usr/local/bin/paxid
📦 Version: v1.x.x
✅ Database Schema Ready & Updated
🚀 Governance Server on port 8080
👥 Authorized Devs: 5
```

### 10. **Test Paxid CLI**

You can verify paxid is installed by checking logs:

```bash
# In Railway dashboard → Deployments → View Logs
# You should see:
✅ Paxi CLI Found: /usr/local/bin/paxid
📦 Version: <version>
```

---

## 🔍 Troubleshooting

### Issue: "paxid: command not found"

**Cause:** Dockerfile didn't install paxid correctly

**Solution:**
1. Check Dockerfile has this line:
   ```dockerfile
   RUN wget -q https://github.com/paxi-web3/paxi/releases/latest/download/paxid-linux-amd64 -O /usr/local/bin/paxid \
       && chmod +x /usr/local/bin/paxid \
       && paxid version
   ```
2. Redeploy the app

### Issue: "Database connection failed"

**Cause:** DATABASE_URL not set

**Solution:**
1. Add PostgreSQL database in Railway
2. Verify `DATABASE_URL` is in environment variables
3. Restart deployment

### Issue: "Port already in use"

**Cause:** Railway expects app to listen on $PORT

**Solution:**
1. Ensure server.js has:
   ```javascript
   const PORT = process.env.PORT || 8080;
   server.listen(PORT, "0.0.0.0", () => {
     console.log(`🚀 Server on port ${PORT}`);
   });
   ```

### Issue: Build fails with "no space left on device"

**Cause:** Docker image too large

**Solution:**
1. Use `node:18-slim` (not `node:18`)
2. Add cleanup in Dockerfile:
   ```dockerfile
   RUN apt-get clean && rm -rf /var/lib/apt/lists/*
   ```

---

## 🎯 Expected Result

After successful deployment, your app should:

✅ Have paxid CLI installed and working
✅ Connect to PostgreSQL database
✅ Respond to health checks at `/health`
✅ Process add_liquidity and remove_liquidity proposals
✅ Auto-restart on failure

---

## 📊 Monitoring

### Railway Dashboard
- **Deployments:** View build logs and deployment status
- **Metrics:** CPU, Memory, Network usage
- **Logs:** Real-time application logs

### Health Check
```bash
curl https://your-app.railway.app/health
# Should return: {"status":"OK"}
```

### Test Liquidity Operations
After deploying, test with a proposal:

```javascript
// Frontend request
{
  actionType: "add_liquidity",
  actionData: {
    tokenContract: "paxi18wpg...",
    paxiAmount: "1000000",
    tokenAmount: "16000"
  }
}
```

Check logs for:
```
💧 Adding Liquidity via Paxi CLI...
📝 Importing wallet...
✅ Wallet imported
📝 Increasing allowance...
✅ Allowance TX: ABC123...
💧 Providing liquidity...
✅ Liquidity Added! TX: DEF456...
🧹 Cleaning up...
```

---

## 🔐 Security Notes

1. **Environment Variables:** Never commit `.env` to git
2. **Database:** Use Railway's managed PostgreSQL (automatic backups)
3. **Secrets:** DEV_ADDRESSES should be kept secure
4. **Mnemonic:** Never logged, always cleaned from memory after use

---

## 📚 Additional Resources

- [Railway Documentation](https://docs.railway.app/)
- [Dockerfile Best Practices](https://docs.docker.com/develop/develop-images/dockerfile_best-practices/)
- [Paxi Network Docs](https://paxinet.io/paxi_docs/developers)
- [Node.js Docker Guide](https://nodejs.org/en/docs/guides/nodejs-docker-webapp/)

---

## 🆘 Need Help?

If you encounter issues:

1. Check Railway deployment logs
2. Verify all environment variables are set
3. Test locally with Docker:
   ```bash
   docker build -t paxi-governance .
   docker run -p 8080:8080 --env-file .env paxi-governance
   ```
4. Check GitHub repository structure
5. Ensure Dockerfile, .dockerignore, and railway.toml are in repo root

---

**Last Updated:** December 2024
**Tested On:** Railway (December 2024)