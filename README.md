<p align="center">
  <img src="herdr/session-restore/preview.png" alt="Session Restore for Herdr: your Claude Code sessions, back in their tabs after every reboot" width="100%">
</p>

<p align="center">
  <a href="https://herdr.dev/mods"><img src="https://img.shields.io/badge/Herdr-mod-8fb3ff?style=flat-square" alt="Herdr mod"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-sessions-e08a5f?style=flat-square" alt="Claude Code">
  <img src="https://img.shields.io/badge/platforms-Windows%20%C2%B7%20Linux%20%C2%B7%20macOS%20(beta)-7ad3a2?style=flat-square" alt="Windows, Linux, macOS (beta)">
  <img src="https://img.shields.io/badge/dependencies-none-9aa3b2?style=flat-square" alt="No dependencies">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-b59cff?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <b>Get your Claude Code sessions back into their <a href="https://herdr.dev">Herdr</a> tabs after a reboot or a crash.</b><br>
  One key, one popup, every session where it was.
</p>

---

herdr-core brings every space, tab and folder back after a restart, but each terminal
comes back as an empty shell: the command that ran there is never started again. This
mod saves, every 5 minutes, which Claude Code session runs in which terminal. After a
restart you press **Ctrl+Shift+R**, tick the sessions you want, and press **Enter**:
each one resumes in its own tab with `claude --resume`.

## How it works

<p align="center">
  <img src="docs/assets/how-it-works.png" alt="1. After a reboot, tabs come back empty. 2. Press Ctrl+Shift+R and pick the sessions. 3. Each resumes in its tab." width="100%">
</p>

## Safe by design

| | |
|---|---|
| **Only `claude --resume`** | Never runs anything else. Other programs that ran in a tab (say `npm run dev`) are listed with a Copy button. |
| **Never twice** | A session that is already running anywhere is shown, not resumed. |
| **Never into a busy tab** | Text is only typed into a shell sitting at its prompt, checked again right before. |
| **Hands off your setup** | No Claude Code hooks or settings changes, no layout changes. |
| **Nothing to install** | Windows PowerShell on Windows, plain `sh` on Linux and macOS. |

## Install

Ask your agent in Herdr:

> Read ~/.config/herdr-app/AGENTS.md, then add this mod:
> https://github.com/Dirvann/herdr-session-restore/tree/main/herdr/session-restore

Or by hand:

1. Copy `herdr/session-restore/mods/session-restore/` to `~/.config/herdr-app/mods/`.
2. Merge `herdr/session-restore/keys.json` into `~/.config/herdr-app/keys.json`
   (Ctrl+Shift+R opens the popup; Enter inside it resumes).
3. `herdr-app check ~/.config/herdr-app/mods/session-restore`

Then press **Ctrl+Shift+R** and click **Turn on autosave**. Saving only happens while
autosave is on.

## What it does to your system

- Runs `hc` and its own saver (`save.ps1` / `save.sh`, next to the mod).
- Reads Claude Code's session files in `~/.claude/sessions`.
- Writes snapshots to `~/.herdr-sessions/auto/` (newest 50, only when something
  changed), plus `log.txt`, `last.run`, `last.error`, `last.sig`.
- **Turn on autosave** schedules the saver every 5 minutes:
  - Windows: scheduled task `HerdrSessionAutosave` (runs hidden).
  - Linux: systemd user timer `herdr-session-save.timer`, or a crontab line tagged
    `# herdr-session-restore` when there is no systemd user session.
  - macOS: LaunchAgent `dev.herdr.session-restore`.

The saver works by hand too: `sh save.sh [save|print|enable|disable|status]`, or on
Windows `powershell -File save.ps1 [-Print|-Enable|-Disable|-Status]`.

## Uninstall

Click **Turn off** in the popup (or run the saver's `disable`), delete
`~/.config/herdr-app/mods/session-restore`, remove the two keys from `keys.json`, and
delete `~/.herdr-sessions` if you don't want the snapshots.

## Status and limits

- Windows 11 (Herdr 0.1.16, herdr-core 0.1.21): saving, the popup and resuming a
  session whose Claude was killed are tested. Resuming after a real reboot is not yet.
- Linux (Ubuntu): the saver and autosave are tested and the mod loads
  (`herdr-app check`); the popup has not been used in a Linux window yet.
- **macOS is untested**: the saver is written for its `ps` and `launchctl` but has never
  run on a Mac. Reports welcome.
- Claude Code only for now. Other agents (Codex and more) are planned.
- Only terminals on this computer; terminals on other machines (`hc machine`) are not
  saved.
- If only Claude died and its shell lived on, the session opens in a new tab rather than
  being typed into the old one: a killed Claude can leave the terminal in a state that
  garbles typed text.

## Development

```
herdr/session-restore/           the folder Herdr's gallery installs from
  RECIPE.md  preview.png  keys.json
  mods/session-restore/
    main.js      the popup
    plan.js      all decisions, pure and tested
    save.ps1     saver for Windows
    save.sh      saver for Linux and macOS
tests/           node tests for plan.js (made-up fixtures)
docs/design.md   why it works the way it does
docs/assets/     README images; showcase.html and steps.html are their sources
```

`npm test` runs the tests (Node 20+; only needed for development). See
[CLAUDE.md](CLAUDE.md) for working on it and [docs/design.md](docs/design.md) for the
design.

## License

MIT
