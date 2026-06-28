# Minimate — Setup Guide

## Quick Start (Demo Mode — No Database)

Run locally without any database. Data resets on page refresh.

### Steps

1. Open a terminal in the `automatex-app` folder:
   ```
   cd D:\personal\ControlSystems\automatex-app
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the dev server:
   ```
   npx vite
   ```

4. Open http://localhost:5173 — you'll see the project selector.
5. Click **CONTINUE IN DEMO MODE** to enter the app without persistence.

---

## Full Setup (Supabase — Data Persists Across Devices)

### 1. Create a Supabase Project

1. Go to https://supabase.com and sign up (free tier is fine).
2. Click **New Project**.
3. Name it `minimate` (or whatever you like).
4. Set a database password — save it somewhere safe.
5. Choose a region close to you (e.g., Middle East or Europe).
6. Wait for the project to finish provisioning (~2 minutes).

### 2. Run the Database Schema

1. In your Supabase dashboard, click **SQL Editor** in the left sidebar.
2. Click **New query**.
3. Open the file `supabase/schema.sql` from this project folder.
4. Copy-paste the entire contents into the SQL editor.
5. Click **Run** (or Ctrl+Enter).
6. You should see "Success. No rows returned" — that means the projects table was created.

### 3. Configure Environment Variables

1. In the Supabase dashboard, go to **Settings > API**.
2. Copy the **Project URL** (looks like `https://abcdefgh.supabase.co`).
3. Copy the **anon/public** key (the longer string).
4. In the `automatex-app` folder, create a `.env` file:
   ```
   copy .env.example .env
   ```
5. Edit `.env` and paste your values:
   ```
   VITE_SUPABASE_URL=https://your-actual-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-actual-anon-key
   ```

### 4. Restart and Go

```
npx vite
```

The app will now show the project selector. Create a project, import your Excel files, and all data persists — even across browser refreshes, different devices, and different networks.

---

## Deploy to Vercel (Free)

### 1. Push to GitHub

1. Create a new GitHub repository.
2. In the project folder:
   ```
   git init
   git add .
   git commit -m "Minimate v0.2"
   git remote add origin https://github.com/YOUR_USERNAME/minimate.git
   git push -u origin main
   ```

### 2. Deploy on Vercel

1. Go to https://vercel.com and sign up with GitHub.
2. Click **Add New > Project**.
3. Import your repository.
4. Framework Preset: **Vite** (auto-detects).
5. In **Environment Variables**, add:
   - `VITE_SUPABASE_URL` = your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` = your Supabase anon key
6. Click **Deploy**.
7. Done — share the URL with your team.

---

## Project Structure

```
automatex-app/
  src/
    components/       UI components (Sidebar, StatusBadge, ProgressBar)
    pages/            Page views (Dashboard, PanelsList, PanelDetail, CommDevices, ProjectSelector)
    lib/
      supabase.js     Supabase client initialization
      supabaseDb.js   Load/save/list/create project functions
      smartParser.js  Auto-detecting Excel parser (IO list, termination, FCU/VAV)
      controllerModules.js  DDC controller/module templates
      demoData.js     Empty initial state (demo mode fallback)
    App.jsx           Main app with routing, state, and persistence
    main.jsx          Entry point
    index.css         Tailwind v4 theme
  supabase/
    schema.sql        Database schema (single projects table with JSONB data)
  .env.example        Template for Supabase credentials
```
