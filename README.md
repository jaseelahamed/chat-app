# Pulse — Real-Time Messaging, Voice & Video Calling

A real-time communication web app separated cleanly into `backend/` and `frontend/` folders, featuring instant channel & direct messaging, peer-to-peer WebRTC voice and video calls, screen sharing, and a frosted-glass dark UI.

## Project Structure

```text
├── backend/
│   ├── package.json        # Express + Socket.IO backend dependencies
│   └── server.js           # Signaling, messaging, presence server & static frontend host
├── frontend/
│   ├── index.html          # App markup, call modals, and video/audio stage
│   ├── package.json        # Frontend start/dev scripts
│   ├── server.js           # Static frontend dev server (default port 5173)
│   ├── css/
│   │   └── styles.css      # Frosted-glass dark UI & responsive layout
│   └── js/
│       ├── app.js          # Socket.IO client, state, messaging & UI wiring
│       ├── webrtc.js       # WebRTC peer connection, audio/video & screen sharing
│       ├── ui.js           # Safe DOM rendering, reactions, replies & toasts
│       └── sound.js        # Web Audio API chimes & call ringtones
├── package.json            # Root scripts to launch frontend + backend together
└── start.js                # Launches backend (:5000) and frontend (:5173) together
```

## Getting Started

1. **Install backend dependencies** (requires Node.js 18+):
   ```bash
   cd backend
   npm install
   ```
   *(Or run `npm install` from the root folder, which automatically installs `backend/` dependencies.)*

2. **Start both servers on separate ports**:
   - **Together (recommended)** from the root folder:
     ```bash
     npm start
     ```
     This starts the **backend** on port `5000` and the **frontend** on port `5173`.
   - **Or separately** in two terminals:
     ```bash
     # Terminal 1 (Backend on port 5000)
     npm run start:backend

     # Terminal 2 (Frontend on port 5173)
     npm run start:frontend
     ```

3. **Open the app**:
   Visit [http://localhost:5173](http://localhost:5173) in your browser.

   > The frontend connects automatically to the backend Socket.IO server on port `5000` (or pass `?backend=http://localhost:PORT` in the URL if you run the backend on a custom port).

## Testing Two Users Locally

1. Open `http://localhost:5173` in **Tab 1** and join as e.g. `Alex`.
2. Open `http://localhost:5173` in **Tab 2** and join as e.g. `Maya`.
3. Chat in `#General` or click each other under **Direct Messages** to send private messages, start a **Voice Call**, or start a **Video Call**.

> **Note:** Browsers require `localhost` or HTTPS for camera and microphone access via `getUserMedia`.

## Deployment (Render Backend + Netlify Frontend)

1. **Push to GitHub** (root [`.gitignore`](.gitignore) excludes `node_modules/`).
2. **Deploy Backend on Render** (uses [`render.yaml`](render.yaml)):
   - Create a **New Web Service** connected to your GitHub repo (or use **New Blueprint**).
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
   - Copy the deployed Render URL (e.g. `https://pulse-connect-backend.onrender.com`).
3. **Deploy Frontend on Netlify** (uses [`netlify.toml`](netlify.toml)):
   - Create a **New site from Git** connected to the same GitHub repo.
   - Netlify will automatically publish `frontend/`.
   - In **Site configuration -> Environment variables**, add:
     - `BACKEND_URL` = your Render URL (e.g. `https://pulse-connect-backend.onrender.com`)
   - Trigger a redeploy so [`netlify.toml`](netlify.toml) writes `BACKEND_URL` into `frontend/config.js`.
   - *(Optional)* Set `CORS_ORIGIN` on Render to your Netlify URL (e.g. `https://your-site.netlify.app`) to restrict Socket.IO origins.
