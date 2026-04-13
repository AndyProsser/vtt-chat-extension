// Polyfill for Chrome/Edge
if (typeof browser === "undefined") {
  var browser = chrome;
}

const RELAUNCH_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

async function getState() {
  const { servers = [], activeServerId = null, lastSession = null } =
    await browser.storage.local.get(["servers", "activeServerId", "lastSession"]);
  return { servers, activeServerId, lastSession };
}

async function saveState(partial) {
  await browser.storage.local.set(partial);
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
  const { servers, activeServerId, lastSession } = await getState();
  renderServers(servers, activeServerId);

  // -----------------------------
  // Add Server
  // -----------------------------
  document.getElementById("add-server").addEventListener("click", async () => {
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
  const relaunchBtn = document.getElementById("relaunch");

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
      )}/sessions/${lastSession.sessionId}?token=${encodeURIComponent(lastSession.token)}`
    });
  });
}

initPopup();
