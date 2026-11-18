# Design

## The problem

Herdr (the desktop app plus herdr-core, `hc`) keeps terminals running when the window
closes. After a reboot, crash or logout, herdr-core brings every space, tab and split
back, each terminal at its old address and folder, but as an empty shell: it never
reruns the original command. Claude Code sessions are lost from their tabs until each is
resumed by hand, and by then you no longer remember which session ran where.

Success: after a restart, open Herdr, press Ctrl+Shift+R, see the Claude sessions that
ran in each tab, and resume the ones you want with one key.

## Goals, non-goals, anti-goals

- Goals: save every 5 minutes which Claude Code session runs in which Herdr terminal;
  offer them back in a popup; resume the chosen ones in the tab they came from; work on
  Windows, Linux and macOS with nothing extra to install; install the normal gallery way.
- Non-goals (for now): other agents than Claude Code; terminals on other machines;
  recreating spaces and tabs (herdr-core does that); resuming without being asked.
- Anti-goals (a failure even if it works): editing Claude Code's settings or hooks;
  copying or changing a shipped Herdr layout; running any command other than
  `claude --resume`; resuming a session that is already running somewhere (two live
  copies of one conversation); typing into a terminal that isn't at an idle prompt;
  scheduling anything before the user turns autosave on.

## Approaches considered

- **A mod alone.** A mod only runs while it is shown in a layout, and the shipped layouts
  take no new blocks, so saving would stop whenever the popup is closed. Rejected.
- **Claude Code hooks** (save on session start). Needs global hook changes in
  `~/.claude/settings.json`. Rejected (anti-goal).
- **One saver language everywhere** (PowerShell 7, Python, a compiled binary). Each needs
  an install on some system, or can't be read before installing. Rejected.
- **Chosen: a thin saver per system plus all logic in the mod.** The savers (`save.ps1`
  for Windows PowerShell 5.1, `save.sh` for POSIX sh) only collect raw facts. `plan.js`,
  a pure JavaScript module inside the mod, makes every decision, so there is one copy of
  the logic and it is tested with node.

## Saving

Run by the system scheduler every 5 minutes once autosave is on, or by hand.

1. `hc ls --json`, then `hc get <t> --json` for every local terminal (address without
   `machine/`). If `hc` fails, nothing is written and the reason goes to `last.error`.
2. The process list: Windows from one `Win32_Process` query (only the processes under
   terminal root pids, plus every Claude pid, with start time and path); Linux and macOS
   from `LC_ALL=C ps -A -o pid=,ppid=,lstart=,comm=`.
3. Claude Code's session files `~/.claude/sessions/<pid>.json` whose pid is alive.
4. Written as `~/.herdr-sessions/auto/<yyyyMMdd-HHmmss>.json`:
   `{version: 2, savedAt, platform, ls, get, processes, sessions}`, raw outputs embedded
   as they are. Only when the signature changed (terminal addresses, each terminal's
   foreground program, live session ids); otherwise the newest file's time is touched,
   so files mark changes, not ticks. Newest 50 kept.

## Deciding (plan.js)

- **Which process is Claude:** breadth first under a terminal's root pid, the first
  process with a session file whose `startedAt` lies within −5 s … +120 s of the process
  start. Claude Code's own `procStart` field differs per system, `startedAt` doesn't.
  The window also rejects a crash's leftover session file whose pid now belongs to
  another program.
- **Entries:** per terminal with a `herdr.space` label: claude (session id, folder, WSL
  distro and path when the folder is `\\wsl.localhost\…`), command (a foreground program
  that isn't a shell), or idle. Names come from the `where` label ("space / tab").
- **States now:** running (its session is live anywhere), ready (the terminal is a shell
  at its prompt with no Claude under it), busy, gone.
- **Snapshot choice:** the newest with a session that isn't running and whose terminal is
  gone or back to an empty shell. A terminal that runs something else now was reused,
  not lost.
- **Resume line** follows the shell found now: cmd, PowerShell, bash/zsh/sh/dash, fish,
  nu, or a `wsl.exe` line for WSL sessions, with each shell's quoting.
- **Same shell, Claude gone:** when the terminal's root pid equals the saved one, only
  Claude died. A killed Claude can leave the terminal in bracketed-paste mode, which
  garbles a typed line, so the session opens in a new tab instead. After a reboot the
  shell is a new process and the line is typed.

## The popup

Opened with Ctrl+Shift+R (`mod.open`, `place: "none"`, a dialog). It asks the saver for
a fresh snapshot (`print`) as "now", reads the saved snapshots, and shows rows ordered
ready, gone, busy, with running sessions folded and other commands at the bottom.
Resume (button or Enter) plans again first, then `hc send` for ready rows and
`tab.new` for the others, and reports in a toast. The footer shows autosave state and
turns it on or off by running the saver's `enable` / `disable`.

## Testing

- `npm test`: `plan.js` against made-up Windows and Linux snapshots (paths with spaces
  and quotes, WSL, pid reuse, hidden and remote terminals, snapshot choice).
- Savers: run on Windows 11 (PowerShell 5.1) and Ubuntu (dash and bash), every
  subcommand. macOS: not run yet.
- End to end on Windows: a Claude killed in its tab comes back with its conversation.
  A real reboot is the remaining check for the typed-line path.
