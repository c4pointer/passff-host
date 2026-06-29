"use strict";

const HOST_NAME = "passff";
const USERNAME_KEYS = ["login", "username", "user", "email", "userid", "user name"];

const $ = (id) => document.getElementById(id);
let allEntries = [];     // [{path, name}]
let currentEntry = null; // {password, username, fields, raw}

// ---- Native messaging -------------------------------------------------------

// NOTE: we use connectNative + postMessage rather than sendNativeMessage.
// Chrome's sendNativeMessage types `message` as `object` and rejects a
// top-level JSON array ("No matching signature"), but the PassFF host protocol
// sends arrays (e.g. [] or ["path"]). A native messaging Port's postMessage
// accepts any JSON value, so arrays go through.
function passffCall(args) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
    } catch (e) {
      return reject(e);
    }
    let settled = false;
    port.onMessage.addListener((resp) => {
      settled = true;
      port.disconnect();
      resolve(resp);
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      const err = chrome.runtime.lastError;
      reject(new Error(err ? err.message : "The host app disconnected without replying."));
    });
    port.postMessage(args);
  });
}

// ---- pass output parsing ----------------------------------------------------

// Parse the `tree` listing that `pass show /` returns (PassFF host sends []).
// The host forces TREE_CHARSET=ISO-8859-1, so connectors are ASCII:
//   |-- name      `-- name      |   (indent)      (4 spaces indent)
function parseTree(stdout) {
  const lines = stdout.split("\n");
  const nodes = []; // {depth, name}
  const pathStack = [];
  const re = /^((?:\|   |    )*)(?:\|-- |`-- )(.*)$/;

  for (let raw of lines) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, "");
    if (!line) continue;
    const m = line.match(re);
    if (!m) continue; // skip the root header line
    const depth = m[1].length / 4 + 1;
    const name = m[2];
    pathStack.length = depth - 1;
    pathStack.push(name);
    nodes.push({ depth, path: pathStack.join("/") });
  }

  // A node is a leaf (a real password entry) when nothing deeper follows it.
  const entries = [];
  for (let i = 0; i < nodes.length; i++) {
    const next = nodes[i + 1];
    if (!next || next.depth <= nodes[i].depth) {
      entries.push({ path: nodes[i].path, name: nodes[i].path.split("/").pop() });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

// First line = password; following "key: value" lines = metadata fields.
function parseEntry(stdout) {
  const lines = stdout.replace(/\n$/, "").split("\n");
  const password = lines.shift() || "";
  const fields = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  let username = "";
  for (const key of USERNAME_KEYS) {
    if (fields[key]) { username = fields[key]; break; }
  }
  return { password, username, fields, raw: stdout };
}

// ---- UI ---------------------------------------------------------------------

function setStatus(msg, isError) {
  const el = $("status");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
  el.classList.toggle("error", !!isError);
}

function renderList(filter) {
  const list = $("list");
  list.innerHTML = "";
  const needle = (filter || "").toLowerCase();
  const matches = allEntries.filter((e) => e.path.toLowerCase().includes(needle));
  for (const entry of matches.slice(0, 300)) {
    const li = document.createElement("li");
    const dir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1) : "";
    const dirSpan = document.createElement("span");
    dirSpan.className = "dir";
    dirSpan.textContent = dir;
    const nameSpan = document.createElement("span");
    nameSpan.className = "leaf-name";
    nameSpan.textContent = entry.name;
    li.append(dirSpan, nameSpan);
    li.addEventListener("click", () => openEntry(entry));
    list.appendChild(li);
  }
  $("footer").textContent = `${matches.length} / ${allEntries.length} entries`;
}

async function openEntry(entry) {
  setStatus("Decrypting…");
  try {
    const resp = await passffCall([entry.path]);
    if (resp.exitCode !== 0) {
      setStatus((resp.stderr || "pass failed").trim(), true);
      return;
    }
    setStatus("");
    currentEntry = parseEntry(resp.stdout);
    showDetail(entry);
  } catch (e) {
    setStatus(e.message, true);
  }
}

function showDetail(entry) {
  $("list").classList.add("hidden");
  $("detail").classList.remove("hidden");
  $("detail-name").textContent = entry.path;

  const pwEl = $("detail-password");
  pwEl.textContent = currentEntry.password;
  pwEl.classList.add("masked");
  pwEl.dataset.shown = "0";

  const userField = $("username-field");
  if (currentEntry.username) {
    userField.classList.remove("hidden");
    $("detail-username").textContent = currentEntry.username;
  } else {
    userField.classList.add("hidden");
  }

  const extraKeys = Object.keys(currentEntry.fields).filter((k) => !USERNAME_KEYS.includes(k));
  const extraWrap = $("extra-wrap");
  if (extraKeys.length) {
    extraWrap.classList.remove("hidden");
    $("detail-extra").textContent = extraKeys.map((k) => `${k}: ${currentEntry.fields[k]}`).join("\n");
  } else {
    extraWrap.classList.add("hidden");
  }
}

function showList() {
  $("detail").classList.add("hidden");
  $("list").classList.remove("hidden");
  currentEntry = null;
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`${label} copied to clipboard.`);
    setTimeout(() => setStatus(""), 1500);
  } catch (e) {
    setStatus("Copy failed: " + e.message, true);
  }
}

// ---- Autofill ---------------------------------------------------------------

// Injected into the active tab. Fills the first password field and a best-guess
// username field of the form that contains it.
function fillForm(username, password) {
  const set = (el, val) => {
    el.focus();
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const pw = document.querySelector('input[type="password"]');
  if (!pw) return "no-password-field";
  set(pw, password);
  if (username) {
    const form = pw.form || document;
    const candidates = form.querySelectorAll(
      'input[type="text"], input[type="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i], input[autocomplete="username"]'
    );
    if (candidates.length) set(candidates[0], username);
  }
  return "ok";
}

async function doFill() {
  if (!currentEntry) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab.");
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillForm,
      args: [currentEntry.username || "", currentEntry.password],
    });
    if (res && res.result === "no-password-field") {
      setStatus("No password field found on the page.", true);
    } else {
      setStatus("Filled. You can close this popup.");
      setTimeout(() => window.close(), 700);
    }
  } catch (e) {
    setStatus("Fill failed: " + e.message, true);
  }
}

// ---- Wiring -----------------------------------------------------------------

async function init() {
  setStatus("Loading password list…");
  try {
    const resp = await passffCall([]);
    if (resp.exitCode !== 0) {
      setStatus((resp.stderr || "Could not list the store.").trim(), true);
      return;
    }
    allEntries = parseTree(resp.stdout);
    setStatus("");
    renderList("");
  } catch (e) {
    setStatus(
      "Cannot reach the PassFF host app.\n" + e.message +
      "\n\nMake sure the host is installed for Chromium (see README).",
      true
    );
  }
}

$("search").addEventListener("input", (e) => renderList(e.target.value));
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const first = $("list").querySelector("li");
    if (first) first.click();
  }
});
$("back").addEventListener("click", showList);
$("copy-pw").addEventListener("click", () => copy(currentEntry.password, "Password"));
$("copy-user").addEventListener("click", () => copy(currentEntry.username, "Login"));
$("toggle-pw").addEventListener("click", () => {
  const el = $("detail-password");
  const shown = el.dataset.shown === "1";
  el.dataset.shown = shown ? "0" : "1";
  el.classList.toggle("masked", shown);
});
$("fill").addEventListener("click", doFill);

init();
