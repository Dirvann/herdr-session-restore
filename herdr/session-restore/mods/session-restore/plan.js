// Pure logic for session-restore: snapshot in, entries, states and resume lines out.
// No imports, so node can test it (tests/*.test.mjs) and the mod can use it as is.

export const SHELLS = ["cmd", "pwsh", "powershell", "bash", "zsh", "sh", "dash", "fish", "nu"];
const NOT_COMMANDS = new Set([...SHELLS, "wsl", "conhost"]);
// Agents other than Claude Code: resumed with their own "continue the latest session"
// command, run in the saved folder. Only agents whose docs say "latest" is scoped to the
// current folder or project are listed, so a row never pulls in another project's
// conversation. exe: program names; pkg: npm package folder when it runs through node.
export const AGENTS = {
  codex: { name: "Codex", exe: ["codex"], pkg: ["@openai/codex"], resume: ["codex", "resume", "--last"] },
  gemini: { name: "Gemini", exe: ["gemini"], pkg: ["gemini-cli"], resume: ["gemini", "--resume"] },
  qwen: { name: "Qwen", exe: ["qwen"], pkg: ["qwen-code"], resume: ["qwen", "--continue"] },
  kimi: { name: "Kimi", exe: ["kimi"], pkg: [], resume: ["kimi", "--continue"] },
  pi: { name: "Pi", exe: ["pi"], pkg: ["pi-coding-agent"], resume: ["pi", "--continue"] },
  grok: { name: "Grok", exe: ["grok"], pkg: [], resume: ["grok", "--continue"] },
  kiro: { name: "Kiro", exe: ["kiro-cli"], pkg: [], resume: ["kiro-cli", "chat", "--resume"] },
  qoder: { name: "Qoder", exe: ["qoder", "qodercli"], pkg: [], resume: ["qoder", "-c"] },
  crush: { name: "Crush", exe: ["crush"], pkg: [], resume: ["crush", "--continue"] },
};
const RUNTIMES = new Set(["node", "bun", "deno", "npx", "python", "python3", "uv", "uvx"]);
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Epoch ms. Numbers pass through; text is `ps -o lstart` ("Wed Nov  8 00:20:22 2026"),
 *  which the saver prints in UTC (TZ=UTC0) so no time zone has to agree. */
export function parseStart(start) {
  if (typeof start === "number") return start;
  const m = /^\s*\w+\s+(\w{3})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})\s*$/.exec(String(start ?? ""));
  if (!m || !(m[1] in MONTHS)) return NaN;
  return Date.UTC(+m[6], MONTHS[m[1]], +m[2], +m[3], +m[4], +m[5]);
}

/** Last part of a path, lowercased, without ".exe" or a login shell's leading "-". */
export function leaf(path) {
  if (!path) return "";
  return String(path).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "").replace(/^-/, "");
}

/** A program's name: leaf() without script extensions (qwen.cmd, cli.js). */
const prog = (path) => leaf(path).replace(/\.(cmd|bat|ps1|js|mjs|cjs)$/, "");

/** Which agent from AGENTS a foreground program is, or null. hcAgent: herdr-core's name for it. */
export function detectAgent(argv, hcAgent) {
  const args = Array.isArray(argv) ? argv : [];
  const first = prog(args[0]);
  const hc = String(hcAgent ?? "").toLowerCase();
  for (const [key, a] of Object.entries(AGENTS)) {
    if (a.exe.includes(first) || hc === key || a.exe.includes(hc) || hc.startsWith(key + "-")) return key;
    if (!RUNTIMES.has(first)) continue;
    for (const arg of args.slice(1)) {
      const low = String(arg).toLowerCase().replace(/\\/g, "/");
      if (a.exe.includes(prog(arg)) || a.pkg.some((p) => low.includes(`/${p}/`))) return key;
    }
  }
  return null;
}

/** "agent|folder", with the folder written one way (case-blind for Windows paths). */
export function folderKey(agent, cwd) {
  let f = String(cwd ?? "").replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:|\\/.test(f)) f = f.toLowerCase();
  return `${agent}|${f}`;
}

/** The snapshot's terminals: per-terminal `hc get` output (`get`), or one
 *  `terminal.list` result (`list`, written by the Windows saver). */
export function terminalsOf(snapshot) {
  const get = snapshot?.get;
  if (get && Object.keys(get).length) return Object.values(get);
  return Array.isArray(snapshot?.list?.terminals) ? snapshot.list.terminals : [];
}

/** herdr-core's agent name per address, from `hc ls`. */
function hcAgents(snapshot) {
  const map = new Map();
  for (const t of snapshot?.ls?.terminals ?? []) if (t?.address) map.set(t.address, t.agent ?? null);
  return map;
}

export function processIndex(snapshot) {
  const byPid = new Map();
  const children = new Map();
  for (const p of snapshot?.processes ?? []) {
    const proc = { pid: Number(p.pid), ppid: Number(p.ppid), startMs: parseStart(p.start), name: p.name ?? "", path: p.path ?? null, args: p.args ?? null };
    byPid.set(proc.pid, proc);
  }
  for (const proc of byPid.values()) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc);
  }
  return { byPid, children };
}

export function sessionsByPid(snapshot) {
  const map = new Map();
  for (const s of snapshot?.sessions ?? []) if (s && s.pid != null) map.set(Number(s.pid), s);
  return map;
}

// The session file belongs to this very process, not an older one with the same pid:
// Claude writes startedAt a few seconds after its process starts.
function ownSession(proc, sessions) {
  const s = sessions.get(proc.pid);
  if (!s) return null;
  if (s.startedAt == null || Number.isNaN(proc.startMs)) return s;
  const d = Number(s.startedAt) - proc.startMs;
  return d >= -5000 && d <= 120000 ? s : null;
}

/** The first Claude Code process under a terminal's root process, breadth first. */
export function findClaude(index, rootPid, sessions) {
  const root = index.byPid.get(Number(rootPid));
  if (!root) return null;
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    const session = ownSession(p, sessions);
    if (session) return { proc: p, session };
    // A child older than its parent means the parent pid was reused.
    for (const c of index.children.get(p.pid) ?? []) if (!(c.startMs < p.startMs)) queue.push(c);
  }
  return null;
}

/** A Windows command line split into words ("quoted parts" kept whole). */
const splitArgs = (line) => [...String(line).matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

/** The first process from AGENTS under a terminal's root process (root included), breadth
 *  first. On Windows herdr-core reports the shell as the foreground program, so the agent
 *  shows only here. */
export function findAgent(index, rootPid) {
  const root = index.byPid.get(Number(rootPid));
  if (!root) return null;
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    const agent = detectAgent(p.args ? splitArgs(p.args) : [p.name], null);
    if (agent) return { agent, proc: p };
    for (const c of index.children.get(p.pid) ?? []) if (!(c.startMs < p.startMs)) queue.push(c);
  }
  return null;
}

/** "space / tab" from hc's where field, split on the last " / ". */
export function splitWhere(where) {
  const w = String(where ?? "");
  const i = w.lastIndexOf(" / ");
  if (i < 0) return { spaceName: w || null, tabName: null };
  return { spaceName: w.slice(0, i), tabName: w.slice(i + 3) };
}

/** \\wsl.localhost\Ubuntu\home\alex\x -> { distro: "Ubuntu", path: "/home/alex/x" } */
export function wslFromCwd(cwd) {
  const m = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(String(cwd ?? ""));
  if (!m) return null;
  return { distro: m[1], path: m[2] ? m[2].replace(/\\/g, "/") : "/" };
}

/** C:\Users\alex\x.exe -> /mnt/c/Users/alex/x.exe */
export function mntPath(winPath) {
  const m = /^([A-Za-z]):\\(.*)$/.exec(String(winPath ?? ""));
  if (!m) return null;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

const formatArgv = (argv) => (argv ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");

/** Terminals Herdr shows on this computer: live, with herdr.space, no "machine/" prefix. */
function saveable(t) {
  return t && t.state === "live" && t.labels && t.labels["herdr.space"] && !String(t.address).includes("/");
}

/** One entry per saveable terminal in the snapshot. */
export function entries(snapshot) {
  const index = processIndex(snapshot);
  const sessions = sessionsByPid(snapshot);
  const named = hcAgents(snapshot);
  const out = [];
  for (const t of terminalsOf(snapshot)) {
    if (!saveable(t)) continue;
    const fg = t.foreground ?? null;
    const { spaceName, tabName } = splitWhere(t.labels.where);
    const e = {
      address: t.address,
      space: t.labels["herdr.space"],
      tab: t.labels["herdr.tab"] ?? null,
      spaceName,
      tabName,
      shell: leaf(t.argv?.[0]),
      rootPid: t.pid != null ? Number(t.pid) : null,
      cwd: fg?.cwd || t.cwd || null,
      kind: "idle",
      agent: null,
      exe: null,
      sessionId: null,
      title: null,
      wsl: null,
      command: null,
    };
    const claude = findClaude(index, t.pid, sessions);
    if (claude) {
      const s = claude.session;
      const wsl = wslFromCwd(s.cwd);
      Object.assign(e, {
        kind: "claude",
        agent: "claude",
        cwd: s.cwd,
        sessionId: s.sessionId,
        title: s.name ?? null,
        wsl: wsl ? { ...wsl, exe: mntPath(claude.proc.path) } : null,
      });
    } else {
      const fgRuns = fg && fg.pid != null && Number(fg.pid) !== Number(t.pid) && !NOT_COMMANDS.has(leaf(fg.argv?.[0]));
      const fgAgent = fgRuns ? detectAgent(fg.argv, named.get(t.address)) : null;
      const tree = fgAgent ? null : findAgent(index, t.pid);
      if (fgAgent) Object.assign(e, { kind: "agent", agent: fgAgent, exe: prog(fg.argv?.[0]) });
      else if (tree) Object.assign(e, { kind: "agent", agent: tree.agent, exe: prog(tree.proc.name) });
      else if (fgRuns) Object.assign(e, { kind: "command", command: formatArgv(fg.argv) });
    }
    out.push(e);
  }
  return out;
}

// ---------- restore planning ----------

/** A parsed snapshot when the text is version 2 JSON, else null. Never throws. */
export function readable(text) {
  if (!text) return null;
  try {
    const s = JSON.parse(String(text).replace(/^﻿/, ""));
    return s && s.version === 2 ? s : null;
  } catch {
    return null;
  }
}

/** What runs now: per address { idle, shell }, and every live session id. */
export function nowState(snapshot) {
  const index = processIndex(snapshot);
  const sessions = sessionsByPid(snapshot);
  const named = hcAgents(snapshot);
  const terminals = new Map();
  const liveAgents = new Set();
  for (const t of terminalsOf(snapshot)) {
    if (!t || t.state !== "live" || String(t.address).includes("/")) continue;
    const fg = t.foreground ?? null;
    const fgLeaf = leaf(fg?.argv?.[0]);
    const fgAgent = fg && Number(fg.pid) !== Number(t.pid) && !NOT_COMMANDS.has(fgLeaf) ? detectAgent(fg.argv, named.get(t.address)) : null;
    const agent = fgAgent ?? findAgent(index, t.pid)?.agent ?? null;
    if (agent) liveAgents.add(folderKey(agent, fg?.cwd || t.cwd));
    const shell = SHELLS.includes(fgLeaf) ? fgLeaf : leaf(t.argv?.[0]);
    const atPrompt = Boolean(fg) && (Number(fg.pid) === Number(t.pid) || SHELLS.includes(fgLeaf));
    const idle = atPrompt && SHELLS.includes(shell) && !agent && !findClaude(index, t.pid, sessions);
    terminals.set(t.address, { idle, shell, rootPid: Number(t.pid), space: t.labels?.["herdr.space"] ?? null });
  }
  // A session is live when its process still runs and is the one that wrote the file:
  // a file left by a crash can carry a pid that now belongs to another program.
  const live = new Set();
  for (const [pid, s] of sessions) {
    const proc = index.byPid.get(pid);
    if (s.sessionId && proc && ownSession(proc, sessions)) live.add(s.sessionId);
  }
  return { terminals, live, liveAgents };
}

/** running | ready | busy | gone for one saved Claude or agent entry. Another agent counts
 *  as running when the same agent runs in the same folder now (its "latest" is that one). */
export function rowState(entry, now) {
  if (entry.kind === "agent" ? now.liveAgents?.has(folderKey(entry.agent, entry.cwd)) : now.live.has(entry.sessionId)) return "running";
  const t = now.terminals.get(entry.address);
  // The address must still be a visible terminal in the same space: a parked or reused
  // terminal without that label is not the tab this session came from.
  if (!t || !t.space || t.space !== entry.space) return "gone";
  return t.idle ? "ready" : "busy";
}

function wslLine(entry) {
  const w = entry.wsl;
  const exe = w.exe ? `'${w.exe}'` : "claude.exe";
  return `cd '${w.path}' && ${exe} --resume ${entry.sessionId}; exec bash`;
}

/** The line typed into an idle shell to resume a saved session, in that shell's syntax. */
export function resumeText(entry, shell) {
  if (entry.wsl) return `wsl.exe -d ${entry.wsl.distro} -e bash -lic "${wslLine(entry)}"`;
  const run = resumeArgv(entry).join(" ");
  const cwd = String(entry.cwd ?? "");
  switch (leaf(shell)) {
    case "pwsh":
    case "powershell":
      return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${run}`;
    case "cmd":
      return `cd /d "${cwd}" && ${run}`;
    case "fish":
      return `cd '${cwd.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'; and ${run}`;
    case "nu":
      return cwd.includes("'") ? `cd \`${cwd}\`; ${run}` : `cd '${cwd}'; ${run}`;
    default:
      return `cd -- '${cwd.replace(/'/g, "'\\''")}' && ${run}`;
  }
}

/** The program that resumes a saved session (also what a new tab starts). */
export function resumeArgv(entry) {
  if (entry.wsl) return ["wsl.exe", "-d", entry.wsl.distro, "-e", "bash", "-lic", wslLine(entry)];
  if (entry.kind === "agent") {
    const a = AGENTS[entry.agent];
    // Keep the program name that ran when it is one of the agent's own (qoder or qodercli).
    const exe = a.exe.includes(entry.exe) && a.exe.includes(a.resume[0]) ? entry.exe : a.resume[0];
    return [exe, ...a.resume.slice(1)];
  }
  return ["claude", "--resume", entry.sessionId];
}

/** Rows for the popup from one snapshot. spaceIds: the spaces that exist now. */
export function buildPlan(snapshot, now, spaceIds) {
  const rows = [];
  for (const e of entries(snapshot)) {
    if (e.kind === "claude" || e.kind === "agent") {
      const state = rowState(e, now);
      const row = {
        kind: e.kind, address: e.address, state, space: e.space, spaceName: e.spaceName, tabName: e.tabName,
        cwd: e.cwd, sessionId: e.sessionId, title: e.title, wsl: Boolean(e.wsl), send: null, newTab: null,
        agent: e.agent, agentName: e.kind === "agent" ? AGENTS[e.agent].name : "Claude", sameAs: null,
      };
      const t = now.terminals.get(e.address);
      // The same shell as when saved means only Claude died; a killed Claude can leave the
      // terminal in bracketed-paste mode, which garbles a typed line. Use a new tab then.
      const survived = state === "ready" && e.rootPid != null && t.rootPid === e.rootPid;
      if (state === "ready" && !survived) row.send = resumeText(e, t.shell);
      if ((state === "gone" || survived) && e.space && spaceIds.has(e.space)) {
        row.newTab = { space: e.space, name: e.tabName ?? e.title ?? row.agentName, folder: e.wsl ? null : e.cwd, argv: resumeArgv(e) };
      }
      rows.push(row);
    } else if (e.kind === "command") {
      rows.push({ kind: "command", address: e.address, state: "copy", space: e.space, spaceName: e.spaceName, tabName: e.tabName, cwd: e.cwd, command: e.command });
    }
  }
  const key = (r) => [r.spaceName ?? "", r.tabName ?? "", r.address];
  rows.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  });
  // "Latest in folder" is one session: two tabs with the same agent in the same folder
  // would both open it. Only the first may resume; the others say why not.
  const first = new Map();
  for (const r of rows) {
    if (r.kind !== "agent" || (r.state !== "ready" && r.state !== "gone")) continue;
    const k = folderKey(r.agent, r.cwd);
    if (!first.has(k)) { first.set(k, r); continue; }
    Object.assign(r, { state: "duplicate", send: null, newTab: null, sameAs: first.get(k).tabName ?? first.get(k).address });
  }
  return rows;
}

/** Index of the newest snapshot (newest first) holding a lost Claude session: not running
 *  now, and its terminal is gone or back to an empty shell. 0 when none. */
export function pickSnapshot(snapshots, now) {
  for (let i = 0; i < snapshots.length; i++) {
    for (const e of entries(snapshots[i])) {
      if (e.kind !== "claude" && e.kind !== "agent") continue;
      const state = rowState(e, now);
      if (state === "gone" || state === "ready") return i;
    }
  }
  return 0;
}
