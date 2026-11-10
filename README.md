# Lazy Organizer

## Run

```powershell
cd backend
npm install
npm start
```

The backend listens on `http://127.0.0.1:3000`. Its MCP endpoint is `http://127.0.0.1:3000/mcp` and requires the `MCP_API_KEY` from `backend/.env`.

The backend uses Prisma with SQLite. Set `DATABASE_URL=file:../data/organizer.db` in `backend/.env`; `npm start` synchronizes the schema automatically. Use `npm run db:studio` from `backend` to inspect or edit data in Prisma Studio.

## Login

The browser app uses Better Auth with a username/password and a 30-day HttpOnly session cookie. Nothing in the organizer is mounted or fetched before the session check succeeds; otherwise the app redirects to the plain `/login` page. Add these values to `backend/.env` before starting the backend:

```dotenv
AUTH_USERNAME=your_username
AUTH_PASSWORD=your-password-at-least-12-characters
BETTER_AUTH_SECRET=your-stable-secret
BETTER_AUTH_URL=https://organizer.calvinwu.com
```

Use 1-30 letters, numbers or underscores for the username and 12-128 characters for the password. Generate the stable secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Use `BETTER_AUTH_URL=http://localhost:5173` for Vite development; the URL must match the browser origin. Production requires HTTPS. Never put these values in frontend `VITE_*` variables.

The single owner is created or updated at startup. Changing either credential revokes existing sessions at the next restart. Sessions expire 30 days after login, without sliding renewal; sign out revokes them immediately. All `/api/*` routes require the browser session except the three login/session/sign-out endpoints. Public registration and other auth endpoints are disabled. Browser mutations must come from `BETTER_AUTH_URL`.

MCP remains separate and continues to use `MCP_API_KEY` at `/mcp`; browser cookies cannot authenticate MCP and the MCP key cannot authenticate browser APIs. Rebuild both services when deploying. The existing startup command adds the auth tables without replacing organizer data. All data remains one shared organizer, not separate per-user workspaces.

Run `npm test` from `backend` for login/API/MCP integration checks and `npm run check:auth` from `frontend` to verify that no organizer markup renders before session verification.

## Google Calendar

The Calendar view has a **Connect Google Calendar** button. After authorization, it automatically syncs both directions with your primary Google calendar when you open Calendar or return to the tab with Calendar active. Automatic attempts are throttled to once every two minutes, including failed attempts. **Sync now** bypasses the wait. Syncs do not overlap, and authorization is never started automatically.

Register this exact authorized redirect URI on your Google Cloud Web OAuth client:

```text
https://organizer.calvinwu.com/api/integrations/google/callback
```

Enable the Google Calendar API and configure these values in `backend/.env` (or your deployment's backend environment):

```dotenv
GOOGLE_CLIENT_ID=your-web-client-id
GOOGLE_CLIENT_SECRET=your-web-client-secret
GOOGLE_TOKEN_ENCRYPTION_KEY=your-base64-encoded-32-byte-key
GOOGLE_REDIRECT_URI=https://organizer.calvinwu.com/api/integrations/google/callback
GOOGLE_APP_ORIGIN=https://organizer.calvinwu.com
```

Generate the encryption key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Keep this key stable and private; changing it makes existing stored Google tokens unreadable. Never put these secrets in frontend `VITE_*` variables. `backend/.env.example` lists configuration placeholders.

Back up SQLite before deploying. Restart/rebuild the backend and frontend after configuring credentials; the backend startup runs `prisma db push` to add the integration tables and event fields. Docker Compose already loads `backend/.env`.

Better Auth protects browser APIs, including `/api/integrations/google/*`. Keep direct backend access private. Cloudflare Access is optional additional protection; if enabled, configure `/mcp` separately so MCP clients can reach its API-key authentication without a browser login. OAuth callbacks require HTTPS for their secure cookie and a valid organizer session. This integration is a single shared Google connection for the organizer. If your OAuth consent screen is in external Testing mode, Google can expire refresh tokens after seven days; reconnect or configure the appropriate production publishing status.

### Sync Behavior

- Creates, edits, and deletions sync on automatic or manual attempts, including local changes made through MCP. If both sides changed since the previous sync, Google wins; concurrent edits made during a sync are protected and reported for retry. This is not a continuous background timer; opening Calendar or returning to the tab triggers the automatic check.
- New events are synced from 30 days ago through 366 days ahead. Previously mapped events continue to be checked outside that window.
- Title, description, dates, times, and timezone sync. All-day and multi-day events are supported; all-day end dates are exclusive. Existing Google attendees, reminders, location, and other metadata are preserved but not exposed locally.
- Deadlines, including task-created deadlines, sync as one-minute timed Google events with a private deadline marker. Google edits preserve their local deadline identity and zero duration; changing the Google duration does not turn them into ordinary events. An all-day Google edit becomes a midnight deadline locally.
- Moving a deadline in Google updates only linked tasks whose due date matches the deadline's previous date; deleting it clears only those matching due dates and deletes the local deadline. Task titles and descriptions are not changed. Links with different or absent due dates are treated as mentions and left alone. Deleting a local deadline deletes its mapped Google event through the usual sync flow.
- Recurring Google instances, already-generated local occurrences and the first deadline of a recurring series sync as individual events, without Google recurrence rules. Local deadline recurrence settings are preserved on pull. Recurrence rules are not synchronized or generated by sync; ordinary local recurrence roots remain skipped. Google schedule changes to recurring deadline roots are explicitly skipped: move those in Organizer instead. Deleting a deadline root in Google deletes its local generated occurrences too; their mapped Google deletions follow on subsequent syncs. Unsupported Google event types and sub-minute times are skipped, with counts displayed in the UI.
- Sync is resumable, not an all-or-nothing transaction. If a request fails, some changes may already have applied; retry the button to continue. Persistent mappings and conditional Google writes protect against duplicate exports and overwriting newer remote edits.
- Disconnect removes stored credentials but keeps events and mappings. Reconnect the same account/calendar to resume. Disconnect does not revoke Google's consent; remove the app in your Google account settings to revoke access entirely.

Backend integration tests use mocked Google responses and disposable SQLite databases: run `npm test` from `backend`. Live Google authorization must be verified on your configured domain.

## Connect Hermes

Copy the same key into `~/.hermes/.env`:

```dotenv
ORGANIZER_MCP_API_KEY=<the MCP_API_KEY value from backend/.env>
```

Add this to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  lazy_organizer:
    url: "http://127.0.0.1:3000/mcp"
    headers:
      Authorization: "Bearer ${ORGANIZER_MCP_API_KEY}"
    tools:
      exclude: []
```

Restart Hermes, then ask it to inspect or change the organizer. Hermes registers these as `mcp_lazy_organizer_<tool>` and can manage task metadata and recurrence, move and delete tasks, manage checklists, link tasks to events or notebooks, manage recurring calendar events and deadlines, add comments, and manage notebooks.
S

## Verify

With the backend running:

```powershell
cd backend
npm run check:mcp
```

The check performs an authenticated MCP handshake, discovers the tools, then creates, updates, and deletes a card.
