# External CLIs (not bus commands, but bundled context)

## agent-browser (Browser Automation)
Rust CLI, replaces Playwright MCP.

- **Binary:** `agent-browser` (npm-installed globally; Chrome auto-downloaded by `agent-browser install`)
- **Use for:** Scraping, browser automation, OSINT, form filling, screenshots, login flows
- **Skill:** `.claude/skills/agent-browser/SKILL.md` — instructs `agent-browser skills get <name>` for per-version syntax
- **Quick verify:** `agent-browser open https://example.com && agent-browser get title && agent-browser close`
- **Snapshot-ref pattern:** `agent-browser snapshot` returns a11y tree (refs e1/e2/...), then `agent-browser click @e1` / `fill @e2 "text"` — more reliable than text selectors
- **NOT:** dashboard E2E tests under `dashboard/` use Playwright directly (not via MCP). agent-browser only replaces the agent-facing browser MCP.

## peekaboo (macOS Desktop Automation)

- **Binary:** `peekaboo`
- **Use for:** Screenshot capture, UI clicking, typing, drag, window/app management, desktop automation
- **Permissions:** Screen Recording + Accessibility granted to daemon (inherited by agents)
- **Usage:** `peekaboo image` (screenshot), `peekaboo list` (apps/windows), `peekaboo run <script>` (automation)
- **Learn:** `peekaboo learn` for full AI-agent usage guide
- **Note:** Headful mode only (needs a display)

## gog (Google Workspace CLI)

- **Binary:** `gog`
- **Use for:** Gmail (search, send, archive, labels, drafts, filters), Calendar (events, free/busy), Drive (list/upload/download), Contacts, Tasks, Sheets, Docs
- **Auth:** OAuth via `gog auth credentials` + `gog auth add`
- **Multi-account:** `-a email@gmail.com` flag
- **Output:** `-j` JSON, `-p` TSV plain

Examples:
```bash
gog gmail ls -a YOUR_EMAIL "is:unread" --max 10
gog gmail send -a YOUR_EMAIL --to "user@example.com" --subject "Subject" --body "Body"
gog calendar ls -a YOUR_EMAIL --max 5
gog calendar create -a YOUR_EMAIL --summary "Meeting" --start "2026-03-28T14:00:00" --end "2026-03-28T15:00:00"
gog drive ls -a YOUR_EMAIL --max 10
```

gog replaces Gmail/Calendar MCP tools. Prefer gog over MCP for full capabilities.
