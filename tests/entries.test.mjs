process.env.TZ = "UTC"; // lstart fixtures are written in UTC
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { entries, parseStart, splitWhere, leaf } from "../herdr/session-restore/mods/session-restore/plan.js";

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const byAddress = (list) => Object.fromEntries(list.map((e) => [e.address, e]));

test("windows: a Claude session under pwsh becomes a claude entry", () => {
  const e = byAddress(entries(load("windows"))).t2;
  assert.equal(e.kind, "claude");
  assert.equal(e.agent, "claude");
  assert.equal(e.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(e.cwd, "C:\\Users\\alex\\code\\shop");
  assert.equal(e.spaceName, "shop");
  assert.equal(e.tabName, "api");
  assert.equal(e.space, "spcA");
  assert.equal(e.shell, "pwsh");
  assert.equal(e.title, "shop-api");
  assert.equal(e.wsl, null);
});

test("windows: a WSL Claude session keeps distro, Linux path and the claude.exe path", () => {
  const e = byAddress(entries(load("windows"))).t3;
  assert.equal(e.kind, "claude");
  assert.deepEqual(e.wsl, { distro: "Ubuntu", path: "/home/alex/blog", exe: "/mnt/c/Users/alex/AppData/Roaming/npm/claude.exe" });
});

test("windows: a foreground program that is not a shell is a command", () => {
  const e = byAddress(entries(load("windows"))).t4;
  assert.equal(e.kind, "command");
  assert.equal(e.command, "npm run dev");
  assert.equal(e.agent, null);
});

test("windows: a shell at its prompt is idle", () => {
  assert.equal(byAddress(entries(load("windows"))).t1.kind, "idle");
});

test("a session file whose startedAt is long before the process start is not that process", () => {
  assert.equal(byAddress(entries(load("windows"))).t6.kind, "idle");
});

test("hidden terminals (no herdr.space) and remote terminals are left out", () => {
  const addresses = entries(load("windows")).map((e) => e.address);
  assert.ok(!addresses.includes("t5"));
  assert.ok(!addresses.includes("devbox/t3"));
  assert.equal(addresses.length, 5);
});

test("linux: lstart process times match the session's startedAt", () => {
  const list = byAddress(entries(load("linux")));
  assert.equal(list.t1.kind, "claude");
  assert.equal(list.t1.sessionId, "33333333-3333-4333-8333-333333333333");
  assert.equal(list.t1.shell, "bash");
  assert.equal(list.t2.kind, "idle");
});

test("parseStart reads lstart text, single-digit days included, and passes numbers through", () => {
  assert.equal(parseStart("Sun Nov  8 00:20:22 2026"), Date.UTC(2026, 10, 8, 0, 20, 22));
  assert.equal(parseStart(1794950000000), 1794950000000);
  assert.ok(Number.isNaN(parseStart("yesterday")));
});

test("parseStart reads lstart as UTC whatever the local time zone (the saver runs ps with TZ=UTC0)", () => {
  const was = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.equal(parseStart("Sun Nov  8 00:20:22 2026"), Date.UTC(2026, 10, 8, 0, 20, 22));
  } finally {
    process.env.TZ = was;
  }
});

test("leaf strips a login shell's leading dash", () => {
  assert.equal(leaf("-zsh"), "zsh");
  assert.equal(leaf("/bin/-bash"), "bash");
});

test("splitWhere splits on the last ' / '", () => {
  assert.deepEqual(splitWhere("a / b / c"), { spaceName: "a / b", tabName: "c" });
  assert.deepEqual(splitWhere("solo"), { spaceName: "solo", tabName: null });
});
