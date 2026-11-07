# Lazy Organizer workspace

React 19 + TypeScript + Vite. The real Today, Tasks, Calendar, and Notebooks views share a paper-and-olive workspace, bundled local serif fonts, responsive navigation, and native modal editors. API routes and payloads are unchanged; no backend or schema changes.

## Local screenshot review (no backend, no credentials)

Use Node 24. From the repository root:

```sh
npm --prefix frontend ci --ignore-scripts --no-audit --no-fund
npm --prefix frontend run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open these **development-server** URLs:

- Today: `http://127.0.0.1:5173/?preview=1#today`
- Tasks: `http://127.0.0.1:5173/?preview=1#tasks`
- Calendar: `http://127.0.0.1:5173/?preview=1#calendar`
- Notebooks: `http://127.0.0.1:5173/?preview=1#notebooks`

The persistent amber label identifies all sample content. The fixtures are relative to the local date, held only in this tab's memory, and reset on reload. These are the real application views and editors, not a separate mock screen. No API request falls through to `fetch`, including unsupported operations. Google integration is disabled in preview. No authentication is bypassed. Without `?preview=1`, the existing `/api` requests and Vite localhost:3000 proxy remain unchanged: **do not open the non-preview app for credential-free review**.

The opt-in is guarded by `import.meta.env.DEV`. Production builds omit the preview module and fixtures; `vite preview` is a production build server and does **not** enable sample mode. Vite's implicit dotenv loading is disabled (`envDir: false`); this frontend has no environment-variable configuration.

### Suggested screenshot surfaces

- Today: editorial heading, task capture, real counts, due/overdue/in-progress groups, schedule. On mobile, Tasks and Schedule switch panels.
- Tasks: open **Shape the first draft of the homepage** for a populated task dialog, checklist, linked notebook/event chips, comments, and attachments. Expand its metadata chips for due date, priority, repeat, color, and keyboard-accessible list movement.
- Calendar: open **Review the first draft** for its schedule/description/activity editor; **Add event** opens the creation dialog. Mobile uses a compact month with counts and a full, tappable agenda instead of tiny event targets.
- Notebooks: open **Website refresh** or **A little room to think** for the rich-text editor, formatting toolbar, and backlinks.
- Task completion/undo, capture, card moves, checklists, comments, local file attachments, events/deadlines, and notebook CRUD mutate the isolated fixtures.

## Validation

From the repository root:

```sh
npm --prefix frontend run build
npm --prefix frontend run lint
npm --prefix frontend test
node frontend/tests/preview.test.mjs
npm --prefix backend run lint
```

The dependency-free Node checks cover seven cases: fixture isolation, task capture/completion/undo, detail CRUD, calendar/deadline CRUD and multi-day overlap, notebooks/backlinks, network isolation, and atomic validation failures. Direct execution prints all seven cases (the installed Node test runner may summarize the file as one passing unit). After building, this command must print nothing:

```sh
rg 'createPreviewRequest|Shape the first draft|Fictional sample content' frontend/dist/assets
```

## Review limitations

- No browser, browser automation, screenshot tools, persistent server, production credentials, or live backend were used during implementation. Desktop/mobile screenshots and interactive visual verification are delegated to the review worker.
- The local preview deliberately does not generate recurring occurrences, emulate linked task/deadline synchronization, or perform external Google sync. Unsupported recurring edits show an explicit error; production recurrence and synchronization still use the unchanged backend.
- Backend integration tests require a generated Prisma client and a temporary database; they were not run for this frontend-only change. Backend syntax checks were run instead.
- The notebook editor retains the existing browser-native rich-text commands and blur-to-save behavior. No autosave queue, offline persistence, search, analytics, or new product features were added.

## Changed files

- `frontend/src/App.tsx`: shared navigation and view headers, responsive surfaces, detail controls, request selection, loading/error/empty states, native-dialog lifecycle, and save/error handling.
- `frontend/src/App.css`, `frontend/src/index.css`: cohesive responsive visual system, local font setup, keyboard focus, reduced-motion and forced-color support.
- `frontend/src/preview.ts`: dev-only isolated fixture adapter, rejecting unsupported requests without network fallback.
- `frontend/tests/preview.test.mjs`, `frontend/package.json`: dependency-free runnable checks and `npm test`.
- `frontend/vite.config.ts`: no implicit dotenv reads; existing API proxy retained.
- `frontend/index.html`, `frontend/public/favicon.svg`: product metadata and matching identity.
- `frontend/README.md`: exact launch, review, and validation instructions.
