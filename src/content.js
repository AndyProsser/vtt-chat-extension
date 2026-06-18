// Polyfill for Chrome/Edge
if (typeof browser === "undefined") {
  var browser = chrome;
}

//
// 1. USER EXTRACTORS
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
    email: el.getAttribute("email") || null,
    roles: (el.getAttribute("roles") || "").split(",").map(r => r.trim())
  };
}

function extractFromCobalt() {
  if (window.Cobalt?.User?.ID) {
    return {
      id: Number(window.Cobalt.User.ID),
      displayName: window.Cobalt.User.DisplayName || null,
      avatarUrl: window.Cobalt.User.AvatarUrl || null,
      email: window.Cobalt.User.Email || null,
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
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n");
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
      email: raw.email || null,
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
    Authorization: `Bearer ${token}`,
    Accept: "application/json"
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

function sendCharacterSyncUpdate(update) {
  try {
    browser.runtime.sendMessage({ type: "character-update-detected", payload: update });
  } catch {
    // extension context may be unavailable during page unload
  }
}

function emitCharacterDiffs(previousList, nextList, ddbUserId) {
  if (!Array.isArray(previousList) || !Array.isArray(nextList)) return;
  const prevMap = new Map(previousList.map(c => [String(c.id), c]));
  for (const nextChar of nextList) {
    const prevChar = prevMap.get(String(nextChar.id));
    if (!prevChar) continue;
    const levelChanged = Number(prevChar.level || 0) !== Number(nextChar.level || 0);
    const classChanged = String(prevChar.class || "") !== String(nextChar.class || "");
    if (!levelChanged && !classChanged) continue;
    sendCharacterSyncUpdate({
      source: "player",
      externalUserId: String(ddbUserId || ""),
      externalCharacterId: String(nextChar.id),
      level: typeof nextChar.level === "number" ? nextChar.level : null,
      className: nextChar.class || null
    });
  }
}

function normalizeCampaignMembers(details) {
  const members = Array.isArray(details?.activeCharacters) ? details.activeCharacters : [];
  return members.map(member => ({
    externalUserId: String(member.userId || ""),
    displayName: member.userName || member.displayName || null,
    avatarUrl: member.avatarUrl || null,
    character: {
      externalCharacterId: String(member.id || ""),
      name: member.name || null,
      class: member.class || null,
      level: typeof member.level === "number" ? member.level : null,
      avatarUrl: member.avatarUrl || null
    }
  }));
}

function buildCampaignPacket(details) {
  if (!details) return null;
  return {
    externalCampaignId: String(details.id || ""),
    campaignName: details.name || null,
    dmExternalUserId: String(details.dmId || ""),
    members: normalizeCampaignMembers(details)
  };
}

//
// 3. CHARACTER DETAIL + STATS EXTRACTION
//
async function fetchCharacterDetails(characterId) {
  const headers = await buildAuthHeaders();
  if (!headers.Authorization) return null;
  const url = `https://character-service.dndbeyond.com/character/v5/character/${characterId}?includeCustomItems=true`;
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data || null;
}

const DDB_STAT_ID = { 1: "str", 2: "dex", 3: "con", 4: "int", 5: "wis", 6: "cha" };

const SCORE_SUBTYPE = {
  "strength-score": "str", "dexterity-score": "dex", "constitution-score": "con",
  "intelligence-score": "int", "wisdom-score": "wis", "charisma-score": "cha"
};

const CONDITION_NAMES = {
  1: "Blinded", 2: "Charmed", 3: "Deafened", 4: "Exhaustion", 5: "Frightened",
  6: "Grappled", 7: "Incapacitated", 8: "Invisible", 9: "Paralyzed", 10: "Petrified",
  11: "Poisoned", 12: "Prone", 13: "Restrained", 14: "Stunned", 15: "Unconscious"
};

function getFlatMods(data) {
  return Object.values(data.modifiers || {}).flat();
}

function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

function sumBonusMods(mods, subType) {
  return mods
    .filter(m => m.type === "bonus" && m.subType === subType)
    .reduce((s, m) => s + (m.value ?? m.fixedValue ?? 0), 0);
}

function extractAbilityScores(data) {
  const mods = getFlatMods(data);
  const modBonus = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
  for (const m of mods) {
    const stat = SCORE_SUBTYPE[m.subType];
    if (m.type === "bonus" && stat) modBonus[stat] += (m.value ?? m.fixedValue ?? 0);
  }

  const scores = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
  for (const s of (data.stats || [])) {
    const k = DDB_STAT_ID[s.id]; if (k) scores[k] = s.value || 0;
  }
  for (const s of (data.bonusStats || [])) {
    const k = DDB_STAT_ID[s.id]; if (k && s.value) scores[k] += s.value;
  }
  for (const k of Object.keys(scores)) scores[k] += modBonus[k];
  // overrideStats win everything
  for (const s of (data.overrideStats || [])) {
    const k = DDB_STAT_ID[s.id]; if (k && s.value != null) scores[k] = s.value;
  }
  return scores;
}

function extractCharacterStats(data) {
  if (!data) return null;

  const mods = getFlatMods(data);
  const abilityScores = extractAbilityScores(data);
  const totalLevel = (data.classes || []).reduce((s, c) => s + (c.level || 0), 0);
  const proficiencyBonus = totalLevel > 0 ? Math.floor((totalLevel - 1) / 4) + 2 : 2;

  // HP — baseHitPoints is hit-dice only; CON and per-level feature bonuses added manually
  const conMod = abilityMod(abilityScores.con);
  const hpPerLevel = mods
    .filter(m => m.type === "bonus" && m.subType === "hit-points-per-level")
    .reduce((s, m) => s + (m.value ?? m.fixedValue ?? 0), 0);
  const maxHp = data.overrideHitPoints ??
    ((data.baseHitPoints || 0) + (conMod * totalLevel) + (hpPerLevel * totalLevel) + (data.bonusHitPoints || 0));
  const currentHp = Math.max(0, maxHp - (data.removedHitPoints || 0));

  // AC
  const UNARMORED_STAT = { 1: "str", 2: "dex", 3: "con", 4: "int", 5: "wis", 6: "cha" };
  const dexMod = abilityMod(abilityScores.dex);
  const equippedArmor = (data.inventory || []).find(
    i => i.equipped && i.definition?.filterType === "Armor" && i.definition?.armorTypeId !== 4
  );
  const equippedShield = (data.inventory || []).find(
    i => i.equipped && i.definition?.armorTypeId === 4
  );
  let baseAC;
  if (equippedArmor) {
    const base = equippedArmor.definition.armorClass;
    const typeId = equippedArmor.definition.armorTypeId;
    if (typeId === 1)      baseAC = base + dexMod;
    else if (typeId === 2) baseAC = base + Math.min(dexMod, 2);
    else                   baseAC = base;
  } else {
    // Unarmored Defense: statId encodes the extra ability score added to 10 + DEX
    const unarmoredMod = mods.find(
      m => m.type === "set" && m.subType === "unarmored-armor-class" && m.statId != null
    );
    baseAC = unarmoredMod
      ? 10 + dexMod + abilityMod(abilityScores[UNARMORED_STAT[unarmoredMod.statId]])
      : 10 + dexMod;
  }
  const ac = baseAC + (equippedShield ? 2 : 0) + sumBonusMods(mods, "armor-class");

  // Initiative
  const initiative = dexMod + sumBonusMods(mods, "initiative");

  // Passive Perception: 10 + WIS + prof if proficient + prof again if expert
  const wisMod = abilityMod(abilityScores.wis);
  const percProf  = mods.some(m => m.type === "proficiency" && m.subType === "perception") ? proficiencyBonus : 0;
  const percExpert = mods.some(m => m.type === "expertise"  && m.subType === "perception") ? proficiencyBonus : 0;
  const passivePerception = 10 + wisMod + percProf + percExpert;

  // Speed
  const speed = data.race?.weightSpeeds?.normal?.walk || 30;

  // Spell slots — include only levels with at least one slot (regular + pact magic)
  const spellSlots = {};
  for (const slot of (data.spellSlots || [])) {
    const total = (slot.available || 0) + (slot.used || 0);
    if (total > 0) spellSlots[slot.level] = { total, used: slot.used || 0, available: slot.available || 0 };
  }
  for (const slot of (data.pactMagic || [])) {
    const total = (slot.available || 0) + (slot.used || 0);
    if (total > 0) spellSlots[`pact${slot.level}`] = { total, used: slot.used || 0, available: slot.available || 0 };
  }

  return {
    initiative,
    proficiencyBonus,
    passivePerception,
    abilityScores,
    spellSlots: Object.keys(spellSlots).length > 0 ? spellSlots : null,
    hp: { current: currentHp, max: maxHp, temp: data.temporaryHitPoints || 0 },
    ac,
    speed
  };
}

function extractConditions(data) {
  return (data.conditions || []).map(c => CONDITION_NAMES[c.id] || String(c.id));
}

function extractFeatures(data) {
  const seen = new Set();
  const features = [];
  const push = name => { if (name && !seen.has(name)) { seen.add(name); features.push(name); } };
  for (const a of (data.actions?.class || []))  push(a.name);
  for (const o of (data.options?.class || []))  push(o.definition?.name);
  return features;
}

function extractInventory(data) {
  const items = (data.inventory || []).map(item => {
    const def = item.definition || {};
    return {
      id: item.id,
      name: def.name || null,
      type: def.filterType || null,
      subtype: def.subType || null,
      rarity: def.rarity || null,
      quantity: item.quantity || 1,
      equipped: item.equipped || false,
      isAttuned: item.isAttuned || false,
      chargesUsed: item.chargesUsed || 0,
      weight: def.weight || 0,
      cost: def.cost ?? null
    };
  });
  const customItems = (data.customItems || []).map(item => ({
    id: item.id,
    name: item.name || null,
    type: "custom",
    quantity: item.quantity || 1,
    equipped: false,
    isAttuned: false,
    weight: item.weight || 0,
    cost: item.cost ?? null,
    notes: item.notes || null
  }));
  return {
    items: [...items, ...customItems],
    currency: data.currencies || { cp: 0, sp: 0, gp: 0, ep: 0, pp: 0 }
  };
}

function buildFullCharacterPayload(listChar, detailData) {
  const subclass = detailData?.classes?.[0]?.subclassDefinition?.name || null;
  const race = detailData?.race?.fullName || listChar.race || null;
  const stats = extractCharacterStats(detailData);

  return {
    ddbCharacterId: listChar.id,
    externalCharacterId: String(listChar.id),
    name: listChar.name,
    race,
    class: listChar.class || null,
    subclass,
    level: listChar.level,
    avatarUrl: listChar.avatar || detailData?.avatarUrl || null,
    characterUrl: `https://www.dndbeyond.com/characters/${listChar.id}`,
    stats: stats || undefined,
    conditions: extractConditions(detailData || {}),
    features: extractFeatures(detailData || {}),
    inventory: detailData ? extractInventory(detailData) : null
  };
}

//
// 4. CAMPAIGN API SUPPORT
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
// 5. PAGE HELPERS
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
// 6. CHARACTER INFO BUTTON (debug helper — copies extracted JSON to clipboard)
//
async function copyCharacterInfoToClipboard(charId, btn) {
  const { ddbCharacterList } = await browser.storage.local.get("ddbCharacterList");
  const listChar = ddbCharacterList?.find(c => c.id === charId);
  if (!listChar) return;

  const origLabel = btn?.textContent;
  try {
    const detailData = await fetchCharacterDetails(charId);
    const payload = buildFullCharacterPayload(listChar, detailData);
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    if (btn) {
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = origLabel; }, 1500);
    }
  } catch {
    if (btn) {
      btn.textContent = "Error";
      setTimeout(() => { btn.textContent = origLabel; }, 1500);
    }
  }
}

function injectCharacterInfoButtons(characterList) {
  if (!characterList?.length) return;
  const knownIds = new Set(characterList.map(c => c.id));

  document.querySelectorAll('a[href*="/characters/"]').forEach(link => {
    const m = link.href.match(/\/characters\/(\d+)/);
    if (!m) return;
    const charId = Number(m[1]);
    if (!knownIds.has(charId)) return;

    const buttonId = `vtt-info-btn-${charId}`;
    if (document.getElementById(buttonId)) return;

    const card =
      link.closest('[class*="listing-item"]') ||
      link.closest('[class*="character-card"]') ||
      link.closest('[class*="ddb-character"]') ||
      link.closest("li") ||
      link.closest("article") ||
      link.parentElement;
    if (!card) return;

    const btn = document.createElement("button");
    btn.id = buttonId;
    btn.textContent = "INFO";
    btn.title = "Copy character JSON to clipboard (VTT-Chat)";
    btn.style.cssText =
      "position:absolute;top:6px;right:6px;padding:2px 8px;font-size:11px;" +
      "font-weight:600;background:#1a3a6b;color:#fff;border:none;" +
      "border-radius:3px;cursor:pointer;z-index:9999;opacity:0.85;";
    btn.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
    btn.addEventListener("mouseleave", () => { btn.style.opacity = "0.85"; });
    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      copyCharacterInfoToClipboard(charId, btn);
    });

    if (getComputedStyle(card).position === "static") card.style.position = "relative";
    card.appendChild(btn);
  });
}

//
// 7. CACHE + OBSERVER
//
const CACHE_TTL_MS = 5 * 60 * 1000;

async function ensureDdbCache() {
  const { ddbUser, ddbCharacterList, ddbCacheUpdatedAt } = await browser.storage.local.get([
    "ddbUser",
    "ddbCharacterList",
    "ddbCacheUpdatedAt"
  ]);

  if (ddbUser && ddbCacheUpdatedAt && Date.now() - ddbCacheUpdatedAt < CACHE_TTL_MS) return;

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
    emitCharacterDiffs(ddbCharacterList, characterList, user.id);
    await browser.storage.local.set({
      ddbUser: user,
      ddbCharacterList: characterList,
      ddbCacheUpdatedAt: Date.now()
    });
  } catch (e) {
    console.warn("[VTT-Chat] Cache refresh failed:", e);
  }
}

(async () => {
  await ensureDdbCache();

  let injectTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(injectTimer);
    injectTimer = setTimeout(async () => {
      const { ddbUser, ddbCharacterList } = await browser.storage.local.get([
        "ddbUser",
        "ddbCharacterList"
      ]);
      if (ddbUser) injectCharacterInfoButtons(ddbCharacterList);
    }, 300);
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
