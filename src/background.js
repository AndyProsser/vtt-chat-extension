// Polyfill for Chrome/Edge
if (typeof browser === "undefined") {
  var browser = chrome;
}

const RELAUNCH_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "connect") {
    handleConnect(msg.payload);
  }
});

async function getState() {
  const { servers = [], activeServerId = null, lastSession = null } =
    await browser.storage.local.get(["servers", "activeServerId", "lastSession"]);
  return { servers, activeServerId, lastSession };
}

async function getActiveServer() {
  const { servers, activeServerId } = await getState();
  return servers.find(s => s.id === activeServerId) || null;
}

async function handleConnect(payload) {
  const server = await getActiveServer();
  if (!server) {
    console.warn("No active VTT-Chat server configured");
    return;
  }

  const body = {
    serverCode: server.serverCode,
    ddbUserId: String(payload.ddbUser.id),
    ddbUsername: payload.ddbUser.displayName,
    ddbAvatarUrl: payload.ddbUser.avatarUrl,
    ddbCampaignId: payload.ddbCampaignId,
    ddbCampaignName: payload.ddbCampaignName,
    isDm: payload.isDm,
    character: payload.character
  };

  let res;
  try {
    res = await fetch(`${server.url.replace(/\/$/, "")}/api/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.warn("Connect request failed:", e);
    return;
  }

  if (!res.ok) {
    console.warn("Connect failed:", res.status);
    return;
  }

  const json = await res.json();

  await browser.storage.local.set({
    lastSession: {
      serverId: server.id,
      token: json.token,
      sessionId: json.sessionId,
      role: json.role,
      connectedAt: Date.now()
    }
  });

  browser.tabs.create({
    url: `${server.url.replace(/\/$/, "")}${json.appUrl}?token=${encodeURIComponent(
      json.token
    )}`
  });
}

export async function relaunchLastSession() {
  const { servers, lastSession } = await getState();
  if (!lastSession) return;
  if (Date.now() - lastSession.connectedAt > RELAUNCH_MAX_AGE_MS) return;

  const server = servers.find(s => s.id === lastSession.serverId);
  if (!server) return;

  browser.tabs.create({
    url: `${server.url.replace(
      /\/$/,
      ""
    )}/sessions/${lastSession.sessionId}?token=${encodeURIComponent(lastSession.token)}`
  });
}
