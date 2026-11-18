# Session restore for Herdr

Get your Claude Code sessions back into their [Herdr](https://herdr.dev) tabs after a
reboot or a crash.

![The session restore popup](herdr/session-restore/preview.png)

herdr-core brings every space, tab and folder back after a restart, but each terminal
comes back as an empty shell: the command that ran there is never started again. This
mod saves, every 5 minutes, which Claude Code session runs in which terminal. After a
restart you press **Ctrl+Shift+R**, tick the sessions you want, and press **Enter**:
each one resumes in its own tab with `claude --resume`.

- Windows, Linux and macOS, with nothing extra to install (Windows PowerShell on
  Windows, plain `sh` elsewhere).
- Never runs anything but `claude --resume`. Other programs that ran in a tab are listed
  with a Copy button.
- Never resumes a session that is already running, never types into a busy tab.
- No Claude Code hooks or settings changes, no layout changes.

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
```

`npm test` runs the tests (Node 20+; only needed for development). See
[CLAUDE.md](CLAUDE.md) for working on it and [docs/design.md](docs/design.md) for the
design.

## License

MIT
