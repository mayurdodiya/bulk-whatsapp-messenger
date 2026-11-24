# Deploying Bulk WhatsApp Sender

This app needs an **always-on server with a permanent disk**. It keeps a live connection to WhatsApp for every customer, runs campaigns for hours, pushes live progress over WebSockets, and stores WhatsApp sessions and files on disk.

**Vercel, Netlify and other "serverless" hosts cannot run it.** They stop the app after each request and wipe the disk, which causes `500 FUNCTION_INVOCATION_FAILED`.

Pick one of the options below.

---

## Option A: Railway (easiest, deploys from GitHub like Vercel)
Cost: Hobby plan, about $5 a month.

1. Go to https://railway.com, sign in with GitHub, then **New Project → Deploy from GitHub repo** and pick `bulk-whatsapp-messenger`. Railway finds the `Dockerfile` and builds it automatically.
2. Open the service, go to **Variables**, and add:
   | Name | Value |
   |---|---|
   | `MONGODB_URI` | your MongoDB Atlas connection string |
   | `ADMIN_EMAIL` | admin login email |
   | `ADMIN_PASSWORD` | admin login password |
   | `ADMIN_NAME` | `Admin` |
   | `SUPPORT_PHONE` | `+91 8347337661` |
   | `APP_TIMEZONE` | `Asia/Kolkata` |
   | `COOKIE_SECURE` | `true` |
   | `DATA_DIR` | `/data` |

   Don't set `PORT`; Railway sets it.
3. **Add a volume.** Right-click the service, choose **Attach Volume**, and set the mount path to **`/data`**. Without it, everyone's WhatsApp login and files are lost on every deploy.
4. In **Settings → Networking**, click **Generate Domain**. You get an `https://…up.railway.app` address, and you can add your own domain there later.
5. In **Settings → Deploy**, set the health check path to **`/healthz`**. Keep **1 replica**: WhatsApp sessions live on one server.
6. In **MongoDB Atlas → Network Access**, click **Add IP Address**, then **Allow access from anywhere** (`0.0.0.0/0`). Railway has no fixed IP, so use a strong database password.
7. Open the domain, sign in as admin, go to **Connect & contacts**, and scan the QR code. This server is a new "linked device", so it needs its own scan.

Updating later: push to `main` and Railway redeploys automatically. Running campaigns pause during the restart and can be resumed.

---

## Option B: Your own VPS (DigitalOcean, Hetzner, Hostinger VPS, AWS Lightsail…)
Cost: about ₹400–800 a month for 2 GB RAM, which is enough for roughly 15–20 connected customers.

On a fresh Ubuntu server:

```bash
# 1. Node.js 22 + tools
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx
sudo npm install -g pm2

# 2. App
git clone https://github.com/mayurdodiya/bulk-whatsapp-messenger.git
cd bulk-whatsapp-messenger
npm ci --omit=dev
cp .env.example .env && nano .env        # fill in the values; set COOKIE_SECURE=true
npm run seed                              # creates the admin

# 3. Keep it running (also after reboots)
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Then set up Nginx with HTTPS. Replace `your-domain.com`, and point the domain's DNS A record at the server first.

```nginx
# /etc/nginx/sites-available/bulk-sender
server {
  server_name your-domain.com;
  client_max_body_size 70m;              # uploads up to 64 MB
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # live progress (WebSocket)
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/bulk-sender /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com          # free HTTPS certificate
```

Add the server's IP in **MongoDB Atlas → Network Access**.

Updating later: `git pull && npm ci --omit=dev && pm2 restart bulk-sender`.
Back up the `data/` folder regularly. It holds every customer's WhatsApp login and files.

---

## Option C: Docker anywhere (Render, Fly.io, a VPS with Docker)
```bash
docker build -t bulk-sender .
docker run -d --name bulk-sender -p 3000:3000 --env-file .env -e DATA_DIR=/data -v bulk-data:/data --restart unless-stopped bulk-sender
```
On Render, create a **Web Service** from the repo (it uses the Dockerfile), add a **Disk** mounted at `/data`, and add the variables from Option A.
