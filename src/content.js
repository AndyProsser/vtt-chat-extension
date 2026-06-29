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
// 2. HTML ENTITY DECODING
//
function decodeHtml(str) {
  if (!str || typeof str !== "string") return str;
  const el = document.createElement("textarea");
  el.innerHTML = str;
  return el.value;
}

//
// 3. AUTH + CHARACTER LIST
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
    name: decodeHtml(c.name),
    level: c.level,
    race: decodeHtml(c.raceName),
    class: decodeHtml(c.classDescription),
    avatar: c.avatarUrl,
    campaignId: c.campaignId,
    campaignName: decodeHtml(c.campaignName)
  }));
}

async function emitCharacterDiffs(previousList, nextList) {
  if (!Array.isArray(previousList) || !Array.isArray(nextList)) return;
  const prevMap = new Map(previousList.map(c => [String(c.id), c]));
  for (const nextChar of nextList) {
    const prevChar = prevMap.get(String(nextChar.id));
    if (!prevChar) continue;
    const levelChanged = Number(prevChar.level || 0) !== Number(nextChar.level || 0);
    const classChanged = String(prevChar.class || "") !== String(nextChar.class || "");
    if (!levelChanged && !classChanged) continue;
    try {
      const detailData = await fetchCharacterDetails(nextChar.id);
      const payload = buildFullCharacterPayload(nextChar, detailData);
      browser.runtime.sendMessage({ type: "character-data-updated", payload });
    } catch {
      // skip — user can trigger a manual sync from the character sheet
    }
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
    campaignName: decodeHtml(details.name) || null,
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

  // Spell slots — { total: { "1": N, … }, used: { "1": N, … } } per doc format
  function buildSlotMap(source) {
    const total = {}, used = {};
    for (const slot of (source || [])) {
      const t = (slot.available || 0) + (slot.used || 0);
      if (t > 0) { total[String(slot.level)] = t; used[String(slot.level)] = slot.used || 0; }
    }
    return Object.keys(total).length > 0 ? { total, used } : null;
  }
  const spellSlots = buildSlotMap(data.spellSlots);
  const pactMagic  = buildSlotMap(data.pactMagic);

  return {
    initiative,
    proficiencyBonus,
    passivePerception,
    abilityScores,
    spellSlots,
    pactMagic,
    hp: { current: currentHp, max: maxHp, temp: data.temporaryHitPoints || 0 },
    ac,
    speed
  };
}

function extractConditions(data) {
  return (data.conditions || []).map(c => {
    const name = CONDITION_NAMES[c.id] || `Condition ${c.id}`;
    return c.level ? `${name} ${c.level}` : name;
  });
}

function extractFeatures(data) {
  // Build valid component ID set: classFeature IDs + chosen option IDs.
  // DDB injects actions.class entries (e.g. Circle Magic) whose componentId
  // doesn't match any feature or chosen option the character actually has.
  const validIds = new Set(
    [
      ...(data.classes || []).flatMap(cls =>
        (cls.classFeatures || []).map(f => f.definition?.id)
      ),
      ...(data.options?.class || []).map(o => o.definition?.id)
    ].filter(Boolean)
  );

  const seen = new Set();
  const features = [];
  const push = name => { if (name && !seen.has(name)) { seen.add(name); features.push(name); } };
  for (const a of (data.actions?.class || []))  {
    if (validIds.has(a.componentId)) push(a.name);
  }
  for (const o of (data.options?.class || []))  push(o.definition?.name);
  return features;
}

function buildItemProperties(def) {
  // Melee weapons report reach as range 5 (normal) or 10 (polearm). Anything
  // larger is an actual thrown/ranged weapon and should show the range values.
  const rangeStr = def.range > 10
    ? (def.longRange && def.longRange > def.range
        ? `(${def.range}/${def.longRange})`
        : `(${def.range})`)
    : null;

  const names = (def.properties || []).map(p => {
    const name = p.name;
    // Annotate the property that carries the range meaning rather than appending separately
    if (rangeStr && (name === "Thrown" || name === "Range")) return `${name} ${rangeStr}`;
    return name;
  }).filter(Boolean);

  return names.length ? names.join(", ") : null;
}

const ARMOR_TYPE_NAME = { 1: "Light Armor", 2: "Medium Armor", 3: "Heavy Armor" };

function buildArmorProperties(def) {
  if (def.filterType !== "Armor") return null;
  const ac = def.armorClass;
  if (def.armorTypeId === 4) return ac ? `Shield (+${ac} AC)` : "Shield";
  const typeName = ARMOR_TYPE_NAME[def.armorTypeId] || "Armor";
  return ac ? `${typeName} (AC ${ac})` : typeName;
}

function buildItemDamage(def) {
  if (def.filterType !== "Weapon" || !def.damage) return null;
  const d = def.damage;
  let str = d.diceString || (d.diceCount && d.diceValue ? `${d.diceCount}d${d.diceValue}` : null);
  if (!str) return null;
  if (d.fixedValue) str += `+${d.fixedValue}`;
  return str;
}

function extractInventory(data) {
  const items = (data.inventory || []).map(item => {
    const def = item.definition || {};
    const isWeapon = def.filterType === "Weapon";
    const isArmor = def.filterType === "Armor";
    const tags = Array.isArray(def.tags) ? def.tags : [];
    const isContainer = def.isContainer === true || tags.includes("Container");
    const properties = buildItemProperties(def);
    const armorProperties = isArmor ? buildArmorProperties(def) : null;
    const damage = buildItemDamage(def);

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
      weight: def.bundleSize > 1 ? (def.weight || 0) / def.bundleSize : (def.weight || 0),
      cost: def.cost ?? null,
      isContainer,
      containerEntityId: item.containerEntityId || null,
      magic: def.magic === true,
      description: def.snippetDescription || def.description || null,
      tags,
      avatarUrl: def.avatarUrl || null,
      ...(isArmor && armorProperties !== null && { properties: armorProperties }),
      ...(!isArmor && properties !== null && { properties }),
      ...(isWeapon && damage !== null && { damage }),
      ...(isWeapon && def.damageType && { damageType: def.damageType })
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
    notes: item.notes || null,
    isContainer: false,
    containerEntityId: null,
    description: item.description || null,
    tags: [],
    avatarUrl: null
  }));

  return {
    items: [...items, ...customItems],
    currency: data.currencies || { cp: 0, sp: 0, gp: 0, ep: 0, pp: 0 }
  };
}

function buildFullCharacterPayload(listChar, detailData) {
  const race = detailData?.race?.fullName || listChar.race || null;
  const stats = extractCharacterStats(detailData);
  const rawClasses = detailData?.classes || [];
  const classes = rawClasses.map(cls => ({
    classId: cls.definition.id,
    className: cls.definition.name,
    classLevel: cls.level,
    subclassName: cls.subclassDefinition?.name ?? null
  }));

  return {
    ddbCharacterId: listChar.id,
    externalCharacterId: String(listChar.id),
    name: listChar.name,
    race,
    class: listChar.class || null,
    subclass: rawClasses[0]?.subclassDefinition?.name || null,
    level: listChar.level,
    multiclass: classes.length > 1,
    classes: classes.length ? classes : undefined,
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
// Campaign List for User (MUST cache for 24 hrs or risk being flagged as BOT)
// https://www.dndbeyond.com/api/campaign/stt/user-campaigns
//

// Fetches campaigns owned by the logged-in user (DM role). Must be cached ≥24h.
async function fetchUserCampaigns() {
  const headers = await buildAuthHeaders();
  if (!headers.Authorization) return null;
  const res = await fetch("https://www.dndbeyond.com/api/campaign/stt/user-campaigns", {
    method: "GET",
    headers,
    credentials: "include"
  });
  if (!res.ok) return null;
  const json = await res.json();
  const data = json.data ?? json;
  return Array.isArray(data) ? data : null;
}

function normalizeOwnedCampaigns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(c => {
    // DDB wraps each list item in {"data": {...}} — unwrap if present
    const item = (c?.data && typeof c.data === "object" && !Array.isArray(c.data)) ? c.data : c;
    return {
      id: item.id,
      name: decodeHtml(item.name) || null,
      memberCount: item.playerCount || null,
      dateCreated: item.dateCreated || null,
      dmUsername: decodeHtml(item.dmUsername) || null,
      dmId: item.dmId || null
    };
  });
}

// Builds the rich DM sync payload: campaign metadata + full stats for every party member.
// Character detail fetches are best-effort — some may be inaccessible to the DM token.
async function buildDmCampaignPayload(ddbCampaignId) {
  const details = await fetchCampaignDetails(Number(ddbCampaignId));
  if (!details) return null;

  const members = Array.isArray(details.activeCharacters) ? details.activeCharacters : [];

  const characters = await Promise.all(members.map(async member => {
    const charId = member.id;

    let detailData = null;
    try {
      detailData = await fetchCharacterDetails(charId);
    } catch {
      // Player character may not be accessible via DM token — basic data only
    }

    if (detailData) {
      const listChar = {
        id: charId,
        name: member.name || null,
        race: null,
        class: member.class || null,
        level: member.level || null,
        avatar: member.avatarUrl || null
      };
      const full = buildFullCharacterPayload(listChar, detailData);
      return {
        ...full,
        externalUserId: String(member.userId || ""),
        displayName: member.userName || member.displayName || null
      };
    }

    return {
      externalCharacterId: String(charId),
      externalUserId: String(member.userId || ""),
      displayName: member.userName || member.displayName || null,
      name: member.name || null,
      class: member.class || null,
      level: member.level ?? null,
      avatarUrl: member.avatarUrl || null,
      characterUrl: `https://www.dndbeyond.com/characters/${charId}`
    };
  }));

  return {
    externalCampaignId: String(details.id || ddbCampaignId),
    campaignData: {
      name: decodeHtml(details.name) || null,
      description: decodeHtml(details.description) || null,
      publicNotes: decodeHtml(details.publicNotes) || null,
      dmExternalUserId: String(details.dmId || ""),
      dmUsername: decodeHtml(details.dmUsername) || null,
      dateCreated: details.dateCreated || null,
      memberCount: members.length
    },
    characters
  };
}

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
function isBuilderPage() {
  return location.pathname.includes("/builder/");
}
async function isOwnedCharacterPage() {
  if (!isCharacterPage()) return false;
  const charId = getCharacterIdFromUrl();
  const { ddbCharacterList } = await browser.storage.local.get("ddbCharacterList");
  return ddbCharacterList?.some(c => c.id === charId) || false;
}

//
// 6. CHARACTER INFO BUTTON (copies extracted JSON to clipboard)
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

async function injectCharacterPageButtons() {
  if (isBuilderPage() || !isCharacterPage()) return;

  const charId = getCharacterIdFromUrl();
  const infoId = `vtt-info-btn-${charId}`;
  const syncId = `vtt-sync-btn-${charId}`;
  if (document.getElementById(infoId) && document.getElementById(syncId)) return;

  const { ddbCharacterList } = await browser.storage.local.get("ddbCharacterList");
  if (!ddbCharacterList?.some(c => c.id === charId)) return;

  const heading = document.querySelector(".ddbc-character-tidbits__heading");
  const menuCallout = heading?.querySelector(".ddbc-character-tidbits__menu-callout");
  if (!menuCallout) return;

  // Inject spin keyframe once per page
  if (!document.getElementById("vtt-chat-styles")) {
    const style = document.createElement("style");
    style.id = "vtt-chat-styles";
    style.textContent = "@keyframes vtt-spin { to { transform: rotate(360deg); } }";
    document.head.appendChild(style);
  }

  const BTN_CLASS =
    "ct-theme-button ct-theme-button--outline ct-theme-button--interactive " +
    "ct-button character-button ddbc-button character-button-small";
  const BTN_BG = "rgba(26, 58, 107, 0.6)";

  // EXTRACT button — copies full character JSON to clipboard
  if (!document.getElementById(infoId)) {
    const infoBtn = document.createElement("button");
    infoBtn.id = infoId;
    infoBtn.textContent = "EXTRACT";
    infoBtn.title = "Copy Character Data to Clipboard";
    infoBtn.className = BTN_CLASS;
    infoBtn.style.backgroundColor = BTN_BG;

    infoBtn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      void copyCharacterInfoToClipboard(charId, infoBtn);
    });

    // INFO goes directly after menuCallout (which contains the existing "Manage" button)
    menuCallout.insertAdjacentElement("afterend", infoBtn);
  }

  // SYNC button — refresh SVG, spins while fetching, inserted first (closest to MANAGE)
  if (!document.getElementById(syncId)) {
    const syncBtn = document.createElement("button");
    syncBtn.id = syncId;
    syncBtn.title = "Sync Character to VTT-Chat";
    syncBtn.className = BTN_CLASS;
    syncBtn.style.backgroundColor = BTN_BG;
    syncBtn.style.padding = "1px 6px"; // default padding is too large for 12x12 icon
    syncBtn.style.margin = "0 4px"; // separate from INFO button

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("fill", "currentColor");
    svg.style.display = "block";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d",
      "M17.65 6.35A7.96 7.96 0 0012 4C7.58 4 4.01 7.58 4.01 12S7.58 20 12 20" +
      "c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6" +
      "s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
    );
    svg.appendChild(path);
    syncBtn.appendChild(svg);

    syncBtn.addEventListener("click", async e => {
      e.preventDefault();
      e.stopPropagation();
      syncBtn.disabled = true;
      svg.style.animation = "vtt-spin 0.8s linear infinite";
      try {
        await handleRefetchCharacter(charId);
      } finally {
        svg.style.animation = "";
        syncBtn.disabled = false;
      }
    });

    // SYNC goes after EXTRACT (or directly after menuCallout if INFO wasn't injected)
    const extractEl = document.getElementById(infoId);
    (extractEl ?? menuCallout).insertAdjacentElement("afterend", syncBtn);
  }
}

//
// 7. XHR-TRIGGERED REFETCH
//
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "refetch-character") {
    void handleRefetchCharacter(msg.characterId);
    return;
  }
  if (msg.type === "dm-fetch-campaign-data") {
    // Return true to keep the channel open; respond via sendResponse once async work finishes
    buildDmCampaignPayload(msg.ddbCampaignId)
      .then(payload => sendResponse(payload))
      .catch(() => sendResponse(null));
    return true;
  }
});

async function handleRefetchCharacter(characterId) {
  const { ddbCharacterList } = await browser.storage.local.get("ddbCharacterList");
  const listChar = ddbCharacterList?.find(c => c.id === characterId);
  if (!listChar) return;

  const detailData = await fetchCharacterDetails(characterId);
  const payload = buildFullCharacterPayload(listChar, detailData);
  await browser.runtime.sendMessage({ type: "character-data-updated", payload });
}

//
// 8. CACHE + OBSERVER
//
const CACHE_TTL_MS = 5 * 60 * 1000;
const CAMPAIGN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function ensureDdbCache() {
  const {
    ddbUser, ddbCharacterList, ddbCacheUpdatedAt,
    ddbCampaignsCacheUpdatedAt
  } = await browser.storage.local.get([
    "ddbUser", "ddbCharacterList", "ddbCacheUpdatedAt",
    "ddbCampaignsCacheUpdatedAt"
  ]);

  const userCacheStale = !ddbUser || !ddbCacheUpdatedAt || Date.now() - ddbCacheUpdatedAt >= CACHE_TTL_MS;
  const campaignCacheStale = !ddbCampaignsCacheUpdatedAt || Date.now() - ddbCampaignsCacheUpdatedAt >= CAMPAIGN_CACHE_TTL_MS;

  if (!userCacheStale && !campaignCacheStale) return;

  try {
    if (userCacheStale) {
      const user = extractDdbUser();
      if (!user) {
        await browser.storage.local.set({
          ddbUser: null,
          ddbCharacterList: null,
          ddbCacheUpdatedAt: Date.now()
        });
      } else {
        const rawList = await fetchCharacterList(user.id);
        const characterList = normalizeCharacterList(rawList);
        await emitCharacterDiffs(ddbCharacterList, characterList);
        await browser.storage.local.set({
          ddbUser: user,
          ddbCharacterList: characterList,
          ddbCacheUpdatedAt: Date.now()
        });
      }
    }

    if (campaignCacheStale) {
      const rawCampaigns = await fetchUserCampaigns();
      if (rawCampaigns !== null) {
        await browser.storage.local.set({
          ddbOwnedCampaigns: normalizeOwnedCampaigns(rawCampaigns),
          ddbCampaignsCacheUpdatedAt: Date.now()
        });
      }
    }
  } catch (e) {
    console.warn("[VTT-Chat] Cache refresh failed:", e);
  }
}

(async () => {
  await ensureDdbCache();

  let injectTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(injectTimer);
    injectTimer = setTimeout(() => { void injectCharacterPageButtons(); }, 300);
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
