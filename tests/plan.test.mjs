process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entries, readable, nowState, rowState, resumeText, resumeArgv, buildPlan, pickSnapshot } from "../herdr/session-restore/mods/session-restore/plan.js";

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const ID = "11111111-1111-4111-8111-111111111111";
const entry = (cwd, extra = {}) => ({ address: "t9", kind: "claude", agent: "claude", sessionId: ID, cwd, wsl: null, ...extra });

// ---------- resume lines: paths with spaces and quotes ----------

test("cmd: cd /d with the path in double quotes", () => {
  assert.equal(resumeText(entry("C:\\Users\\Alex Doe\\it's"), "cmd"), `cd /d "C:\\Users\\Alex Doe\\it's" && claude --resume ${ID}`);
});

test("pwsh and powershell: Set-Location with single quotes doubled", () => {
  const want = `Set-Location -LiteralPath 'C:\\Users\\Alex Doe\\it''s'; claude --resume ${ID}`;
  assert.equal(resumeText(entry("C:\\Users\\Alex Doe\\it's"), "pwsh"), want);
  assert.equal(resumeText(entry("C:\\Users\\Alex Doe\\it's"), "powershell"), want);
});

test("bash, zsh, sh: cd -- with POSIX single-quote escaping", () => {
  const want = `cd -- '/home/alex/it'\\''s here' && claude --resume ${ID}`;
  for (const sh of ["bash", "zsh", "sh", "dash"]) assert.equal(resumeText(entry("/home/alex/it's here"), sh), want);
});

test("fish: backslash-escaped single quote and 'and'", () => {
  assert.equal(resumeText(entry("/home/alex/it's here"), "fish"), `cd '/home/alex/it\\'s here'; and claude --resume ${ID}`);
});

test("nu: single quotes, backticks when the path has a quote", () => {
  assert.equal(resumeText(entry("/home/alex/my code"), "nu"), `cd '/home/alex/my code'; claude --resume ${ID}`);
  assert.equal(resumeText(entry("/home/alex/it's"), "nu"), `cd \`/home/alex/it's\`; claude --resume ${ID}`);
});

test("WSL: the v1 wsl.exe line, whatever the shell", () => {
  const e = entry("\\\\wsl.localhost\\Ubuntu\\home\\alex\\blog", { wsl: { distro: "Ubuntu", path: "/home/alex/blog", exe: "/mnt/c/claude.exe" } });
  assert.equal(resumeText(e, "cmd"), `wsl.exe -d Ubuntu -e bash -lic "cd '/home/alex/blog' && '/mnt/c/claude.exe' --resume ${ID}; exec bash"`);
  assert.deepEqual(resumeArgv(e), ["wsl.exe", "-d", "Ubuntu", "-e", "bash", "-lic", `cd '/home/alex/blog' && '/mnt/c/claude.exe' --resume ${ID}; exec bash`]);
});

test("resumeArgv for a new tab is claude --resume <id>", () => {
  assert.deepEqual(resumeArgv(entry("/home/alex")), ["claude", "--resume", ID]);
});

// ---------- what runs now ----------

test("nowState: shell at its prompt is idle, a program or Claude is not", () => {
  const now = nowState(load("windows"));
  assert.deepEqual(now.terminals.get("t1"), { idle: true, shell: "cmd", rootPid: 100, space: "spcA" });
  assert.equal(now.terminals.get("t4").idle, false); // npm run dev
  assert.equal(now.terminals.get("t2").idle, false); // Claude under pwsh
  assert.equal(now.terminals.get("t6").idle, true);  // stale session file only
  assert.ok(now.live.has(ID));
});

test("nowState: a leftover session file whose pid now belongs to another process is not live", () => {
  const now = nowState(load("windows"));
  assert.ok(!now.live.has("66666666-6666-4666-8666-666666666666"));
});

test("a hidden terminal now at a saved address is never typed into", () => {
  // t2 was a visible Claude tab; the terminal at t2 now has no herdr.space (parked or reused).
  const snap = load("windows");
  const now = load("windows");
  now.get.t2 = { ...now.get.t2, labels: {}, pid: 999, foreground: { argv: ["pwsh.exe"], pid: 999 } };
  now.sessions = [];
  const r = buildPlan(snap, nowState(now), new Set(["spcA"])).find((x) => x.address === "t2");
  assert.equal(r.state, "gone");
  assert.equal(r.send, null);
});

test("rowState: running beats everything, then gone / ready / busy", () => {
  const now = { terminals: new Map([["t1", { idle: true, shell: "cmd", space: "s" }], ["t4", { idle: false, shell: "cmd", space: "s" }]]), live: new Set(["live-id"]) };
  assert.equal(rowState({ address: "t1", sessionId: "live-id", space: "s" }, now), "running");
  assert.equal(rowState({ address: "t1", sessionId: "x", space: "s" }, now), "ready");
  assert.equal(rowState({ address: "t4", sessionId: "x", space: "s" }, now), "busy");
  assert.equal(rowState({ address: "t8", sessionId: "x", space: "s" }, now), "gone");
});

// ---------- plan ----------

const emptyNow = (terminals = []) => ({ terminals: new Map(terminals), live: new Set() });

test("buildPlan: running session row, ready row with the shell's line", () => {
  const snap = load("windows");
  const live = nowState(snap);
  const rows = buildPlan(snap, live, new Set(["spcA", "spcB"]));
  const t2 = rows.find((r) => r.address === "t2");
  assert.equal(t2.state, "running");
  const now = emptyNow([["t2", { idle: true, shell: "cmd", space: "spcA" }]]);
  const r = buildPlan(snap, now, new Set(["spcA"])).find((x) => x.address === "t2");
  assert.equal(r.state, "ready");
  assert.equal(r.send, `cd /d "C:\\Users\\alex\\code\\shop" && claude --resume ${ID}`);
});

test("buildPlan: a shell that outlived its Claude gets a new tab, not typed text", () => {
  // Same root pid as in the snapshot: only Claude died, and it may have left the
  // terminal in bracketed-paste mode, which garbles a typed line.
  const snap = load("windows");
  const now = emptyNow([["t2", { idle: true, shell: "pwsh", rootPid: 200, space: "spcA" }]]);
  const r = buildPlan(snap, now, new Set(["spcA"])).find((x) => x.address === "t2");
  assert.equal(r.state, "ready");
  assert.equal(r.send, null);
  assert.deepEqual(r.newTab.argv, ["claude", "--resume", ID]);
  const fresh = emptyNow([["t2", { idle: true, shell: "pwsh", rootPid: 999, space: "spcA" }]]);
  assert.match(buildPlan(snap, fresh, new Set(["spcA"])).find((x) => x.address === "t2").send, /^Set-Location/);
});

test("buildPlan: gone terminal opens a new tab in its space, or nothing when the space is gone", () => {
  const snap = load("windows");
  const r = buildPlan(snap, emptyNow(), new Set(["spcA"])).find((x) => x.address === "t2");
  assert.equal(r.state, "gone");
  assert.deepEqual(r.newTab, { space: "spcA", name: "api", folder: "C:\\Users\\alex\\code\\shop", argv: ["claude", "--resume", ID] });
  const r2 = buildPlan(snap, emptyNow(), new Set()).find((x) => x.address === "t2");
  assert.equal(r2.newTab, null);
});

test("buildPlan: commands are copy rows, idle terminals are left out", () => {
  const rows = buildPlan(load("windows"), emptyNow(), new Set());
  assert.deepEqual(rows.find((r) => r.address === "t4"), {
    kind: "command", address: "t4", state: "copy", space: "spcA", spaceName: "shop", tabName: "dev",
    cwd: "C:\\Users\\alex\\code\\shop", command: "npm run dev",
  });
  assert.ok(!rows.some((r) => r.address === "t1"));
});

// ---------- snapshot choice ----------

test("pickSnapshot: newest snapshot with a lost session whose terminal is gone or idle", () => {
  const newer = load("windows");
  const older = load("linux");
  const now = { terminals: new Map([["t1", { idle: true, shell: "bash", space: "spcL" }]]), live: new Set(entries(newer).map((e) => e.sessionId).filter(Boolean)) };
  assert.equal(pickSnapshot([newer, older], now), 1);
  const busy = { terminals: new Map([["t1", { idle: false, shell: "bash", space: "spcL" }]]), live: now.live };
  assert.equal(pickSnapshot([newer, older], busy), 0);
});

test("readable: only version 2 JSON, never throws", () => {
  assert.equal(readable("{"), null);
  assert.equal(readable('{"version":1}'), null);
  assert.equal(readable(null), null);
  assert.equal(readable('{"version":2,"get":{}}').version, 2);
});
