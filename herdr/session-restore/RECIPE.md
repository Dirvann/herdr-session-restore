# Session restore

A popup that brings coding agents back into your Herdr tabs after a reboot or crash.
herdr-core restores every space, tab and folder, but as an empty shell; this mod
remembers which agent ran in which terminal and resumes the ones you tick: Claude Code
with its exact session, other agents (Codex, Gemini, Qwen, Kimi, Pi, Grok, Kiro, Qoder,
Crush) with their own "continue the latest session" command in the saved folder.

![Session restore](preview.png)

**Before installing, know that it runs programs and reads files outside its folder:**
it runs `hc` and its own saver script (`save.ps1` on Windows, `save.sh` on Linux and
macOS); the saver reads Claude Code's session files in `~/.claude/sessions`, on Windows
the command lines of node, bun, deno, python and uv processes in Herdr terminals, and
writes snapshots to `~/.herdr-sessions`. When you click **Turn on autosave**, it
registers the saver with your system's scheduler (a scheduled task on Windows, a systemd
user timer or crontab line on Linux, a LaunchAgent on macOS). Nothing is scheduled
before that click. It never edits any agent's settings or hooks and never changes a
layout.

## What you see

A dialog (720 wide, 75% of the window high), opened with **Ctrl+Shift+R**:

1. **Title row:** "Resume agent sessions", the shortcut in dim text on the right.
2. **Snapshot row:** "Saved 18/11 21:22 · 15 agent sessions" and **‹ Older** /
   **Newer ›** buttons to step through saved snapshots.
3. **Rows**, one per saved agent session, ordered ready, gone, busy, same folder:
   checkbox, "space / tab" in the foreground color, below it in monospace the folder
   (home shown as `~`) and then, for Claude, the first 8 characters of the session id
   and "WSL" when it ran in WSL; for other agents "· Codex · latest in folder". On the
   right the state in small text (accent color for Ready), with a note under it ("opens
   in a new tab", "its space is gone too", "as <tab>" for Same folder).
4. A folded group **▸ ALREADY RUNNING · N** (click to unfold) for sessions running now.
5. **OTHER COMMANDS · copy and run them yourself**: programs that ran in a tab (say
   `npm run dev`, or an agent that isn't supported), each with a **Copy** button. Never
   run by the mod.
6. **Autosave row:** a dot (accent when on), "Autosave on · last save 3 min ago" or
   "Autosave is off: sessions are only saved while it is on", and a **Turn off** or
   **Turn on autosave** button. A failed last save shows its reason under it.
7. **Footer:** "N selected", **Cancel**, **Resume N** (primary).

Colors come from `theme()`: popover background, raised buttons, solid primary button,
accent for ticks and ready.

## How it behaves

- **Agents:** Claude Code is found by its session file and resumed exactly
  (`claude --resume <id>`). Other agents come from a table in `plan.js` with their resume
  command: Codex `codex resume --last`, Gemini `gemini --resume`, Qwen `qwen --continue`,
  Kimi `kimi --continue`, Pi `pi --continue`, Grok `grok --continue`, Kiro
  `kiro-cli chat --resume`, Qoder `qoder -c`, Crush `crush --continue`. Only agents whose
  "latest" is documented as per folder or project are in the table. OpenCode, Copilot,
  Cursor, Goose, Droid (scope not documented), Amp and Aider (no "resume latest") stay
  Copy rows.
- **States:** *Ready* (the tab is a shell at its prompt, ticked by default), *Tab gone*
  (offered as a new tab in the same space, unticked), *Tab is busy* (runs something
  else; not selectable), *Already running* (Claude: that session id runs somewhere, in
  Herdr or not; other agents: the same agent runs in the same folder now; not
  selectable), *Same folder* (another saved tab has the same agent in the same folder
  and comes first; only that one can resume; not selectable).
- **Which snapshot:** the newest one holding an agent session that isn't running now and
  whose tab is gone or back to an empty shell. Older/Newer change it.
- **Resume (button or Enter):** plans again first, so a tab that got busy meanwhile is
  skipped. Ready rows get one typed line in their shell, a `cd` to the saved folder and
  the resume command (`cd /d "…" && claude --resume <id>` in cmd,
  `Set-Location -LiteralPath '…'; codex resume --last` in PowerShell,
  `cd -- '…' && claude --resume <id>` in bash/zsh/sh, own forms for fish and nu, a
  `wsl.exe -d <distro> …` line for Claude in WSL). If the shell is the same process as
  when the snapshot was saved (only the agent died), it opens a new tab instead, because
  a killed Claude can leave the terminal in bracketed-paste mode, which garbles typed
  text. Gone rows open the resume command as a new tab in their space, in the saved
  folder. A toast reports what was resumed and what was skipped; the dialog closes.
- **Escape / Cancel** closes it. Clicking a row toggles it.

## Built from

- `mods/session-restore/` with `mod.json`
  `{ "place": "none", "title": "Resume sessions", "overlay": { "kind": "dialog", "width": 720, "height": 0.75 } }`.
- `keys.json`: global `ctrl-shift-r` → `mod.open:session-restore`; section
  `mod:session-restore` `enter` → `session-restore.resume` (the mod reads it with
  `nextCommand()`).
- `main.js` (the dialog), `plan.js` (pure logic, no imports: reads snapshots, finds the
  Claude process under each terminal's root pid by matching a session file's
  `startedAt` to the process start, detects other agents, decides states and resume
  lines). `AGENTS` maps each agent to a display name, program names (`exe`), npm package
  folders (`pkg`) and its resume argv. An agent is detected by the foreground program's
  name, by herdr-core's agent name from `hc ls`, by a package path or script name in the
  arguments when it runs through node, bun, deno, python or uv, and otherwise breadth
  first in the process tree under the terminal (on Windows herdr-core reports the shell
  as foreground). Agent rows are keyed by agent and folder (`codex|/home/alex/code/shop`,
  lowercased for Windows paths); after sorting by space and tab, the first ready or gone
  row per key resumes and the rest become *Same folder*.
- `herdr` functions: `exec` (the saver), `hc(["send", …])`, `run("tab.new", …)`,
  `readTextFile`, `spaces()`, `appHome()`, `home()`, `window().platform`, `theme()`,
  `notify`, `props`, `closeOverlay`, `checking`, `nextCommand`; `fs/promises.readdir`;
  `cx.write_to_clipboard` for Copy.
- Saver, same subcommands on every system: save (default), `print` (fresh snapshot to
  stdout, the popup's view of "now"), `enable`, `disable`, `status`
  (`{"enabled","lastRun","lastError"}`). Windows: `powershell.exe -File save.ps1
  [-Print|-Enable|-Disable|-Status]`, Windows PowerShell 5.1. Linux/macOS: `sh save.sh
  [save|print|enable|disable|status]`, POSIX sh. Snapshots:
  `~/.herdr-sessions/auto/<yyyyMMdd-HHmmss>.json` with `version: 2`, raw `hc ls` output,
  the terminals, the process list and live Claude session files; written only when
  something changed; newest 50 kept. Terminals: Linux/macOS run every `hc get <t> --json`
  in parallel and store them under `get` (address → output); Windows reads all of them
  in one `hc connect` call (JSON-RPC `hello`, then `terminal.list`) and stores the result
  under `list` (`{terminals: […]}`). `plan.js` reads either. Windows processes carry
  `args` (the command line) for node, bun, deno, python and uv.

## Watch out

- Claude Code's `procStart` differs per OS; match on `startedAt` (a few seconds after the
  process starts) within −5 s … +120 s, or a crash's leftover session file whose pid
  was reused will look like a live session.
- Never add an agent whose "continue latest" is global rather than per folder: the row
  would open another project's conversation. Two tabs with one agent in one folder share
  one "latest", hence *Same folder*.
- On Windows herdr-core reports the shell (`cmd /k codex`) as the foreground program, so
  other agents are found only in the process tree; npm installs show up as `node.exe`
  and need the recorded command line.
- `hc send` always presses Enter, so other commands are Copy-only.
- Only this computer's terminals. Terminals without a `herdr.space` label (hidden
  workers, Herdr mobile) are skipped.
- `herdr-app check` runs `init()` for real: the mod skips all `exec` while `checking()`.
- The popup waits for a saver run when it opens and again before resuming: keep the
  saver fast (about 2.7 s on Windows, 0.2 s on Linux).
- macOS is untested (written for BSD `ps` and `launchctl`, never run on a Mac).
- Space and tab names come from hc's `where` label ("space / tab"), split on the last
  " / "; a tab name containing " / " splits wrong.
