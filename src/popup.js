// Polyfill for Chrome/Edge
if (typeof browser === "undefined") {
  var browser = chrome;
}

const RELAUNCH_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

async function getState() {
  const {
    servers = [],
    activeServerId = null,
    lastSession = null,
    lastPreflight = null,
    ddbUser = null
  } = await browser.storage.local.get([
    "servers",
    "activeServerId",
    "lastSession",
    "lastPreflight",
    "ddbUser"
  ]);
  return { servers, activeServerId, lastSession, lastPreflight, ddbUser };
}

async function saveState(partial) {
  await browser.storage.local.set(partial);
}

function byId(id) {
  return document.getElementById(id);
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = `status ${kind || "muted"}`;
}

function renderServers(servers, activeServerId) {
  const container = document.getElementById("servers");
  container.innerHTML = "";

  servers.forEach(server => {
    const div = document.createElement("div");
    div.className = "server";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "activeServer";
    radio.checked = server.id === activeServerId;
    radio.addEventListener("change", async () => {
      await saveState({ activeServerId: server.id });
    });

    const label = document.createElement("span");
    label.textContent = `${server.name} (${server.url})`;

    div.appendChild(radio);
    div.appendChild(label);
    container.appendChild(div);
  });
}

async function initPopup() {
  const { servers, activeServerId, lastSession, lastPreflight, ddbUser } = await getState();
  renderServers(servers, activeServerId);

  const inviteCodeInput = byId("invite-code");
  const emailInput = byId("email");
  const externalUserIdInput = byId("external-user-id");
  const runPreflightButton = byId("run-preflight");
  const preflightStatus = byId("preflight-status");
  const guestLoginSection = byId("guest-login-section");
  const guestLoginButton = byId("guest-login");
  const fullLoginSection = byId("full-login-section");
  const fullLoginButton = byId("full-login");
  const loginEmailInput = byId("login-email");
  const loginPasswordInput = byId("login-password");
  const authStateBox = byId("auth-state");

  emailInput.value = ddbUser?.email || "";
  externalUserIdInput.value = ddbUser?.id ? String(ddbUser.id) : "";
  loginEmailInput.value = ddbUser?.email || "";

  const syncAuthState = async () => {
    const state = await browser.runtime.sendMessage({ type: "get-auth-state" });
    if (!state?.ok || !state.hasAuthToken) {
      setStatus(authStateBox, "No in-memory token", "muted");
      return;
    }

    const expiry = state.tokenExpiresAt
      ? new Date(state.tokenExpiresAt).toLocaleString()
      : "unknown";
    setStatus(
      authStateBox,
      `${state.authType || "UNKNOWN"} token in memory. Expires: ${expiry}`,
      "ok"
    );
  };

  const hideAuthBranches = () => {
    guestLoginSection.style.display = "none";
    fullLoginSection.style.display = "none";
  };

  if (lastPreflight?.checkedAt) {
    const checkedAt = new Date(lastPreflight.checkedAt).toLocaleString();
    const status = lastPreflight.ok ? "Previous pre-flight succeeded" : "Previous pre-flight failed";
    setStatus(preflightStatus, `${status} at ${checkedAt}.`, lastPreflight.ok ? "ok" : "error");
  }

  // -----------------------------
  // Add Server
  // -----------------------------
  byId("add-server").addEventListener("click", async () => {
    const name = prompt("Server name:");
    if (!name) return;

    const url = prompt("Server URL (e.g. https://vtt.example.com):");
    if (!url) return;

    const serverCode = prompt("Server invite code:");
    if (!serverCode) return;

    const id = crypto.randomUUID();
    const newServers = [...servers, { id, name, url, serverCode }];
    await saveState({ servers: newServers, activeServerId: id });
    renderServers(newServers, id);
  });

  // -----------------------------
  // Relaunch Last Session
  // -----------------------------
  const relaunchBtn = byId("relaunch");

  const canRelaunch =
    lastSession &&
    Date.now() - lastSession.connectedAt <= RELAUNCH_MAX_AGE_MS &&
    servers.some(s => s.id === lastSession.serverId);

  if (!canRelaunch) {
    relaunchBtn.disabled = true;
  }

  relaunchBtn.addEventListener("click", async () => {
    const { servers, lastSession } = await getState();
    if (!lastSession) return;

    const server = servers.find(s => s.id === lastSession.serverId);
    if (!server) return;

    browser.tabs.create({
      url: `${server.url.replace(
        /\/$/,
        ""
      )}/join/${encodeURIComponent(lastSession.inviteCode || server.serverCode || "")}`
    });
  });

  runPreflightButton.addEventListener("click", async () => {
    hideAuthBranches();
    setStatus(preflightStatus, "Running pre-flight...", "muted");

    const payload = {
      inviteCode: inviteCodeInput.value.trim(),
      email: emailInput.value.trim(),
      externalUserId: externalUserIdInput.value.trim()
    };

    const result = await browser.runtime.sendMessage({ type: "run-preflight", payload });

    if (!result?.ok) {
      const message = result?.error || "Pre-flight failed";
      if (result?.code === "INTEGRATION_NOT_AUTHORIZED") {
        setStatus(
          preflightStatus,
          `Platform not enabled: ${message}`,
          "error"
        );
        return;
      }
      setStatus(preflightStatus, message, "error");
      return;
    }

    const suggestedFlow = result.preflight?.suggestedFlow || "unknown";
    const accountStatus = result.preflight?.accountStatus || "unknown";
    const campaignName = result.invite?.campaign?.name || "Unknown campaign";
    setStatus(
      preflightStatus,
      `Online. Invite valid for ${campaignName}. accountStatus=${accountStatus}, suggestedFlow=${suggestedFlow}`,
      "ok"
    );

    if (suggestedFlow === "guest" || suggestedFlow === "auto-login") {
      guestLoginSection.style.display = "block";
    } else if (suggestedFlow === "authenticate") {
      fullLoginSection.style.display = "block";
      loginEmailInput.value = emailInput.value.trim();
    }
  });

  guestLoginButton.addEventListener("click", async () => {
    setStatus(preflightStatus, "Running guest login...", "muted");
    const payload = {
      inviteCode: inviteCodeInput.value.trim(),
      email: emailInput.value.trim(),
      externalUserId: externalUserIdInput.value.trim(),
      externalCharacterId: null
    };
    const result = await browser.runtime.sendMessage({ type: "guest-login", payload });
    if (!result?.ok) {
      const message = result?.error || "Guest login failed";
      if (result?.code === "INTEGRATION_NOT_AUTHORIZED") {
        setStatus(preflightStatus, `Platform not enabled: ${message}`, "error");
      } else {
        setStatus(preflightStatus, message, "error");
      }
      return;
    }

    setStatus(preflightStatus, "Guest login succeeded. Token is stored in extension memory.", "ok");
    await syncAuthState();
  });

  fullLoginButton.addEventListener("click", async () => {
    setStatus(preflightStatus, "Running full-account login...", "muted");
    const payload = {
      email: loginEmailInput.value.trim(),
      password: loginPasswordInput.value,
      inviteCode: inviteCodeInput.value.trim(),
      role: "PLAYER"
    };

    const result = await browser.runtime.sendMessage({ type: "full-login", payload });
    if (!result?.ok) {
      const message = result?.error || "Full login failed";
      if (result?.code === "INTEGRATION_NOT_AUTHORIZED") {
        setStatus(preflightStatus, `Platform not enabled: ${message}`, "error");
      } else {
        setStatus(preflightStatus, message, "error");
      }
      return;
    }

    setStatus(preflightStatus, "Full-account login succeeded. Token is stored in extension memory.", "ok");
    await syncAuthState();
  });

  await syncAuthState();
}

initPopup();
