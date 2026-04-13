//
// --- 1. MegaMenu extractor (most pages) ---
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

//
// --- 2. Cobalt extractor (legacy pages) ---
//
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

//
// --- 3. Next.js Flight extractor (new pages) ---
//
function findNextFlightScript() {
  const scripts = document.querySelectorAll("script");
  for (const s of scripts) {
    const text = s.textContent;
    if (text && text.includes('\\"user\\"')) {
      return text;
    }
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

  let raw;
  try {
    raw = JSON.parse(unescapeJson(escaped));
  } catch (e) {
    console.warn("NextFlight parse error:", e);
    return null;
  }

  return {
    id: Number(raw.id),
    displayName: raw.displayName || raw.name || null,
    avatarUrl: raw.avatarUrl || null,
    roles: Array.isArray(raw.roles) ? raw.roles : []
  };
}

//
// --- 4. Unified extractor ---
//
function extractDdbUser() {
  return (
    extractFromMegaMenu() ||
    extractFromCobalt() ||
    extractFromNextFlight() ||
    null
  );
}

//
// --- 5. AUTH FLOW ---
//

// STEP 1: POST to /v1/cobalt-token to get the JWT (JSON response)
async function fetchCobaltAuthToken() {
  const res = await fetch("https://auth-service.dndbeyond.com/v1/cobalt-token", {
    method: "POST",
    credentials: "include"
  });

  if (!res.ok) {
    console.warn("Failed to fetch cobalt-token:", res.status);
    return null;
  }

  const json = await res.json();
  return json.token || null;
}

// STEP 2: Build headers using the returned token
async function buildAuthHeaders() {
  const token = await fetchCobaltAuthToken();
  if (!token) return {};

  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json"
  };
}

//
// --- 6. Character list + details using the REAL auth token ---
//
async function fetchCharacterList(userId) {
  const headers = await buildAuthHeaders();
  if (!headers.Authorization) return null;

  const url = `https://character-service.dndbeyond.com/character/v5/characters/list?userId=${userId}`;

  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers
  });

  if (!res.ok) {
    console.warn("Character list fetch failed:", res.status);
    return null;
  }

  const data = await res.json();
  return data.data; // raw object with .characters
}

//
// --- 7. Normalizer (fixes "not iterable") ---
//
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
    campaignName: c.campaignName,
    summary: c.characterSecondaryInfo
  }));
}

//
// --- 8. Main pipeline ---
//
(async () => {
  try {
    const user = extractDdbUser();

    if (!user) {
      await browser.storage.local.set({
        ddbUser: null,
        ddbCharacterList: null,
        ddbCharacterDetails: null
      });
      return;
    }

    const rawList = await fetchCharacterList(user.id);
    const characterList = normalizeCharacterList(rawList);

    // Skip details for now (can be added later)
    await browser.storage.local.set({
      ddbUser: user,
      ddbCharacterList: characterList,
      ddbCharacterDetails: {}
    });

  } catch (e) {
    console.warn("DDB Identity Inspector error:", e);
  }
})();
