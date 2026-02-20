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
- The contact page now uses request timeouts and explicit success/error states so users are not left in a loading state.
- If primary inquiry storage is temporarily unavailable, the backend queues submissions in `inquiry-backlog.json` and retries automatically.
- If the browser cannot reach the server, non-attachment submissions are queued in local browser storage and auto-retried when connectivity returns.
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

## Load testing (local)

This repo includes a lightweight load test utility: `load-test.js`.

Usage:
- `node load-test.js <baseUrl> <path> <requests> <concurrency> <method>`

Examples:
- Baseline health endpoint:
   - `node load-test.js http://localhost:3000 /health 1000 100 GET`
- Inquiry submission endpoint:
   - `node load-test.js http://localhost:3000 /api/inquiries 400 40 POST`

Result fields include throughput, success count, rate-limited count, failed count, and latency percentiles (`p50`, `p95`, `p99`).

Important:
- `POST /api/inquiries` is rate-limited by design (anti-spam), so high-volume tests from one IP will return many `429` responses.
- To measure raw backend capacity (instead of anti-spam behavior), use `/health` or temporarily increase rate-limit settings in a staging environment.

## Admin features

- Status workflow: `new`, `in-progress`, `resolved`
- Search and filters: text query, email, request type, status, date range
- Edit inquiry details
- Delete inquiry with confirmation
- Attachment download links in the admin table
- Analytics summary cards and activity audit feed
- Backlog status + manual backlog flush controls in the admin page

Backlog admin APIs (admin key required):
- `GET /api/admin/inquiries/backlog`
- `POST /api/admin/inquiries/backlog/flush` (optional JSON body: `{ "limit": 100 }`)

## Client portal features

- User account registration and login
- Sign in supports username, email, or phone number
- Optional phone number can be stored during account registration
- JWT-based authenticated sessions for portal APIs
- Project progress dashboard for logged-in users
- Dashboard stats/graphs: completion, budget usage, and weeks-to-deadline
- Left-side slide-out menu with hamburger button and logout action
- Side-menu **Settings** area for accessibility controls and logout
- Account settings in portal: profile (email/phone), password change, and "log out other sessions"
- Admin progress update API: `POST /api/admin/user-progress` (requires admin key)
- Admin account reset API: `POST /api/admin/users/reset` (requires admin key; clears all client accounts/progress)

Account settings APIs (authenticated user):
- `GET /api/user/settings`
- `PATCH /api/user/settings` with `{ "email": "...", "phone": "..." }`
- `POST /api/user/settings/password` with `{ "currentPassword": "...", "newPassword": "..." }`
- `POST /api/user/settings/sessions/revoke-others`

`POST /api/admin/user-progress` accepts:
- `identity` (username/email)
- `projectName`
- `status`
- `percentComplete`
- `deadlineDate` (`YYYY-MM-DD`)
- `budgetTotal`
- `budgetUsed`
- `summary`

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
- `SMTP_CONNECTION_TIMEOUT_MS` (optional, default `10000`)
- `SMTP_SOCKET_TIMEOUT_MS` (optional, default `10000`)
- `SMTP_RETRY_COOLDOWN_MS` (optional, default `300000`; temporary pause after timeout errors)
- `BACKUP_CRON` (optional cron override for backup frequency; default is `*/15 * * * *`)
- `BACKLOG_FLUSH_CRON` (optional cron override for queued inquiry retry frequency; default is `*/2 * * * *`)
- `AUTH_JWT_SECRET` (recommended in production for account session token signing)
- `TRUST_PROXY` (recommended for reverse-proxy hosts; set `1` on Render so rate limits use real client IPs)
- `ENABLE_SECURITY_HEADERS` (optional, default `true`; enables CSP and hardening headers)
- `SECURITY_HSTS_ENABLED` (optional, default `true` on Render, else `false`; sends HSTS on HTTPS requests)
- `REQUEST_LOGGING_ENABLED` (optional, default `true`; structured JSON request logs with request IDs)
- `LOGIN_RATE_LIMIT_MAX` (optional, default `15` per 15 minutes)
- `REGISTER_RATE_LIMIT_MAX` (optional, default `25` per 15 minutes)
- `ADMIN_RATE_LIMIT_MAX` (optional, default `250` per 15 minutes)
- `FAILED_LOGIN_LIMIT` (optional, default `8`; lock user/IP combo after failed attempts)
- `FAILED_LOGIN_LOCK_MS` (optional, default `900000` / 15 minutes)

If SMTP values are not provided, the app still works but email notifications/alerts are disabled.

## Security hardening defaults

The backend now includes:

- Security headers (`Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, etc.)
- Optional HSTS on HTTPS
- Structured request logging with `X-Request-Id`
- Separate rate limits for login, registration, and admin routes
- Temporary lockout after repeated failed login attempts

If you see `ETIMEDOUT` from Nodemailer on Render, your SMTP host/port is unreachable or blocked. In that case:
- Verify `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, and `SMTP_PASS` exactly match your provider docs.
- Use provider-supported submission ports (`587` with `SMTP_SECURE=false`, or `465` with `SMTP_SECURE=true`).
- Confirm your provider allows connections from Render's region/IP ranges.

## Accessibility (WCAG AA) verification checklist

The UI is designed with AA-oriented contrast tokens for both light and dark themes.
Accessibility and logout controls are available in the slide-out side menu under **Settings**.
Accessibility tools are nested in the **Accessibility** section inside Settings:

- Ultra contrast toggle
- Text size scaling
- Image magnifier scaling
- Built-in text-to-speech tools (read page, read selection, pause/resume, stop)

Keyboard shortcuts:
- `Alt+Shift+A` open side menu and focus Accessibility section
- `Alt+Shift+R` read current page content aloud
- `Alt+Shift+S` stop text-to-speech

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