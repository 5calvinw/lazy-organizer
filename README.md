# Lazy Organizer

## Run

```powershell
cd backend
npm install
npm start
```

The backend listens on `http://127.0.0.1:3000`. Its MCP endpoint is `http://127.0.0.1:3000/mcp` and requires the `MCP_API_KEY` from `backend/.env`.

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
