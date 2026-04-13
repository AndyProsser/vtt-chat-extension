// Polyfill for Chrome/Edge
if (typeof browser === "undefined") {
  var browser = chrome;
}

//
// 1. USER EXTRACTORS (your POC)
//
function extractFromMegaMenu() {
  const el = document.querySelector("#mega-menu-target");
  if (!el) return null;
  const userId = el.getAttribute("user-id");
  if (!userId) return null;
  return {
    id: Number(userId),
    displayName: el.getAttribute("display-name") || null,
    avatarUrl: el.getAttribute("user-avatar") || null,
    roles: (el.getAttribute("roles") || "").split(",").map(r => r.trim())
  };
}

function extractFromCobalt() {
  if (window.Cobalt?.User?.ID) {
    return {
      id: Number(window.Cobalt.User.ID),
      displayName: window.Cobalt.User.DisplayName || null,
      avatarUrl: window.Cobalt.User.AvatarUrl || null,
      roles: []
    };
  }
  return null;
}

function findNextFlightScript() {
  const scripts = document.querySelectorAll("script");
  for (const s of scripts) {
    const text = s.textContent;
    if (text && text.includes('\\"user\\"')) return text;
  }
  return null;
}

function extractEscapedUserJson(text) {
  const match = text.match(/\\"user\\":(\{[^]*?\})/);
  return match ? match[1] : null;
}

function unescapeJson(escaped) {
  return escaped
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n');
}

function extractFromNextFlight() {
  const scriptText = findNextFlightScript();
  if (!scriptText) return null;
  const escaped = extractEscapedUserJson(scriptText);
  if (!escaped) return null;
  try {
    const raw = JSON.parse(unescapeJson(escaped));
    return {
      id: Number(raw.id),
      displayName: raw.displayName || raw.name || null,
      avatarUrl: raw.avatarUrl || null,
      roles: Array.isArray(raw.roles) ? raw.roles : []
    };
  } catch {
    return null;
  }
}

function extractDdbUser() {
  return (
    extractFromMegaMenu() ||
    extractFromCobalt() ||
    extractFromNextFlight() ||
    null
  );
}

//
// 2. AUTH + CHARACTER LIST
//
async function fetchCobaltAuthToken() {
  const res = await fetch("https://auth-service.dndbeyond.com/v1/cobalt-token", {
    method: "POST",
    credentials: "include"
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.token || null;
}

async function buildAuthHeaders() {
  const token = await fetchCobaltAuthToken();
  if (!token) return {};
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json"
  };
}

async function fetchCharacterList(userId) {
  const headers = await buildAuthHeaders();
  if (!headers.Authorization) return null;
  const url = `https://character-service.dndbeyond.com/character/v5/characters/list?userId=${userId}`;
  const res = await fetch(url, { method: "GET", credentials: "include", headers });
  if (!res.ok) return null;
  const data = await res.json();
  return data.data;
}

function normalizeCharacterList(raw) {
  if (!raw || !raw.characters) return [];
  return raw.characters.map(c => ({
    id: c.id,
    name: c.name,
    level: c.level,
    race: c.raceName,
    class: c.classDescription,
    avatar: c.avatarUrl,
    campaignId: c.campaignId,
    campaignName: c.campaignName
  }));
}

//
// 3. CAMPAIGN API SUPPORT
//
async function fetchCampaignDetails(campaignId) {
  const headers = await buildAuthHeaders();
  if (!headers.Authorization) return null;

  const url = `https://api.dndbeyond.com/campaigns/v1/details/${campaignId}`;
  const res = await fetch(url, { method: "GET", credentials: "include", headers });
  if (!res.ok) return null;

  const data = await res.json();
  return data.data;
}

//
// 4. PAGE HELPERS
//
function isCharacterPage() {
  return /\/characters\/\d+/.test(location.pathname);
}
function getCharacterIdFromUrl() {
  const m = location.pathname.match(/\/characters\/(\d+)/);
  return m ? Number(m[1]) : null;
}
function isCampaignPage() {
  return /\/campaigns\/\d+/.test(location.pathname);
}
function getCampaignIdFromUrl() {
  const m = location.pathname.match(/\/campaigns\/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function isOwnedCharacterPage() {
  if (!isCharacterPage()) return false;
  const charId = getCharacterIdFromUrl();
  const { ddbCharacterList } = await browser.storage.local.get("ddbCharacterList");
  return ddbCharacterList?.some(c => c.id === charId) || false;
}

//
// 5. BUTTON INJECTION
//
function injectLaunchButton(targetEl) {
  if (!targetEl) return;
  if (document.getElementById("vtt-launch-btn")) return;

  const btn = document.createElement("button");
  btn.id = "vtt-launch-btn";
  btn.textContent = "Launch VTT‑Chat";
  btn.style.background = "#c53131";
  btn.style.color = "#fff";
  btn.style.padding = "6px 12px";
  btn.style.borderRadius = "6px";
  btn.style.border = "none";
  btn.style.cursor = "pointer";
  btn.style.marginLeft = "8px";
  btn.style.fontWeight = "600";

  btn.addEventListener("click", onLaunchClick);
  targetEl.appendChild(btn);
}

//
// 6. LAUNCH HANDLER
//
async function onLaunchClick() {
  const { ddbUser, ddbCharacterList } = await browser.storage.local.get([
    "ddbUser",
    "ddbCharacterList"
  ]);
  if (!ddbUser) return;

  const payload = {
    ddbUser,
    ddbCampaignId: null,
    ddbCampaignName: null,
    isDm: false,
    character: null
  };

  if (isCharacterPage()) {
    const charId = getCharacterIdFromUrl();
    const char = ddbCharacterList?.find(c => c.id === charId);
    if (!char) return;

    payload.ddbCampaignId = String(char.campaignId || "");
    payload.ddbCampaignName = char.campaignName || "Campaign";
    payload.isDm = false;
    payload.character = {
      ddbCharacterId: char.id,
      name: char.name,
      avatarUrl: char.avatar,
      race: char.race,
      className: char.class,
      level: char.level
    };
  }

  if (isCampaignPage()) {
    const campaignId = getCampaignIdFromUrl();
    const details = await fetchCampaignDetails(campaignId);
    if (!details) return;

    payload.ddbCampaignId = String(details.id);
    payload.ddbCampaignName = details.name;
    payload.isDm = Number(details.dmId) === Number(ddbUser.id);

    if (!payload.isDm) {
      const userChar = details.activeCharacters?.find(
        c => Number(c.userId) === Number(ddbUser.id)
      );
      if (userChar) {
        payload.character = {
          ddbCharacterId: userChar.id,
          name: userChar.name,
          avatarUrl: userChar.avatarUrl,
          race: null,
          className: null,
          level: null
        };
      }
    }
  }

  browser.runtime.sendMessage({ type: "connect", payload });
}

//
// 7. CACHE + OBSERVER
//
const CACHE_TTL_MS = 5 * 60 * 1000;

async function ensureDdbCache() {
  const { ddbUser, ddbCacheUpdatedAt } = await browser.storage.local.get([
    "ddbUser",
    "ddbCacheUpdatedAt"
  ]);

  if (ddbUser && ddbCacheUpdatedAt && Date.now() - ddbCacheUpdatedAt < CACHE_TTL_MS) {
    return;
  }

  try {
    const user = extractDdbUser();
    if (!user) {
      await browser.storage.local.set({
        ddbUser: null,
        ddbCharacterList: null,
        ddbCacheUpdatedAt: Date.now()
      });
      return;
    }

    const rawList = await fetchCharacterList(user.id);
    const characterList = normalizeCharacterList(rawList);

    await browser.storage.local.set({
      ddbUser: user,
      ddbCharacterList: characterList,
      ddbCacheUpdatedAt: Date.now()
    });
  } catch (e) {
    console.warn("DDB Identity Inspector error:", e);
  }
}

(async () => {
  await ensureDdbCache();

  const observer = new MutationObserver(async () => {
    const { ddbUser } = await browser.storage.local.get("ddbUser");
    if (!ddbUser) return;

    if (isCharacterPage()) {
      if (!(await isOwnedCharacterPage())) return;
      const header =
        document.querySelector('[data-testid="character-header"]') ||
        document.querySelector("h1");
      injectLaunchButton(header);
    }

    if (isCampaignPage()) {
      const header =
        document.querySelector(".ddb-campaigns-detail-header") ||
        document.querySelector("h1");
      injectLaunchButton(header);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
