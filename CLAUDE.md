# herdr-session-restore

A Herdr mod that brings coding agents back into their tabs after a reboot or crash:
Claude Code with its exact session, other agents (Codex, Gemini and more) with their own
"continue the latest session" command in the saved folder. User docs: `README.md`.
Design and reasoning: `docs/design.md`. The brief another agent could rebuild it from:
`herdr/session-restore/RECIPE.md`.

## Rules

- **No personal data in any commit.** This repo is public. Fixtures, examples, docs and
  screenshots use made-up names (`alex`, `devbox`, `shop`, made-up session ids). Never
  commit real paths, hostnames, space/tab names, session ids or snapshot files.
- Conventional commits. Short branch, then merge to `main`.
- Keep the anti-goals in `docs/design.md`: no agent hooks or settings edits, no layout
  changes, only ever run an agent's own resume command, never resume a running session,
  never type into a busy terminal, schedule nothing before "Turn on autosave".
- Add an agent to `AGENTS` in `plan.js` only when its docs say "resume latest" is
  scoped to the current folder or project; otherwise a row could open another
  project's conversation.
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
  plan.js     pure logic, no imports: agent table and detection, entries, states,
              resume lines, snapshot choice
  save.ps1    Windows saver (also enable/disable/status of the scheduled task)
  save.sh     Linux/macOS saver (systemd user timer, crontab, or LaunchAgent)
tests/        node --test, fixtures in tests/fixtures (made up)
```

## Images

`herdr/session-restore/preview.png` (shown on herdr.dev/mods and as the README hero) and
`docs/assets/how-it-works.png` are rendered from `docs/assets/showcase.html` and
`steps.html` with headless Edge or Chrome (command in each file's top comment).
`docs/assets/popup.png` is a real screenshot of the popup fed made-up rows. Keep all of
them free of real data.

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
- On Windows herdr-core reports the shell (`cmd /k codex`) as a terminal's foreground
  program, so `plan.js` finds other agents in the process tree; npm installs run as
  `node.exe`, which is why `save.ps1` records the command line of script runtimes.
- Snapshots hold terminals under `get` (Linux/macOS, one `hc get` per terminal, run in
  parallel) or `list` (Windows, one `hc connect` call with `hello` and `terminal.list`).
  `terminalsOf()` in `plan.js` reads both.
- The popup waits for a saver run when it opens and again before resuming; keep the
  saver fast (about 2.7 s on Windows, 0.2 s on Linux).
- `herdr-app check` runs `init()` for real; the mod does nothing while `checking()`.
- From Git Bash on Windows, leading-slash arguments (`/exit`, `/tmp/x`) are rewritten to
  Windows paths; set `MSYS_NO_PATHCONV=1`.

## Status

- Windows 11: saver, popup, autosave switch and resume (Claude killed, same shell →
  new tab) verified. Codex verified end to end (detected, shown, resumed in a new tab
  with `codex resume --last`). Typed-line resume after a real reboot not yet seen.
- Other agents (Gemini, Qwen, Kimi, Pi, Grok, Kiro, Qoder, Crush): unit-tested only,
  with made-up snapshots.
- Linux (Ubuntu): saver and every subcommand verified, `herdr-app check` passes; popup
  not yet opened in a Linux window.
- macOS: untested.
- Next: more agents once their latest-session scope is confirmed (OpenCode, Copilot,
  Cursor, Goose, Droid); a real reboot test.
