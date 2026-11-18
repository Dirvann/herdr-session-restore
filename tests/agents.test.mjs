process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entries, detectAgent, nowState, buildPlan, resumeText, resumeArgv, pickSnapshot, AGENTS } from "../herdr/session-restore/mods/session-restore/plan.js";

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const byAddress = (list) => Object.fromEntries(list.map((e) => [e.address, e]));
const SPACES = new Set(["spcS", "spcB", "spcN", "spcG", "spcH"]);
// Every saved terminal is now a plain shell at its prompt (after a reboot: new root pids).
const afterReboot = (snap) => ({
  terminals: new Map(Object.values(snap.get).map((t) => [t.address, { idle: true, shell: t.argv[0], rootPid: 90000 + Number(t.pid), space: t.labels["herdr.space"] }])),
  live: new Set(),
  liveAgents: new Set(),
});

test("detectAgent: by program name, by hc's agent name, and through node for npm installs", () => {
  assert.equal(detectAgent(["codex", "--model", "o9"], null), "codex");
  assert.equal(detectAgent(["bash"], "codex"), "codex");
  assert.equal(detectAgent(["node", "/x/node_modules/@google/gemini-cli/dist/index.js"], null), "gemini");
  assert.equal(detectAgent(["C:\\Users\\alex\\AppData\\Roaming\\npm\\qwen.cmd"], null), "qwen");
  assert.equal(detectAgent(["opencode"], "opencode"), null); // latest-session scope not documented
  assert.equal(detectAgent(["npm", "run", "dev"], null), null);
});

test("entries: supported agents become agent entries, others stay commands", () => {
  const e = byAddress(entries(load("agents")));
  assert.equal(e.t1.kind, "agent");
  assert.equal(e.t1.agent, "codex");
  assert.equal(e.t1.cwd, "/home/alex/code/shop");
  assert.equal(e.t2.agent, "gemini");
  assert.equal(e.t5.agent, "kiro");
  assert.equal(e.t4.kind, "command");
  assert.equal(e.t4.command, "opencode");
  assert.equal(e.t6.kind, "idle");
});

test("resume lines: cd into the folder, then the agent's continue command", () => {
  const e = byAddress(entries(load("agents")));
  assert.equal(resumeText(e.t1, "bash"), "cd -- '/home/alex/code/shop' && codex resume --last");
  assert.equal(resumeText(e.t5, "fish"), "cd '/home/alex/garden'; and kiro-cli chat --resume");
  assert.equal(resumeText({ ...e.t1, cwd: "C:\\code\\shop" }, "cmd"), 'cd /d "C:\\code\\shop" && codex resume --last');
  assert.deepEqual(resumeArgv(e.t2), ["gemini", "--resume"]);
});

test("every agent in the table has a resume command and a display name", () => {
  for (const [key, a] of Object.entries(AGENTS)) {
    assert.ok(a.name, key);
    assert.ok(Array.isArray(a.resume) && a.resume.length >= 2, key);
  }
});

test("buildPlan: two tabs with the same agent in the same folder: only the first can resume", () => {
  const snap = load("agents");
  const rows = buildPlan(snap, afterReboot(snap), SPACES);
  const t1 = rows.find((r) => r.address === "t1");
  const t3 = rows.find((r) => r.address === "t3");
  assert.equal(t1.state, "ready");
  assert.equal(t1.agentName, "Codex");
  assert.match(t1.send, /codex resume --last$/);
  assert.equal(t3.state, "duplicate");
  assert.equal(t3.send, null);
  assert.equal(t3.newTab, null);
  assert.equal(t3.sameAs, "codex");
});

test("buildPlan: an agent already running in that folder now counts as running", () => {
  const snap = load("agents");
  const now = afterReboot(snap);
  now.liveAgents.add("gemini|/home/alex/blog");
  assert.equal(buildPlan(snap, now, SPACES).find((r) => r.address === "t2").state, "running");
});

test("nowState: live agents are keyed by agent and folder", () => {
  const now = nowState(load("agents"));
  assert.ok(now.liveAgents.has("codex|/home/alex/code/shop"));
  assert.ok(now.liveAgents.has("gemini|/home/alex/blog"));
  assert.ok(!now.liveAgents.has("opencode|/home/alex/notes"));
});

test("a snapshot with one terminal list (hc connect terminal.list) reads like one with per-terminal get", () => {
  const snap = load("agents");
  const listed = { ...snap, get: undefined, list: { terminals: Object.values(snap.get), machines: [] } };
  assert.deepEqual(entries(listed), entries(snap));
  assert.deepEqual([...nowState(listed).liveAgents], [...nowState(snap).liveAgents]);
});

// On Windows herdr-core reports the shell (`cmd /k codex`) as the foreground program;
// the agent only shows in the process tree.
const windowsCodex = () => ({
  version: 2, savedAt: 1794962000000, platform: "windows",
  ls: { terminals: [{ address: "t7", agent: "pwsh", state: "live" }, { address: "t8", agent: "pwsh", state: "live" }] },
  get: {
    t7: { address: "t7", argv: ["pwsh.exe"], cwd: "C:\\Users\\alex\\code\\shop", state: "live", pid: 700,
      foreground: { argv: ["C:\\WINDOWS\\system32\\cmd.exe", "/k", "codex"], cwd: "C:\\Users\\alex\\code\\shop", name: "cmd.exe", pid: 710 },
      labels: { "herdr.space": "spcS", "herdr.tab": "tab7", where: "shop / codex" } },
    t8: { address: "t8", argv: ["pwsh.exe"], cwd: "C:\\Users\\alex\\blog", state: "live", pid: 800,
      foreground: { argv: ["pwsh.exe"], cwd: "C:\\Users\\alex\\blog", name: "pwsh.exe", pid: 800 },
      labels: { "herdr.space": "spcB", "herdr.tab": "tab8", where: "blog / gemini" } },
  },
  processes: [
    { pid: 700, ppid: 1, start: 1794950000000, name: "pwsh.exe" },
    { pid: 710, ppid: 700, start: 1794950001000, name: "cmd.exe" },
    { pid: 720, ppid: 710, start: 1794950002000, name: "codex.exe" },
    { pid: 800, ppid: 1, start: 1794950000000, name: "pwsh.exe" },
    { pid: 810, ppid: 800, start: 1794950001000, name: "node.exe", args: "\"C:\\Program Files\\nodejs\\node.exe\" C:\\Users\\alex\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js" },
  ],
  sessions: [],
});

test("windows: an agent found under the shell in the process tree is an agent entry", () => {
  const e = byAddress(entries(windowsCodex()));
  assert.equal(e.t7.kind, "agent");
  assert.equal(e.t7.agent, "codex");
  assert.equal(e.t8.kind, "agent");
  assert.equal(e.t8.agent, "gemini");
});

test("windows: a terminal with an agent in its process tree is not idle, and the agent is live", () => {
  const now = nowState(windowsCodex());
  assert.equal(now.terminals.get("t7").idle, false);
  assert.equal(now.terminals.get("t8").idle, false);
  assert.ok(now.liveAgents.has("codex|c:\\users\\alex\\code\\shop"));
});

test("pickSnapshot counts lost agent sessions too", () => {
  const snap = load("agents");
  const busyEverywhere = { ...afterReboot(snap), live: new Set() };
  for (const t of busyEverywhere.terminals.values()) t.idle = false;
  const empty = { version: 2, get: {}, processes: [], sessions: [] };
  assert.equal(pickSnapshot([empty, snap], afterReboot(snap)), 1);
  assert.equal(pickSnapshot([empty, snap], busyEverywhere), 0);
});
