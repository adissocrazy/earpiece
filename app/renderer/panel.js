// The notch panel's "Needs you" tab: everything waiting on you and the work that finished in the
// last day (src/inbox.mjs builds the list, the app checks every answer). Keyboard first: 1–9
// answer, J/K move, R or Enter reply, O open the terminal, E clear, Tab the agents, Esc undo
// (every answer waits 2 s) or close. card.js owns the island and the Agents tab; it calls in here.
(() => {
  const J = window.earpiece;
  const q = (id) => document.getElementById(id);
  const hold = createHold(2000);
  let data = { needs: [], older: [], finished: [] };
  let olderOpen = false; // the folded "Older" section
  let tab = "needs"; // or "agents"
  const gone = new Set(); // item ids sliding out (sent)
  let mic = null; // { id, clip } while the reply box records
  let items = [];
  let sel = null; // item id
  let replying = null; // item id with its reply box open
  let draft = "";
  const picks = {}; // item id → { qi, answers: { question: label | [labels] } }
  const held = new Set(); // item ids with an answer waiting or in flight

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const ago = (ms) => (ms < 60_000 ? "now" : ms < 3600_000 ? `${Math.floor(ms / 60_000)}m` : ms < 86400_000 ? `${Math.floor(ms / 3600_000)}h` : `${Math.floor(ms / 86400_000)}d`);
  const isAsk = (it) => it.kind === "question" || it.kind === "permission" || it.kind === "reply";
  const canReply = (it) => it.kind === "question" || it.kind === "reply" || Boolean(it.replyId || it.run);
  const DOT = { question: "amber", permission: "amber", reply: "amber", terminal: "amber", waiting: "amber", done: "green", error: "red", idle: "grey", working: "" };
  const STATUS = { question: "Asks", permission: "Needs approval", reply: "Asks", terminal: "In its terminal", waiting: "Waiting on you", working: "Working", done: "Done", error: "Error", idle: "Idle" };
  const MIC = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/></svg>';
  const resized = () => window.dispatchEvent(new Event("panel-resize"));

  function error(msg) {
    q("panelErr").textContent = msg || "";
    q("panelErr").hidden = !msg;
    resized();
  }

  // ---------- sending (held 2 s) ----------

  function send(it, what, value) {
    error("");
    held.add(it.id);
    q("undoText").replaceChildren(`${what} `, el("b", "", `${it.agent}${it.project ? ` · ${it.project}` : ""}`));
    const u = q("undo");
    u.hidden = false;
    u.classList.remove("run");
    void u.offsetWidth; // restart the countdown bar
    u.classList.add("run");
    const id = it.id;
    hold.start(id, async () => {
      gone.add(id); // slides out while it goes
      render();
      const [r] = await Promise.all([J.card("inbox-act", { id, ...value }), new Promise((res) => setTimeout(res, 250))]);
      if (!hold.pending()) u.hidden = true;
      held.delete(id);
      gone.delete(id);
      if (!r?.ok) error(r?.error || "That didn't go through.");
      render();
    });
    if (replying === id) (replying = null), (draft = "");
    move(1, id);
    render();
  }

  function undo() {
    const id = hold.pending();
    if (!hold.cancel()) return false;
    held.delete(id);
    q("undo").hidden = true;
    sel = id;
    render();
    return true;
  }

  // ---------- the numbered choices of an item ----------

  function choices(it) {
    if (it.kind === "question") {
      const p = (picks[it.id] ||= { qi: 0, answers: {} });
      const qu = it.questions[p.qi];
      return qu.options.map((o) => ({ label: o.label, note: o.description, on: [].concat(p.answers[qu.question] || []).includes(o.label), run: () => choose(it, o.label) }));
    }
    if (it.kind === "permission") {
      const out = [];
      if (!it.partial) out.push({ label: "Allow", cls: "go", run: () => send(it, "Allowing", { action: "permission", behavior: "allow" }) });
      if (it.canAlways) out.push({ label: "Always allow", note: it.alwaysRule, run: () => send(it, "Always allowing", { action: "permission", behavior: "always" }) });
      out.push({ label: "Deny", cls: "no", run: () => send(it, "Denying", { action: "permission", behavior: "deny" }) });
      return out;
    }
    return (it.options || []).map((o) => ({ label: o, quick: true, run: () => (canReply(it) ? send(it, `“${o}” to`, { action: "reply", text: o }) : error("Earpiece can't type into that terminal. Press O to open it.")) }));
  }

  // One question at a time; a multi-select question takes several, then Enter.
  function choose(it, label) {
    const p = picks[it.id];
    const qu = it.questions[p.qi];
    if (qu.multiSelect) {
      const cur = [].concat(p.answers[qu.question] || []);
      p.answers[qu.question] = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
      return render();
    }
    p.answers[qu.question] = label;
    next(it);
  }

  function next(it) {
    const p = picks[it.id];
    const qu = it.questions[p.qi];
    if (![].concat(p.answers[qu.question] || []).length) return;
    if (p.qi < it.questions.length - 1) return (p.qi++, render());
    const said = Object.values(p.answers).map((a) => [].concat(a).join(", ")).join("; ");
    send(it, `“${said}” to`, { action: "choose", answers: p.answers });
    delete picks[it.id];
  }

  function submitReply(it, text) {
    const t = text.trim();
    if (!t) return;
    if (it.kind === "question") {
      picks[it.id].answers[it.questions[picks[it.id].qi].question] = t; // the "Other" answer
      replying = null;
      draft = "";
      return next(it);
    }
    send(it, "Replying to", { action: "reply", text: t });
  }

  function open(it) {
    if (isAsk(it)) return send(it, "Back to the terminal:", { action: "terminal" });
    J.card("inbox-act", { id: it.id, action: "open" }).then((r) => (r?.ok ? window.dispatchEvent(new Event("panel-close")) : error(r?.error)));
  }

  // ---------- drawing ----------

  function card(it) {
    const c = el("div", `card${it.id === sel ? " sel" : ""}${held.has(it.id) ? " held" : ""}${gone.has(it.id) ? " gone" : ""}`);
    c.dataset.id = it.id;
    const meta = el("div", "meta");
    meta.append(window.EarpieceLogos?.logo(it.agentId) || el("span"), el("span", "who", it.agent));
    if (it.project) meta.append(el("span", "", "·"), el("span", "pj", it.project));
    meta.append(el("span", `dot ${DOT[it.kind] || ""}`), el("span", "", STATUS[it.kind] || ""), el("span", "age", it.at ? ago(Date.now() - it.at) : ""));
    c.append(meta);

    if (it.kind === "question") {
      const p = (picks[it.id] ||= { qi: 0, answers: {} });
      const qu = it.questions[p.qi];
      const n = it.questions.length;
      if (qu.header || n > 1) c.append(el("div", "qh", [qu.header, n > 1 ? `${p.qi + 1} of ${n}` : ""].filter(Boolean).join(" · ")));
      c.append(el("div", "q", qu.text));
      if (qu.multiSelect) c.append(el("div", "sub", "Pick any, then Enter."));
    } else if (it.kind === "permission") {
      c.append(el("div", "q", it.why || it.line));
      if (it.detail) c.append(el("div", "code", it.detail));
      if (it.partial) c.append(el("div", "sub", "Too long to approve here. Press O to check it in the terminal."));
    } else {
      // Options are shown as buttons below, so the question keeps only its words.
      const line = it.options ? it.line.split("\n").filter((l) => !/^\s*(?:\d{1,2}[.)]|[-*•])\s+/.test(l)).join("\n") : it.line;
      c.append(el("div", "q", line || (it.kind === "error" ? "Stopped with an error." : "Finished.")));
    }

    const cs = choices(it);
    // Short answers ("Yes" / "No") sit in a row; a real list of options stacks.
    const row = it.kind === "permission" || (cs.length && cs.every((ch) => ch.quick && ch.label.length <= 28));
    if (cs.length) {
      const box = el("div", row ? "btns" : "opts");
      cs.forEach((ch, i) => {
        const b = el("button", it.kind === "permission" ? `btn ${ch.cls || ""}` : row ? "btn quick" : `opt${ch.on ? " on" : ""}`);
        b.append(el("kbd", "", String(i + 1)), el("span", "", ch.label));
        if (ch.note) b.append(el("small", "", ch.note));
        b.disabled = held.has(it.id);
        b.tabIndex = -1; // the keys drive it; a focused button would also take Enter
        b.onclick = (e) => (e.stopPropagation(), (sel = it.id), ch.run());
        box.append(b);
      });
      c.append(box);
    }

    const acts = el("div", "btns");
    const btn = (k, label, fn) => {
      const b = el("button", "btn");
      b.append(el("kbd", "", k), el("span", "", label));
      b.disabled = held.has(it.id);
      b.tabIndex = -1;
      b.onclick = (e) => (e.stopPropagation(), (sel = it.id), fn());
      acts.append(b);
    };
    if (canReply(it) && replying !== it.id) btn("R", it.kind === "question" ? "Other…" : "Reply", () => startReply(it));
    btn("O", isAsk(it) ? "Answer in terminal" : "Open", () => open(it));
    if (!isAsk(it)) btn("E", "Clear", () => clear(it));
    c.append(acts);

    if (replying === it.id) {
      const r = el("div", "reply");
      const t = el("textarea");
      t.rows = 2;
      t.maxLength = 4000;
      t.spellcheck = false;
      t.placeholder = `Reply to ${it.agent}…  (Enter to send, Esc to cancel)`;
      t.value = draft;
      t.oninput = () => (draft = t.value);
      t.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) (e.preventDefault(), submitReply(it, t.value));
        if (e.key === "Escape") (e.preventDefault(), (replying = null), (draft = ""), render());
      };
      const m = el("button", `mic${mic?.id === it.id ? " rec" : ""}`);
      m.tabIndex = -1;
      m.title = "Speak your reply";
      m.innerHTML = MIC;
      m.prepend(el("span", "lv"));
      m.onclick = (e) => (e.stopPropagation(), dictate(it, m));
      r.append(t, m);
      c.append(r);
    }
    c.onclick = (e) => (e.stopPropagation(), (sel = it.id), render());
    return c;
  }

  function render() {
    items = [...data.needs, ...data.finished, ...(olderOpen ? data.older : [])];
    if (!items.some((x) => x.id === sel)) sel = items.find((x) => !held.has(x.id))?.id || items[0]?.id || null;
    const n = data.needs.length;
    q("needsCount").textContent = String(n);
    q("needsCount").hidden = !n;
    q("agents").dataset.tab = tab;
    q("tabNeeds").classList.toggle("on", tab === "needs");
    q("tabAgents").classList.toggle("on", tab === "agents");
    const list = q("needs");
    if (!items.length && !data.older.length) {
      const e = el("div", "empty", "Nothing waiting on you.");
      e.append(el("br"), "Questions and finished work from your agents land here.");
      list.replaceChildren(e);
      return resized();
    }
    const out = [];
    if (data.needs.length) out.push(el("div", "sec", "Needs you"), ...data.needs.map(card));
    if (data.finished.length) out.push(el("div", "sec", "Finished"), ...data.finished.map(card));
    // Asked hours ago and nothing since: likely dealt with. Folded, so they don't crowd what's new.
    if (data.older.length) {
      const h = el("button", "sec fold", `${olderOpen ? "▾" : "▸"} Older · ${data.older.length}`);
      h.tabIndex = -1;
      h.title = "Waiting more than 3 hours with nothing new";
      h.onclick = (e) => (e.stopPropagation(), (olderOpen = !olderOpen), render());
      out.push(h, ...(olderOpen ? data.older.map(card) : []));
    }
    list.replaceChildren(...out);
    list.querySelector(".card.sel")?.scrollIntoView({ block: "nearest" });
    const t = list.querySelector(".reply textarea");
    if (t && tab === "needs") (t.focus(), t.setSelectionRange(t.value.length, t.value.length));
    resized();
  }

  // Step the selection; skip `from` itself when it was just answered.
  function move(dir, from = sel) {
    const live = items.filter((x) => !held.has(x.id) || x.id === from);
    const i = live.findIndex((x) => x.id === from);
    const to = live[i + dir] || live[i - dir];
    sel = to && to.id !== from ? to.id : sel;
  }

  function startReply(it) {
    if (!canReply(it)) return error("Earpiece can't type into that terminal. Press O to open it.");
    replying = it.id;
    draft = "";
    render();
  }

  function clear(it) {
    send(it, "Cleared", { action: "clear" });
  }

  // The reply box's mic: speak, and the words land in the box for you to check and send.
  async function dictate(it, button) {
    if (mic) return mic.clip?.stop();
    const ok = await J.dictate("start");
    if (!ok?.ok) return error(ok?.error);
    mic = { id: it.id, clip: null };
    button.classList.add("rec");
    const lv = button.querySelector(".lv");
    try {
      mic.clip = await recordClip({ onLevel: (v) => (lv.style.height = `${Math.round(v * 100)}%`) });
    } catch {
      mic = null;
      return (error("Couldn't open the microphone."), render());
    }
    const got = await mic.clip.done;
    mic = null;
    if (!got || got.silent) return (got?.silent && error("Didn't hear anything."), render());
    button.classList.replace("rec", "busy");
    const r = await J.dictate("transcribe", got.bytes, got.mime);
    if (!r?.ok) return (error(r?.error), render());
    if (replying === it.id) draft = [draft.trim(), r.text].filter(Boolean).join(" ");
    render();
  }

  function setTab(t) {
    if (tab === t) return render();
    tab = t;
    replying = null;
    render();
  }

  // ---------- keys (card.js forwards them while the panel is open) ----------

  function onKey(e) {
    if (e.metaKey || e.ctrlKey) return;
    if (e.target?.matches?.("input, textarea, select")) return; // typing somewhere (Pro's run boxes)
    const k = e.key.toLowerCase();
    if (k === "escape") return void (undo() || window.dispatchEvent(new Event("panel-close")));
    if (k === "tab") return (e.preventDefault(), setTab(tab === "needs" ? "agents" : "needs"));
    if (tab !== "needs") return;
    const it = items.find((x) => x.id === sel);
    if (k === "j" || e.key === "ArrowDown") return (e.preventDefault(), move(1), render());
    if (k === "k" || e.key === "ArrowUp") return (e.preventDefault(), move(-1), render());
    if (!it || held.has(it.id)) return;
    if (/^[1-9]$/.test(k)) return void choices(it)[Number(k) - 1]?.run();
    if (k === "enter" && it.kind === "question" && it.questions[picks[it.id]?.qi || 0]?.multiSelect) return (e.preventDefault(), next(it));
    if (k === "r" || k === "enter") return (e.preventDefault(), startReply(it));
    if (k === "o") return open(it);
    if (k === "e" && !isAsk(it)) return clear(it);
  }

  window.EarpiecePanel = {
    update: (l) => ((data = { needs: [], older: [], finished: [], ...(l || {}) }), render()),
    count: () => data.needs.length,
    setTab,
    tab: () => tab,
    // Open on one item; `reply`: with its reply box (Reply on a line in the notch).
    focus: (id, reply = false) => {
      sel = id;
      tab = "needs";
      const it = reply && items.find((x) => x.id === id);
      if (it && canReply(it)) return startReply(it);
      render();
    },
    onKey,
    // Something you'd lose if the panel folded now: a reply being typed, an answer held, the mic.
    busy: () => Boolean(hold.pending() || mic || (replying && draft.trim())),
    // Folding away: an answer you picked still goes; a recording is dropped.
    close: () => {
      hold.flush();
      mic?.clip?.drop();
      q("undo").hidden = true;
      replying = null;
      draft = "";
    },
  };
  render();
})();
