# herdr-session-restore

A Herdr mod that brings Claude Code sessions back into their tabs after a reboot or
crash. User docs: `README.md`. Design and reasoning: `docs/design.md`. The brief another
agent could rebuild it from: `herdr/session-restore/RECIPE.md`.

## Rules

- **No personal data in any commit.** This repo is public. Fixtures, examples, docs and
  screenshots use made-up names (`alex`, `devbox`, `shop`, made-up session ids). Never
  commit real paths, hostnames, space/tab names, session ids or snapshot files.
- Conventional commits. Short branch, then merge to `main`.
- Keep the anti-goals in `docs/design.md`: no Claude hooks or settings edits, no layout
  changes, only ever run `claude --resume`, never resume a running session, never type
  into a busy terminal, schedule nothing before "Turn on autosave".
- Savers stay dependency-free: `save.ps1` must run on Windows PowerShell 5.1 (no
  `-AsHashtable`, `??`, ternaries); `save.sh` is POSIX sh (check with `dash -n`; no
  GNU-only flags; must keep LF line endings, see `.gitattributes`).

## Commands

| Command | Does |
|---|---|
| `npm test` | Tests for `plan.js` (node 20+) |
| `herdr-app check herdr/session-restore/mods/session-restore` | Loads the mod once |
| `sh save.sh print` / `powershell -File save.ps1 -Print` | A fresh snapshot on stdout |
| `… status` / `-Status` | Autosave state, last run, last error |

To try a change in Herdr, copy the files in `herdr/session-restore/mods/session-restore/`
over `~/.config/herdr-app/mods/session-restore/` (Herdr reloads on save) and press
Ctrl+Shift+R.

## Layout

```
herdr/session-restore/mods/session-restore/
  main.js     popup: reads snapshots, runs the saver, acts (hc send, tab.new)
  plan.js     pure logic, no imports: entries, states, resume lines, snapshot choice
  save.ps1    Windows saver (also enable/disable/status of the scheduled task)
  save.sh     Linux/macOS saver (systemd user timer, crontab, or LaunchAgent)
tests/        node --test, fixtures in tests/fixtures (made up)
```

## Things that are not obvious

- `herdr-app.exe` is a GUI-subsystem program on Windows: PowerShell's `&` neither waits
  for it nor captures its output. Use `System.Diagnostics.Process`, or node's
  `spawnSync`.
- `hc send` from inside an agent's terminal wraps the text in `<hc from="tN">` tags (agent
  notes). The mod calls `hc` from the app, so it doesn't. Test resume through the popup
  (`herdr-app do mod.open '{"name":"session-restore"}'`, then
  `herdr-app do session-restore.resume`), not with `hc send` from an agent.
- `mod.open` toggles: a second call closes the popup.
- A killed Claude can leave its terminal in bracketed-paste mode; a line typed into that
  shell arrives garbled. Hence "same root pid → new tab".
- `hc send` always presses Enter; there is no "type without submit".
- `herdr-app check` runs `init()` for real; the mod does nothing while `checking()`.
- From Git Bash on Windows, leading-slash arguments (`/exit`, `/tmp/x`) are rewritten to
  Windows paths; set `MSYS_NO_PATHCONV=1`.

## Status

- Windows 11: saver, popup, autosave switch and resume (Claude killed, same shell →
  new tab) verified. Typed-line resume after a real reboot not yet seen.
- Linux (Ubuntu): saver and every subcommand verified, `herdr-app check` passes; popup
  not yet opened in a Linux window.
- macOS: untested.
- Next: other agents (Codex and more).
