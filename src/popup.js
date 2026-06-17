// Polyfill for Chrome/Edge
if (typeof browser === "undefined") {
  var browser = chrome;
}

const RELAUNCH_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getState() {
  const {
    servers = [],
    activeServerId = null,
    lastSession = null,
    ddbUser = null,
    ddbCharacterList = null,
    savedInviteCode = ""
  } = await browser.storage.local.get([
    "servers",
    "activeServerId",
    "lastSession",
    "ddbUser",
    "ddbCharacterList",
    "savedInviteCode"
  ]);
  return { servers, activeServerId, lastSession, ddbUser, ddbCharacterList, savedInviteCode };
}

async function saveState(partial) {
  await browser.storage.local.set(partial);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function byId(id) { return document.getElementById(id); }

function showStatus(text, kind) {
  const el = byId("status");
  el.textContent = text;
  el.className = `status-box ${kind || ""}`;
  el.style.display = "block";
}

function hideStatus() {
  byId("status").style.display = "none";
}

// ---------------------------------------------------------------------------
// Render DDB user
// ---------------------------------------------------------------------------

function renderUser(ddbUser) {
  const nameEl = byId("user-name");
  const subEl = byId("user-sub");
  const avatarImg = byId("user-avatar");
  const avatarPlaceholder = byId("user-avatar-placeholder");

  if (!ddbUser) {
    nameEl.textContent = "Not logged in to D&D Beyond";
    subEl.textContent = "Open a D&D Beyond page first";
    avatarImg.style.display = "none";
    avatarPlaceholder.style.display = "flex";
    return;
  }

  nameEl.textContent = ddbUser.displayName || "D&D Beyond User";
  subEl.textContent = ddbUser.email || `User #${ddbUser.id}`;

  if (ddbUser.avatarUrl) {
    avatarImg.src = ddbUser.avatarUrl;
    avatarImg.style.display = "block";
    avatarPlaceholder.style.display = "none";
  } else {
    avatarImg.style.display = "none";
    avatarPlaceholder.textContent = (ddbUser.displayName || "?")[0].toUpperCase();
    avatarPlaceholder.style.display = "flex";
  }
}

// ---------------------------------------------------------------------------
// Render server list
// ---------------------------------------------------------------------------

function renderServers(servers, activeServerId) {
  const container = byId("servers");
  container.innerHTML = "";

  if (!servers.length) {
    container.innerHTML = '<p style="color:#666;font-size:11px;margin:4px 0;">No servers added yet.</p>';
    return;
  }

  servers.forEach(server => {
    const row = document.createElement("div");
    row.className = "server-row";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "activeServer";
    radio.value = server.id;
    radio.checked = server.id === activeServerId;
    radio.addEventListener("change", () => saveState({ activeServerId: server.id }));

    const info = document.createElement("div");
    info.style.flex = "1";
    info.innerHTML = `<div class="server-row-name">${escHtml(server.name)}</div>
                      <div class="server-row-url">${escHtml(server.url)}</div>`;

    row.appendChild(radio);
    row.appendChild(info);
    row.addEventListener("click", (e) => {
      if (e.target !== radio) radio.click();
    });
    container.appendChild(row);
  });
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Render character select
// ---------------------------------------------------------------------------

function renderCharacters(ddbCharacterList) {
  const select = byId("character-select");
  select.innerHTML = '<option value="">— select a character —</option>';

  const chars = (ddbCharacterList || []).filter(c => c.campaignId);
  if (!chars.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No characters in a campaign found";
    opt.disabled = true;
    select.appendChild(opt);
    return;
  }

  chars.forEach(c => {
    const opt = document.createElement("option");
    opt.value = String(c.id);
    const detail = [c.race, c.class, c.level ? `Lv${c.level}` : null].filter(Boolean).join(" · ");
    opt.textContent = `${c.name}${c.campaignName ? ` — ${c.campaignName}` : ""}${detail ? ` (${detail})` : ""}`;
    select.appendChild(opt);
  });
}

// ---------------------------------------------------------------------------
// Build the payload for background based on selected character
// ---------------------------------------------------------------------------

function buildLaunchPayload(ddbUser, ddbCharacterList, inviteCode, selectedCharId) {
  const char = selectedCharId
    ? (ddbCharacterList || []).find(c => String(c.id) === selectedCharId) || null
    : null;

  return {
    inviteCode,
    email: ddbUser?.email || "",
    externalUserId: String(ddbUser?.id || ""),
    displayName: ddbUser?.displayName || "",
    avatarUrl: ddbUser?.avatarUrl || null,
    externalCharacterId: char ? String(char.id) : null,
    externalCampaignId: char ? String(char.campaignId || "") : "",
    campaignName: char ? (char.campaignName || "") : "",
    character: char ? {
      externalCharacterId: String(char.id),
      ddbCharacterId: char.id,
      name: char.name,
      race: char.race || null,
      class: char.class || null,
      level: char.level || null,
      avatarUrl: char.avatar || null,
      characterUrl: `https://www.dndbeyond.com/characters/${char.id}`
    } : null
  };
}

// ---------------------------------------------------------------------------
// Main popup init
// ---------------------------------------------------------------------------

async function initPopup() {
  const { servers, activeServerId, lastSession, ddbUser, ddbCharacterList, savedInviteCode } =
    await getState();

  renderUser(ddbUser);
  renderServers(servers, activeServerId);
  renderCharacters(ddbCharacterList);

  const inviteCodeInput = byId("invite-code");
  const characterSelect = byId("character-select");
  const connectBtn = byId("connect-launch");
  const passwordSection = byId("password-section");
  const passwordInput = byId("login-password");
  const launchWithPwBtn = byId("launch-with-password");
  const relaunchBtn = byId("relaunch");

  // Restore saved invite code
  if (savedInviteCode) inviteCodeInput.value = savedInviteCode;

  // Save invite code as user types
  inviteCodeInput.addEventListener("input", () => {
    saveState({ savedInviteCode: inviteCodeInput.value.trim() });
  });

  // Add server
  byId("add-server").addEventListener("click", async () => {
    const name = prompt("Server name:");
    if (!name) return;
    const url = prompt("Server URL (e.g. https://vtt.example.com):");
    if (!url) return;
    const serverCode = prompt("Default invite code for this server (optional):");
    const id = crypto.randomUUID();
    const newServers = [...servers, { id, name, url, serverCode: serverCode || "" }];
    await saveState({ servers: newServers, activeServerId: id });
    renderServers(newServers, id);
  });

  // Remove active server
  byId("remove-server").addEventListener("click", async () => {
    const { servers: current, activeServerId: active } = await getState();
    if (!active) return;
    if (!confirm("Remove the selected server?")) return;
    const next = current.filter(s => s.id !== active);
    const nextActive = next.length ? next[next.length - 1].id : null;
    await saveState({ servers: next, activeServerId: nextActive });
    renderServers(next, nextActive);
  });

  // Relaunch last session
  const canRelaunch =
    lastSession &&
    Date.now() - lastSession.connectedAt <= RELAUNCH_MAX_AGE_MS &&
    servers.some(s => s.id === lastSession.serverId);
  relaunchBtn.disabled = !canRelaunch;
  relaunchBtn.addEventListener("click", async () => {
    const { servers: sv, lastSession: ls } = await getState();
    if (!ls) return;
    const server = sv.find(s => s.id === ls.serverId);
    if (!server) return;
    const code = ls.inviteCode || server.serverCode || "";
    browser.tabs.create({
      url: `${server.url.replace(/\/$/, "")}/join/${encodeURIComponent(code)}`
    });
  });

  // Connect & Launch
  connectBtn.addEventListener("click", async () => {
    const inviteCode = inviteCodeInput.value.trim();
    if (!inviteCode) {
      showStatus("Please enter an invite code.", "error");
      return;
    }
    if (!ddbUser?.email && !ddbUser?.id) {
      showStatus("No D&D Beyond user detected. Open a D&D Beyond page and try again.", "error");
      return;
    }

    connectBtn.disabled = true;
    passwordSection.style.display = "none";
    hideStatus();
    showStatus("Checking platform & invite…", "info");

    // Save invite code
    await saveState({ savedInviteCode: inviteCode });

    const { ddbUser: freshUser } = await getState();

    const preflightResult = await browser.runtime.sendMessage({
      type: "run-preflight",
      payload: {
        inviteCode,
        email: freshUser?.email || "",
        externalUserId: String(freshUser?.id || "")
      }
    });

    if (!preflightResult?.ok) {
      const msg = preflightResult?.error || "Pre-flight failed";
      showStatus(msg, "error");
      connectBtn.disabled = false;
      return;
    }

    const campaignName = preflightResult.invite?.campaign?.name || "the campaign";
    const flow = preflightResult.preflight?.suggestedFlow || "guest";

    if (flow === "authenticate") {
      showStatus(
        `Invite valid for "${campaignName}". You have an existing account — enter your password below.`,
        "info"
      );
      passwordSection.style.display = "block";
      connectBtn.disabled = false;
      return;
    }

    // Guest or auto-login: proceed immediately
    showStatus(`Joining "${campaignName}"…`, "info");

    const { ddbCharacterList: freshChars } = await getState();
    const selectedCharId = characterSelect.value || null;
    const launchPayload = buildLaunchPayload(freshUser, freshChars, inviteCode, selectedCharId);

    const result = await browser.runtime.sendMessage({
      type: "guest-login-and-launch",
      payload: launchPayload
    });

    if (!result?.ok) {
      showStatus(result?.error || "Login failed.", "error");
      connectBtn.disabled = false;
      return;
    }

    showStatus(`Connected! Opening VTT-Chat…`, "ok");
    connectBtn.disabled = false;
  });

  // Login & Launch (full account)
  launchWithPwBtn.addEventListener("click", async () => {
    const inviteCode = inviteCodeInput.value.trim();
    const password = passwordInput.value;
    if (!password) {
      showStatus("Please enter your password.", "error");
      return;
    }

    launchWithPwBtn.disabled = true;
    showStatus("Logging in…", "info");

    const { ddbUser: freshUser, ddbCharacterList: freshChars } = await getState();
    const selectedCharId = characterSelect.value || null;
    const launchPayload = {
      ...buildLaunchPayload(freshUser, freshChars, inviteCode, selectedCharId),
      password
    };

    const result = await browser.runtime.sendMessage({
      type: "full-login-and-launch",
      payload: launchPayload
    });

    if (!result?.ok) {
      showStatus(result?.error || "Login failed.", "error");
      launchWithPwBtn.disabled = false;
      return;
    }

    showStatus("Connected! Opening VTT-Chat…", "ok");
    launchWithPwBtn.disabled = false;
    passwordSection.style.display = "none";
    passwordInput.value = "";
  });
}

initPopup();
