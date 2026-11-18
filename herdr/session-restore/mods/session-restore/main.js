// Resume Claude Code sessions that Herdr terminals lost to a reboot or crash.
// Opened with Ctrl+Shift+R. The saver next to this file (save.ps1 on Windows, save.sh on
// Linux and macOS) records every 5 minutes which session ran in which terminal; plan.js
// decides what each one can do now. This mod shows that and acts on what the person ticks.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, run, theme, home, appHome, props, closeOverlay, notify, readTextFile, checking, nextCommand, spaces, window as appWindow } from "herdr";
import * as fs from "fs/promises";
import { readable, entries, nowState, buildPlan, pickSnapshot } from "./plan.js";

const SNAPSHOTS_SHOWN = 20;
const keyOf = (r) => `${r.address}|${r.sessionId ?? r.agent ?? r.command}`;
const shortId = (id) => (id ?? "").slice(0, 8);
const timeOf = (ms) => {
  const d = new Date(ms);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getDate()}/${d.getMonth() + 1} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const ago = (ms) => {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};
const shortPath = (p) => {
  const n = String(p ?? "").replace(/\\/g, "/");
  const h = String(home() ?? "").replace(/\\/g, "/");
  return h && n.toLowerCase().startsWith(h.toLowerCase()) ? `~${n.slice(h.length)}` : n;
};
const autoDir = () => `${home()}/.herdr-sessions/auto`;

// The saver: one script per platform, same subcommands.
const FLAGS = { print: "-Print", enable: "-Enable", disable: "-Disable", status: "-Status" };
async function saver(command) {
  const dir = `${appHome()}/mods/session-restore`;
  const r = appWindow().platform === "windows"
    ? await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${dir}/save.ps1`, ...(FLAGS[command] ? [FLAGS[command]] : [])], { timeout: 90000 })
    : await exec("sh", [`${dir}/save.sh`, command], { timeout: 90000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `saver ${command} failed`).trim().split("\n")[0]);
  return (r.stdout ?? "").trim();
}

async function readSnapshots() {
  let names = [];
  try { names = await fs.readdir(autoDir()); } catch { return []; }
  names = names.filter((n) => /^\d{8}-\d{6}\.json$/.test(n)).sort().reverse().slice(0, SNAPSHOTS_SHOWN);
  const out = [];
  for (const file of names) {
    const snap = readable(await readTextFile(`${autoDir()}/${file}`).catch(() => null));
    if (snap) out.push({ file, snap });
  }
  return out;
}

const STATE = {
  ready: { label: "Ready", tone: "accent" },
  running: { label: "Already running", tone: "dim" },
  busy: { label: "Tab is busy", tone: "dim" },
  duplicate: { label: "Same folder", tone: "dim" },
  gone: { label: "Tab gone", tone: "muted" },
  copy: { label: "Command", tone: "muted" },
};

export default class SessionRestore extends View {
  init(_props, cx) {
    this.plan = null;
    this.error = null;
    this.loading = true;
    this.working = false;
    this.picked = new Set();
    this.copied = null;
    this.snapshot = null;
    this.autosave = null;
    this.toggling = false;
    if (checking()) { this.loading = false; return; }
    this.load(cx, null);
    this.loadStatus(cx);
    // Key commands (keys.json section "mod:session-restore"): Enter resumes the ticked rows.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "resume") this.resume(cx);
        else if (command === "close") this.close();
      }
    });
  }

  load(cx, snapshot) {
    this.loading = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const plan = await this.fetchPlan(snapshot);
        this.plan = plan;
        this.snapshot = plan.chosen;
        this.picked = new Set(plan.rows.filter((r) => r.state === "ready").map(keyOf));
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  loadStatus(cx) {
    cx.spawn(async (cx) => {
      try { this.autosave = JSON.parse(await saver("status")); } catch (e) { this.autosave = { enabled: false, lastRun: null, lastError: String(e?.message ?? e) }; }
      cx.notify();
    });
  }

  toggleAutosave(cx) {
    if (this.toggling) return;
    const on = !this.autosave?.enabled;
    this.toggling = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await saver(on ? "enable" : "disable"); } catch (e) {
        notify({ title: on ? "Autosave could not be turned on" : "Autosave could not be turned off", body: String(e?.message ?? e), level: "warning" });
      }
      this.toggling = false;
      this.loadStatus(cx);
      if (on) this.load(cx, null);
      cx.notify();
    });
  }

  // The plan for one snapshot (null: the default choice) against what runs now.
  async fetchPlan(snapshot) {
    const now = readable(await saver("print"));
    if (!now) throw new Error("The saver printed no snapshot.");
    const live = nowState(now);
    const list = await readSnapshots();
    let at = snapshot ? list.findIndex((s) => s.file === snapshot) : -1;
    if (at < 0) at = list.length ? pickSnapshot(list.map((s) => s.snap), live) : -1;
    const spaceIds = new Set(spaces().filter((s) => !s.machine).map((s) => s.id));
    return {
      chosen: at >= 0 ? list[at].file : null,
      snapshots: list.map((s) => ({ file: s.file, savedAt: s.snap.savedAt, claude: entries(s.snap).filter((e) => e.kind === "claude" || e.kind === "agent").length })),
      rows: at >= 0 ? buildPlan(list[at].snap, live, spaceIds) : [],
    };
  }

  selectable(r) {
    return r.state === "ready" || (r.state === "gone" && r.newTab);
  }

  toggle(r, cx) {
    if (!this.selectable(r)) return;
    const k = keyOf(r);
    if (this.picked.has(k)) this.picked.delete(k);
    else this.picked.add(k);
    cx.notify();
  }

  close() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  // Checks every ticked row again right before acting, so a terminal that got busy
  // in the meantime is skipped, never typed into.
  resume(cx) {
    if (this.working || !this.picked.size) return;
    this.working = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const done = [], skipped = [];
      try {
        const fresh = await this.fetchPlan(this.snapshot);
        const byKey = new Map(fresh.rows.map((r) => [keyOf(r), r]));
        for (const k of this.picked) {
          const r = byKey.get(k);
          const label = r ? (r.tabName || r.title || r.address) : k;
          if (r?.state === "ready" && r.send) {
            const res = await hc(["send", r.address, r.send]).catch((e) => ({ code: 1, stderr: String(e) }));
            if (res.code === 0) done.push(label); else skipped.push(`${label} (${(res.stderr || "send failed").trim().split("\n")[0]})`);
          } else if ((r?.state === "gone" || r?.state === "ready") && r.newTab) {
            try {
              const args = { space: r.newTab.space, name: r.newTab.name, argv: r.newTab.argv, focus: false };
              if (r.newTab.folder) args.folder = r.newTab.folder;
              await run("tab.new", args);
              done.push(`${label} (new tab)`);
            } catch (e) { skipped.push(`${label} (${String(e?.message ?? e)})`); }
          } else {
            skipped.push(`${label} (${r ? STATE[r.state]?.label ?? r.state : "no longer in the snapshot"})`);
          }
        }
      } catch (e) {
        skipped.push(String(e?.message ?? e));
      }
      notify({
        title: done.length ? `Resumed ${done.length} session${done.length === 1 ? "" : "s"}` : "Nothing resumed",
        body: [done.join(", "), skipped.length ? `Skipped: ${skipped.join("; ")}` : ""].filter(Boolean).join("\n"),
        level: skipped.length ? "warning" : "info",
      });
      this.working = false;
      cx.notify();
      this.close();
    });
  }

  copy(r, cx) {
    cx.write_to_clipboard(String(r.command ?? ""));
    this.copied = keyOf(r);
    cx.notify();
  }

  // ---------- drawing ----------

  button(t, id, text, onClick, { primary = false, disabled = false } = {}) {
    return div().id(id).px(14).h(30).flex().items_center().rounded(6).text_size(13)
      .bg(primary && !disabled ? t.solid : t.raised).text_color(primary && !disabled ? t.solid_foreground : disabled ? t.dim : t.foreground)
      .border(1).border_color(t.border)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.9)).on_click((_e, cx) => onClick(cx)))
      .child(text);
  }

  checkbox(t, on, enabled) {
    return div().w(16).h(16).flex_none().rounded(4).border(1)
      .border_color(on ? t.accent : enabled ? t.input : t.border).bg(on ? t.accent : "#00000000")
      .flex().items_center().justify_center().text_size(11).text_color(t.accent_foreground)
      .child(on ? "✓" : "");
  }

  row(t, r, i) {
    const k = keyOf(r);
    const on = this.picked.has(k);
    const can = this.selectable(r);
    const s = STATE[r.state] ?? { label: r.state, tone: "muted" };
    const tone = s.tone === "accent" ? t.accent : s.tone === "dim" ? t.dim : t.muted;
    const title = `${r.spaceName || "?"} / ${r.tabName || r.title || r.address}`;
    const note = r.state === "duplicate" ? `as ${r.sameAs}`
      : r.state === "gone" ? (r.newTab ? "opens in a new tab" : "its space is gone too")
      : r.state === "ready" && !r.send && r.newTab ? "opens in a new tab" : null;
    const sub = r.kind === "command"
      ? r.command
      : r.kind === "agent"
        ? `${shortPath(r.cwd)} · ${r.agentName} · latest in folder`
        : `${shortPath(r.cwd)} · ${shortId(r.sessionId)}${r.wsl ? " · WSL" : ""}`;
    return h_flex().id(`row-${i}`).px(14).py(8).gap(12).items_center().rounded(8)
      .when(can, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.toggle(r, cx)))
      .child(r.kind === "command" ? div().w(16).flex_none() : this.checkbox(t, on, can))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(13).text_color(can || r.kind === "command" ? t.foreground : t.muted).truncate().child(title))
        .child(div().text_size(11).font_family("monospace").text_color(t.dim).truncate().child(sub)))
      .child(v_flex().flex_none().items_end().gap(2)
        .child(div().text_size(11).text_color(tone).child(s.label))
        .when(Boolean(note), (el) => el.child(div().text_size(10).text_color(t.dim).child(note))))
      .when(r.kind === "command", (el) => el.child(
        div().id(`copy-${i}`).flex_none().px(10).h(24).flex().items_center().rounded(5).text_size(12)
          .border(1).border_color(t.border).cursor_pointer().hover((st) => st.bg(t.raised))
          .on_click((_e, cx) => { cx.stop_propagation(); this.copy(r, cx); })
          .child(this.copied === k ? "Copied" : "Copy")));
  }

  snapshotBar(t) {
    const list = this.plan?.snapshots ?? [];
    const at = list.findIndex((s) => s.file === this.snapshot);
    const cur = list[at];
    const go = (d) => (cx) => { const n = list[at + d]; if (n) this.load(cx, n.file); };
    return h_flex().px(14).gap(8).items_center().text_size(12).text_color(t.muted)
      .child(div().child(cur ? `Saved ${timeOf(cur.savedAt)} · ${cur.claude} agent session${cur.claude === 1 ? "" : "s"}` : "No snapshot yet"))
      .child(div().flex_1())
      .child(this.button(t, "older", "‹ Older", go(1), { disabled: this.loading || at < 0 || at >= list.length - 1 }))
      .child(this.button(t, "newer", "Newer ›", go(-1), { disabled: this.loading || at <= 0 }));
  }

  autosaveBar(t) {
    const a = this.autosave;
    const on = Boolean(a?.enabled);
    const text = !a ? "Checking autosave…"
      : on ? `Autosave on · ${a.lastRun ? `last save ${ago(a.lastRun)}` : "no save yet"}`
        : "Autosave is off: sessions are only saved while it is on";
    return v_flex().px(14).gap(4)
      .child(h_flex().gap(8).items_center()
        .child(div().w(8).h(8).rounded(4).flex_none().bg(on ? t.accent : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(on ? t.muted : t.foreground).child(text))
        .when(Boolean(a), (el) => el.child(this.button(t, "autosave", this.toggling ? "…" : on ? "Turn off" : "Turn on autosave",
          (cx) => this.toggleAutosave(cx), { primary: !on, disabled: this.toggling }))))
      .when(Boolean(a?.lastError), (el) => el.child(div().text_size(11).text_color(t.dim).truncate().child(`Last save failed: ${a.lastError}`)));
  }

  render(cx) {
    const t = theme();
    const rows = this.plan?.rows ?? [];
    const order = { ready: 0, gone: 1, busy: 2, duplicate: 3, running: 4 };
    const claude = rows.filter((r) => r.kind === "claude" || r.kind === "agent");
    const open = claude.filter((r) => r.state !== "running").sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
    const running = claude.filter((r) => r.state === "running");
    const commands = rows.filter((r) => r.kind === "command");
    const n = this.picked.size;
    const label = (text) => div().px(14).pt(14).pb(4).text_size(11).text_color(t.dim).child(text);
    const body = this.loading
      ? div().p(20).text_size(13).text_color(t.muted).child("Checking which sessions can come back…")
      : this.error
        ? div().p(20).text_size(13).text_color(t.blocked ?? t.muted).child(this.error)
        : !this.plan?.chosen
          ? div().p(20).text_size(13).text_color(t.muted).child("Nothing saved yet. Turn on autosave below; after a reboot, the sessions that ran come back here.")
          : !rows.length
            ? div().p(20).text_size(13).text_color(t.muted).child("Nothing saved in this snapshot.")
            : v_flex().gap(2)
                .when(!open.length, (el) => el.child(div().px(14).py(10).text_size(13).text_color(t.muted)
                  .child(running.length ? `Nothing to resume: all ${running.length} saved sessions are running.` : "Nothing to resume.")))
                .children(open.map((r, i) => this.row(t, r, i)))
                .when(running.length > 0, (el) => el
                  .child(h_flex().id("toggle-running").px(14).pt(14).pb(4).gap(6).items_center().cursor_pointer()
                    .on_click((_e, cx) => { this.showRunning = !this.showRunning; cx.notify(); })
                    .child(div().text_size(11).text_color(t.dim).child(`${this.showRunning ? "▾" : "▸"} ALREADY RUNNING · ${running.length}`)))
                  .when(Boolean(this.showRunning), (el2) => el2.children(running.map((r, i) => this.row(t, r, 500 + i)))))
                .when(commands.length > 0, (el) => el
                  .child(label("OTHER COMMANDS · copy and run them yourself"))
                  .children(commands.map((r, i) => this.row(t, r, 1000 + i))));
    return v_flex().size_full().bg(t.popover ?? t.surface).text_color(t.foreground).py(14).gap(10)
      .child(h_flex().px(14).items_center()
        .child(div().text_size(16).font_semibold().child("Resume agent sessions"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child("Ctrl+Shift+R")))
      .child(this.snapshotBar(t))
      .child(div().id("rows").flex_1().min_h(0).overflow_y_scrollbar().px(6).child(body))
      .child(this.autosaveBar(t))
      .child(h_flex().px(14).gap(8).items_center()
        .child(div().text_size(12).text_color(t.dim).child(this.working ? "Resuming…" : `${n} selected`))
        .child(div().flex_1())
        .child(this.button(t, "cancel", "Cancel", () => this.close()))
        .child(this.button(t, "resume", n ? `Resume ${n}` : "Resume", (cx) => this.resume(cx), { primary: true, disabled: !n || this.working || this.loading })));
  }
}
