"use strict";

const SCRATCH_PATTERN = "https://scratch.mit.edu/*";
const MAX_CONSECUTIVE_FAILS = 3;
const MIN_COOLDOWN_SEC = 0.1;

const $ = (id) => document.getElementById(id);
const els = {
  project: $("project"),
  studios: $("studios"),
  studioCount: $("studioCount"),
  cooldown: $("cooldown"),
  jitter: $("jitter"),
  btnAdd: $("btnAdd"),
  btnRemove: $("btnRemove"),
  btnReplace: $("btnReplace"),
  btnStop: $("btnStop"),
  btnCopy: $("btnCopy"),
  btnClear: $("btnClear"),
  progress: $("progress"),
  statusText: $("statusText"),
  log: $("log"),
};

let running = false;
let stopRequested = false;

/* ---------- ログ・表示 ---------- */

function log(message, type = "") {
  const row = document.createElement("div");
  if (type) row.className = type;
  const t = document.createElement("span");
  t.className = "time";
  t.textContent = new Date().toLocaleTimeString("ja-JP", { hour12: false }) + " ";
  row.append(t, document.createTextNode(message));
  els.log.appendChild(row);
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function setRunning(value) {
  running = value;
  for (const b of [els.btnAdd, els.btnRemove, els.btnReplace]) b.disabled = value;
  els.btnStop.disabled = !value;
  for (const el of [els.project, els.studios, els.cooldown, els.jitter]) el.disabled = value;
}

/* ---------- 入力の解析 ---------- */

function parseProjectId(raw) {
  const text = raw.trim();
  const m = text.match(/projects\/(\d+)/) || text.match(/^(\d+)$/);
  return m ? m[1] : null;
}

function parseStudioIds(raw) {
  const ids = [];
  const invalid = [];
  const seen = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    const m = text.match(/studios\/(\d+)/) || text.match(/^(\d+)$/);
    if (!m) {
      invalid.push(text);
      continue;
    }
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return { ids, invalid };
}

function updateStudioCount() {
  const { ids, invalid } = parseStudioIds(els.studios.value);
  let text = `${ids.length} 件`;
  if (invalid.length) text += `（読み取れない行が ${invalid.length} 行あります）`;
  els.studioCount.textContent = text;
}

/* ---------- 設定の保存 ---------- */

async function saveSettings() {
  try {
    await chrome.storage.local.set({
      project: els.project.value,
      studios: els.studios.value,
      cooldown: els.cooldown.value,
      jitter: els.jitter.checked,
    });
  } catch (e) {
    console.error(e);
  }
}

async function loadSettings() {
  try {
    const s = await chrome.storage.local.get(["project", "studios", "cooldown", "jitter"]);
    if (s.project !== undefined) els.project.value = s.project;
    if (s.studios !== undefined) els.studios.value = s.studios;
    if (s.cooldown !== undefined) els.cooldown.value = s.cooldown;
    if (s.jitter !== undefined) els.jitter.checked = s.jitter;
  } catch (e) {
    console.error(e);
  }
  updateStudioCount();
}

/* ---------- Scratchのタブ上で実行する関数 ---------- */
// ※ これらの関数は chrome.scripting.executeScript でページ内に注入されるため、
//    外側の変数を参照せず、必ず自己完結させること。

async function pageFetchSession() {
  try {
    const r = await fetch("https://scratch.mit.edu/session/", {
      headers: { "X-Requested-With": "XMLHttpRequest" },
      credentials: "include",
    });
    const j = await r.json();
    return {
      ok: true,
      token: (j && j.user && j.user.token) || null,
      username: (j && j.user && j.user.username) || null,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function pageCallApi(method, url, token) {
  try {
    const r = await fetch(url, { method, headers: { "X-Token": token } });
    let body = "";
    try {
      body = (await r.text()).slice(0, 200);
    } catch (_) {}
    return { status: r.status, ok: r.ok, body };
  } catch (e) {
    return { status: 0, ok: false, error: String(e) };
  }
}

async function findScratchTab() {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: SCRATCH_PATTERN });
  if (!tabs.length) tabs = await chrome.tabs.query({ url: SCRATCH_PATTERN });
  return tabs[0] || null;
}

async function runInTab(tabId, func, args) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return results && results[0] ? results[0].result : undefined;
}

/* ---------- 待機 ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nextCooldownMs() {
  let sec = Number(els.cooldown.value);
  if (!Number.isFinite(sec) || sec < MIN_COOLDOWN_SEC) sec = MIN_COOLDOWN_SEC;
  let ms = Math.round(sec * 1000); // 基準のクールタイム（ミリ秒）
  if (els.jitter.checked) {
    // 0〜最大50%の範囲から、1ミリ秒単位でランダムに上乗せする
    const maxExtra = Math.floor(ms * 0.5);
    ms += Math.floor(Math.random() * (maxExtra + 1));
  }
  return ms;
}

async function wait(ms) {
  const end = Date.now() + ms;
  const totalText = (ms / 1000).toFixed(3);
  while (Date.now() < end) {
    if (stopRequested) return;
    const left = Math.max(0, (end - Date.now()) / 1000).toFixed(3);
    setStatus(`次の操作まで ${left} 秒待機中（今回の待機時間 ${totalText} 秒）`);
    await sleep(50);
  }
}

/* ---------- メイン処理 ---------- */

const ACTION_LABEL = { POST: "追加", DELETE: "削除" };

async function run(mode) {
  if (running) return;

  const projectId = parseProjectId(els.project.value);
  if (!projectId) {
    log("作品IDを数字（または作品のURL）で入力してください。", "err");
    return;
  }
  const { ids: studioIds, invalid } = parseStudioIds(els.studios.value);
  if (invalid.length) {
    log(`読み取れない行があります: ${invalid.join(" / ")}`, "err");
    return;
  }
  if (!studioIds.length) {
    log("スタジオIDを1つ以上入力してください。", "err");
    return;
  }

  const modeLabel = { add: "追加", remove: "削除", replace: "削除→追加" }[mode];
  if (mode !== "add") {
    const ok = confirm(
      `作品 ${projectId} を、${studioIds.length} 件のスタジオで「${modeLabel}」します。よろしいですか？`
    );
    if (!ok) return;
  }

  await saveSettings();
  stopRequested = false;
  setRunning(true);

  try {
    const tab = await findScratchTab();
    if (!tab) {
      log("scratch.mit.edu のタブが見つかりません。Scratchにログインしたタブを開いてからやり直してください。", "err");
      return;
    }

    const session = await runInTab(tab.id, pageFetchSession, []);
    if (!session || !session.ok || !session.token) {
      log("ログイン情報を取得できませんでした。Scratchにログインし、タブを再読み込みしてからやり直してください。", "err");
      return;
    }

    log(`開始: ${modeLabel} / 作品 ${projectId} / ${studioIds.length} スタジオ / ユーザー ${session.username}`);

    const total = studioIds.length;
    els.progress.max = total;
    els.progress.value = 0;

    let consecutiveFails = 0;
    let okCount = 0;
    let failCount = 0;
    let skipCount = 0;
    let requestCount = 0;
    let aborted = false;

    // 1回のAPI呼び出し。成功/失敗/スキップ を返す
    async function callOnce(studioId, method) {
      if (requestCount > 0) {
        await wait(nextCooldownMs());
        if (stopRequested) return "stopped";
      }
      requestCount++;
      const label = ACTION_LABEL[method];
      setStatus(`スタジオ ${studioId} を${label}中…`);
      const url = `https://api.scratch.mit.edu/studios/${studioId}/project/${projectId}`;
      const res = await runInTab(tab.id, pageCallApi, [method, url, session.token]);

      if (res && res.ok) {
        consecutiveFails = 0;
        okCount++;
        log(`✓ スタジオ ${studioId}: ${label} 成功 (${res.status})`, "ok");
        return "ok";
      }

      // 削除で404 = そのスタジオに作品が入っていない、とみなして失敗には数えない
      if (method === "DELETE" && res && res.status === 404) {
        skipCount++;
        log(`- スタジオ ${studioId}: 削除 対象なし (404) ※入っていないためスキップ`, "warn");
        return "skip";
      }

      consecutiveFails++;
      failCount++;
      const detail = res
        ? res.error || `HTTP ${res.status}${res.body ? " " + res.body : ""}`
        : "応答なし";
      log(`✗ スタジオ ${studioId}: ${label} 失敗 (${detail}) 連続失敗 ${consecutiveFails}/${MAX_CONSECUTIVE_FAILS}`, "err");
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        log(`${MAX_CONSECUTIVE_FAILS}回連続で失敗したため、処理を終了します。`, "err");
        aborted = true;
      }
      return "fail";
    }

    for (let i = 0; i < total; i++) {
      if (stopRequested || aborted) break;
      const studioId = studioIds[i];

      if (mode === "add") {
        await callOnce(studioId, "POST");
      } else if (mode === "remove") {
        await callOnce(studioId, "DELETE");
      } else {
        // 削除→追加: 削除が失敗したら、そのスタジオの追加は行わない
        const r = await callOnce(studioId, "DELETE");
        if (r === "ok" || r === "skip") {
          if (!stopRequested && !aborted) await callOnce(studioId, "POST");
        } else if (r === "fail") {
          log(`スタジオ ${studioId}: 削除に失敗したため追加はスキップしました。`, "warn");
        }
      }

      els.progress.value = i + 1;
      if (aborted) break;
    }

    if (stopRequested) log("停止ボタンで中断しました。", "warn");
    log(
      `終了: 成功 ${okCount} / 失敗 ${failCount} / スキップ ${skipCount}（スタジオ ${els.progress.value}/${total} 件まで処理）`,
      failCount ? "warn" : "ok"
    );
    setStatus(aborted ? "連続失敗のため終了" : stopRequested ? "中断しました" : "完了");
  } catch (e) {
    console.error(e);
    log(`予期しないエラー: ${e && e.message ? e.message : e}`, "err");
    setStatus("エラーで終了");
  } finally {
    setRunning(false);
  }
}

/* ---------- イベント ---------- */

els.btnAdd.addEventListener("click", () => run("add"));
els.btnRemove.addEventListener("click", () => run("remove"));
els.btnReplace.addEventListener("click", () => run("replace"));
els.btnStop.addEventListener("click", () => {
  stopRequested = true;
  setStatus("停止しています…");
});
els.btnClear.addEventListener("click", () => {
  els.log.textContent = "";
});
els.btnCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.log.innerText);
    setStatus("ログをコピーしました");
  } catch (e) {
    setStatus("コピーに失敗しました");
  }
});

for (const el of [els.project, els.studios, els.cooldown]) {
  el.addEventListener("input", () => {
    updateStudioCount();
    saveSettings();
  });
}
els.jitter.addEventListener("change", saveSettings);

loadSettings();
