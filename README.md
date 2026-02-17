# Horizon Website + Inquiry Backend

This project is a static website plus an Express backend for contact form submissions.

## Local setup

1. Install dependencies:
   `npm install`

2. Set an admin key (required for `/admin.html` to load inquiries):
   - PowerShell:
     `$env:ADMIN_KEY="replace-with-a-strong-secret"`

3. Start the app:
   `npm start`

4. Open:
   - Main site: `http://localhost:3000`
   - Contact page: `http://localhost:3000/contact.html`
   - Admin page: `http://localhost:3000/admin.html`

## Deploy online (public access)

This repo is ready for Render deployment via `render.yaml`.
It now provisions a managed PostgreSQL database and connects it through `DATABASE_URL`,
so inquiries persist across deploys/pushes.

1. Push this folder to a GitHub repo.
2. Create a Render account and connect GitHub.
3. Click **New +** -> **Blueprint**.
4. Select your repo; Render will detect `render.yaml` and create the web service.
5. In Render service settings, set `ADMIN_KEY` to a strong secret (or keep generated value and copy it for admin use).
6. Deploy. You will get a public URL like:
   `https://your-service-name.onrender.com`

Use these URLs after deploy:
- Public site: `https://your-service-name.onrender.com`
- Contact form: `https://your-service-name.onrender.com/contact.html`
- Admin viewer: `https://your-service-name.onrender.com/admin.html`

## Important notes

- The contact form now submits in a backend-compatible format and is saved by `POST /api/inquiries`.
- In production (when `DATABASE_URL` exists), inquiries are stored in PostgreSQL and persist through code pushes/redeploys.
- In local development (without `DATABASE_URL`), inquiries are stored in `inquiries.json`.

## Pushing updates without losing inquiries

1. Commit and push code updates to GitHub.
2. Let Render auto-deploy (or trigger manual deploy).
3. Keep the same Render PostgreSQL database attached to the service.

As long as the service still uses the same database, your inquiry history stays intact.