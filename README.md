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
- Account portal: `https://your-service-name.onrender.com/account.html`
- Admin viewer: `https://your-service-name.onrender.com/admin.html`
- CSV export: `https://your-service-name.onrender.com/api/inquiries.csv?key=YOUR_ADMIN_KEY`
- Monitoring details: `https://your-service-name.onrender.com/health/details`

## Important notes

- The contact form supports optional file attachments (`.pdf`, `.png`, `.jpg`, `.jpeg`, `.txt`, `.doc`, `.docx`, max 5MB) and is saved by `POST /api/inquiries`.
- Contact form includes anti-spam protections (IP rate limiting + honeypot field).
- In production (when `DATABASE_URL` exists), inquiries are stored in PostgreSQL and persist through code pushes/redeploys.
- In local development (without `DATABASE_URL`), inquiries are stored in `inquiries.json`.
- Automated backups run every 15 minutes (recommended default) and are written to `/backups` as JSON + CSV snapshots.
- Account login/sign-up and project-progress tracking are available at `/account.html`.

## Pushing updates without losing inquiries

1. Commit and push code updates to GitHub.
2. Let Render auto-deploy (or trigger manual deploy).
3. Keep the same Render PostgreSQL database attached to the service.

As long as the service still uses the same database, your inquiry history stays intact.

## Export inquiries outside the table view

- Open the admin page and click **Export CSV**.
- You will be prompted for your admin key first (if it is not already entered).
- In supported browsers, a save dialog appears so you can choose where to save the file.
- In browsers without file-picker support, the CSV downloads using the browser's default download behavior.

## Admin features

- Status workflow: `new`, `in-progress`, `resolved`
- Search and filters: text query, email, request type, status, date range
- Edit inquiry details
- Delete inquiry with confirmation
- Attachment download links in the admin table
- Analytics summary cards and activity audit feed

## Client portal features

- User account registration and login
- JWT-based authenticated sessions for portal APIs
- Project progress dashboard for logged-in users
- Left-side slide-out menu with hamburger button and logout action
- Admin progress update API: `POST /api/admin/user-progress` (requires admin key)
- Admin account reset API: `POST /api/admin/users/reset` (requires admin key; clears all client accounts/progress)

## Notification and alert environment variables (optional)

Set these in your deployment platform to enable email notifications and monitoring alerts:

- `SMTP_HOST`
- `SMTP_PORT` (default `587`)
- `SMTP_SECURE` (`true` or `false`)
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM` (optional, defaults to `SMTP_USER`)
- `NOTIFY_EMAIL` (recipient for new inquiry notifications)
- `ALERT_EMAIL` (recipient for health-alert emails)
- `BACKUP_CRON` (optional cron override for backup frequency; default is `*/15 * * * *`)
- `AUTH_JWT_SECRET` (recommended in production for account session token signing)

If SMTP values are not provided, the app still works but email notifications/alerts are disabled.

## Accessibility (WCAG AA) verification checklist

The UI is designed with AA-oriented contrast tokens for both light and dark themes.
Use this quick manual checklist after deploy:

1. **Theme parity**
   - Toggle light/dark mode in the top navigation.
   - Verify text remains readable in both themes for hero, cards, forms, tables, and footer.

2. **Text contrast**
   - Confirm body text, muted text, and links are clearly readable on their backgrounds.
   - Check status messages (`loading`, `success`, `error`) in forms.

3. **Controls and focus visibility**
   - Keyboard-tab through links, buttons, inputs, selects, and textareas.
   - Ensure a visible focus indicator appears on each interactive element.

4. **Data table readability**
   - Validate header-to-cell contrast and row text clarity in the admin inquiry table.
   - Confirm status select controls are readable and focusable.

5. **Automated spot check (recommended)**
   - Run Lighthouse accessibility audit in Chrome DevTools for both themes.
   - Resolve any flagged contrast issues before production rollout.