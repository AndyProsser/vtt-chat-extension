// Polyfill for Chrome/Edge
if (typeof browser === "undefined") {
  var browser = chrome;
}

console.log("[VTT-Chat] Content script loaded");

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
  const res = await fetch(url, { method: "GET", headers });
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
  const res = await fetch(url, { method: "GET", headers });
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
  if (!targetEl) {
    console.log("[VTT-Chat] No target element provided");
    return;
  }
  if (document.getElementById("vtt-launch-btn")) {
    console.log("[VTT-Chat] Button already exists");
    return;
  }

  if (isCharacterPage()) {
    console.log("[VTT-Chat] Injecting for character page");

    // Find the existing Game Log button structure to copy classes
    const existingDiv = document.querySelector('div[role="button"][aria-roledescription="Game Log"]');
    if (!existingDiv) {
      console.log("[VTT-Chat] Could not find Game Log button structure");
      return;
    }

    const existingInnerDiv = existingDiv.querySelector('div');
    if (!existingInnerDiv) {
      console.log("[VTT-Chat] Could not find inner div in Game Log button");
      return;
    }

    console.log("[VTT-Chat] Found Game Log structure, copying classes:", existingDiv.className);

    // Create the tooltip span wrapper
    const tooltipSpan = document.createElement("span");
    tooltipSpan.className = "ddbc-tooltip ddbc-tooltip--dark-mode";
    tooltipSpan.setAttribute("data-tippy", "");
    tooltipSpan.setAttribute("data-original-title", "Launch VTT Chat");

    // Create the button div
    const buttonDiv = document.createElement("div");
    buttonDiv.id = "vtt-launch-btn";
    buttonDiv.setAttribute("role", "button");
    buttonDiv.setAttribute("aria-roledescription", "Launch VTT Chat");
    buttonDiv.className = existingDiv.className; // Copy the classes

    // Create the inner content div
    const innerDiv = document.createElement("div");
    innerDiv.className = existingInnerDiv.className; // Copy the inner div classes

    // Add the chat icon SVG
    innerDiv.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.54.36 3.05 1.05 4.42L2 22l5.58-1.05C9.95 21.64 11.46 22 13 22h7c1.1 0 2-.9 2-2V12c0-5.52-4.48-10-10-10zM8 12h2v2H8v-2zm4 0h2v2h-2v-2zm4 0h2v2h-2v-2z"/></svg>`;

    // Assemble the structure
    buttonDiv.appendChild(innerDiv);
    tooltipSpan.appendChild(buttonDiv);

    // Add click event
    buttonDiv.addEventListener("click", onLaunchClick);

    // Insert before the target element
    if (targetEl.parentNode) {
      targetEl.parentNode.insertBefore(tooltipSpan, targetEl);
      console.log("[VTT-Chat] Character page button injected successfully");
    } else {
      console.log("[VTT-Chat] Could not find parent node for character page insertion");
    }
  } else if (isCampaignPage()) {
    console.log("[VTT-Chat] Injecting for campaign page");

    const btn = document.createElement("button");
    btn.id = "vtt-launch-btn";
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12c0 1.54.36 3.05 1.05 4.42L2 22l5.58-1.05C9.95 21.64 11.46 22 13 22h7c1.1 0 2-.9 2-2V12c0-5.52-4.48-10-10-10zM8 12h2v2H8v-2zm4 0h2v2h-2v-2zm4 0h2v2h-2v-2z"/></svg> CHAT`;
    btn.title = "Launch VTT Chat";
    btn.style.background = "#2d5aa0";
    btn.style.color = "#fff";
    btn.style.padding = "6px 12px";
    btn.style.border = "none";
    btn.style.cursor = "pointer";
    btn.style.marginRight = "8px";
    btn.style.fontWeight = "600";
    btn.style.display = "flex";
    btn.style.alignItems = "center";
    btn.style.gap = "4px";

    btn.addEventListener("click", onLaunchClick);

    targetEl.appendChild(btn);
    console.log("[VTT-Chat] Campaign page button injected successfully");
  } else {
    console.log("[VTT-Chat] Unknown page type, no injection performed");
  }
}

//
// 6. LAUNCH HANDLER
//
async function onLaunchClick() {
  console.log("[VTT-Chat] Launch button clicked");

  const { ddbUser, ddbCharacterList } = await browser.storage.local.get([
    "ddbUser",
    "ddbCharacterList"
  ]);

  if (!ddbUser) {
    console.log("[VTT-Chat] No user data available");
    return;
  }

  console.log("[VTT-Chat] Preparing payload for user:", ddbUser.displayName);

  const payload = {
    ddbUser,
    ddbCampaignId: null,
    ddbCampaignName: null,
    isDm: false,
    character: null
  };

  if (isCharacterPage()) {
    const charId = getCharacterIdFromUrl();
    console.log("[VTT-Chat] Character page detected, character ID:", charId);

    const char = ddbCharacterList?.find(c => c.id === charId);
    if (!char) {
      console.log("[VTT-Chat] Character not found in list");
      return;
    }

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

    console.log("[VTT-Chat] Character payload prepared:", payload.character.name);
  }

  if (isCampaignPage()) {
    const campaignId = getCampaignIdFromUrl();
    console.log("[VTT-Chat] Campaign page detected, campaign ID:", campaignId);

    const details = await fetchCampaignDetails(campaignId);
    if (!details) {
      console.log("[VTT-Chat] Could not fetch campaign details");
      return;
    }

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

    console.log("[VTT-Chat] Campaign payload prepared, is DM:", payload.isDm);
  }

  console.log("[VTT-Chat] Sending connect message to background");
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
    console.log("[VTT-Chat] Using cached user data");
    return;
  }

  console.log("[VTT-Chat] Refreshing user cache");
  try {
    const user = extractDdbUser();
    if (!user) {
      await browser.storage.local.set({
        ddbUser: null,
        ddbCharacterList: null,
        ddbCacheUpdatedAt: Date.now()
      });
      console.log("[VTT-Chat] No user found, cleared cache");
      return;
    }

    const rawList = await fetchCharacterList(user.id);
    const characterList = normalizeCharacterList(rawList);

    await browser.storage.local.set({
      ddbUser: user,
      ddbCharacterList: characterList,
      ddbCacheUpdatedAt: Date.now()
    });
    console.log("[VTT-Chat] Cache updated with user and", characterList.length, "characters");
  } catch (e) {
    console.warn("[VTT-Chat] Cache error:", e);
  }
}

(async () => {
  await ensureDdbCache();

  const observer = new MutationObserver(async () => {
    const { ddbUser } = await browser.storage.local.get("ddbUser");
    if (!ddbUser) return;

    if (isCharacterPage()) {
      if (!(await isOwnedCharacterPage())) return;
      const gameLogSpan = document.querySelector('span.ddbc-tooltip[data-original-title="Launch Game"]');
      if (gameLogSpan) {
        setTimeout(() => injectLaunchButton(gameLogSpan), 1000);
      }
    }

    if (isCampaignPage()) {
      const header =
        document.querySelector('div.ddb-campaigns-detail-gamespace') ||
        document.querySelector("header.page-header");
      injectLaunchButton(header);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
