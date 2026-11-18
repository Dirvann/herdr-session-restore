# Design

## The problem

Herdr (the desktop app plus herdr-core, `hc`) keeps terminals running when the window
closes. After a reboot, crash or logout, herdr-core brings every space, tab and split
back, each terminal at its old address and folder, but as an empty shell: it never
reruns the original command. Coding agent sessions (Claude Code, Codex and others) are
lost from their tabs until each is resumed by hand, and by then you no longer remember
which session ran where.

Success: after a restart, open Herdr, press Ctrl+Shift+R, see the agent sessions that
ran in each tab, and resume the ones you want with one key.

## Goals, non-goals, anti-goals

- Goals: save every 5 minutes which coding agent session runs in which Herdr terminal;
  offer them back in a popup; resume the chosen ones in the tab they came from; work on
  Windows, Linux and macOS with nothing extra to install; install the normal gallery way.
- Non-goals (for now): agents whose "resume latest" isn't documented as per folder;
  terminals on other machines; recreating spaces and tabs (herdr-core does that);
  resuming without being asked.
- Anti-goals (a failure even if it works): editing any agent's settings or hooks;
  copying or changing a shipped Herdr layout; running any command other than an agent's
  own resume command; resuming a session that is already running somewhere (two live
  copies of one conversation); opening another project's conversation; typing into a
  terminal that isn't at an idle prompt; scheduling anything before the user turns
  autosave on.

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

1. The terminals. Linux and macOS: `hc ls --json`, then `hc get <t> --json` for every
   local terminal (address without `machine/`), all `hc get` calls in parallel. Windows:
   `hc ls --json` next to one `hc connect` call that sends JSON-RPC `hello` and
   `terminal.list`, which returns every terminal with the same details as `hc get`,
   instead of one `hc get` process per terminal. If `hc` fails, nothing is written and
   the reason goes to `last.error`.
2. The process list: Windows from one `Win32_Process` query (only the processes under
   terminal root pids, plus every Claude pid, with start time and path, and the command
   line of node, bun, deno, python and uv processes); Linux and macOS from
   `LC_ALL=C ps -A -o pid=,ppid=,lstart=,comm=`.
3. Claude Code's session files `~/.claude/sessions/<pid>.json` whose pid is alive.
4. Written as `~/.herdr-sessions/auto/<yyyyMMdd-HHmmss>.json`:
   `{version: 2, savedAt, platform, ls, get | list, processes, sessions}`, raw outputs
   embedded as they are. `get` is an object of `hc get` outputs by address (Linux,
   macOS); `list` is the `terminal.list` result, `{terminals: […]}` (Windows). Each
   process is `{pid, ppid, start, name, path, args}`, `args` only on Windows runtimes.
   Only written when the signature changed (terminal addresses, each terminal's
   foreground program, live session ids); otherwise the newest file's time is touched,
   so files mark changes, not ticks. Newest 50 kept.

A run takes about 2.7 s on Windows (it was 5.5 s with one `hc get` per terminal) and
about 0.2 s on Linux. The popup waits for one run when it opens and one before
resuming, so this time is felt.

## Agents

- **Claude Code: exact.** Its session files give the session id of each process, so a
  row resumes that one conversation with `claude --resume <id>`.
- **Other agents: latest in folder.** The saver reads only Claude Code's session files,
  so for other agents there is no session id, but most have a "continue the latest
  session" command. The row runs that command in the saved folder: Codex
  `codex resume --last`, Gemini `gemini --resume`, Qwen `qwen --continue`, Kimi
  `kimi --continue`, Pi `pi --continue`, Grok `grok --continue`, Kiro
  `kiro-cli chat --resume`, Qoder `qoder -c`, Crush `crush --continue`. The table is
  `AGENTS` in `plan.js`.
- **Only folder-scoped agents.** An agent is in the table only when its docs say
  "latest" is the latest in the current folder or project. Otherwise "latest" could be a
  conversation from another project, which is worse than not resuming. Left out for now:
  OpenCode, Copilot, Cursor, Goose and Droid (scope not documented), Amp and Aider (no
  "resume latest"). They show as Copy rows like any other program.
- **Duplicate rule.** Two saved tabs with the same agent in the same folder would both
  open the same latest session. Rows are keyed by agent and folder (Windows paths
  lowercased, trailing slash dropped); after sorting by space and tab, only the first
  ready or gone row per key can resume. The others get the state *Same folder* with the
  note "as <tab>".
- **Already running.** Without a session id, "running" means the same agent runs in the
  same folder now, in any terminal. Resuming then would open a second copy.
- **Detection**, in this order for a terminal without a Claude session: the foreground
  program's name (`codex`, `qodercli`; `.exe`, `.cmd`, `.js` and the like stripped);
  herdr-core's agent name for the terminal from `hc ls`; for node, bun, deno, npx,
  python, uv and uvx, a program name or an npm package folder (`@openai/codex`,
  `gemini-cli`, `qwen-code`, `pi-coding-agent`) in the arguments; and last, breadth first
  through the process tree under the terminal. The tree is needed on Windows, where
  herdr-core reports the shell (`cmd /k codex`) as the foreground program, and the
  recorded command lines are needed there for npm installs, which run as `node.exe`.

## Deciding (plan.js)

- **Which process is Claude:** breadth first under a terminal's root pid, the first
  process with a session file whose `startedAt` lies within −5 s … +120 s of the process
  start. Claude Code's own `procStart` field differs per system, `startedAt` doesn't.
  The window also rejects a crash's leftover session file whose pid now belongs to
  another program.
- **Entries:** per terminal with a `herdr.space` label: claude (session id, folder, WSL
  distro and path when the folder is `\\wsl.localhost\…`), agent (which agent and its
  folder), command (a foreground program that isn't a shell or a known agent), or idle.
  Names come from the `where` label ("space / tab").
- **States now:** running (Claude: its session is live anywhere; other agents: that
  agent runs in that folder), ready (the terminal is a shell at its prompt with no agent
  under it), busy, gone, and same folder (the duplicate rule above).
- **Snapshot choice:** the newest with an agent session that isn't running and whose
  terminal is gone or back to an empty shell. A terminal that runs something else now
  was reused, not lost.
- **Resume line** follows the shell found now: cmd, PowerShell, bash/zsh/sh/dash, fish,
  nu, or a `wsl.exe` line for Claude sessions in WSL, with each shell's quoting. It is a
  `cd` to the saved folder followed by the resume command.
- **Same shell, agent gone:** when the terminal's root pid equals the saved one, only
  the agent died. A killed Claude can leave the terminal in bracketed-paste mode, which
  garbles a typed line, so the session opens in a new tab instead. After a reboot the
  shell is a new process and the line is typed.

## The popup

Opened with Ctrl+Shift+R (`mod.open`, `place: "none"`, a dialog titled "Resume agent
sessions"). It asks the saver for a fresh snapshot (`print`) as "now", reads the saved
snapshots, and shows rows ordered ready, gone, busy, same folder, with running sessions
folded and other commands at the bottom. Claude rows show folder and short session id;
other agents show "<folder> · <Agent> · latest in folder". Resume (button or Enter)
plans again first, then `hc send` for ready rows and `tab.new` for the others, and
reports in a toast. The footer shows autosave state and turns it on or off by running
the saver's `enable` / `disable`.

## Testing

- `npm test`: `plan.js` against made-up Windows and Linux snapshots (paths with spaces
  and quotes, WSL, pid reuse, hidden and remote terminals, snapshot choice), and agent
  snapshots (detection by name, by hc's agent name, through node and in a Windows process
  tree; resume lines; the duplicate rule; running agents; `list` read like `get`).
- Savers: run on Windows 11 (PowerShell 5.1) and Ubuntu (dash and bash), every
  subcommand. macOS: not run yet.
- End to end on Windows: a Claude killed in its tab comes back with its conversation.
  Codex is detected, shown and resumed in a new tab with `codex resume --last`. The
  other agents are covered only by the unit tests. A real reboot is the remaining check
  for the typed-line path.
