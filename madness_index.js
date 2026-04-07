/************************************************************
 * Madness Index v3.2 — Scoring & Prediction Engine
 * Source of truth: project Word docs (Core Traits, Breadth,
 * Resume Context Score, Interaction Metrics, Profile Marks,
 * Madness Index v3.2 master).
 *
 * No legacy rule-based logic. All scoring is:
 * - Field-normalized (z-scores)
 * - Directional (higher = better after orientation)
 * - Tier-calibrated
 ************************************************************/

// Global containers
let RAW_ROWS = [];
let TEAMS = {};          // key: team name -> team object
let FIELD_STATS = {};    // key: metric -> { mean, sd }
let TEAM_LIST = [];
let CURRENT_ROUND = null;
let SANDBOX_MODE = false;
let MI_ROUND_NUDGE_SHOWN = false;
let MI_ROUND_TOUCHED = false;

let MI_TEAM_BRANDING = {};

async function loadTeamBranding() {
  try {
    const res = await fetch('data/branding/team_branding.json');

    if (!res.ok) {
      throw new Error(`Branding load failed: ${res.status}`);
    }

    MI_TEAM_BRANDING = await res.json();

    console.log(
      'Team branding loaded:',
      Object.keys(MI_TEAM_BRANDING).length,
      'teams'
    );
  } catch (err) {
    console.error('Failed to load team branding JSON:', err);
    MI_TEAM_BRANDING = {};
  }
}

function normalizeTeamKey(name = '') {
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

function getTeamBranding(teamName) {
  if (!teamName || !MI_TEAM_BRANDING) {
    return defaultBranding(teamName);
  }

  const slug = normalizeTeamKey(teamName);

  // 1 — direct slug match
  if (MI_TEAM_BRANDING[slug]) {
    return MI_TEAM_BRANDING[slug];
  }

  // 2 — alias match
  for (const key in MI_TEAM_BRANDING) {
    const branding = MI_TEAM_BRANDING[key];

    if (
      branding.aliases &&
      branding.aliases.some(
        alias => normalizeTeamKey(alias) === slug
      )
    ) {
      return branding;
    }
  }

  return defaultBranding(teamName);
}

function defaultBranding(teamName) {
  return {
    team: teamName || "Unknown Team",
    shortName: teamName || "Unknown Team",
    primary: "#6b7280",
    secondary: "#ffffff",
    logo: ""
  };
}

function miApplyTeamLogo(imgEl, branding, fallbackName = 'Team') {
  if (!imgEl) return;

  if (branding && branding.logo) {
    imgEl.src = branding.logo;
    imgEl.alt = `${branding.shortName || fallbackName} logo`;
    imgEl.hidden = false;
    return;
  }

  imgEl.removeAttribute('src');
  imgEl.alt = '';
  imgEl.hidden = true;
}

function miIsValidHexColor(value) {
  return typeof value === 'string' && /^#([0-9a-fA-F]{6})$/.test(value.trim());
}

function miHexToRgbString(hex, fallback = '107 114 128') {
  if (!miIsValidHexColor(hex)) return fallback;

  const clean = hex.trim().slice(1);
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);

  return `${r} ${g} ${b}`;
}

function miClamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function miRgbStringToChannels(rgbString, fallback = [107, 114, 128]) {
  if (typeof rgbString !== 'string') return fallback;

  const parts = rgbString
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(n => Number.isFinite(n));

  if (parts.length !== 3) return fallback;
  return parts.map(n => miClamp(Math.round(n), 0, 255));
}

function miMixRgbStrings(rgbA, rgbB, weightA = 0.5) {
  const a = miRgbStringToChannels(rgbA);
  const b = miRgbStringToChannels(rgbB);
  const wa = miClamp(Number(weightA), 0, 1);
  const wb = 1 - wa;

  const mixed = [
    Math.round((a[0] * wa) + (b[0] * wb)),
    Math.round((a[1] * wa) + (b[1] * wb)),
    Math.round((a[2] * wa) + (b[2] * wb))
  ];

  return `${mixed[0]} ${mixed[1]} ${mixed[2]}`;
}

function miRelativeLuminanceFromRgbString(rgbString) {
  const [r, g, b] = miRgbStringToChannels(rgbString).map(v => {
    const channel = v / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4);
  });

  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
}

function miNormalizeTeamBranding(teamName) {
  const raw = getTeamBranding(teamName);

  const safePrimary = miIsValidHexColor(raw?.primary) ? raw.primary.trim() : '#6b7280';
  const rawSecondary = miIsValidHexColor(raw?.secondary) ? raw.secondary.trim() : '';

  const primaryRgb = miHexToRgbString(safePrimary, '107 114 128');

  let safeSecondary = rawSecondary;
  if (!safeSecondary) {
    safeSecondary = safePrimary;
  }

  const secondaryRgb = miHexToRgbString(safeSecondary, primaryRgb);

  const secondaryLum = miRelativeLuminanceFromRgbString(secondaryRgb);

  // If secondary is essentially white/very bright, keep it as a highlight color,
  // but derive a more useful ambient blend color so the glow still has depth.
  const ambientSecondaryRgb =
    secondaryLum > 0.88
      ? miMixRgbStrings(primaryRgb, '255 255 255', 0.72)
      : secondaryRgb;

  const glowMidRgb = miMixRgbStrings(primaryRgb, ambientSecondaryRgb, 0.58);
  const glowEdgeRgb = miMixRgbStrings(primaryRgb, ambientSecondaryRgb, 0.32);

  return {
    ...raw,
    team: raw?.team || teamName || 'Unknown Team',
    shortName: raw?.shortName || raw?.team || teamName || 'Unknown Team',
    primary: safePrimary,
    secondary: safeSecondary,
    primaryRgb,
    secondaryRgb,
    ambientSecondaryRgb,
    glowMidRgb,
    glowEdgeRgb
  };
}

function miApplyBrandVariables(el, branding, side = '') {
  if (!el || !branding) return;

  el.style.setProperty('--team-primary', branding.primary);
  el.style.setProperty('--team-secondary', branding.secondary);

  el.style.setProperty('--team-primary-rgb', branding.primaryRgb);
  el.style.setProperty('--team-secondary-rgb', branding.secondaryRgb);
  el.style.setProperty('--team-secondary-ambient-rgb', branding.ambientSecondaryRgb);
  el.style.setProperty('--team-glow-mid-rgb', branding.glowMidRgb);
  el.style.setProperty('--team-glow-edge-rgb', branding.glowEdgeRgb);

  if (side === 'a' || side === 'b') {
    el.style.setProperty(`--team-${side}-primary`, branding.primary);
    el.style.setProperty(`--team-${side}-secondary`, branding.secondary);
    el.style.setProperty(`--team-${side}-primary-rgb`, branding.primaryRgb);
    el.style.setProperty(`--team-${side}-secondary-rgb`, branding.secondaryRgb);
    el.style.setProperty(`--team-${side}-glow-mid-rgb`, branding.glowMidRgb);
    el.style.setProperty(`--team-${side}-glow-edge-rgb`, branding.glowEdgeRgb);
  }
}

function miApplyScorebugAmbientBranding(teamAName, teamBName) {
  const brandA = miNormalizeTeamBranding(teamAName);
  const brandB = miNormalizeTeamBranding(teamBName);

  const scorebugNameA = document.getElementById('miScorebugTeamA');
  const scorebugNameB = document.getElementById('miScorebugTeamB');

  const scorebugCardA = scorebugNameA?.closest('.mi-team-brand--scorebug');
  const scorebugCardB = scorebugNameB?.closest('.mi-team-brand--scorebug');

  const verdictShell = document.getElementById('verdictShell');
  const metricsTile = document.getElementById('miVerdictMetricsTile');

  miApplyBrandVariables(scorebugCardA, brandA, 'a');
  miApplyBrandVariables(scorebugCardB, brandB, 'b');

  // Optional broader scope so the tile/shell can consume A/B ambient variables too.
  miApplyBrandVariables(metricsTile, brandA, 'a');
  miApplyBrandVariables(metricsTile, brandB, 'b');
  miApplyBrandVariables(verdictShell, brandA, 'a');
  miApplyBrandVariables(verdictShell, brandB, 'b');

  const logoA = scorebugCardA?.querySelector('.mi-team-brand-logo');
  const logoB = scorebugCardB?.querySelector('.mi-team-brand-logo');

  miApplyTeamLogo(logoA, brandA, teamAName || 'Team A');
  miApplyTeamLogo(logoB, brandB, teamBName || 'Team B');
}

function miApplyCanonicalTeamHeaderBranding(aName, bName) {
  const brandA = miNormalizeTeamBranding(aName);
  const brandB = miNormalizeTeamBranding(bName);

  const applyCluster = ({
    wrapId,
    logoId,
    nameId,
    teamName,
    branding,
    side,
    useShortName = false
  }) => {
    const wrap = document.getElementById(wrapId);
    const logo = document.getElementById(logoId);
    const name = document.getElementById(nameId);

    if (wrap) {
      miApplyBrandVariables(wrap, branding, side);
    }

    miApplyTeamLogo(logo, branding, teamName || `Team ${side.toUpperCase()}`);

    const displayName = useShortName
      ? (branding.shortName || branding.team || teamName || `Team ${side.toUpperCase()}`)
      : (branding.team || teamName || branding.shortName || `Team ${side.toUpperCase()}`);

    if (name) {
      name.textContent = displayName;
    }

    return wrap;
  };

  // Card headers (already present in canonical HTML)
  const teamABrandWrap = applyCluster({
    wrapId: 'teamABrand',
    logoId: 'teamALogo',
    nameId: 'teamATitle',
    teamName: aName,
    branding: brandA,
    side: 'a'
  });

  const teamBBrandWrap = applyCluster({
    wrapId: 'teamBBrand',
    logoId: 'teamBLogo',
    nameId: 'teamBTitle',
    teamName: bName,
    branding: brandB,
    side: 'b'
  });

  // Score synthesis desktop headers (new brand clusters)
  const summaryABrandWrap = applyCluster({
    wrapId: 'summaryBrandA',
    logoId: 'summaryLogoA',
    nameId: 'summaryTeamA',
    teamName: aName,
    branding: brandA,
    side: 'a'
  });

  const summaryBBrandWrap = applyCluster({
    wrapId: 'summaryBrandB',
    logoId: 'summaryLogoB',
    nameId: 'summaryTeamB',
    teamName: bName,
    branding: brandB,
    side: 'b'
  });

  // Score synthesis mobile headers (new mobile brand clusters)
  const summaryMobileABrandWrap = applyCluster({
    wrapId: 'summaryMobileBrandA',
    logoId: 'summaryMobileLogoA',
    nameId: 'summaryMobileTeamA',
    teamName: aName,
    branding: brandA,
    side: 'a'
  });

  const summaryMobileBBrandWrap = applyCluster({
    wrapId: 'summaryMobileBrandB',
    logoId: 'summaryMobileLogoB',
    nameId: 'summaryMobileTeamB',
    teamName: bName,
    branding: brandB,
    side: 'b'
  });

  // Whole card shells inherit team vars for border + header glow
  const cindCard = document.getElementById('cindCard');
  const favCard = document.getElementById('favCard');

  if (cindCard) {
    miApplyBrandVariables(cindCard, brandA, 'a');
  }

  if (favCard) {
    miApplyBrandVariables(favCard, brandB, 'b');
  }

  // Let the summary section inherit A/B team vars too
  const summarySection = document.getElementById('summarySection');
  if (summarySection) {
    summarySection.style.setProperty('--mi-brand-a', brandA.primary);
    summarySection.style.setProperty('--mi-brand-b', brandB.primary);
    summarySection.style.setProperty('--mi-brand-a-secondary', brandA.secondary);
    summarySection.style.setProperty('--mi-brand-b-secondary', brandB.secondary);
    summarySection.style.setProperty('--mi-brand-a-rgb', brandA.primaryRgb);
    summarySection.style.setProperty('--mi-brand-b-rgb', brandB.primaryRgb);
    summarySection.style.setProperty('--mi-brand-a-secondary-ambient-rgb', brandA.ambientSecondaryRgb);
    summarySection.style.setProperty('--mi-brand-b-secondary-ambient-rgb', brandB.ambientSecondaryRgb);
  }

  const summarySectionMobile = document.getElementById('summarySectionMobile');
  if (summarySectionMobile) {
    summarySectionMobile.style.setProperty('--mi-brand-a', brandA.primary);
    summarySectionMobile.style.setProperty('--mi-brand-b', brandB.primary);
    summarySectionMobile.style.setProperty('--mi-brand-a-secondary', brandA.secondary);
    summarySectionMobile.style.setProperty('--mi-brand-b-secondary', brandB.secondary);
    summarySectionMobile.style.setProperty('--mi-brand-a-rgb', brandA.primaryRgb);
    summarySectionMobile.style.setProperty('--mi-brand-b-rgb', brandB.primaryRgb);
    summarySectionMobile.style.setProperty('--mi-brand-a-secondary-ambient-rgb', brandA.ambientSecondaryRgb);
    summarySectionMobile.style.setProperty('--mi-brand-b-secondary-ambient-rgb', brandB.ambientSecondaryRgb);
    summarySectionMobile.style.setProperty('--syn-a-rgb', brandA.primaryRgb);
    summarySectionMobile.style.setProperty('--syn-b-rgb', brandB.primaryRgb);
    summarySectionMobile.style.setProperty('--syn-a-ambient-rgb', brandA.ambientSecondaryRgb);
    summarySectionMobile.style.setProperty('--syn-b-ambient-rgb', brandB.ambientSecondaryRgb);
  }

  // Also apply inherited vars to the actual header cells
  const synTeamA = summaryABrandWrap?.closest('.syn-team-a');
  const synTeamB = summaryBBrandWrap?.closest('.syn-team-b');

  if (synTeamA) {
    miApplyBrandVariables(synTeamA, brandA, 'a');
  }

  if (synTeamB) {
    miApplyBrandVariables(synTeamB, brandB, 'b');
  }

  const summaryMobileTeamSlotA = summaryMobileABrandWrap?.closest('.mi-sum-mob-team-slot-a');
  const summaryMobileTeamSlotB = summaryMobileBBrandWrap?.closest('.mi-sum-mob-team-slot-b');

  if (summaryMobileTeamSlotA) {
    miApplyBrandVariables(summaryMobileTeamSlotA, brandA, 'a');
  }

  if (summaryMobileTeamSlotB) {
    miApplyBrandVariables(summaryMobileTeamSlotB, brandB, 'b');
  }

  // Preserve existing mobile summary names if present
  document.querySelectorAll('.mi-sum-mob-team-name-a').forEach(el => {
    el.textContent = brandA.team || aName || brandA.shortName || 'Team A';
    el.style.setProperty('--team-primary', brandA.primary);
    el.style.setProperty('--team-secondary', brandA.secondary);
    el.style.setProperty('--team-primary-rgb', brandA.primaryRgb);
    el.style.setProperty('--team-secondary-rgb', brandA.secondaryRgb);
    el.style.setProperty('--team-secondary-ambient-rgb', brandA.ambientSecondaryRgb);
    el.style.setProperty('--team-glow-mid-rgb', brandA.glowMidRgb);
    el.style.setProperty('--team-glow-edge-rgb', brandA.glowEdgeRgb);
  });

  document.querySelectorAll('.mi-sum-mob-team-name-b').forEach(el => {
    el.textContent = brandB.team || bName || brandB.shortName || 'Team B';
    el.style.setProperty('--team-primary', brandB.primary);
    el.style.setProperty('--team-secondary', brandB.secondary);
    el.style.setProperty('--team-primary-rgb', brandB.primaryRgb);
    el.style.setProperty('--team-secondary-rgb', brandB.secondaryRgb);
    el.style.setProperty('--team-secondary-ambient-rgb', brandB.ambientSecondaryRgb);
    el.style.setProperty('--team-glow-mid-rgb', brandB.glowMidRgb);
    el.style.setProperty('--team-glow-edge-rgb', brandB.glowEdgeRgb);
  });
}

function miColorDistance(rgbA, rgbB) {
  const a = miRgbStringToChannels(rgbA, [107, 114, 128]);
  const b = miRgbStringToChannels(rgbB, [107, 114, 128]);

  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];

  return Math.sqrt((dr * dr) + (dg * dg) + (db * db));
}

function miApplyWinnerTokens(winnerSide, brandA, brandB) {
  const verdictShell = document.getElementById('verdictShell');
  const summarySection = document.getElementById('summarySection');
  const summarySectionMobile = document.getElementById('summarySectionMobile');
  
  if (!verdictShell && !summarySection && !summarySectionMobile) return;

  const safeA = brandA || miNormalizeTeamBranding('');
  const safeB = brandB || miNormalizeTeamBranding('');

  const winnerBrand =
    winnerSide === 'a' ? safeA :
    winnerSide === 'b' ? safeB :
    null;

  const loserBrand =
    winnerSide === 'a' ? safeB :
    winnerSide === 'b' ? safeA :
    null;

  const applySharedWinnerVars = (el) => {
    if (!el) return;

    if (winnerBrand) {
      el.style.setProperty('--mi-winner-primary-rgb', winnerBrand.primaryRgb);
      el.style.setProperty('--mi-winner-secondary-rgb', winnerBrand.secondaryRgb);
      el.style.setProperty('--mi-winner-ambient-rgb', winnerBrand.ambientSecondaryRgb);
    } else {
      el.style.setProperty('--mi-winner-primary-rgb', '148 163 184');
      el.style.setProperty('--mi-winner-secondary-rgb', '148 163 184');
      el.style.setProperty('--mi-winner-ambient-rgb', '148 163 184');
    }

    if (loserBrand) {
      el.style.setProperty('--mi-loser-primary-rgb', loserBrand.primaryRgb);
      el.style.setProperty('--mi-loser-secondary-rgb', loserBrand.secondaryRgb);
    } else {
      el.style.setProperty('--mi-loser-primary-rgb', '107 114 128');
      el.style.setProperty('--mi-loser-secondary-rgb', '107 114 128');
    }
  };

  applySharedWinnerVars(verdictShell);
  applySharedWinnerVars(summarySection);
  applySharedWinnerVars(summarySectionMobile);

  if (verdictShell) {
    const verdictRgb = winnerBrand ? winnerBrand.primaryRgb : '148 163 184';
    verdictShell.style.setProperty('--mi-verdict-rgb', verdictRgb);
  }

  const colorDistance = miColorDistance(safeA.primaryRgb, safeB.primaryRgb);
  const proximity = colorDistance < 40 ? 'close' : 'distinct';

  if (verdictShell) {
    verdictShell.setAttribute('data-color-proximity', proximity);
  }

  if (summarySection) {
    summarySection.setAttribute('data-color-proximity', proximity);
  }

  if (summarySectionMobile) {
    summarySectionMobile.setAttribute('data-color-proximity', proximity);
  }
}

// Default Profile Mark descriptions (fallback if JSON not present)
const DEFAULT_MARK_DESCRIPTIONS = {
  "Offensive Rigidity":         "Predictable, inflexible offense.",
  "Unstable Perimeter": "Volatile 3-point identity.",
  "Cold Arc Team":              "Translation risk from deep.",
  "Undisciplined Defense":      "Foul-prone, mistake-heavy defense.",
  "Soft Interior":              "Weak rim protection / deterrence.",
  "Perimeter Leakage":          "Allows clean perimeter looks.",
  "Tempo Strain":               "Pace identity strains possessions.",
};

// getMarkDescription Looks up the description text for a profile mark (e.g., Offensive Rigidity), preferring copy.marks.descriptions (including severity-specific text) and falling back to DEFAULT_MARK_DESCRIPTIONS.

// Decode HTML entities in strings (e.g., "St. Mary&#39;s" -> "St. Mary's")
function miDecodeEntities(str){
  if (str == null) return "";
  const s = String(str);
  if (s.indexOf("&") === -1) return s;
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

function miSplitHeadlineSubdeckSafe(raw){
  const s = String(raw || "").trim();
  if (!s) return { headlineText: "", subText: "" };

  const ABBR = new Set(["st","mt","mr","ms","mrs","dr","jr","sr","vs"]);

  // Find a ". " / "! " / "? " that is likely a true sentence boundary.
  for (let i = 0; i < s.length - 1; i++){
    const ch = s[i];
    const next = s[i + 1];
    if (!((ch === "." || ch === "!" || ch === "?") && next === " ")) continue;

    // If period, check abbreviation immediately before it (St., Mt., etc.)
    if (ch === ".") {
      let j = i - 1;
      while (j >= 0 && /[A-Za-z]/.test(s[j])) j--;
      const token = s.slice(j + 1, i).toLowerCase();
      if (token && ABBR.has(token)) continue;
    }

    // Also require next non-space char to look like a new sentence start
    let k = i + 2;
    while (k < s.length && s[k] === " ") k++;
    const start = s[k] || "";
    if (!/[A-Z“"‘]/.test(start)) continue;

    return {
      headlineText: s.slice(0, i + 1).trim(),
      subText: s.slice(i + 1).trim()
    };
  }

  return { headlineText: s, subText: "" };
}

function setSandboxMode(next) {
  const on = !!next;

  // Write BOTH (some code paths read one or the other)
  try { window.SANDBOX_MODE = on; } catch(e) {}
  try { SANDBOX_MODE = on; } catch(e) {}

  // Pre-matchup UI hooks
  if (typeof updateRoundOptionsForCurrentSeeds === 'function') {
    updateRoundOptionsForCurrentSeeds();
  }
  if (typeof updatePreMatchupHubProgress === 'function') {
    updatePreMatchupHubProgress();
  }
  if (typeof refreshCompareButtonState === 'function') {
    refreshCompareButtonState();
  }

  // Post-matchup visual hook (header swap styling)
  const matchupBar = document.getElementById('matchupBar');
  if (matchupBar) matchupBar.classList.toggle('is-sandbox', on);

  console.log('[MI] Sandbox mode:', on ? 'ON' : 'OFF');
}

function getMarkDescription(baseName, severity) {
  const copy = window.MI_COPY;

  if (copy && copy.marks && copy.marks.descriptions) {
    const entry = copy.marks.descriptions[baseName];

    if (entry && typeof entry === 'object') {
      const sevKey = (severity || '').toLowerCase(); // "moderate" / "severe"
      if (entry[sevKey]) return entry[sevKey];
      if (entry.base) return entry.base; // optional fallback if you add "base"
    }

    // OLD: simple string fallback
    if (typeof entry === 'string') return entry;
  }

  // DEFAULT fallback
  return DEFAULT_MARK_DESCRIPTIONS[baseName] || '';
}

// applyCopyToDOM(copy) Walks all elements with data-copy="..." and fills their text (or HTML) from the nested keys in the copy JSON object.

function applyCopyToDOM(copy) {
  if (!copy) return;

  const elements = document.querySelectorAll('[data-copy]');
  elements.forEach(el => {
    const key = el.getAttribute('data-copy'); // e.g. "controls.data_title"
    if (!key) return;

    // Walk nested keys: "controls.data_title" → copy.controls.data_title
    const parts = key.split('.');
    let value = copy;
    for (const part of parts) {
      if (value && Object.prototype.hasOwnProperty.call(value, part)) {
        value = value[part];
      } else {
        value = null;
        break;
      }
    }

    if (typeof value === 'string') {
      el.textContent = value;
    } else if (Array.isArray(value)) {
      el.textContent = value.filter(Boolean).join(' ');
    }
  });
}

// ===== Copy helpers (path lookup + {{TOKENS}} template fill) =====
function miGetCopy(path, fallback = '') {
  const copy = window.MI_COPY;
  if (!copy || !path) return fallback;

  const parts = String(path).split('.');
  let value = copy;

  for (const part of parts) {
    if (value && Object.prototype.hasOwnProperty.call(value, part)) {
      value = value[part];
    } else {
      return fallback;
    }
  }

  return (typeof value === 'string') ? value : fallback;
}

function miTpl(str, tokens = {}) {
  if (typeof str !== 'string') return '';
  return str.replace(/{{\s*([A-Za-z0-9_]+)\s*}}/g, (_, key) => {
    const v = tokens[key];
    return (v === null || v === undefined) ? '' : String(v);
  });
}

// ===== PATCH NOTES "NEW" DETECTION (badge-based) =====
const MI_PATCH_NOTES_SEEN_KEY = 'mi_patch_notes_last_seen_badge';

function miSyncPatchNotesNewState(currentBadge) {
  const btn = document.getElementById('versionBadgeBtn');
  if (!btn) return;

  const lastSeen = localStorage.getItem(MI_PATCH_NOTES_SEEN_KEY) || '';
  const isNew = !!currentBadge && currentBadge !== lastSeen;

  btn.classList.toggle('is-new', isNew);
}

function miMarkPatchNotesSeen(currentBadge) {
  if (!currentBadge) return;
  localStorage.setItem(MI_PATCH_NOTES_SEEN_KEY, currentBadge);

  const btn = document.getElementById('versionBadgeBtn');
  if (btn) btn.classList.remove('is-new');
}

// ===== VERSION BADGE PATCH NOTES =====
function initVersionPatchNotes() {
  const btn = document.getElementById('versionBadgeBtn');
  const panel = document.getElementById('versionNotes');
  if (!btn || !panel) return;

  const open = () => {
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-expanded', 'true');

    const badge = document.getElementById('versionBadgeText')?.textContent?.trim() || '';
    miMarkPatchNotesSeen(badge);
  };

  const close = () => {
    panel.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    btn.setAttribute('aria-expanded', 'false');
  };

  const isOpen = () => panel.classList.contains('is-open');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  });

  // close on outside click
  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    close();
  });

  // close on Esc
  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') close();
  });
}

// ========== PRE-MATCHUP COPY ADAPTER (pre_matchup → prematch.*) ==========
// Your HTML expects data-copy="prematch.*" but copy.json uses pre_matchup.*
// This adapter creates a prematch block so applyCopyToDOM can populate the hub.

function normalizePreMatchupCopy(data) {
  if (!data) return;

  // If already present in the right shape, do nothing
  if (data.prematch && data.prematch.progress) return;

  if (!data.pre_matchup) return;

  const pm = data.pre_matchup;

  const intro = pm.intro || {};
  const steps = Array.isArray(pm.steps) ? pm.steps : [];
  const cta   = pm.cta || {};

  const clean = (s) => (typeof s === 'string' ? s.replace(/\*/g, '').trim() : '');

  const stepLine = (i) => {
    const row = steps[i] || {};
    const t = clean(row.title);
    const d = clean(row.description);
    if (t && d) return `${t} — ${d}`;
    return clean(t || d);
  };

  // HTML expects prematch.progress.*
  data.prematch = {
    progress: {
      title:    clean(intro.title) || 'Start a matchup',
      subtitle: [clean(intro.lead), clean(intro.secondary)].filter(Boolean).join(' '),

      // These are the “step copy” strings your hub and status logic consume
      step1_pending: stepLine(0) || 'Load tournament data to begin.',
      step2_pending: stepLine(1) || 'Select both teams.',
      step2_ready:   clean(cta.step2_ready) || 'Teams selected. Choose a round.',

      step3_pending: stepLine(2) || 'Select a round to unlock Compare.',
      step3_ready:   clean(cta.step3_ready) || 'Briefing complete. Run Compare when ready.',

      // Generic labels
      status_pending: clean(cta.status_pending) || 'Pending',
      status_next:    clean(cta.status_next) || 'Next',

      // Optional “more details” expander labels (your code already references these)
      more_show: clean(cta.more_show) || 'What you’ll get (optional)',
      more_hide: clean(cta.more_hide) || 'Hide details',

      note: clean(cta.hint) || ''
    }
  };
}

// ===============================
// Verdict-first UI (Option A)
// ===============================
function setEvidenceOpen(isOpen) {
  const shell  = document.getElementById('analysisShell');
  const btn    = document.getElementById('miEvidenceToggle');
  const verdict = document.getElementById('verdictShell');
  if (!shell || !btn) return;

  // Track state for CSS (breadcrumbs vs open state)
  if (verdict) verdict.classList.toggle('scorecard-open', !!isOpen);

  // Update ARIA
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

  // Update label + chevron
  const chev = btn.querySelector('.mi-chev');
  btn.childNodes[0].nodeValue = isOpen ? 'Hide Full Scorecard ' : 'View Full Scorecard ';
  if (chev) chev.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';

  // Visual open/close
  if (isOpen) {
    shell.classList.remove('hidden');
    requestAnimationFrame(() => {
      shell.classList.add('analysis-visible');

      // Mobile: after opening, scroll the scorecard into view so it feels immediate
      if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) {
        try {
          shell.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (e) {
          shell.scrollIntoView(true);
        }
      }
    });
  } else {

    shell.classList.remove('analysis-visible');
    window.setTimeout(() => {
      shell.classList.add('hidden');

      // Mobile: returning focus to verdict keeps the flow coherent
      if (window.matchMedia && window.matchMedia('(max-width: 720px)').matches) {
        const vs = document.getElementById('verdictShell');
        if (vs) {
          try {
            vs.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch (e) {
            vs.scrollIntoView(true);
          }
        }
      }
    }, 280);
  }
}

function initEvidenceToggleOnce() {
  const btn = document.getElementById('miEvidenceToggle');
  if (!btn || btn.__miBound) return;
  btn.__miBound = true;

  btn.addEventListener('click', () => {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    setEvidenceOpen(!expanded);
  });
}

function showVerdictShell() {
  const vs = document.getElementById('verdictShell');
  if (!vs) return;
  vs.classList.remove('hidden');
}

function persistWorkflowState() {
  const datasetSelect = document.getElementById('datasetSelect');
  const teamASelect = document.getElementById('teamA');
  const teamBSelect = document.getElementById('teamB');

  const state = {
    dataset: datasetSelect?.value || '',
    teamA: teamASelect?.value || '',
    teamB: teamBSelect?.value || '',
    round: (typeof CURRENT_ROUND !== 'undefined' && CURRENT_ROUND) ? CURRENT_ROUND : ''
  };

  localStorage.setItem('miWorkflowState', JSON.stringify(state));
}

function restoreWorkflowState() {
  const raw = localStorage.getItem('miWorkflowState');
  if (!raw) return;

  try {
    const state = JSON.parse(raw);

    const datasetSelect = document.getElementById('datasetSelect');
    const teamASelect = document.getElementById('teamA');
    const teamBSelect = document.getElementById('teamB');
    const roundBtn = document.getElementById('roundSelectBtn');

    if (datasetSelect && state.dataset) {
      datasetSelect.value = state.dataset;
    }

    if (teamASelect && state.teamA) {
      teamASelect.value = state.teamA;
    }

    if (teamBSelect && state.teamB) {
      teamBSelect.value = state.teamB;
    }

    if (state.round) {
      CURRENT_ROUND = state.round;
      if (roundBtn && typeof getRoundLabelFromCode === 'function') {
        roundBtn.textContent = getRoundLabelFromCode(CURRENT_ROUND);
      }
    }
  } catch (err) {
    console.warn('[MI] Workflow state restore failed:', err);
  }
}

function logWorkflowEvent(event, details = {}) {
  console.log(
    '[MI Workflow]',
    event,
    details
  );
}

function resetWorkflowFrom(level) {
  const teamA = document.getElementById('teamA');
  const teamB = document.getElementById('teamB');
  const roundBtn = document.getElementById('roundSelectBtn');

  if (level === 'teams') {
    CURRENT_ROUND = null;
    MI_ROUND_TOUCHED = false;
    MI_ROUND_NUDGE_SHOWN = false;

    if (roundBtn) {
      roundBtn.textContent = 'Select Round';
      delete roundBtn.dataset.selected;
    }

    if (typeof setCompareButtonEnabled === 'function') {
      setCompareButtonEnabled(false);
    }

    if (typeof updatePreMatchupHubProgress === 'function') {
      updatePreMatchupHubProgress();
    }

    if (typeof refreshCompareButtonState === 'function') {
      refreshCompareButtonState();
    }

    if (typeof syncNextHalo === 'function') {
      syncNextHalo();
    }
  }
}

function resetNativeTeamSelect(selectEl, placeholderText) {
  if (!selectEl) return;

  selectEl.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = '';
  opt.disabled = true;
  opt.selected = true;
  opt.textContent = placeholderText;
  selectEl.appendChild(opt);

  selectEl.value = '';
}

function forceTeamSelectPlaceholder(selectEl, placeholderText) {
  if (!selectEl) return;

  const hasPlaceholder = Array.from(selectEl.options).some(opt => opt.value === '');

  if (!hasPlaceholder) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = placeholderText;
    selectEl.insertBefore(opt, selectEl.firstChild);
  }

  selectEl.value = '';
  selectEl.selectedIndex = 0;
}

function syncSearchableTeamDropdownUi(selectEl, wrapEl, placeholderText) {
  if (!wrapEl) return;

  const root = wrapEl.querySelector('.mi-team-dd');
  if (!root) return;

  const label = root.querySelector('.mi-label');
  const panel = root.querySelector('.mi-team-dd-panel');
  const search = root.querySelector('.mi-team-dd-search');
  const list = root.querySelector('.mi-team-dd-list');

  if (label) {
    label.textContent = (selectEl && selectEl.value) ? selectEl.value : placeholderText;
  }

  if (panel) {
    panel.hidden = true;
  }

  if (search) {
    search.value = '';
  }

  if (list) {
    list.innerHTML = '';
  }
}

function destroySearchableTeamDropdown(wrapEl) {
  if (!wrapEl) return;

  wrapEl.querySelectorAll('.mi-team-dd').forEach(el => el.remove());
}

function hardResetWorkflow(options = {}) {
  const {
    clearDatasetSelection = true,
    preserveDatasetSelection = false,
    statusText = 'Select a dataset to begin.'
  } = options;

  // -----------------------------
  // 1) Clear in-memory dataset state
  // -----------------------------
  RAW_ROWS = [];
  TEAMS = {};
  FIELD_STATS = {};
  TEAM_LIST = [];
  CURRENT_ROUND = null;
  MI_ROUND_TOUCHED = false;
  MI_ROUND_NUDGE_SHOWN = false;

  try { window.LAST_RESULT = null; } catch (e) {}

  if (typeof RESUME_CONTEXT_STATS_V2 !== 'undefined') {
    RESUME_CONTEXT_STATS_V2 = null;
  }

  // -----------------------------
  // 2) Clear persisted workflow state
  // -----------------------------
  localStorage.removeItem('miWorkflowState');

  // -----------------------------
  // 3) Reset dataset controls
  // -----------------------------
  const datasetSelect = document.getElementById('datasetSelect');
  const datasetDownloadBtn = document.getElementById('datasetDownloadBtn');
  const statusEl = document.getElementById('status');
  const appShell = document.querySelector('.app-shell');

  if (datasetSelect && !preserveDatasetSelection && clearDatasetSelection) {
    datasetSelect.value = '';
  }

  if (datasetDownloadBtn) {
    datasetDownloadBtn.disabled = true;
    datasetDownloadBtn.classList.add('hidden');
    datasetDownloadBtn.textContent = 'Download Dataset';
  }

  if (statusEl) {
    statusEl.className = 'status';
    statusEl.textContent = statusText;
  }

  if (appShell) {
    appShell.classList.remove('csv-loaded');
  }

  // -----------------------------
  // 4) Reset team / round controls
  // -----------------------------
  const teamA = document.getElementById('teamA');
  const teamB = document.getElementById('teamB');
  const roundBtn = document.getElementById('roundSelectBtn');

  resetNativeTeamSelect(teamA, 'Select Team A');
  resetNativeTeamSelect(teamB, 'Select Team B');

  if (roundBtn) {
    roundBtn.textContent = 'Select Round';
    delete roundBtn.dataset.selected;
  }

  if (typeof updateInteractionHeadersFromSelections === 'function') {
    updateInteractionHeadersFromSelections();
  }

  if (typeof clearRoundNudge === 'function') {
    clearRoundNudge();
  }

  // -----------------------------
  // 5) Destroy custom team dropdown UI
  // -----------------------------
  destroySearchableTeamDropdown(document.getElementById('teamASelectWrap'));
  destroySearchableTeamDropdown(document.getElementById('teamBSelectWrap'));

  // -----------------------------
  // 6) Reset post-matchup / result state
  // -----------------------------
  if (typeof resetPreMatchupEmptyView === 'function') {
    resetPreMatchupEmptyView();
  }

  if (typeof resetVolatilityMeter === 'function') {
    resetVolatilityMeter();
  }

  if (typeof setCompareButtonEnabled === 'function') {
    setCompareButtonEnabled(false);
  }

  // -----------------------------
  // 7) Re-sync workflow UI
  // -----------------------------
  if (typeof updatePreMatchupHubProgress === 'function') {
    updatePreMatchupHubProgress();
  }

  if (typeof refreshCompareButtonState === 'function') {
    refreshCompareButtonState();
  }

  if (typeof syncNextHalo === 'function') {
    syncNextHalo();
  }
}

function clearWorkflowState() {
  hardResetWorkflow({
    clearDatasetSelection: true,
    preserveDatasetSelection: false,
    statusText: 'Select a dataset to begin.'
  });
}

function resetPostMatchupDefaultView() {
  // After each run: verdict visible, evidence closed
  showVerdictShell();
  initEvidenceToggleOnce();
  setEvidenceOpen(false);
}

function resetPreMatchupEmptyView() {
  const verdictShell = document.getElementById('verdictShell');
  const analysisShell = document.getElementById('analysisShell');
  const evidenceBtn = document.getElementById('miEvidenceToggle');

  if (verdictShell) {
    verdictShell.classList.add('hidden');
    verdictShell.classList.remove('scorecard-open');
  }

  if (analysisShell) {
    analysisShell.classList.add('hidden');
    analysisShell.classList.remove('analysis-visible');
  }

  if (evidenceBtn) {
    evidenceBtn.setAttribute('aria-expanded', 'false');

    const chev = evidenceBtn.querySelector('.mi-chev');
    evidenceBtn.childNodes[0].nodeValue = 'View Full Scorecard ';
    if (chev) chev.style.transform = 'rotate(0deg)';
  }
}

// ===== PATCH NOTES: render from canonical MI_COPY =====
function miRenderPatchNotesFromCopy(copyObj) {
  const copy = copyObj || window.MI_COPY;
  const list = document.getElementById('versionNotesList');
  const badgeText = document.getElementById('versionBadgeText');
  if (!copy || !list) return;

  const pn = copy.patch_notes;
  if (!pn || !Array.isArray(pn.items)) {
    list.innerHTML = '';
    return;
  }

  // Drive the badge line from copy.json when available,
  // otherwise fall back to the live technical build.
  let currentBadge = `Version 2.0 (Build ${MI_BUILD})`;
  if (typeof pn.badge === 'string' && pn.badge.trim()) {
    currentBadge = pn.badge.trim();
  }

  if (badgeText) badgeText.textContent = currentBadge;

  miSyncPatchNotesNewState(currentBadge);

  const maxItems = Number(pn.max_items || 6);
  const items = pn.items.slice(0, maxItems);

  list.innerHTML = items.map(entry => {
    const build = entry.build || 'Update';
    const date = entry.date ? ` <span class="pn-date">(${miEscapeHtml(String(entry.date))})</span>` : '';
    const bullets = Array.isArray(entry.bullets) ? entry.bullets : [];

    const bulletsHtml = bullets
      .map(b => `<li class="pn-bullet">${miEscapeHtml(String(b))}</li>`)
      .join('');

    return `
      <li class="pn-entry">
        <div class="pn-build"><strong>${miEscapeHtml(String(build))}</strong>${date}</div>
        <ul class="pn-bullets">${bulletsHtml}</ul>
      </li>
    `;
  }).join('');
}

function miEscapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));
}

// loadCopyJSON() { Fetches copy.json, stores it on window.MI_COPY, then calls applyCopyToDOM, buildGlossaryFromCopy, populateBackExplanations, and populateInteractionsHowToList. Handles fetch/parse errors.

function loadCopyJSON() {
  console.log("[MI] loadCopyJSON fired");

  fetch(`copy.json?v=${MI_BUILD}`, { cache: 'no-store' })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(data => {
      // Ensure pre-matchup hub keys exist in the shape the HTML expects
      normalizePreMatchupCopy(data);

      // Canonical copy assignment
      window.MI_COPY = data;

      // Apply copy-driven UI
      applyCopyToDOM(data);
      miRenderPatchNotesFromCopy(data);
      buildGlossaryFromCopy(data);
      populateBackExplanations(data);

      // Glossary arrives empty on first init — refresh once copy exists
      if (typeof window.miRefreshGlossary === 'function') {
        window.miRefreshGlossary();
      }

      // Re-sync availability now that copy + matchup state are both known
      if (typeof window.miSyncGlossaryToMatchupState === 'function') {
        window.miSyncGlossaryToMatchupState();
      }

      // Update pre-matchup hub once copy is ready
      if (typeof updatePreMatchupHubProgress === 'function') {
        updatePreMatchupHubProgress();
      }
    })
    .catch(err => {
      console.error('Error loading copy.json:', err);
    });
}


// populateBackExplanations(copy) { Uses copy.back to fill the big back-of-card explainer paragraphs and the smaller “mini-tile” explanations for Core, Breadth, Résumé, Marks, Identity, and formula.

function populateBackExplanations(copy) {
  if (!copy || !copy.back) return;

  const b = copy.back;

  const setText = (id, text) => {
    if (!text) return;
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  // ----- Whole-card backs: Cinderella (A) & Favorite (B) -----
  setText('backFormulaA', b.formula && b.formula.card);
  setText('backFormulaB', b.formula && b.formula.card);

  setText('backBreadthA', b.breadth && b.breadth.card);
  setText('backBreadthB', b.breadth && b.breadth.card);

  setText('backResumeA',  b.resume  && b.resume.card);
  setText('backResumeB',  b.resume  && b.resume.card);

  setText('backMarksA',   b.marks   && b.marks.card);
  setText('backMarksB',   b.marks   && b.marks.card);

  // ----- Mini flip tiles (Core / Breadth / Résumé / Marks / Identity) -----

  // Breadth mini-tiles
  setText('backBreadthTileA', b.breadth && b.breadth.tile);
  setText('backBreadthTileB', b.breadth && b.breadth.tile);

  // Résumé mini-tiles
  setText('backResumeTileA',  b.resume  && b.resume.tile);
  setText('backResumeTileB',  b.resume  && b.resume.tile);
}

function updateMarksBacksForResult(result) {
  const copy = window.MI_COPY;
  const marksCopy = copy && copy.marks ? copy.marks : null;
  if (!marksCopy || !result || !result.a || !result.b) return;

  const elTileA = document.getElementById('backMarksTileA');
  const elTileB = document.getElementById('backMarksTileB');
  if (!elTileA || !elTileB) return;

  const clearEl = (el) => {
    while (el.firstChild) el.removeChild(el.firstChild);
  };

  const renderTeamInto = (el, team) => {
    clearEl(el);

    const marks = Array.isArray(team.profileMarks) ? team.profileMarks : [];
    const count = Math.max(0, Math.min(7, marks.length));

    // --- Summary (always present) ---
    const summaryMap = marksCopy.summary_by_count || {};
    const summaryText = summaryMap[String(count)] || summaryMap[count] || '';

    const summarySpan = document.createElement('span');
    summarySpan.className = 'mi-marks-back-summary';
    summarySpan.textContent = summaryText;
    el.appendChild(summarySpan);

    // Divider (CSS can draw line using ::after on summary, or style this element)
    const divider = document.createElement('span');
    divider.className = 'mi-marks-back-divider';
    el.appendChild(divider);
    
    // --- Marks list (0–7 rows) ---
    if (!marks.length) {
      // Ensure fade state resets when summary-only
      requestAnimationFrame(() => {
        const needsScroll = el.scrollHeight > el.clientHeight + 1;
        el.classList.toggle('has-scroll', needsScroll);
      });
      return;
    }

    const parsed = marks
      .map(parseProfileMark)
      .filter(Boolean)
      .map(pm => {
        const base = String(pm.base || '').trim();
        const sevRaw = String(pm.severity || 'Moderate').trim();
        const sevKey = sevRaw.toLowerCase() === 'severe' ? 'severe' : 'moderate';
        const sevLabel = sevKey === 'severe' ? 'Severe' : 'Moderate';
        return { base, sevKey, sevLabel };
      });

    // Deterministic ordering: Severe first, then Moderate; alphabetical within severity
    const sevRank = { severe: 0, moderate: 1 };
    parsed.sort((a, b) => {
      const ra = sevRank[a.sevKey] ?? 99;
      const rb = sevRank[b.sevKey] ?? 99;
      if (ra !== rb) return ra - rb;
      return String(a.base).localeCompare(String(b.base));
    });

    // Container for rows (still inside <p>, so use spans)
    const listSpan = document.createElement('span');
    listSpan.className = 'mi-marks-back-list';
    el.appendChild(listSpan);

    const backMap = marksCopy.back || {};

    parsed.forEach((pm, idx) => {
      const row = document.createElement('span');
      row.className = 'mi-marks-back-row';
      row.setAttribute('data-severity', pm.sevKey);

      const name = document.createElement('span');
      name.className = 'mi-marks-back-name';
      name.textContent = pm.base;

      const sev = document.createElement('span');
      sev.className = 'mi-marks-back-sev';
      sev.textContent = pm.sevLabel;

      const desc = document.createElement('span');
      desc.className = 'mi-marks-back-desc';
      const key = pm.base || '';
      const backEntry = backMap[key] || {};
      desc.textContent = backEntry[pm.sevKey] || '';

      row.appendChild(name);
      row.appendChild(sev);
      row.appendChild(desc);

      listSpan.appendChild(row);

      // Line break between rows (cleanest inside a <p>)
      if (idx < parsed.length - 1) listSpan.appendChild(document.createElement('br'));
    });

    requestAnimationFrame(() => {
      const needsScroll = el.scrollHeight > el.clientHeight + 1;
      el.classList.toggle('has-scroll', needsScroll);
    });
  };

  renderTeamInto(elTileA, result.a);
  renderTeamInto(elTileB, result.b);

  equalizeProfileMarksTiles();
}

// ========== CORE TRAITS TILE — BULLETED LAYOUT ==========

// bulletizeCoreTile(tileId) Takes a long paragraph from a core back-of-card element, splits it into sentences, and rebuilds it as a vertical bullet list container (optionally keeping a “Breadth Bonus:” line separate).

function bulletizeCoreTile(tileId) {
  const el = document.getElementById(tileId);
  if (!el) return;

  // Don't re-bulletize if we've already done it
  if (el.dataset.bulletized === '1') return;

  const raw = (el.textContent || '').trim();
  if (!raw) return;

  // Optional: keep "Breadth Bonus: ..." as a separate line at the bottom
  let mainText = raw;
  let breadthText = null;

  const bbIndex = raw.indexOf('Breadth Bonus:');
  if (bbIndex !== -1) {
    mainText = raw.slice(0, bbIndex).trim();
    breadthText = raw.slice(bbIndex).trim();
  }

  // Split the main text into sentences
  const sentences = mainText
    .split('.')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (!sentences.length) return;

  // Build the new structure
  const container = document.createElement('div');
  container.className = 'core-back-container';

  const list = document.createElement('ul');
  list.className = 'core-back-list';

  sentences.forEach(sentence => {
    const li = document.createElement('li');
    li.className = 'core-back-item';

    const body = document.createElement('div');
    body.className = 'core-back-text';
    // Put the period back for readability
    body.textContent = sentence.endsWith('.') ? sentence : sentence + '.';

    li.appendChild(body);
    list.appendChild(li);
  });

  container.appendChild(list);

  if (breadthText) {
    const bb = document.createElement('p');
    bb.className = 'core-back-breadth';
    bb.textContent = breadthText;
    container.appendChild(bb);
  }

  // Replace the old paragraph content
  el.textContent = '';
  el.appendChild(container);
  el.dataset.bulletized = '1';
}

function nudgeRoundSelector() {
  const roundBtn = document.getElementById("roundSelectBtn");
  if (!roundBtn) return;

  const wrap = roundBtn.closest(".round-selector-wrap");
  if (!wrap) return;

  wrap.classList.remove("is-nudged"); // reset animation
  void wrap.offsetWidth;              // reflow to restart animation
  wrap.classList.add("is-nudged");

  // auto-clear the class after the pulse finishes
  setTimeout(() => wrap.classList.remove("is-nudged"), 2400);
}

function clearRoundNudge() {
  const roundBtn = document.getElementById("roundSelectBtn");
  const wrap = roundBtn?.closest(".round-selector-wrap");
  if (wrap) wrap.classList.remove("is-nudged");
}

// populateInteractionsHowToList(copy) Populates the “How this works” list in the Interactions explainer tile (#interactionsHowToList) from copy.interactions.howto_items.

function populateInteractionsHowToList(copy) {
  if (!copy || !copy.interactions) return;

  const listEl = document.getElementById('interactionsHowToList');
  if (!listEl) return;

  const items = copy.interactions.howto_items;
  if (!Array.isArray(items) || !items.length) {
    // If nothing is defined, leave whatever is in the HTML (or empty)
    return;
  }

  // Clear any existing items
  listEl.innerHTML = '';

  items.forEach(text => {
    if (!text) return;
    const li = document.createElement('li');
    li.textContent = text;
    listEl.appendChild(li);
  });
}

// buildGlossaryFromCopy(copy) Builds the glossary section from copy.glossary.entries, creating a clean list of glossary items with term, category tag, abbreviation, and definition.

function buildGlossaryFromCopy(copy) {
  const container = document.getElementById('glossaryContent');
  if (!container || !copy || !copy.glossary || !Array.isArray(copy.glossary.entries)) {
    return;
  }

  const entries = copy.glossary.entries;

  // Clear anything that might already be there
  container.innerHTML = '';

  // Build a simple, clean list of items
  entries.forEach(entry => {
    const term = entry.term || '';
    const abbr = entry.abbr || '';
    const category = entry.category || '';
    const definition = entry.definition || '';

    const item = document.createElement('div');
    item.className = 'glossary-item';

    item.innerHTML = `
      <div class="glossary-header-row">
        <span class="glossary-term">${term}</span>
        ${category ? `<span class="glossary-tag">${category}</span>` : ''}
      </div>
      <div class="glossary-meta">
        ${abbr ? `Abbrev: <strong>${abbr}</strong>` : ''}
      </div>
      <p class="glossary-def">${definition}</p>
    `;

    container.appendChild(item);
  });
}

function getCoreExplainKeys(team, copy) {
  const cx = copy && copy.core_explain ? copy.core_explain : {};
  const jsonOrder = Array.isArray(cx.metric_order) ? cx.metric_order.filter(Boolean) : [];

  if (jsonOrder.length) return jsonOrder;

  if (team && Array.isArray(team.coreDetails) && team.coreDetails.length) {
    return team.coreDetails.map(row => row.key).filter(Boolean);
  }

  if (Array.isArray(CORE_KEYS_FOR_EXPLAIN) && CORE_KEYS_FOR_EXPLAIN.length) {
    return CORE_KEYS_FOR_EXPLAIN;
  }

  return [];
}

function getBreadthTierFromValue(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;

  if (v >= 0.135) return 'Elite';
  if (v >= 0.105) return 'Strong';
  if (v >= 0.060) return 'Above Average';
  if (v >= 0.010) return 'Average';
  if (v >= -0.020) return 'Weak';
  return 'Fragile';
}

function getCoreTierForMetric(team, key) {
  if (!team) return null;

  if (key === 'off_breadth') {
    return getBreadthTierFromValue(team.offBreadth);
  }

  if (key === 'def_breadth') {
    return getBreadthTierFromValue(team.defBreadth);
  }

  if (!Array.isArray(team.coreDetails)) return null;
  const row = team.coreDetails.find(r => r && r.key === key);
  return row && row.tier ? row.tier : null;
}

function buildCoreBackTextForTeam(team, copy, variantMap) {
  if (!team || !copy || !copy.core_explain) return '';

  const cx = copy.core_explain;
  const metricsConfig = cx.metrics || {};
  const metricKeys = getCoreExplainKeys(team, copy);

  const sentences = [];

  metricKeys.forEach(key => {
    const cfg = metricsConfig[key];
    if (!cfg) return;

    const tier = getCoreTierForMetric(team, key);
    if (!tier) return;

    const useAlt = !!(
      variantMap &&
      Object.prototype.hasOwnProperty.call(variantMap, key) &&
      variantMap[key]
    );

    const sentence = selectCoreBackSentence(cfg, tier, useAlt);
    if (sentence) {
      sentences.push(sentence);
    }
  });

  if (!sentences.length) {
    const fallback =
      cx.fallback_template ||
      '{{team}} shows a generally balanced cross-domain profile.';
    return fallback.replace('{{team}}', team.name || 'This team');
  }

  let paragraph = sentences.join(' ');
  if (cx.paragraph_prefix) {
    const prefix = cx.paragraph_prefix.replace('{{team}}', team.name || 'This team');
    paragraph = prefix + ' ' + paragraph;
  }

  return paragraph.trim();
}

function selectCoreBackSentence(cfg, tier, useAltVariant) {
  if (!cfg || !tier) return '';

  const baseMap = cfg.back_phrases || {};
  const altMap = cfg.back_phrases_alt || {};

  let sentence = '';

  if (useAltVariant && typeof altMap[tier] === 'string') {
    const trimmed = altMap[tier].trim();
    if (trimmed) sentence = trimmed;
  }

  if (!sentence && typeof baseMap[tier] === 'string') {
    sentence = baseMap[tier];
  }

  if (!sentence && cfg.phrases && typeof cfg.phrases[tier] === 'string') {
    sentence = cfg.phrases[tier];
    if (!/[.!?]\s*$/.test(sentence)) {
      sentence += '.';
    }
  }

  return sentence;
}

function buildCoreBackItemsForTeam(team, copy, variantMap) {
  if (!team || !copy || !copy.core_explain) return [];

  const cx = copy.core_explain;
  const metricsConfig = cx.metrics || {};
  const metricKeys = getCoreExplainKeys(team, copy);

  const items = [];

  metricKeys.forEach(key => {
    const cfg = metricsConfig[key];
    if (!cfg) return;

    const tier = getCoreTierForMetric(team, key);
    if (!tier) return;

    let label = cfg.label || key;

    if (Array.isArray(team.coreDetails)) {
      const row = team.coreDetails.find(r => r && r.key === key);
      if (row && row.label) {
        label = row.label;
      }
    }

    const useAlt = !!(
      variantMap &&
      Object.prototype.hasOwnProperty.call(variantMap, key) &&
      variantMap[key]
    );

    let text = selectCoreBackSentence(cfg, tier, useAlt);

    if (!text) {
      const baseMap = cfg.phrases || {};
      text = (baseMap[tier] || '').trim();
    }

    if (!text) return;

    if (!/[.!?]\s*$/.test(text)) {
      text += '.';
    }

    items.push({
      key,
      label,
      tier,
      text
    });
  });

  return items;
}

function getMiEfficiencyBand(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 'neutral';

  if (v >= 0.75) return 'strong_positive';
  if (v >= 0.15) return 'positive';
  if (v <= -0.75) return 'strong_negative';
  if (v <= -0.15) return 'negative';
  return 'neutral';
}

function buildMiEfficiencyBackItemsForTeam(team, copy) {
  const cfg = copy && copy.mi_efficiency_explain ? copy.mi_efficiency_explain : null;
  if (!team || !cfg || !cfg.metrics) return [];

  const defs = [
    {
      key: 'mi_off_eff_base',
      value: team.miOffEffBase,
      fallbackValue: team.mi_off_eff_base
    },
    {
      key: 'mi_def_eff_base',
      value: team.miDefEffBase,
      fallbackValue: team.mi_def_eff_base
    },
    {
      key: 'mi_eff_margin_base',
      value: team.miEffMarginBase,
      fallbackValue: team.mi_eff_margin_base
    }
  ];

  return defs.map(def => {
    const metricCfg = cfg.metrics[def.key];
    if (!metricCfg) return null;

    const rawValue = Number.isFinite(def.value) ? def.value : def.fallbackValue;
    const value = Number.isFinite(rawValue) ? rawValue : 0;
    const band = getMiEfficiencyBand(value);

    return {
      key: def.key,
      label: metricCfg.label || def.key,
      value,
      band,
      text: (metricCfg.bands && metricCfg.bands[band]) || ''
    };
  }).filter(Boolean);
}

function renderCoreBackComposite(containerId, coreItems, effItems, fallbackText, sectionLabel) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';

  const hasCore = Array.isArray(coreItems) && coreItems.length;
  const hasEff = Array.isArray(effItems) && effItems.length;

  if (!hasCore && !hasEff) {
    if (fallbackText) container.textContent = fallbackText;
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'core-back-container';

  if (hasCore) {
    const mainSection = document.createElement('div');
    mainSection.className = 'core-back-main-section';

    const mainLabel = document.createElement('div');
    mainLabel.className = 'core-back-main-label';
    mainLabel.textContent = 'Core Traits Profile';
    mainSection.appendChild(mainLabel);

    const ul = document.createElement('ul');
    ul.className = 'core-back-list';

    coreItems.forEach(item => {
      const li = document.createElement('li');
      li.className = 'core-back-item';
      li.innerHTML = `
        <div class="core-back-header">
          <span class="core-back-metric">${item.label}</span>
          <span class="core-back-tier">${item.tier}</span>
        </div>
        <div class="core-back-text">${item.text}</div>
      `;
      ul.appendChild(li);
    });

    mainSection.appendChild(ul);
    wrap.appendChild(mainSection);
  }

  if (hasEff) {
    const effWrap = document.createElement('div');
    effWrap.className = 'core-back-eff-section';

    const effLabel = document.createElement('div');
    effLabel.className = 'core-back-eff-label';
    effLabel.textContent = sectionLabel || 'MI Efficiency Metrics';
    effWrap.appendChild(effLabel);

    const effList = document.createElement('ul');
    effList.className = 'core-back-list core-back-eff-list';

    effItems.forEach(item => {
      const li = document.createElement('li');
      li.className = 'core-back-item core-back-eff-item';
      li.setAttribute('data-band', item.band);
      li.innerHTML = `
        <div class="core-back-header">
          <span class="core-back-metric">${item.label}</span>
        </div>
        <div class="core-back-text">${item.text}</div>
      `;
      effList.appendChild(li);
    });

    effWrap.appendChild(effList);
    wrap.appendChild(effWrap);
  }

  container.appendChild(wrap);
}

function pickCoreSupportPhraseKey(team) {
  const rows = Array.isArray(team?.coreDomainDetails) ? team.coreDomainDetails : [];
  if (!rows.length) return 'balanced';

  const vals = rows
    .map(row => row && typeof row.value === 'number' ? row.value : null)
    .filter(v => Number.isFinite(v));

  if (!vals.length) return 'balanced';

  const eliteCount = vals.filter(v => v >= 1.0).length;
  const strongCount = vals.filter(v => v >= 0.8 && v < 1.0).length;

  const worst = Math.min(...vals);
  const best = Math.max(...vals);

  if (eliteCount >= 2) return 'two_plus_elite';
  if (eliteCount >= 1 && (eliteCount + strongCount) >= 3) return 'one_elite_plus_depth';
  if ((best - worst) >= 1.5) return 'polarized';
  return 'balanced';
}

function buildCoreVariantMaps(result, copy) {
  const cx = copy.core_explain;
  const metricsConfig = cx.metrics || {};
  const metricKeys = getCoreExplainKeys(result?.a, copy);

  const variantsA = {};
  const variantsB = {};

  metricKeys.forEach(key => {
    const cfg = metricsConfig[key];
    if (!cfg) return;

    const tierA = getCoreTierForMetric(result.a, key);
    const tierB = getCoreTierForMetric(result.b, key);
    if (!tierA || !tierB) return;

    if (tierA !== tierB) return;

    const altMap = cfg.back_phrases_alt || {};
    const alt = typeof altMap[tierA] === 'string' ? altMap[tierA].trim() : '';

    if (!alt) return;

    variantsA[key] = false;
    variantsB[key] = true;
  });

  return { variantsA, variantsB };
}

function updateCoreBacksForResult(result) {
  const copy = window.MI_COPY;
  if (!copy || !copy.core_explain || !result || !result.a || !result.b) return;

  const { variantsA, variantsB } = buildCoreVariantMaps(result, copy);

  const textA = buildCoreBackTextForTeam(result.a, copy, variantsA);
  const textB = buildCoreBackTextForTeam(result.b, copy, variantsB);

  const cardBackA = document.getElementById('backCoreA');
  const cardBackB = document.getElementById('backCoreB');

  if (cardBackA) cardBackA.textContent = textA || '';
  if (cardBackB) cardBackB.textContent = textB || '';

  const itemsA = buildCoreBackItemsForTeam(result.a, copy, variantsA);
  const itemsB = buildCoreBackItemsForTeam(result.b, copy, variantsB);

  const effItemsA = buildMiEfficiencyBackItemsForTeam(result.a, copy);
  const effItemsB = buildMiEfficiencyBackItemsForTeam(result.b, copy);

  const sectionLabel =
    (copy.mi_efficiency_explain && copy.mi_efficiency_explain.section_label) ||
    'MI Efficiency Metrics';

  renderCoreBackComposite('backCoreTileA', itemsA, effItemsA, textA, sectionLabel);
  renderCoreBackComposite('backCoreTileB', itemsB, effItemsB, textB, sectionLabel);
}

function buildBreadthBackTextForTeam(team, copy) {
  if (!team || !copy || !copy.breadth_explain) return '';

  const bx = copy.breadth_explain;

  const template =
    bx.template_v2 ||
    bx.template ||
    "{{team}}’s breadth score reflects how evenly its strength is distributed across the eight possession battlefields. Lower dispersion produces stronger balance support, while a more uneven profile lowers breadth.";

  const fallbackTemplate =
    bx.fallback_template_v2 ||
    bx.fallback_template ||
    "{{team}} shows a mixed structural balance profile across the eight possession battlefields.";

  const z = team.internalEffZ || null;
  const breadth =
    (typeof team.breadth === 'number' && Number.isFinite(team.breadth))
      ? team.breadth
      : 0;

  const breadthSD =
    (typeof team.breadthSD === 'number' && Number.isFinite(team.breadthSD))
      ? team.breadthSD
      : null;

  if (!z) {
    return fallbackTemplate
      .replace('{{team}}', team.name || 'This team')
      .replace('{{breadth}}', fmt(breadth, 3))
      .replace('{{breadth_sd}}', fmt(breadthSD ?? 0, 3));
  }

  const driverRows = [
    { key: 'orb',      label: 'offensive rebounding',            value: z.orb },
    { key: 'efg',      label: 'shot-making efficiency',          value: z.efg },
    { key: 'to_inv',   label: 'turnover avoidance',              value: z.to_inv },
    { key: 'ftr',      label: 'free-throw pressure',             value: z.ftr },
    { key: 'def_efg',  label: 'opponent shot suppression',       value: z.def_efg },
    { key: 'drb',      label: 'defensive rebounding',            value: z.drb },
    { key: 'opp_to',   label: 'turnover creation',               value: z.opp_to },
    { key: 'opp_ftr',  label: 'foul-discipline defense',         value: z.opp_ftr }
  ];

  const finiteRows = driverRows.filter(row =>
    typeof row.value === 'number' && Number.isFinite(row.value)
  );

  if (!finiteRows.length) {
    return fallbackTemplate
      .replace('{{team}}', team.name || 'This team')
      .replace('{{breadth}}', fmt(breadth, 3))
      .replace('{{breadth_sd}}', fmt(breadthSD ?? 0, 3));
  }

  const positiveRows = finiteRows
    .filter(row => row.value > 0)
    .sort((a, b) => b.value - a.value);

  const negativeRows = finiteRows
    .filter(row => row.value <= 0)
    .sort((a, b) => a.value - b.value);

  const balanceBand =
    breadth >= 0.22 ? 'high' :
    breadth >= 0.12 ? 'good' :
    breadth >= 0.02 ? 'mixed' :
    breadth >= -0.06 ? 'narrow' :
    'volatile';

  const supportText =
    (bx.support_phrases && bx.support_phrases[balanceBand]) ||
    '';

  const topSupport = positiveRows.slice(0, 3).map(row => row.label);
  const topLeak = negativeRows.slice(0, 2).map(row => row.label);

  const joinNatural = (items) => {
    if (!items || !items.length) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
  };

  const summary =
    topSupport.length
      ? `support from ${joinNatural(topSupport)}`
      : 'an otherwise uneven profile';

  const caution =
    topLeak.length
      ? `The profile is less stable where it gives back ground in ${joinNatural(topLeak)}.`
      : '';

  let text = template
    .replace('{{team}}', team.name || 'This team')
    .replace('{{summary}}', summary)
    .replace('{{breadth}}', fmt(breadth, 3))
    .replace('{{breadth_sd}}', fmt(breadthSD ?? 0, 3))
    .replace('{{balance_band}}', balanceBand);

  if (supportText) {
    if (!/[.!?]\s*$/.test(text)) text += '.';
    text += ' ' + supportText;
  }

  if (caution) {
    if (!/[.!?]\s*$/.test(text)) text += '.';
    text += ' ' + caution;
  }

  return text;
}

// needs to be updated
function pickBreadthSupportKey(totalHits) {
  const hits = Number.isFinite(totalHits) ? totalHits : 0;

  if (hits >= 4) return 'high';
  if (hits >= 2) return 'medium';
  if (hits >= 1) return 'low';
  return 'none';
}

// need to update
function updateBreadthBacksForResult(result) {
  const copy = window.MI_COPY;
  if (!copy || !copy.breadth_explain || !result || !result.a || !result.b) return;

  const textA = buildBreadthBackTextForTeam(result.a, copy);
  const textB = buildBreadthBackTextForTeam(result.b, copy);

  const elA = document.getElementById('backBreadthA');
  const elB = document.getElementById('backBreadthB');

  if (elA) elA.textContent = textA || '';
  if (elB) elB.textContent = textB || '';
}

function buildResumeBackTextForTeam(team, copy) {
  if (!team || !copy || !copy.resume_explain) return '';

  const rx = copy.resume_explain;

  const tier = team.resumeTier || 'Average';
  const rIndex = (typeof team.resumeIndex === 'number' && Number.isFinite(team.resumeIndex))
    ? team.resumeIndex
    : 0;

  const baseTrust = (typeof team.resumeBaseTrust === 'number' && Number.isFinite(team.resumeBaseTrust))
    ? team.resumeBaseTrust
    : 1.00;

  const isPositive = baseTrust >= 1.00;

  const template =
    (isPositive ? rx.template_positive : rx.template_negative) ||
    rx.fallback_template ||
    "{{team}} shows a roughly average résumé once record and schedule are blended together.";

  const recordPhrase =
    rx.record_phrases && rx.record_phrases[tier]
      ? rx.record_phrases[tier]
      : '';

  const schedulePhrase =
    rx.schedule_phrases && rx.schedule_phrases[tier]
      ? rx.schedule_phrases[tier]
      : '';

  const impactPhrase =
    rx.impact_phrases && rx.impact_phrases[tier]
      ? rx.impact_phrases[tier]
      : '';

  // If we somehow have nothing résumé-specific to say, fall back to generic
  if (!recordPhrase && !schedulePhrase && !impactPhrase) {
    return (rx.fallback_template || "{{team}} shows a roughly average résumé once record and schedule are blended together.")
      .replace('{{team}}', team.name || 'This team')
      .replace('{{tier}}', tier)
      .replace('{{resume_index}}', fmt(rIndex, 3))
      .replace('{{resume_trust}}', fmt(baseTrust, 3));
  }

  return template
    .replace('{{team}}', team.name || 'This team')
    .replace('{{tier}}', tier)
    .replace('{{record}}', recordPhrase)
    .replace('{{schedule}}', schedulePhrase)
    .replace('{{impact}}', impactPhrase)
    .replace('{{resume_index}}', fmt(rIndex, 3))
    .replace('{{resume_trust}}', fmt(baseTrust, 3));
}

function updateResumeBacksForResult(result) {
  const copy = window.MI_COPY;
  if (!copy || !copy.resume_explain || !result || !result.a || !result.b) return;

  const textA = buildResumeBackTextForTeam(result.a, copy);
  const textB = buildResumeBackTextForTeam(result.b, copy);

  const elA = document.getElementById('backResumeA');
  const elB = document.getElementById('backResumeB');

  if (elA && textA) elA.textContent = textA;
  if (elB && textB) elB.textContent = textB;
}

// ========== PROFILE MARKS EXPLANATION (from profileMarks + copy.json) ==========

function parseProfileMark(markStr) {
  // Expects strings like "Soft Interior — Severe"
  if (!markStr || typeof markStr !== 'string') return null;
  const parts = markStr.split('—');
  const base = parts[0] ? parts[0].trim() : '';
  const severity = parts[1] ? parts[1].trim() : 'Moderate';
  if (!base) return null;
  return { base, severity };
}

function niceList(names) {
  if (!names || !names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const allButLast = names.slice(0, -1);
  const last = names[names.length - 1];
  return `${allButLast.join(', ')}, and ${last}`;
}

function buildFormulaBackTextForSide(side, result, copy) {
  const team = side === 'A' ? result.a : result.b;
  if (!team || !result) return '';

  const tpl =
    (copy && copy.formula_explain && copy.formula_explain.template_v2) ||
    (copy && copy.formula_explain && copy.formula_explain.template) ||
    "Team Total ({{total}}) = MI Base ({{mi_base}}) + Matchup Interactions ({{interactions}}). MI Base now starts with Foundation ({{foundation}}), which is the team’s internal MI Efficiency Margin, and Breadth ({{breadth}}), which rewards balance across the eight possession battlefields. Those combine into Raw Base ({{raw_base}}). Raw Base is then calibrated by Résumé Base Trust ({{resume_base_trust}}) toward the field mean baseline ({{field_mean_base}}).";

  const foundation =
    (typeof team.foundation === 'number' && Number.isFinite(team.foundation))
      ? team.foundation
      : ((typeof team.mi_eff_margin === 'number' && Number.isFinite(team.mi_eff_margin))
          ? team.mi_eff_margin
          : 0);

  const breadth =
    (typeof team.breadth === 'number' && Number.isFinite(team.breadth))
      ? team.breadth
      : 0;

  const rawBase =
    (typeof team.raw_base === 'number' && Number.isFinite(team.raw_base))
      ? team.raw_base
      : (foundation + breadth);

  const resumeBaseTrust =
    (typeof team.resumeBaseTrust === 'number' && Number.isFinite(team.resumeBaseTrust))
      ? team.resumeBaseTrust
      : 1.00;

  const fieldMeanBase =
    (typeof team.field_mean_base === 'number' && Number.isFinite(team.field_mean_base))
      ? team.field_mean_base
      : (typeof result?.v2?.fieldMean === 'number' && Number.isFinite(result.v2.fieldMean)
          ? result.v2.fieldMean
          : rawBase);

  const miBase =
    (typeof team.mi_base === 'number' && Number.isFinite(team.mi_base))
      ? team.mi_base
      : ((resumeBaseTrust * rawBase) + ((1 - resumeBaseTrust) * fieldMeanBase));

  const total =
    side === 'A'
      ? (result.miA_raw ?? result.miA ?? 0)
      : (result.miB_raw ?? result.miB ?? 0);

  const interactions =
    side === 'A'
      ? ((typeof result.intA === 'number' && Number.isFinite(result.intA))
          ? result.intA
          : (result.interactions?.a ?? 0))
      : ((typeof result.intB === 'number' && Number.isFinite(result.intB))
          ? result.intB
          : (result.interactions?.b ?? 0));

  return miFillTemplate(tpl, {
    total: fmt(total, 3),
    mi_base: fmt(miBase, 3),
    foundation: fmt(foundation, 3),
    breadth: fmt(breadth, 3),
    raw_base: fmt(rawBase, 3),
    resume_base_trust: fmt(resumeBaseTrust, 3),
    field_mean_base: fmt(fieldMeanBase, 3),
    interactions: fmt(interactions, 3),

    // new explicit V4 baseline pieces
    mi_off_eff: fmt(
      (typeof team.mi_off_eff === 'number' && Number.isFinite(team.mi_off_eff)) ? team.mi_off_eff : 0,
      3
    ),
    mi_def_eff: fmt(
      (typeof team.mi_def_eff === 'number' && Number.isFinite(team.mi_def_eff)) ? team.mi_def_eff : 0,
      3
    ),
    mi_eff_margin: fmt(
      (typeof team.mi_eff_margin === 'number' && Number.isFinite(team.mi_eff_margin)) ? team.mi_eff_margin : foundation,
      3
    ),
    breadth_sd: fmt(
      (typeof team.breadthSD === 'number' && Number.isFinite(team.breadthSD)) ? team.breadthSD : 0,
      3
    ),

    // legacy placeholder preserved so old template tokens do not break hard
    identity_edge: fmt(0, 3)
  });
}

function updateFormulaBacksForResult(result) {
  const copy = window.MI_COPY;
  if (!copy || !result) return;

  const elA = document.getElementById('backFormulaA');
  const elB = document.getElementById('backFormulaB');

  if (elA) elA.textContent = buildFormulaBackTextForSide('A', result, copy) || '';
  if (elB) elB.textContent = buildFormulaBackTextForSide('B', result, copy) || '';
}

function updateIdentityBacksForResult(result) {
  const copy = window.MI_COPY;
  if (!copy || !copy.identity_explain || !result || !result.a || !result.b) return;

  const roundCode = result.round || CURRENT_ROUND || "R64";

  const buildTeam = (team, opponent) => {
    // Force: the team we're building is always A in the resolver.
    const ctx = resolveIdentityContext(team, opponent, roundCode);

    // Single source of truth from resolver:
    const myMetric = ctx.metricA;  // "CIS" | "FAS" | "LCI" | "LFI"
    const myValue  = ctx.valueA;   // expected 0..100

    return {
      name: team.name,
      identityPacket: {
        metric: myMetric,
        value: myValue
      }
    };
  };

  const aObj = buildTeam(result.a, result.b);
  const bObj = buildTeam(result.b, result.a);

  const elA = document.getElementById('backIdentityA');
  const elB = document.getElementById('backIdentityB');

  if (elA) elA.textContent = buildIdentityBackTextForTeam(aObj, copy) || '';
  if (elB) elB.textContent = buildIdentityBackTextForTeam(bObj, copy) || '';
}

// ========== IDENTITY — BACK-OF-CARD BUILDER ==========
//
// Pulls CIS/FAS static identity, determines band, selects the appropriate
// template from copy.identity_explain, fills placeholders, and returns a
// final back-of-card explanation string.
//
function miClamp01to100(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, x));
}

function miIdentityBucketKey(value0to100) {
  const v = miClamp01to100(value0to100);
  if (v <= 25) return "b0_25";
  if (v <= 50) return "b26_50";
  if (v <= 85) return "b51_85";
  return "b86_100";
}

function miFillTeamToken(text, teamName) {
  const name = teamName || "This team";
  return String(text || "").replaceAll("{{team}}", name);
}

function getMITierKeyForRating(rating) {
  if (rating == null || isNaN(rating)) return 'Balanced';

  if (rating >= 90) return 'Top';
  if (rating >= 75) return 'High';
  if (rating >= 60) return 'Solid';
  if (rating >= 40) return 'Balanced';
  if (rating >= 25) return 'Low';
  return 'Fragile';
}

function buildIdentityBackTextForTeam(team, copy) {
  // New v3.8+ identity back builder:
  // Uses resolveIdentityContext output via team.identityPacket:
  // { metric: "CIS"|"FAS"|"LCI"|"LFI", value: 0..100 }
  if (!team || !copy || !copy.identity_explain) return "";

  const pkt = team.identityPacket || {};
  const metric = pkt.metric;
  const value = miClamp01to100(pkt.value);

  // Generic fallback if metric missing or invalid
  const fallback = "{{team}} has no clear identity signal in this matchup.";

  // If metric is missing/unknown, return fallback (token-filled)
  const group = copy.identity_explain?.[metric];
  if (!group) return miFillTeamToken(fallback, team.name);

  const bucketKey = miIdentityBucketKey(value);
  const entry = group?.[bucketKey];
  const text = entry?.text;

  if (!text) return miFillTeamToken(fallback, team.name);
  return miFillTeamToken(text, team.name).trim();
}

// ---------- Madness Index Back-of-Card Explanation ----------

function buildMadnessBackTextForTeam(side, result, copy, roleMode) {
  if (!copy || !copy.madness_explain || !result) return '';

  const cfg = copy.madness_explain;

  const team  = side === 'A' ? result.a   : result.b;
  const mi    = side === 'A' ? result.miA : result.miB;
  const diff  = (result.miA ?? 0) - (result.miB ?? 0);
  const roundCode = result.round || CURRENT_ROUND || 'R64';

  if (!team) return cfg.fallback_template
    ? cfg.fallback_template.replace('{{team}}', 'This team')
    : '';

  // 1) MI tier (from 1–99 cosmetic rating)
  const rating   = typeof team.mi_rating === 'number' ? team.mi_rating : null;
  const tierKey  = getMITierKeyForRating(rating);
  const tierDesc = (cfg.mi_tiers && cfg.mi_tiers[tierKey]) || '';
  const miTierText = tierDesc
    ? `${tierKey} tier — ${tierDesc}`
    : `${tierKey} tier`;

  // 2) Role clause (Favorite / Cinderella / Neutral + optional Auto note)
  let roleKey;
  if (diff === 0) {
    roleKey = 'Neutral';
  } else {
    const isFavoriteByModel = side === 'A' ? diff > 0 : diff < 0;
    roleKey = isFavoriteByModel ? 'Favorite' : 'Cinderella';
  }

  const rolePhrases = cfg.role_phrases || {};
  let roleClause = rolePhrases[roleKey] || '';

  // If Role Mode is Auto, append the Auto clause if present
  if (roleMode === 'auto' && rolePhrases.Auto) {
    roleClause = roleClause
      ? roleClause + ' ' + rolePhrases.Auto
      : rolePhrases.Auto;
  }

  // 3) Gap clause (map existing lean band → gap band)
  let gapKey = 'None';
  if (typeof getLeanBand === 'function') {
    const bandName = getLeanBand(diff) || '';
    const lower = bandName.toLowerCase();

    if (diff === 0) {
      gapKey = 'None';
    } else if (lower.includes('major')) {
      gapKey = 'Major';
    } else if (lower.includes('moderate')) {
      gapKey = 'Moderate';
    } else {
      gapKey = 'Thin';
    }
  }

  const gapClause = (cfg.gap_phrases && cfg.gap_phrases[gapKey]) || '';

  // 4) Round clause
  const roundClause =
    (cfg.round_phrases && cfg.round_phrases[roundCode]) || '';

  // 5) Fill template
  const tpl = cfg.template || cfg.fallback_template || '';
  const text = tpl
    .replace('{{team}}', team.name || 'This team')
    .replace('{{mi_tier}}', miTierText)
    .replace('{{role_clause}}', roleClause)
    .replace('{{gap_clause}}', gapClause)
    .replace('{{round_clause}}', roundClause);

  return text.trim();
}

function updateMadnessBacksForResult(result, copy, roleMode) {
  if (!copy || !copy.madness_explain || !result) return;

  const elA = document.getElementById('backMadnessTileA');
  const elB = document.getElementById('backMadnessTileB');

  if (elA) {
    const textA = buildMadnessBackTextForTeam('A', result, copy, roleMode);
    if (textA) elA.textContent = textA;
  }

  if (elB) {
    const textB = buildMadnessBackTextForTeam('B', result, copy, roleMode);
    if (textB) elB.textContent = textB;
  }
}

function miGetCopy(path, fallback = null) {
  const root = window.MI_COPY || {};
  const parts = String(path).split('.');
  let cur = root;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return fallback;
    cur = cur[p];
  }
  return (cur == null ? fallback : cur);
}

function miFillTemplate(tpl, vars) {
  if (!tpl) return '';
  return String(tpl).replace(/{{\s*([\w]+)\s*}}/g, (_, key) => {
    const v = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
    return (v == null ? '' : String(v));
  });
}

/* =========================================================
   Verdict Copy: random variant selection (stable per matchup)
   ========================================================= */

const __miVerdictCopyCache = new Map();

/** Better random int than Math.random when available */
function miRandInt(n){
  n = Math.floor(Number(n) || 0);
  if (n <= 1) return 0;

  // Prefer crypto for less repetitive patterns
  if (window.crypto && crypto.getRandomValues){
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % n;
  }
  return Math.floor(Math.random() * n);
}

/** Ensure we have an array; if a string is provided, wrap it */
function miAsArray(v){
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/**
 * Safe deep-get for copy.json structures.
 * Uses your existing miGetPath if present; otherwise a minimal fallback.
 */
function miSafeGet(obj, path){
  if (!obj || !path) return undefined;
  if (typeof miGetPath === "function") return miGetPath(obj, path);

  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts){
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Pick a random verdict line from copy pools, but keep it stable for the matchup key.
 *
 * @param {string} cacheKey - unique-ish key for the current matchup render
 * @param {string} pathBase - e.g. "verdict.metrics.primary_text"
 * @param {string} tierKey  - e.g. "tiny_gap" | "small_gap" | ...
 * @returns {string} selected line (or empty string)
 */
function miPickVerdictLine(cacheKey, pathBase, tierKey){
  const cacheId = `${cacheKey}::${pathBase}::${tierKey}`;

  // Stable per matchup render
  if (__miVerdictCopyCache.has(cacheId)){
    return __miVerdictCopyCache.get(cacheId) || "";
  }

  const poolsRoot = (window.copy || window.COPY || {});
  const tierPath = `${pathBase}.${tierKey}`;
  const defPath  = `${pathBase}.default`;

  const tierPool = miAsArray(miSafeGet(poolsRoot, tierPath));
  const defPool  = miAsArray(miSafeGet(poolsRoot, defPath));

  const pool = tierPool.length ? tierPool : defPool;
  const picked = pool.length ? pool[miRandInt(pool.length)] : "";

  __miVerdictCopyCache.set(cacheId, picked || "");
  return picked || "";
}

/**
 * Optional: call this if you want new random lines when the user changes the matchup.
 * (Most builds won’t need this because cacheKey should change per matchup.)
 */
function miClearVerdictCopyCache(){
  __miVerdictCopyCache.clear();
}

// ========== SEED / BRACKET LOGIC HELPERS ==========
//
// We treat seeds 1–16 as if they belong to the standard NCAA region structure:
//
//  Pod A (top-top):    {1, 16, 8, 9}
//  Pod B (top-bottom): {5, 12, 4, 13}
//  Pod C (bot-top):    {6, 11, 3, 14}
//  Pod D (bot-bottom): {7, 10, 2, 15}
//
// Within a single region, two seeds have a uniquely-defined meeting round:
//   - R64: same first-round game
//   - R32: same pod but not direct R64
//   - S16: different pods, same half (A↔B or C↔D)
//   - E8:  different halves (A/B vs C/D)
//
// Across different regions, any pair of seeds can only meet in:
//   - Final Four (F4)
//   - Championship (Champ)
//
// For *distinct* seeds, both "same region" and "different region" layouts
// are possible across different years, so the possible rounds are:
//   { intra-region round } ∪ { F4, Champ }.
// For *equal* seeds (e.g., 1 vs 1), they can never share a region
// (only one #1 per region), so only { F4, Champ } are possible.

const R64_PAIRINGS = [
  [1, 16], [8, 9],
  [5, 12], [4, 13],
  [6, 11], [3, 14],
  [7, 10], [2, 15],
];

// Map seed → pod label
function getSeedPod(seed) {
  const s = Number(seed);
  if ([1, 16, 8, 9].includes(s))  return 'A'; // top-top
  if ([5, 12, 4, 13].includes(s)) return 'B'; // top-bottom
  if ([6, 11, 3, 14].includes(s)) return 'C'; // bottom-top
  if ([7, 10, 2, 15].includes(s)) return 'D'; // bottom-bottom
  return null;
}

// Pod → half of region
function getPodHalf(pod) {
  if (pod === 'A' || pod === 'B') return 'top';
  if (pod === 'C' || pod === 'D') return 'bottom';
  return null;
}

// Are these seeds a direct Round of 64 game?
function isFirstRoundPair(seedA, seedB) {
  const a = Number(seedA);
  const b = Number(seedB);
  return R64_PAIRINGS.some(([x, y]) =>
    (a === x && b === y) || (a === y && b === x)
  );
}

// If two seeds were placed in the *same region*,
// what is the unique round where they would meet?
function getIntraRegionRound(seedA, seedB) {
  const a = Number(seedA);
  const b = Number(seedB);

  // Same seed cannot share a region (one slot per seed per region)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;

  const podA = getSeedPod(a);
  const podB = getSeedPod(b);
  if (!podA || !podB) return null;

  if (isFirstRoundPair(a, b)) return 'R64';

  if (podA === podB) return 'R32';

  const halfA = getPodHalf(podA);
  const halfB = getPodHalf(podB);

  if (halfA && halfB && halfA === halfB) return 'S16';

  // Different halves of the same region
  return 'E8';
}

// Global order for sorting rounds
const ROUND_ORDER = ['R64', 'R32', 'S16', 'E8', 'First4', 'F4', 'Champ'];

function isFirstFourSeedPlayIn(seedA, seedB) {
  const a = Number(seedA);
  const b = Number(seedB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a === b && (a === 11 || a === 16);
}

// All possible rounds this *pair of seeds* can meet in,
// across all valid bracket layouts (same region vs different region).
function getPossibleRoundsForSeeds(seedA, seedB) {
  const a = Number(seedA);
  const b = Number(seedB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];

  const possible = new Set();

  // Canonical First Four play-ins:
  // two 11-seeds or two 16-seeds may meet in the First Four,
  // and can also still legally meet cross-region in F4 / Champ.
  if (isFirstFourSeedPlayIn(a, b)) {
    possible.add('First4');
    possible.add('F4');
    possible.add('Champ');

    return Array.from(possible).sort((r1, r2) =>
      ROUND_ORDER.indexOf(r1) - ROUND_ORDER.indexOf(r2)
    );
  }

  if (a !== b) {
    const intra = getIntraRegionRound(a, b);
    if (intra) possible.add(intra);
  }

  // Cross-region possibilities (any pair can be separated across regions)
  possible.add('F4');
  possible.add('Champ');

  // Return sorted by natural tournament order
  return Array.from(possible).sort((r1, r2) =>
    ROUND_ORDER.indexOf(r1) - ROUND_ORDER.indexOf(r2)
  );
}

// Convenience wrapper for checking a specific round
function isRoundPossibleForSeeds(seedA, seedB, roundCode) {
  const possible = getPossibleRoundsForSeeds(seedA, seedB);
  return possible.includes(roundCode);
}

// Build a small descriptor we can attach to the matchup result
function getSeedRoundMeta(seedA, seedB, roundCode) {
  const a = Number(seedA);
  const b = Number(seedB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  const possible = getPossibleRoundsForSeeds(a, b);
  const isAllowed = possible.includes(roundCode);
  const earliest = possible.length
    ? possible[0]
    : null;

  return {
    seedA: a,
    seedB: b,
    possible,    // e.g. ['First4','F4','Champ']
    isAllowed,   // true if current round is compatible with these seeds
    earliest,    // earliest possible round in standard bracket order
  };
}

// Build a small descriptor we can attach to the matchup result
function getSeedRoundMeta(seedA, seedB, roundCode) {
  const a = Number(seedA);
  const b = Number(seedB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  const possible = getPossibleRoundsForSeeds(a, b);
  const isAllowed = possible.includes(roundCode);
  const earliest = possible.length
    ? possible[0]
    : null;

  return {
    seedA: a,
    seedB: b,
    possible,    // e.g. ['R32','F4','Champ']
    isAllowed,   // true if current round is compatible with these seeds
    earliest,    // earliest possible round in standard bracket order
  };
}

// Round pill (Matchup Bar) — JSON-canonical, round-aware
function miUpdateMatchupRoundPill(roundCode) {
  const el = document.getElementById('matchupRoundPill');
  if (!el) return;

  const r = miNormalizeRoundCode(roundCode);

  const copy = window.MI_COPY || {};
  const roundLabels = copy.rounds || {};

  // Deterministic lookup with safe fallback
  const label = roundLabels[r] || 'Round';

  el.textContent = label;

  // Debug / state hook (optional but useful)
  el.setAttribute('data-round', r);
}

// Allows flexible CSV headers while mapping into canonical keys.
const ALIASES = {
  team: ['Team','TEAM','team','School','Team Name','TeamName','Team_Name','School Name','SchoolName','School_Name'],
  seed: ['Seed', 'seed'],
  ts: ['TS', 'TS%', 'ts', 'TS_pct', 'True Shooting %'],
  efg: ['eFG', 'eFG%', 'efg'],
  tempo: ['Tempo', 'tempo', 'Pace'],
  epr: ['EPR', 'epr', 'Effective Possession Ratio'],
  to: ['TO%', 'TOV%', 'to', 'to_pct', 'TO_pct', 'TO pct'],

  // Resume / SOS
  wp: ['Win%', 'Win Pct', 'Win Percentage', 'WPCT', 'W-L%'],
  sos: ['SOS', 'sos', 'Sos'],
  cgw: ['CGW%', 'CGW_pct', 'CGW pct', 'Close Game Win %'],
  q1w: ['Q1W', 'Q1 W'],
  q1l: ['Q1L', 'Q1 L'],
  q2w: ['Q2W', 'Q2 W'],
  q2l: ['Q2L', 'Q2 L'],
  q3w: ['Q3W', 'Q3 W'],
  q3l: ['Q3L', 'Q3 L'],
  q4w: ['Q4W', 'Q4 W'],
  q4l: ['Q4L', 'Q4 L'],

  // Shooting / FT / distribution
  threepr: ['3P Rate', '3P_Rate', '3PR', '3P_Att_Rate', '3PAr'],
  threepp: ['3P%', '3P', '3P_pct', '3P_Pct'],
  pct_pts_3: ['%Pts3', '%Pts from 3', 'PctPts3', '% of Points from 3'],
  pct_pts_2: ['%Pts2', '%Pts from 2', 'PctPts2', '% of Points from 2'],
  pct_pts_ft: ['%PtsFT', '%Pts from FT', 'PctPtsFT', '% of Points from FT'],
  ft_pct: ['FT%', 'FT', 'FT_pct'],

  // Opponent / defensive shooting
  opp_3pr: ['Opp3PR', 'Opp 3P Rate', 'Opp3P_Rate'],
  opp_3pp: ['Opp3P%', 'Opp 3P%', 'Opp. 3PT%', 'Opp. 3PT pct'],
  def_efg: ['Def. eFG %', 'DEFG%', 'Opp eFG%', 'Opp eFG', 'Def. eFG_pct', 'Def. eFG pct'],
  opp_2p_pct: ['Opp2P%', 'Opp 2P%'],
  oapp: ['Opp. Asst./Poss.', 'Opp Asst/Poss',],
  opp_ast_poss: ['Opp. Asst./Poss.', 'Opp Asst/Poss', 'Opp AST/Poss', 'OppAstPoss'],

  // Foul / FT rate
  ftr: ['FTR', 'FT Rate', 'FTr'],
  opp_ftr: ['OppFTR', 'Opp FTR', 'Opp FT Rate'],

  // Paint & rim
  nb2: ['NB2', 'NB2%', 'NonBlock2%', 'NonBlock2P%'],
  blk: ['BLK%', 'Blk%', 'BLK', 'Block%'],

  // Turnover / pressure
  spp: ['SPP', 'StlPoss', 'Steals/poss', 'Stl%'],
  otpp: ['OTPP', 'OppTOPoss', 'Opp TO/poss', 'Opp TOV%'],

  // Rebounding / extra chances
  orb: ['ORB%', 'OR%', 'ORB'],
  drb: ['DRB%', 'DR%', 'DRB'],
  scpg: ['SCPG', 'ExtraChances', '2ndChance', '2nd Chance', 'Extra Scoring Chances/game'],

};

// Helper: normalize percent-like numbers to 0–1 range
function normalizePercentMaybe(v) {
  if (v == null || isNaN(v)) return v;
  if (v > 1.0001 && v <= 100.0) return v / 100.0;
  return v;
}

// Metrics that require field stats for z-scoring
const METRICS_FOR_Z = [
  'ts', 'efg', 'tempo', 'epr', 'to',
  'threepr', 'threepp', 'pct_pts_3', 'pct_pts_2', 'pct_pts_ft',
  'opp_3pr', 'opp_3pp', 'ftr', 'opp_ftr', 'ft_pct',
  'nb2', 'def_efg', 'blk',
  'spp', 'otpp', 'opp_ast_poss',
  'orb', 'drb', 'scpg',
];

// ---------- Utility Functions ----------

function findHeaderIndex(headers, candidates) {
  for (const name of candidates) {
    const idx = headers.findIndex(h => h.trim().toLowerCase() === name.trim().toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function getValue(row, headers, key) {
  const aliases = ALIASES[key];
  if (!aliases) return null;
  const idx = findHeaderIndex(headers, aliases);
  if (idx === -1) return null;
  const raw = row[idx];
  if (raw === undefined || raw === null || raw === '') return null;
  const v = parseFloat(raw);
  return isNaN(v) ? null : v;
}

function computeMean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computeSD(arr, mean) {
  if (!arr.length) return 0;
  const v = arr.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / arr.length;
  return Math.sqrt(v);
}

function zScore(val, mean, sd) {
  if (val === null || val === undefined || sd === 0) return 0;
  return (val - mean) / sd;
}

// Defensive orientation: convert "lower is better" into "higher is better" BEFORE z-scoring
function orientAndZ(team, key, orientation = 'normal') {
  const fs = FIELD_STATS[key];
  if (!fs) return 0;
  let v = team[key];
  if (v === null || v === undefined) return 0;

  if (orientation === 'invert') {
    // For things like DefEff, TO%, Opp eFG% etc. when we store raw values
    v = fs.mean * 2 - v; // simple reflection around mean (works since we only need monotonic inversion)
  }

  return zScore(v, fs.mean, fs.sd);
}

// Helper: safe z on arbitrary metric with control over inversion
function getZ(team, key, inverted = false) {
  const fs = FIELD_STATS[key];
  if (!fs) return 0;
  const v = team[key];
  if (v === null || v === undefined) return 0;
  const val = inverted ? (fs.mean * 2 - v) : v;
  return zScore(val, fs.mean, fs.sd);
}

// v3.2 unified tier table
function getTierPointsFromZ(z) {
  if (z >= 1.00) return 2.0;                  // Elite
  if (z >= 0.80) return 1.5;                  // Strong
  if (z >= 0.60) return 1.0;                  // Above Average
  if (z >= 0.00) return 0.5;                  // Average
  if (z >= -0.80) return 0.0;                 // Weak
  return 0.0;                                 // Fragile (z < -0.80)
}

// Tier labels for UI only (same ranges as tier points)
function getTierLabelFromZ(z) {
  if (z >= 1.00) return 'Elite';
  if (z >= 0.80) return 'Strong';
  if (z >= 0.60) return 'Above Average';
  if (z >= 0.00) return 'Average';
  if (z >= -0.80) return 'Weak';
  return 'Fragile';
}

function getCoreFieldSpreadText(rowKey) {
  const fs = FIELD_STATS_DOMAIN?.[rowKey];
  const sd = fs && Number.isFinite(fs.sd) ? fs.sd : null;

  return `
    <div class="threshold-stack">
      <span class="threshold-chip" title="Standard deviation of the domain across the tournament field. Domain means are approximately 0 because values are standardized using z-scores.">
        σ ${sd == null ? '—' : fmt(sd, 3)}
      </span>
    </div>
  `;
}

function updateInteractionHeadersFromSelections() {
  const selectA = document.getElementById('teamA');
  const selectB = document.getElementById('teamB');
  const adjAHeader = document.getElementById('adjAHeader');
  const adjBHeader = document.getElementById('adjBHeader');

  const aTeam = selectA?.value ? getTeamByName(selectA.value) : null;
  const bTeam = selectB?.value ? getTeamByName(selectB.value) : null;

  if (adjAHeader) adjAHeader.textContent = `Adj to ${aTeam?.name || 'Team A'}`;
  if (adjBHeader) adjBHeader.textContent = `Adj to ${bTeam?.name || 'Team B'}`;
}

// ---------- CSV Parsing & Initialization ----------
function parseCSV(text) {
  // Strip BOM if present
  if (text && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let cur = '', row = [], inQuotes = false;

  const pushCell = () => {
    // Unwrap quotes, unescape ""
    row.push(cur.replace(/^"(.*)"$/s, '$1').replace(/""/g, '"').trim());
    cur = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      pushCell();
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushCell();
      rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }
  if (cur.length || row.length) { pushCell(); rows.push(row); }

  const headers = (rows.shift() || []).map(h => h.trim());
  return { headers, rows };
}

function detectTeamNameIndex(headers, rows) {
  // 1) Try exact alias matches (case-insensitive)
  const aliasIdx = findHeaderIndex(headers, ALIASES.team || ['Team']);
  if (aliasIdx !== -1) return aliasIdx;

  // 2) Try loose regex match on header text
  //    (covers things like "Team Name", "School (D1)", "TEAM/SCHOOL", etc.)
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || '').toLowerCase().replace(/[\s_\-\/().]+/g, '');
    if (h.includes('team') || h.includes('school')) return i;
  }

  // 3) Heuristic: pick the column that looks most like names in first 30 rows
  const sampleN = Math.min(rows.length, 30);
  let bestIdx = -1, bestScore = -1;
  for (let c = 0; c < headers.length; c++) {
    let score = 0;
    for (let r = 0; r < sampleN; r++) {
      const v = (rows[r] && rows[r][c] || '').trim();
      if (!v) continue;
      const hasLetters = /[A-Za-z]/.test(v);
      const looksNumber = /^[\d.\-]+$/.test(v);
      const hasPercent = /%/.test(v);
      // reward typical team-name patterns (letters + spaces, not pure numbers/percents)
      if (hasLetters && !looksNumber && !hasPercent && v.length <= 60) score++;
      // minor bonus if it contains a space (two words like "Saint Mary’s")
      if (/\s/.test(v)) score += 0.25;
    }
    if (score > bestScore) { bestScore = score; bestIdx = c; }
  }
  return bestScore >= 5 ? bestIdx : -1;
}

// Normalize a header (trim, lowercase, strip punctuation/spaces)
// Hardened to remove hidden unicode spaces and normalize percent variants.
function _normHeader(h) {
  return String(h || '')
    // normalize common invisible chars + NBSP
    .replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, ' ')
    // normalize full-width percent to ASCII percent
    .replace(/％/g, '%')
    .trim()
    .toLowerCase()
    // turn % into a real token separator so "3P%" becomes "3p pct"
    .replace(/%/g, ' pct')
    // normalize punctuation/underscores/slashes to spaces
    .replace(/[.\-_/]/g, ' ')
    // collapse spaces
    .replace(/\s+/g, ' ')
    .trim();
}

// EXACT map for the official dataset headers (normalized via _normHeader)
const HEADER_MAP = new Map([
  // identity
  ['team',                       'name'],
  ['seed',                       'seed'],

  // core dataset columns still used
  ['true shooting pct',          'ts'],
  ['efg',                        'efg'],
  ['tempo',                      'tempo'],
  ['effective possession ratio', 'epr'],
  ['to pct',                     'to'],

  // defensive eFG
  ['def efg pct',                'def_efg'],

  // distribution
  ['pct of points from 2',       'pct_pts_2'],
  ['pct of points from 3',       'pct_pts_3'],
  ['pct of points from ft',      'pct_pts_ft'],

  // shooting + rates
  ['3p pct',                     'threepp'],
  ['3p rate',                    'threepr'],
  ['ft',                         'ft_pct'],
  ['ftr',                        'ftr'],

  // extras
  ['extra scoring chances game', 'scpg'],
  ['non blocked 2pt pct',        'nb2'],
  ['orb pct',                    'orb'],
  ['drb pct',                    'drb'],
  ['block pct',                  'blk'],
  ['steals per possession',      'spp'],

  // opponent / defensive shooting
  ['opp 3p pct',                 'opp_3pp'],
  ['opp 3p rate',                'opp_3pr'],
  ['opp asst poss',              'opp_ast_poss'],
  ['opp to poss',                'otpp'],
  ['opp fta fga',                'opp_ftr'],

  // résumé
  ['close game win pct',         'close_win_pct'],
  ['win pct',                    'wp'],
  ['win percentage',             'wp'],
  ['strength of schedule',       'sos'],

  // quadrant records
  ['q1w',                        'q1w'],
  ['q1l',                        'q1l'],
  ['q2w',                        'q2w'],
  ['q2l',                        'q2l'],
  ['q3w',                        'q3w'],
  ['q3l',                        'q3l'],
  ['q4w',                        'q4w'],
  ['q4l',                        'q4l'],
]);

// Build index: CSV header -> internal key
function makeHeaderIndex(headers) {
  const index = {};
  const normed = headers.map(_normHeader);

  normed.forEach((h, i) => {
    const key = HEADER_MAP.get(h);
    if (key) index[key] = i;
  });

  // for sanity: team/name MUST exist
  if (index.name == null) index.name = normed.indexOf('team');

  // store for debugging
  index.__raw = headers;
  index.__norm = normed;
  return index;
}

// Live gain constants (locked “starting constants”)
const MI_IDENTITY_V38 = {
  capC: 98,
  capF: 98,
  gammaC: 1.08,
  gammaF: 1.10,
  kF: 0.55,
  kC: 0.90
};

function buildTeamsFromCSV(headers, rows) {
  const H = makeHeaderIndex(headers);

  function getNum(row, key) {
    const i = H[key];
    if (i == null || i < 0) return null;
    let v = row[i];
    if (v == null || v === '') return null;
    if (typeof v === 'string') v = v.replace(/,/g,'').trim();
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function getStr(row, key) {
    const i = H[key];
    if (i == null || i < 0) return '';
    return String(row[i]).trim();
  }

  TEAMS = {};
  TEAM_LIST = [];

  for (const row of rows) {
    const rawName = getStr(row, 'name');
    const cleanName = miDecodeEntities(rawName).trim();

    const team = {
      name:   cleanName,
      seed:   getNum(row, 'seed'),

      ts:     getNum(row, 'ts'),
      efg:    getNum(row, 'efg'),
      tempo:  getNum(row, 'tempo'),
      epr:    getNum(row, 'epr'),
      to:     getNum(row, 'to'),
      def_efg:getNum(row, 'def_efg'),

      // distribution
      pct_pts_2:  getNum(row, 'pct_pts_2'),
      pct_pts_3:  getNum(row, 'pct_pts_3'),
      pct_pts_ft: getNum(row, 'pct_pts_ft'),

      // interactions/extras
      threepp:       getNum(row, 'threepp'),
      threepr:       getNum(row, 'threepr'),
      ftr:           getNum(row, 'ftr'),
      scpg:          getNum(row, 'scpg'),
      nb2:           getNum(row, 'nb2'),
      orb:           getNum(row, 'orb'),
      drb:           getNum(row, 'drb'),
      blk:           getNum(row, 'blk'),
      spp:           getNum(row, 'spp'),
      opp_ast_poss:  getNum(row, 'opp_ast_poss'),
      otpp:          getNum(row, 'otpp'),
      opp_ftr:       getNum(row, 'opp_ftr'),
      opp_3pp:       getNum(row, 'opp_3pp'),
      opp_3pr:       getNum(row, 'opp_3pr'),
      ft_pct:        getNum(row, 'ft_pct'),

      // résumé
      close_win_pct: getNum(row, 'close_win_pct'),
      wp:            getNum(row, 'wp'),
      q1w:           getNum(row, 'q1w'),
      q1l:           getNum(row, 'q1l'),
      q2w:           getNum(row, 'q2w'),
      q2l:           getNum(row, 'q2l'),
      q3w:           getNum(row, 'q3w'),
      q3l:           getNum(row, 'q3l'),
      q4w:           getNum(row, 'q4w'),
      q4l:           getNum(row, 'q4l'),
      sos:           getNum(row, 'sos'),
    };

    team.q1g = (team.q1w || 0) + (team.q1l || 0);
    team.q2g = (team.q2w || 0) + (team.q2l || 0);
    team.q3g = (team.q3w || 0) + (team.q3l || 0);
    team.q4g = (team.q4w || 0) + (team.q4l || 0);
    team.total_quad_games = team.q1g + team.q2g + team.q3g + team.q4g;

    if (!team.name) continue; // skip empties

    TEAMS[team.name] = team;
    TEAM_LIST.push(team.name);
 
    // Optional safety: keep an alias for the raw encoded form if it differs
    const rawKey = String(rawName || "").trim();
    if (rawKey && rawKey !== team.name && !TEAMS[rawKey]){
      TEAMS[rawKey] = team;
    }
  }

  computeFieldStats(); // your existing function
  computeAllTeamLayers();
  computeStaticIdentities();
  populateTeamDropdowns(); // your existing function
}

function computeFieldStats() {
  FIELD_STATS = {};

  METRICS_FOR_Z.forEach(key => {
    const vals = Object.values(TEAMS)
      .map(t => t[key])
      .filter(v => v !== null && v !== undefined && !isNaN(v));
    if (!vals.length) return;
    const mean = computeMean(vals);
    const sd = computeSD(vals, mean);
    FIELD_STATS[key] = { mean, sd };
  });

  // wp & P for resume / resume-pressure
  const wpArr = [];
  const pArr = [];
  const sosArr = [];

  Object.values(TEAMS).forEach(t => {
    if (t.wp != null && !isNaN(t.wp)) {
      wpArr.push(t.wp);
    }
    if (t.sos != null) {
      sosArr.push(t.sos);
    }
  });

  if (sosArr.length) {
    // Convert SOS rank/index into hardness percentile P: lower SOS -> tougher -> higher P
    const minSOS = Math.min(...sosArr);
    const maxSOS = Math.max(...sosArr);
    Object.values(TEAMS).forEach(t => {
      if (t.sos != null && maxSOS > minSOS) {
        const norm = (t.sos - minSOS) / (maxSOS - minSOS); // 0 = toughest, 1 = weakest
        t.P = 1 - norm; // 1 = toughest schedule
        pArr.push(t.P);
      }
    });
  }

  if (wpArr.length) {
    const mean = computeMean(wpArr);
    const sd = computeSD(wpArr, mean);
    FIELD_STATS.wp = { mean, sd };
  }

  if (pArr.length) {
    const mean = computeMean(pArr);
    const sd = computeSD(pArr, mean);
    FIELD_STATS.P = { mean, sd };
  }
}

// ============================================================
// CANONICAL V4 ENGINE
// Full replacement scoring / comparison path
// ============================================================

const MI_V2_DEFAULTS = {
  useResumeBaseTrust: true,
  useResumeInteractionTrust: true,
  useResumeConfidenceTrust: true,
};

// ------------------------------------------------------------
// Madness Index v4 baseline helpers
// ------------------------------------------------------------
function miClamp(min, value, max) {
  return Math.max(min, Math.min(max, value));
}

function getBaselineFieldTeams() {
  return (TEAM_LIST || [])
    .map(name => TEAMS[name])
    .filter(Boolean);
}

function computeBaselineFieldMean(opts = MI_V2_DEFAULTS) {
  const teams = getBaselineFieldTeams();
  if (!teams.length) return 0;

  const rawVals = teams.map(team => {
    if (!Number.isFinite(team.foundation)) {
      computeCoreForTeam(team, opts);
    }

    const rawBase = Number.isFinite(team.foundation) ? team.foundation : 0;

    team.raw_base = rawBase;
    team.raw_base_v2 = rawBase;

    return rawBase;
  }).filter(Number.isFinite);

  if (!rawVals.length) return 0;
  return rawVals.reduce((sum, v) => sum + v, 0) / rawVals.length;
}

const MI_INTERNAL_EFF_WEIGHTS = {
  off: {
    orb: 0.35,
    efg: 0.30,
    to_inv: 0.25,
    ftr: 0.10
  },
  def: {
    def_efg: 0.35,
    drb: 0.30,
    opp_to: 0.25,
    opp_ftr: 0.10
  }
};

// ------------------------------------------------------------
// Canonical key patch for Opponent Assists / Possession
// Keeps backward compatibility with old "oapp" ingestion
// ------------------------------------------------------------
(function ensureOppAstPossAlias() {
  if (!ALIASES.opp_ast_poss) {
    ALIASES.opp_ast_poss = ['Opp. Asst./Poss.', 'Opp Asst/Poss', 'opp_ast_poss', 'OAPP'];
  }
  if (!METRICS_FOR_Z.includes('opp_ast_poss')) {
    METRICS_FOR_Z.push('opp_ast_poss');
  }
})();

// ------------------------------------------------------------
// Resume helpers
// ------------------------------------------------------------
function getResumeTierFromIndexV2(R) {
  if (R >= 1.00) return 'Elite';
  if (R >= 0.80) return 'Strong';
  if (R >= 0.60) return 'Above Average';
  if (R >= 0.00) return 'Average';
  if (R > -0.80) return 'Weak';
  return 'Fragile';
}

function getResumeBaseTrustFactorV2(tier) {
  switch (tier) {
    case 'Elite':         return 1.03;
    case 'Strong':        return 1.01;
    case 'Above Average': return 1.00;
    case 'Average':       return 0.98;
    case 'Weak':          return 0.95;
    case 'Fragile':       return 0.92;
    default:              return 1.00;
  }
}

function getResumeInteractionFactorV2(tier) {
  switch (tier) {
    case 'Elite':         return 1.05;
    case 'Strong':        return 1.02;
    case 'Above Average': return 1.00;
    case 'Average':       return 0.97;
    case 'Weak':          return 0.93;
    case 'Fragile':       return 0.88;
    default:              return 1.00;
  }
}

function getResumeConfidenceFactorV2(tier) {
  switch (tier) {
    case 'Elite':         return 1.02;
    case 'Strong':        return 1.01;
    case 'Above Average': return 1.00;
    case 'Average':       return 0.99;
    case 'Weak':          return 0.97;
    case 'Fragile':       return 0.95;
    default:              return 1.00;
  }
}

// ------------------------------------------------------------
// IdentityEdge helpers
// ------------------------------------------------------------
function bucketedIdentityBonus(raw, thresholds = [0.40, 0.90, 1.40], values = [0.00, 0.10, 0.20, 0.25]) {
  if (raw < thresholds[0]) return values[0];
  if (raw < thresholds[1]) return values[1];
  if (raw < thresholds[2]) return values[2];
  return values[3];
}

// ------------------------------------------------------------
// Canonical MI internal efficiency construction
// Base-only signals from the 8 possession drivers
// ------------------------------------------------------------
function computeInternalEfficiencyMetricsForTeam(team) {
  const w = MI_INTERNAL_EFF_WEIGHTS;

  // Offensive drivers
  const zORB   = getZ(team, 'orb', false);
  const zEFG   = getZ(team, 'efg', false);
  const zTOInv = getZ(team, 'to', true);         // inverse turnover rate
  const zFTR   = getZ(team, 'ftr', false);

  // Defensive drivers
  const zDefEFG = getZ(team, 'def_efg', true);   // lower opp eFG allowed = better
  const zDRB    = getZ(team, 'drb', false);
  const zOppTO  = getZ(team, 'otpp', false);     // forced-turnover proxy
  const zOppFTR = getZ(team, 'opp_ftr', true);   // lower opp FTR allowed = better

  const miOffEffBase =
      w.off.orb    * zORB
    + w.off.efg    * zEFG
    + w.off.to_inv * zTOInv
    + w.off.ftr    * zFTR;

  const miDefEffBase =
      w.def.def_efg * zDefEFG
    + w.def.drb     * zDRB
    + w.def.opp_to  * zOppTO
    + w.def.opp_ftr * zOppFTR;

  const miEffMarginBase = miOffEffBase + miDefEffBase;

  const zPack = {
    orb: zORB,
    efg: zEFG,
    to_inv: zTOInv,
    ftr: zFTR,
    def_efg: zDefEFG,
    drb: zDRB,
    opp_to: zOppTO,
    opp_ftr: zOppFTR
  };

  team.internalEffZ = zPack;
  team.internalEffZ_v2 = { ...zPack };

  // direct z convenience fields
  team.z_orb = zORB;
  team.z_efg = zEFG;
  team.z_to_inv = zTOInv;
  team.z_ftr = zFTR;
  team.z_def_efg = zDefEFG;
  team.z_drb = zDRB;
  team.z_opp_to = zOppTO;
  team.z_opp_ftr = zOppFTR;

  // ----------------------------------------------------------
  // Base-only signals
  // ----------------------------------------------------------
  team.mi_off_eff_base = miOffEffBase;
  team.mi_off_eff_base_v2 = miOffEffBase;

  team.mi_def_eff_base = miDefEffBase;
  team.mi_def_eff_base_v2 = miDefEffBase;

  team.mi_eff_margin_base = miEffMarginBase;
  team.mi_eff_margin_base_v2 = miEffMarginBase;

  // ----------------------------------------------------------
  // Compatibility aliases
  // For now these still point to base values until computeCoreForTeam
  // overwrites the adjusted canonical values.
  // ----------------------------------------------------------
  team.mi_off_eff = miOffEffBase;
  team.mi_off_eff_v2 = miOffEffBase;

  team.mi_def_eff = miDefEffBase;
  team.mi_def_eff_v2 = miDefEffBase;

  team.mi_eff_margin = miEffMarginBase;
  team.mi_eff_margin_v2 = miEffMarginBase;

  return {
    miOffEffBase,
    miDefEffBase,
    miEffMarginBase,
    zPack
  };
}

function buildInternalEfficiencyRows(team) {
  const z = team.internalEffZ || {};

  const getFieldSd = (fieldKey) => {
    const sd = FIELD_STATS?.[fieldKey]?.sd;
    return Number.isFinite(sd) ? sd : null;
  };

  const rows = [
    {
      key: 'orb',
      label: 'Offensive Rebounding',
      value: Number.isFinite(z.orb) ? z.orb : 0,
      tier: getTierLabelFromZ(Number.isFinite(z.orb) ? z.orb : 0),
      weight: 0.35,
      points: 0.35 * (Number.isFinite(z.orb) ? z.orb : 0),
      sd: getFieldSd('orb')
    },
    {
      key: 'efg',
      label: 'Effective FG%',
      value: Number.isFinite(z.efg) ? z.efg : 0,
      tier: getTierLabelFromZ(Number.isFinite(z.efg) ? z.efg : 0),
      weight: 0.30,
      points: 0.30 * (Number.isFinite(z.efg) ? z.efg : 0),
      sd: getFieldSd('efg')
    },
    {
      key: 'to_inv',
      label: 'Turnover Avoidance',
      value: Number.isFinite(z.to_inv) ? z.to_inv : 0,
      tier: getTierLabelFromZ(Number.isFinite(z.to_inv) ? z.to_inv : 0),
      weight: 0.25,
      points: 0.25 * (Number.isFinite(z.to_inv) ? z.to_inv : 0),
      sd: getFieldSd('to')
    },
    {
      key: 'ftr',
      label: 'Free Throw Rate',
      value: Number.isFinite(z.ftr) ? z.ftr : 0,
      tier: getTierLabelFromZ(Number.isFinite(z.ftr) ? z.ftr : 0),
      weight: 0.10,
      points: 0.10 * (Number.isFinite(z.ftr) ? z.ftr : 0),
      sd: getFieldSd('ftr')
    },
    {
      key: 'def_efg',
      label: 'Opponent eFG%',
      value: Number.isFinite(z.def_efg) ? z.def_efg : 0,
      tier: getTierLabelFromZ(Number.isFinite(z.def_efg) ? z.def_efg : 0),
      weight: 0.35,
      points: 0.35 * (Number.isFinite(z.def_efg) ? z.def_efg : 0),
      sd: getFieldSd('def_efg')
    },
    {
      key: 'drb',
      label: 'Defensive Rebounding',
      value: Number.isFinite(z.drb) ? z.drb : 0,
      tier: getTierLabelFromZ(Number.isFinite(z.drb) ? z.drb : 0),
      weight: 0.30,
      points: 0.30 * (Number.isFinite(z.drb) ? z.drb : 0),
      sd: getFieldSd('drb')
    },
    {
      key: 'opp_to',
      label: 'Forcing Turnovers',
      value: Number.isFinite(z.opp_to) ? z.opp_to : 0,
      tier: getTierLabelFromZ(Number.isFinite(z.opp_to) ? z.opp_to : 0),
      weight: 0.25,
      points: 0.25 * (Number.isFinite(z.opp_to) ? z.opp_to : 0),
      sd: getFieldSd('otpp')
    },
    {
      key: 'opp_ftr',
      label: 'Free Throw Prevention',
      value: Number.isFinite(z.opp_ftr) ? z.opp_ftr : 0,
      tier: getTierLabelFromZ(Number.isFinite(z.opp_ftr) ? z.opp_ftr : 0),
      weight: 0.10,
      points: 0.10 * (Number.isFinite(z.opp_ftr) ? z.opp_ftr : 0),
      sd: getFieldSd('opp_ftr')
    }
  ];

  return rows;
}

// ------------------------------------------------------------
// V4.2 core / foundation
//
// Base offense/defense signals are computed first.
// Then split breadth is applied to each side independently.
//
// MI_OffEff_Adjusted = MI_OffEff_Base + offBreadth
// MI_DefEff_Adjusted = MI_DefEff_Base + defBreadth
// MI_EffMargin       = MI_OffEff_Adjusted + MI_DefEff_Adjusted
//
// foundation = MI_EffMargin
// ------------------------------------------------------------
function computeCoreForTeam(team, opts = MI_V2_DEFAULTS) {
  const {
    miOffEffBase,
    miDefEffBase,
    miEffMarginBase
  } = computeInternalEfficiencyMetricsForTeam(team);

  const {
    offBreadth = 0,
    defBreadth = 0,
    totalBreadth = 0,
    offBreadthSD = 0,
    defBreadthSD = 0
  } = computeBreadthForTeam(team) || {};

  const miOffEffAdj = miOffEffBase + offBreadth;
  const miDefEffAdj = miDefEffBase + defBreadth;
  const miEffMargin = miOffEffAdj + miDefEffAdj;

  // ----------------------------------------------------------
  // Canonical adjusted efficiency signals
  // ----------------------------------------------------------
  team.mi_off_eff = miOffEffAdj;
  team.mi_off_eff_v2 = miOffEffAdj;

  team.mi_def_eff = miDefEffAdj;
  team.mi_def_eff_v2 = miDefEffAdj;

  team.mi_eff_margin = miEffMargin;
  team.mi_eff_margin_v2 = miEffMargin;

  team.foundation = miEffMargin;
  team.foundation_v2 = miEffMargin;

  // backward compatibility
  team.mibs = miEffMargin;
  team.mibs_v2 = miEffMargin;

  // explicit adjusted aliases for cleaner rendering/debug
  team.mi_off_eff_adj = miOffEffAdj;
  team.mi_off_eff_adj_v2 = miOffEffAdj;

  team.mi_def_eff_adj = miDefEffAdj;
  team.mi_def_eff_adj_v2 = miDefEffAdj;

  // explicit breadth references
  team.offBreadth = Number.isFinite(offBreadth) ? offBreadth : 0;
  team.offBreadth_v2 = team.offBreadth;

  team.defBreadth = Number.isFinite(defBreadth) ? defBreadth : 0;
  team.defBreadth_v2 = team.defBreadth;

  team.offBreadthSD = Number.isFinite(offBreadthSD) ? offBreadthSD : 0;
  team.offBreadthSD_v2 = team.offBreadthSD;

  team.defBreadthSD = Number.isFinite(defBreadthSD) ? defBreadthSD : 0;
  team.defBreadthSD_v2 = team.defBreadthSD;

  team.breadth = Number.isFinite(totalBreadth) ? totalBreadth : 0;
  team.breadth_v2 = team.breadth;

  team.miOffEffBase = Number.isFinite(miOffEffBase) ? miOffEffBase : 0;
  team.miDefEffBase = Number.isFinite(miDefEffBase) ? miDefEffBase : 0;
  team.miEffMarginBase = Number.isFinite(miEffMarginBase) ? miEffMarginBase : 0;

  team.mi_off_eff_base = team.miOffEffBase;
  team.mi_def_eff_base = team.miDefEffBase;
  team.mi_eff_margin_base = team.miEffMarginBase;

  // Compatibility-only shell
  team.domains = {};
  team.domains_v2 = {};

  // Compact debug/detail rows
  team.coreDomainDetails = [
    {
      key: 'mi_off_eff_base',
      label: 'MI Offensive Efficiency (Base)',
      value: miOffEffBase,
      weight: 1.00,
      points: miOffEffBase
    },
    {
      key: 'off_breadth',
      label: 'Offensive Breadth',
      value: offBreadth,
      weight: 1.00,
      points: offBreadth
    },
    {
      key: 'mi_off_eff',
      label: 'MI Offensive Efficiency',
      value: miOffEffAdj,
      weight: 1.00,
      points: miOffEffAdj
    },
    {
      key: 'mi_def_eff_base',
      label: 'MI Defensive Efficiency (Base)',
      value: miDefEffBase,
      weight: 1.00,
      points: miDefEffBase
    },
    {
      key: 'def_breadth',
      label: 'Defensive Breadth',
      value: defBreadth,
      weight: 1.00,
      points: defBreadth
    },
    {
      key: 'mi_def_eff',
      label: 'MI Defensive Efficiency',
      value: miDefEffAdj,
      weight: 1.00,
      points: miDefEffAdj
    },
    {
      key: 'mi_eff_margin',
      label: 'MI Efficiency Margin',
      value: miEffMargin,
      weight: 1.00,
      points: miEffMargin
    }
  ];
  team.coreDomainDetails_v2 = team.coreDomainDetails.map(row => ({ ...row }));

  // Canonical front-side / table detail rows
  team.coreDetails = buildInternalEfficiencyRows(team);
  team.coreDetails_v2 = team.coreDetails.map(row => ({ ...row }));

  return miEffMargin;
}

// ------------------------------------------------------------
// V4.2 split breadth
//
// Offensive breadth is computed only from the 4 offensive driver z-scores:
//   ORB, eFG, TO_inv, FTR
//
// Defensive breadth is computed only from the 4 defensive driver z-scores:
//   def_eFG, DRB, opp_TO, opp_FTR
//
// Each side gets its own SD and breadth adjustment.
// The combined breadth is retained only for compatibility.
//
// Suggested side formula:
//   SideBreadthScore = clamp(-0.05, 0.15 - 0.20 * SideBreadthSD, 0.15)
//
// Total max combined effect remains +0.30.
// ------------------------------------------------------------
function computeBreadthForTeam(team) {
  if (!team.internalEffZ) {
    computeInternalEfficiencyMetricsForTeam(team);
  }

  const z = team.internalEffZ || {};

  const offVals = [
    z.orb,
    z.efg,
    z.to_inv,
    z.ftr
  ].map(v => Number.isFinite(v) ? v : 0);

  const defVals = [
    z.def_efg,
    z.drb,
    z.opp_to,
    z.opp_ftr
  ].map(v => Number.isFinite(v) ? v : 0);

  function calcSD(vals) {
    if (!Array.isArray(vals) || !vals.length) return 0;
    const mean = vals.reduce((sum, v) => sum + v, 0) / vals.length;
    const variance = vals.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / vals.length;
    return Math.sqrt(variance);
  }

  const offBreadthSD = calcSD(offVals);
  const defBreadthSD = calcSD(defVals);

  const offBreadth = miClamp(-0.05, 0.15 - 0.20 * offBreadthSD, 0.15);
  const defBreadth = miClamp(-0.05, 0.15 - 0.20 * defBreadthSD, 0.15);

  const totalBreadth = offBreadth + defBreadth;

  // ----------------------------------------------------------
  // Canonical split breadth fields
  // ----------------------------------------------------------
  team.offBreadthSD = offBreadthSD;
  team.offBreadthSD_v2 = offBreadthSD;

  team.defBreadthSD = defBreadthSD;
  team.defBreadthSD_v2 = defBreadthSD;

  team.offBreadth = offBreadth;
  team.offBreadth_v2 = offBreadth;

  team.defBreadth = defBreadth;
  team.defBreadth_v2 = defBreadth;

  // ----------------------------------------------------------
  // Compatibility aggregate fields
  // ----------------------------------------------------------
  team.breadth = totalBreadth;
  team.breadth_v2 = totalBreadth;

  // breadthSD no longer has one canonical meaning, but keep a
  // compatibility value for older surfaces that still reference it
  team.breadthSD = offBreadthSD + defBreadthSD;
  team.breadthSD_v2 = team.breadthSD;

  // ----------------------------------------------------------
  // Compatibility-only hit counts
  // ----------------------------------------------------------
  const offSupportive = offVals.filter(v => v > 0).length;
  const defSupportive = defVals.filter(v => v > 0).length;
  const supportive = offSupportive + defSupportive;

  team.offBreadthHits = offSupportive;
  team.defBreadthHits = defSupportive;

  team.breadthHits = supportive;
  team.breadthHits_v2 = supportive;

  team.breadthDomainHits = {
    positiveDrivers: supportive,
    negativeDrivers: 8 - supportive,
    offensivePositiveDrivers: offSupportive,
    defensivePositiveDrivers: defSupportive
  };
  team.breadthDomainHits_v2 = { ...team.breadthDomainHits };

  team.breadthEffHits = supportive;
  team.breadthShootHits = 0;
  team.breadthPossHits = supportive;
  team.breadthTotalHits = supportive;

  return {
    offBreadth,
    defBreadth,
    totalBreadth,
    offBreadthSD,
    defBreadthSD
  };
}

// ------------------------------------------------------------
// Resume Context V2 prep
// ------------------------------------------------------------
let RESUME_CONTEXT_STATS_V2 = null;

function _safeNum(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function _safeDiv(a, b, fallback = 0) {
  return (Number.isFinite(a) && Number.isFinite(b) && b !== 0) ? (a / b) : fallback;
}

function _mean(values) {
  const arr = values.filter(Number.isFinite);
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function _sd(values, mean = null) {
  const arr = values.filter(Number.isFinite);
  if (arr.length < 2) return 0;
  const m = (mean == null) ? _mean(arr) : mean;
  const variance = arr.reduce((s, v) => s + Math.pow(v - m, 2), 0) / arr.length;
  return Math.sqrt(variance);
}

function _zFromStats(value, stats) {
  if (!Number.isFinite(value) || !stats) return 0;
  const sd = stats.sd || 0;
  if (!Number.isFinite(sd) || sd <= 1e-9) return 0;
  return (value - stats.mean) / sd;
}

function _makeStats(values) {
  const mean = _mean(values);
  const sd = _sd(values, mean);
  return { mean, sd };
}

function _stabilizedWinRate(w, l, priorMean, priorWeight = 4) {
  const W = _safeNum(w, 0);
  const L = _safeNum(l, 0);
  const G = W + L;
  return (W + priorMean * priorWeight) / (G + priorWeight);
}

function prepareResumeContextStatsV2() {
  const teams = (TEAM_LIST || [])
    .map(name => TEAMS[name])
    .filter(Boolean);

  if (!teams.length) {
    RESUME_CONTEXT_STATS_V2 = null;
    return;
  }

  // --------------------------------------------------------
  // 1) field prior means for stabilized Q1 / Q2 conversion
  // --------------------------------------------------------
  let totalQ1W = 0, totalQ1G = 0;
  let totalQ2W = 0, totalQ2G = 0;

  for (const team of teams) {
    const q1w = _safeNum(team.q1w, 0);
    const q1l = _safeNum(team.q1l, 0);
    const q2w = _safeNum(team.q2w, 0);
    const q2l = _safeNum(team.q2l, 0);

    totalQ1W += q1w;
    totalQ1G += (q1w + q1l);

    totalQ2W += q2w;
    totalQ2G += (q2w + q2l);
  }

  const q1PriorMean = _safeDiv(totalQ1W, totalQ1G, 0.5);
  const q2PriorMean = _safeDiv(totalQ2W, totalQ2G, 0.5);
  const priorWeight = 4;

  // --------------------------------------------------------
  // 2) build raw component values for every team
  // --------------------------------------------------------
  const qwcVals = [];
  const qwvAdjVals = [];
  const blrVals = [];
  const oppShareVals = [];
  const wpVals = [];
  const sosVals = [];

  for (const team of teams) {
    const q1w = _safeNum(team.q1w, 0);
    const q1l = _safeNum(team.q1l, 0);
    const q2w = _safeNum(team.q2w, 0);
    const q2l = _safeNum(team.q2l, 0);
    const q3w = _safeNum(team.q3w, 0);
    const q3l = _safeNum(team.q3l, 0);
    const q4w = _safeNum(team.q4w, 0);
    const q4l = _safeNum(team.q4l, 0);

    const q1g = q1w + q1l;
    const q2g = q2w + q2l;
    const q3g = q3w + q3l;
    const q4g = q4w + q4l;
    const totalGames = Math.max(1, q1g + q2g + q3g + q4g);

    const q1Stable = _stabilizedWinRate(q1w, q1l, q1PriorMean, priorWeight);
    const q2Stable = _stabilizedWinRate(q2w, q2l, q2PriorMean, priorWeight);

    const qwc = 0.65 * q1Stable + 0.35 * q2Stable;
    const qwvRaw = (1.00 * q1w) + (0.60 * q2w);
    const qwvAdj = Math.log1p(Math.max(0, qwvRaw));
    const blr = -(0.45 * q3l + 1.00 * q4l);
    const oppShare = ((1.00 * q1g) + (0.60 * q2g)) / totalGames;

    team._resumeV2Parts = {
      q1w, q1l, q2w, q2l, q3w, q3l, q4w, q4l,
      q1g, q2g, q3g, q4g, totalGames,
      q1Stable, q2Stable,
      qwc,
      qwvRaw,
      qwvAdj,
      blr,
      oppShare,
      wp: _safeNum(team.wp, 0),
      sos: _safeNum(team.sos, 0),
    };

    qwcVals.push(qwc);
    qwvAdjVals.push(qwvAdj);
    blrVals.push(blr);
    oppShareVals.push(oppShare);
    wpVals.push(_safeNum(team.wp, 0));
    sosVals.push(_safeNum(team.sos, 0));
  }

  const qwcStats = _makeStats(qwcVals);
  const qwvAdjStats = _makeStats(qwvAdjVals);
  const blrStats = _makeStats(blrVals);
  const oppShareStats = _makeStats(oppShareVals);
  const wpStats = _makeStats(wpVals);
  const sosStats = _makeStats(sosVals);

  // --------------------------------------------------------
  // 3) build composite raw résumé score for every team
  // --------------------------------------------------------
  const rawVals = [];

  for (const team of teams) {
    const p = team._resumeV2Parts || {};

    const zQwc      = _zFromStats(p.qwc, qwcStats);
    const zQwvAdj   = _zFromStats(p.qwvAdj, qwvAdjStats);
    const zBlr      = _zFromStats(p.blr, blrStats);
    const zOppShare = _zFromStats(p.oppShare, oppShareStats);
    const zWp       = _zFromStats(p.wp, wpStats);
    const zSos      = _zFromStats(p.sos, sosStats);

    const scheduleHardness = 0.65 * zSos + 0.35 * zOppShare;

    const raw =
      0.30 * zQwc +
      0.20 * zQwvAdj +
      0.25 * zBlr +
      0.15 * scheduleHardness +
      0.10 * zWp;

    p.zQwc = zQwc;
    p.zQwvAdj = zQwvAdj;
    p.zBlr = zBlr;
    p.zOppShare = zOppShare;
    p.zWp = zWp;
    p.zSos = zSos;
    p.scheduleHardness = scheduleHardness;
    p.raw = raw;

    rawVals.push(raw);
  }

  const rawStats = _makeStats(rawVals);

  RESUME_CONTEXT_STATS_V2 = {
    priorWeight,
    q1PriorMean,
    q2PriorMean,
    qwcStats,
    qwvAdjStats,
    blrStats,
    oppShareStats,
    wpStats,
    sosStats,
    rawStats,
  };
}

// ---------- Résumé Context Score (R) V2 ----------

function computeResumeContextForTeam(team, opts = MI_V2_DEFAULTS) {
  const S = RESUME_CONTEXT_STATS_V2;

  if (!team || !S || !team._resumeV2Parts) {
    team.resumeIndex = 0;
    team.resumeTier = 'Average';
    team.resumeRTier = 'Average';

    team.resumeBaseTrust = 1.00;
    team.resumeIntTrust = 1.00;
    team.resumeConfidenceTrust = 1.00;

    team.resumeR = 0;

    team.resumeIndex_v2 = 0;
    team.resumeTier_v2 = 'Average';
    team.resumeBaseTrust_v2 = 1.00;
    team.resumeIntTrust_v2 = 1.00;
    team.resumeConfidenceTrust_v2 = 1.00;

    team.resumeBreakdown = null;
    team.resumeBreakdown_v2 = null;
    return;
  }

  const p = team._resumeV2Parts;
  const R = _zFromStats(p.raw, S.rawStats);
  const tier = getResumeTierFromIndexV2(R);

  const baseTrust = opts.useResumeBaseTrust ? getResumeBaseTrustFactorV2(tier) : 1.00;
  const intTrust  = opts.useResumeInteractionTrust ? getResumeInteractionFactorV2(tier) : 1.00;
  const confTrust = opts.useResumeConfidenceTrust ? getResumeConfidenceFactorV2(tier) : 1.00;

  team.resumeIndex = R;
  team.resumeTier = tier;
  team.resumeRTier = tier;

  team.resumeBaseTrust = baseTrust;
  team.resumeIntTrust = intTrust;
  team.resumeConfidenceTrust = confTrust;

  // keep this for backwards compatibility / UI debug
  team.resumeR = R;

  team.resumeIndex_v2 = R;
  team.resumeTier_v2 = tier;
  team.resumeBaseTrust_v2 = baseTrust;
  team.resumeIntTrust_v2 = intTrust;
  team.resumeConfidenceTrust_v2 = confTrust;

  team.resumeBreakdown = {
    q1Stable: p.q1Stable,
    q2Stable: p.q2Stable,
    qwc: p.qwc,
    qwvRaw: p.qwvRaw,
    qwvAdj: p.qwvAdj,
    blr: p.blr,
    oppShare: p.oppShare,
    zQwc: p.zQwc,
    zQwvAdj: p.zQwvAdj,
    zBlr: p.zBlr,
    zOppShare: p.zOppShare,
    zWp: p.zWp,
    zSos: p.zSos,
    scheduleHardness: p.scheduleHardness,
    raw: p.raw,
    finalResumeIndex: R,
  };

  team.resumeBreakdown_v2 = { ...team.resumeBreakdown };
}

// ---------- Interaction Metrics (Directional, Continuous, Gated) ----------

const INTERACTION_CHANNEL_META = {
  turnover_pressure: {
    tier: 'high',
    weight: 1.00,
    gain: 1.00,
    penalty: 0.85
  },

  perimeter_variance_pressure: {
    tier: 'high',
    weight: 0.95,
    gain: 1.00,
    penalty: 0.80
  },

  rim_access_pressure: {
    tier: 'medium',
    weight: 0.75,
    gain: 0.90,
    penalty: 0.72
  },

  foul_pressure: {
    tier: 'low',
    weight: 0.50,
    gain: 0.72,
    penalty: 0.55
  },

  rebounding_pressure: {
    tier: 'low',
    weight: 0.50,
    gain: 0.68,
    penalty: 0.52
  }
};

function softGapScore(edge, slope = 1.35, cap = 1.0) {
  const x = Number(edge) || 0;
  const y = (2 / (1 + Math.exp(-slope * x))) - 1; // [-1, 1]
  return Math.max(-cap, Math.min(cap, y * cap));
}

function interactionGate(absBaselineDiff, mid = 1.75, slope = 1.40, floor = 0.20) {
  const x = Number(absBaselineDiff) || 0;
  const logistic = 1 / (1 + Math.exp(slope * (x - mid)));
  return floor + (1 - floor) * logistic;
}

function interactionDisplayStrength(absVal) {
  if (absVal >= 0.45) return 'high';
  if (absVal >= 0.20) return 'medium';
  if (absVal > 0.00) return 'low';
  return 'none';
}

function resolveInteractionChannel({
  key,
  label,
  a_on_b,
  b_on_a,
  importance,
  gate
}) {
  const meta = INTERACTION_CHANNEL_META[key] || {
    tier: 'medium',
    weight: Number(importance) || 1.00,
    gain: 1.00,
    penalty: 1.00
  };

  const raw_edge = a_on_b - b_on_a;
  const soft_edge = softGapScore(raw_edge);

  const weight = Number(meta.weight) || 1.00;
  const gain = Number(meta.gain) || 1.00;
  const penalty = Number(meta.penalty) || 1.00;

  const contribution = soft_edge * weight * gate;
  const aAdj = contribution * gain;
  const bAdj = -contribution * penalty;

  return {
    key,
    label,
    tier: meta.tier || 'medium',
    a_on_b,
    b_on_a,
    raw_edge,
    soft_edge,
    importance: weight,
    weight,
    gain,
    penalty,
    gate,
    contribution,
    aAdj,
    bAdj,
    edge:
      contribution > 0 ? 'FAVORS A' :
      contribution < 0 ? 'FAVORS B' :
      'EVEN',
    winner:
      contribution > 0 ? 'A' :
      contribution < 0 ? 'B' :
      null,
    display_strength: interactionDisplayStrength(Math.max(Math.abs(aAdj), Math.abs(bAdj)))
  };
}

function computeTurnoverPressure(a, b, gate) {
  const forceA =
    0.55 * getZ(a, 'opp_to') +
    0.25 * getZ(a, 'spp') +
    0.20 * getZ(a, 'opp_ast_poss', true);

  const vulnB =
    0.75 * getZ(b, 'to') +
    0.25 * getZ(b, 'opp_ast_poss');

  const forceB =
    0.55 * getZ(b, 'opp_to') +
    0.25 * getZ(b, 'spp') +
    0.20 * getZ(b, 'opp_ast_poss', true);

  const vulnA =
    0.75 * getZ(a, 'to') +
    0.25 * getZ(a, 'opp_ast_poss');

  const a_on_b = 0.60 * forceA + 0.40 * vulnB;
  const b_on_a = 0.60 * forceB + 0.40 * vulnA;

  return resolveInteractionChannel({
    key: 'turnover_pressure',
    label: 'Turnover Pressure',
    a_on_b,
    b_on_a,
    importance: INTERACTION_CHANNEL_META.turnover_pressure,
    gate
  });
}

function computeReboundingPressure(a, b, gate) {
  const a_on_b =
    0.70 * getZ(a, 'orb') -
    0.30 * getZ(b, 'drb');

  const b_on_a =
    0.70 * getZ(b, 'orb') -
    0.30 * getZ(a, 'drb');

  return resolveInteractionChannel({
    key: 'rebounding_pressure',
    label: 'Rebounding Pressure',
    a_on_b,
    b_on_a,
    importance: INTERACTION_CHANNEL_META.rebounding_pressure,
    gate
  });
}

function computeFoulPressure(a, b, gate) {
  const drawA =
    0.85 * getZ(a, 'ftr') +
    0.15 * getZ(a, 'pct_pts_ft');

  const vulnB =
    getZ(b, 'opp_ftr', true); // invert discipline -> vulnerability

  const drawB =
    0.85 * getZ(b, 'ftr') +
    0.15 * getZ(b, 'pct_pts_ft');

  const vulnA =
    getZ(a, 'opp_ftr', true);

  const a_on_b = 0.60 * drawA + 0.40 * vulnB;
  const b_on_a = 0.60 * drawB + 0.40 * vulnA;

  return resolveInteractionChannel({
    key: 'foul_pressure',
    label: 'Foul Pressure',
    a_on_b,
    b_on_a,
    importance: INTERACTION_CHANNEL_META.foul_pressure,
    gate
  });
}

function computeRimAccessPressure(a, b, gate) {
  const accessA =
    0.65 * getZ(a, 'nb2') +
    0.20 * getZ(a, 'pct_pts_2') +
    0.15 * getZ(a, 'efg');

  const rimDefB =
    0.70 * getZ(b, 'blk') +
    0.30 * getZ(b, 'def_efg', true);

  const accessB =
    0.65 * getZ(b, 'nb2') +
    0.20 * getZ(b, 'pct_pts_2') +
    0.15 * getZ(b, 'efg');

  const rimDefA =
    0.70 * getZ(a, 'blk') +
    0.30 * getZ(a, 'def_efg', true);

  const a_on_b = accessA - rimDefB;
  const b_on_a = accessB - rimDefA;

  return resolveInteractionChannel({
    key: 'rim_access_pressure',
    label: 'Rim Access Pressure',
    a_on_b,
    b_on_a,
    importance: INTERACTION_CHANNEL_META.rim_access_pressure,
    gate
  });
}

function computePerimeterVariancePressure(a, b, gate) {
  const varianceA =
    0.60 * getZ(a, 'threepr') +
    0.40 * getZ(a, 'pct_pts_3');

  const resistB =
    0.80 * getZ(b, 'opp_3pr', true) +
    0.20 * getZ(b, 'opp_3pp', true);

  const varianceB =
    0.60 * getZ(b, 'threepr') +
    0.40 * getZ(b, 'pct_pts_3');

  const resistA =
    0.80 * getZ(a, 'opp_3pr', true) +
    0.20 * getZ(a, 'opp_3pp', true);

  const a_on_b = varianceA - resistB;
  const b_on_a = varianceB - resistA;

  return resolveInteractionChannel({
    key: 'perimeter_variance_pressure',
    label: 'Perimeter Variance Pressure',
    a_on_b,
    b_on_a,
    importance: INTERACTION_CHANNEL_META.perimeter_variance_pressure,
    gate
  });
}

function computeInteractions(a, b) {
  const baseA =
    Number(a?.mi_base ?? a?.mibs ?? a?.miBase ?? a?.base ?? 0) || 0;
  const baseB =
    Number(b?.mi_base ?? b?.mibs ?? b?.miBase ?? b?.base ?? 0) || 0;

  const absBaselineDiff = Math.abs(baseA - baseB);
  const gate = interactionGate(absBaselineDiff);

  const channels = {
    turnover_pressure: computeTurnoverPressure(a, b, gate),
    rebounding_pressure: computeReboundingPressure(a, b, gate),
    foul_pressure: computeFoulPressure(a, b, gate),
    rim_access_pressure: computeRimAccessPressure(a, b, gate),
    perimeter_variance_pressure: computePerimeterVariancePressure(a, b, gate)
  };

  const totalA = Object.values(channels).reduce((sum, ch) => sum + (ch.aAdj || 0), 0);
  const totalB = Object.values(channels).reduce((sum, ch) => sum + (ch.bAdj || 0), 0);

  const breakdown = {};
  Object.values(channels).forEach(ch => {
    breakdown[ch.key] = ch;
  });

  return {
    a: totalA,
    b: totalB,
    gate,
    absBaselineDiff,
    channels,
    breakdown
  };
}

// ---------- Profile Marks (Diagnostic Only) ----------

function computeProfileMarks(team) {
  const marks = [];

  // 1. Offensive Rigidity
  const s2 = team.pct_pts_2 || 0;
  const s3 = team.pct_pts_3 || 0;
  const sft = team.pct_pts_ft || 0;
  const primaryShare = Math.max(s2, s3, sft);
  const primary = (primaryShare === s2) ? '2P' : (primaryShare === s3 ? '3P' : 'FT');

  let planBZs = [];
  if (primaryShare >= 0.50) {
    if (primary === '2P') {
      planBZs.push(getZ(team, 'threepp'));
      planBZs.push(getZ(team, 'ft_pct'));
    } else if (primary === '3P') {
      planBZs.push(getZ(team, 'nb2'));
      planBZs.push(getZ(team, 'ft_pct'));
    } else {
      planBZs.push(getZ(team, 'nb2'));
      planBZs.push(getZ(team, 'threepp'));
    }
    const planB = (planBZs[0] + planBZs[1]) / 2;
    if (primaryShare >= 0.55 && planB <= -0.50) {
      marks.push('Offensive Rigidity — Severe');
    } else if (planB <= -0.25) {
      marks.push('Offensive Rigidity — Moderate');
    }
  }

  // 2. Unstable Perimeter Profile
  if (team.threepr != null && team.threepp != null) {
    const vol = team.threepr;
    const acc = team.threepp;
    const gap = Math.abs(vol - acc);
    if (vol >= 0.40) {
      if (gap >= 0.10) marks.push('Unstable Perimeter — Severe');
      else if (gap >= 0.06) marks.push('Unstable Perimeter — Moderate');
    }
  }

  // 3. Cold Arc Team
  if (FIELD_STATS.threepp && team.threepp != null) {
    const z = getZ(team, 'threepp');
    if (z < -0.67) marks.push('Cold Arc Team — Severe');
    else if (z < 0 && z >= -0.67) marks.push('Cold Arc Team — Moderate');
  }

  // 4. Undisciplined Defense
  if (FIELD_STATS.spp && FIELD_STATS.otpp && FIELD_STATS.opp_ftr && team.spp != null && team.otpp != null && team.opp_ftr != null) {
    const pressure = getZ(team, 'spp') + getZ(team, 'otpp');
    const discipline = -getZ(team, 'opp_ftr'); // higher OppFTR = worse discipline
    const disorder = pressure - discipline;
    if (disorder >= 1.00) marks.push('Undisciplined Defense — Severe');
    else if (disorder >= 0.50) marks.push('Undisciplined Defense — Moderate');
  }

  // 5. Soft Interior
  if (FIELD_STATS.def_efg && FIELD_STATS.blk && team.def_efg != null && team.blk != null) {
    const resistance = (-getZ(team, 'def_efg') + getZ(team, 'blk')) / 2;
    if (resistance < -0.75) marks.push('Soft Interior — Severe');
    else if (resistance < -0.25) marks.push('Soft Interior — Moderate');
  }

  // 6. Perimeter Leakage
  if (FIELD_STATS.opp_3pr && FIELD_STATS.opp_3pp && team.opp_3pr != null && team.opp_3pp != null) {
    const exposure = getZ(team, 'opp_3pr') + getZ(team, 'opp_3pp');
    if (exposure >= 1.00) marks.push('Perimeter Leakage — Severe');
    else if (exposure >= 0.50) marks.push('Perimeter Leakage — Moderate');
  }

  // 7. Tempo Strain 
  if (FIELD_STATS.tempo && FIELD_STATS.epr && FIELD_STATS.to &&
      team.tempo != null && team.epr != null && team.to != null) {

    const zTempo = getZ(team, 'tempo');
    const zEPR   = getZ(team, 'epr');
    const zInvTO = getZ(team, 'to', true);

    const tempoExtremity = Math.abs(zTempo);
    if (tempoExtremity < 0.80) {
      // no mark
    } else {
      const si = (zEPR + zInvTO) / 2;
      const vulnerability = Math.max(0, -si);

      const tempoStrain = tempoExtremity * vulnerability;

      if (tempoExtremity >= 1.20 &&
          vulnerability >= 0.75 &&
          tempoStrain   >= 0.90) {
        marks.push('Tempo Strain — Severe');
      } else if (tempoExtremity >= 0.80 &&
                 vulnerability >= 0.40 &&
                 tempoStrain   >= 0.40) {
        marks.push('Tempo Strain — Moderate');
      }
    }
  }

  team.profileMarks = marks;
}

// ------------------------------------------------------------
// Full team layer pass
// Two-pass baseline orchestration
// ------------------------------------------------------------
function computeAllTeamLayers(opts = MI_V2_DEFAULTS) {
  prepareResumeContextStatsV2();

  const teams = Object.values(TEAMS || {});

  // PASS 1: résumé trust + raw baseline pieces
  teams.forEach(team => {
    if (team.opp_ast_poss == null && team.oapp != null) {
      team.opp_ast_poss = team.oapp;
    }

    computeResumeContextForTeam(team, opts);
    computeCoreForTeam(team, opts);

    team.raw_base = Number.isFinite(team.foundation) ? team.foundation : 0;
    team.raw_base_v2 = team.raw_base;

    if (typeof computeProfileMarks === 'function') {
      computeProfileMarks(team);
    }
  });

  // PASS 2: field mean + final baseline
  const fieldMean = computeBaselineFieldMean(opts);

  teams.forEach(team => {
    computeMIBase(team, opts, fieldMean);
  });
}

// ---------- CIS / FAS Static Identity Profiles (v4.0) ----------

// Small helper: count strong/weak V2 core components from canonical domain rows
function getCoreFractions(team) {
  const rows = Array.isArray(team.coreDomainDetails) ? team.coreDomainDetails : [];

  if (!rows.length) {
    return {
      fStrong: 0,
      fWeak: 0,
      strongCount: 0,
      weakCount: 0
    };
  }

  let strongCount = 0;
  let weakCount = 0;
  let total = 0;

  rows.forEach(row => {
    const val = row?.value;
    if (typeof val !== 'number' || !Number.isFinite(val)) return;

    total++;

    if (val >= 0.80) strongCount++;
    else if (val < 0.50) weakCount++;
  });

  if (!total) {
    return {
      fStrong: 0,
      fWeak: 0,
      strongCount: 0,
      weakCount: 0
    };
  }

  return {
    fStrong: strongCount / total,
    fWeak: weakCount / total,
    strongCount,
    weakCount
  };
}

// Compute CIS_static and FAS_static for every team once per CSV load
function computeStaticIdentities() {
  const teams = Object.values(TEAMS || {});
  const n = teams.length;
  if (!n) return;

  // 1) Make sure V2 baseline + résumé trust are populated
  const needsResumeRefresh = teams.some(team =>
    typeof team.resumeBaseTrust !== 'number' || !Number.isFinite(team.resumeBaseTrust)
  );

  if (needsResumeRefresh) {
    prepareResumeContextStatsV2();
    teams.forEach(team => computeResumeContextForTeam(team));
  }

  teams.forEach(team => {
    if (typeof team.mi_base !== 'number' || !Number.isFinite(team.mi_base)) {
      computeMIBase(team);
    }
  });

  // 2) Performance percentile via rank-percentile of MI_base
  const sorted = teams
    .slice()
    .sort((a, b) => ((a.mi_base || 0) - (b.mi_base || 0)));

  const perfMap = new Map();
  sorted.forEach((team, idx) => {
    const P = (idx + 0.5) / n;
    perfMap.set(team.name, P);
  });

  // 3) Compute raw CIS/FAS
  let cisRawMax = 0;
  let fasRawMax = 0;

  teams.forEach(team => {
    const s = Number(team.seed);

    if (!Number.isFinite(s)) {
      team.performancePercentile = 0.5;

      team.coreStrongCount = 0;
      team.coreWeakCount = 0;
      team.coreStrongFrac = 0;
      team.coreWeakFrac = 0;

      team.cis_raw = 0;
      team.fas_raw = 0;
      return;
    }

    const P = perfMap.get(team.name) ?? 0.5;
    team.performancePercentile = P;

    const Sf = (17 - s) / 16;
    const Su = (s - 1) / 16;

    const delta = P - Sf;
    const deltaPlus = Math.max(0, delta);
    const APrime = 1 - Math.abs(delta);

    const { fStrong, fWeak, strongCount, weakCount } = getCoreFractions(team);
    team.coreStrongCount = strongCount;
    team.coreWeakCount = weakCount;
    team.coreStrongFrac = fStrong;
    team.coreWeakFrac = fWeak;

    const bCoreCIS = Math.max(0, fStrong - 0.5 * fWeak);
    const bCoreFAS = fStrong * (1 - fWeak);

    const baseTrust = (
      typeof team.resumeBaseTrust === 'number' &&
      Number.isFinite(team.resumeBaseTrust)
    ) ? team.resumeBaseTrust : 1.00;

    const Rplus = Math.max(0, Math.min(1, 0.5 + ((baseTrust - 1.00) / 0.4)));

    const xCIS =
      0.60 * deltaPlus +
      0.25 * bCoreCIS +
      0.15 * Rplus;

    const xFAS =
      0.50 * APrime +
      0.30 * bCoreFAS +
      0.20 * Rplus;

    const cisRaw = Su * xCIS;
    const fasRaw = Sf * xFAS;

    team.cis_raw = cisRaw;
    team.fas_raw = fasRaw;

    if (cisRaw > cisRawMax) cisRawMax = cisRaw;
    if (fasRaw > fasRawMax) fasRawMax = fasRaw;
  });

  const EPS = 1e-6;

  teams.forEach(team => {
    const cisRaw = Number.isFinite(team.cis_raw) ? team.cis_raw : 0;
    const fasRaw = Number.isFinite(team.fas_raw) ? team.fas_raw : 0;

    const cis = (cisRawMax > EPS && cisRaw > 0)
      ? (cisRaw / cisRawMax) * 100
      : 0;

    const fas = (fasRawMax > EPS && fasRaw > 0)
      ? (fasRaw / fasRawMax) * 100
      : 0;

    team.cisStatic_raw = cis;
    team.fasStatic_raw = fas;

    team.cisStatic = miDampenBaselineScore(cis, MI_IDENTITY_V38.capC, MI_IDENTITY_V38.gammaC);
    team.fasStatic = miDampenBaselineScore(fas, MI_IDENTITY_V38.capF, MI_IDENTITY_V38.gammaF);
  });
}

// ------------------------------------------------------------
// V4.2 MI_base
// raw_base = foundation
// mi_base = ResumeTrust * raw_base + (1 - ResumeTrust) * FieldMean
// ------------------------------------------------------------
function computeMIBase(team, opts = MI_V2_DEFAULTS, fieldMeanOverride = null) {
  const foundation = Number.isFinite(team.foundation)
    ? team.foundation
    : computeCoreForTeam(team, opts);

  const rawBase = Number.isFinite(foundation) ? foundation : 0;

  team.raw_base = rawBase;
  team.raw_base_v2 = rawBase;

  const baseTrust = opts.useResumeBaseTrust
    ? (Number.isFinite(team.resumeBaseTrust) ? team.resumeBaseTrust : 1.00)
    : 1.00;

  const fieldMean = Number.isFinite(fieldMeanOverride)
    ? fieldMeanOverride
    : computeBaselineFieldMean(opts);

  const miBase =
    (baseTrust * rawBase) +
    ((1 - baseTrust) * fieldMean);

  team.baseTrustApplied = baseTrust;
  team.baseTrustApplied_v2 = baseTrust;

  team.field_mean_base = fieldMean;
  team.field_mean_base_v2 = fieldMean;

  // retired as canonical math, but kept as compatibility mirror
  team.scaled_base = rawBase;
  team.scaled_base_v2 = rawBase;

  team.base = miBase;
  team.mi_base = miBase;
  team.mi_base_v2 = miBase;

  return miBase;
}

// ------------------------------------------------------------
// Interaction trust helper (legacy function name preserved)
// ------------------------------------------------------------
function getResumeInteractionFactor(team) {
  if (typeof team.resumeIntTrust === 'number') return team.resumeIntTrust;
  const tier = team.resumeTier || team.resumeRTier || 'Average';
  return getResumeInteractionFactorV2(tier);
}

// ------------------------------------------------------------
// V2 final MI
// ------------------------------------------------------------
function computeFinalMI(team, interactionAdj, opts = MI_V2_DEFAULTS) {
  const base = (typeof team.mi_base === 'number')
    ? team.mi_base
    : computeMIBase(team, opts);

  const intRaw = (typeof interactionAdj === 'number') ? interactionAdj : 0;

  const rFactor = opts.useResumeInteractionTrust
    ? (typeof team.resumeIntTrust === 'number' ? team.resumeIntTrust : getResumeInteractionFactor(team))
    : 1.00;

  const intAdj = intRaw * rFactor;
  const mi_matchup = base + intAdj;

  team.mi_matchup = mi_matchup;
  team.mi_matchup_v2 = mi_matchup;

  team.mi_int_raw = intRaw;
  team.mi_int_raw_v2 = intRaw;

  team.mi_int = intAdj;
  team.mi_int_v2 = intAdj;

  team.mi_int_rFact = rFactor;
  team.mi_int_rFact_v2 = rFactor;

  return mi_matchup;
}

function getTeamByName(name) {
  return TEAMS[name] || null;
}

// =========================================================
// Core Traits Profile Sections — Height Sync
// Sync the two big <section.profile-section.flip-tile> panels
// so both match the taller one.
// =========================================================
function syncCoreTraitsProfileSectionHeights() {
  const sections = document.querySelectorAll('section.profile-section.flip-tile');
  if (!sections || sections.length !== 2) return;

  const a = sections[0];
  const b = sections[1];

  // Reset so we don't lock an old larger size
  a.style.setProperty('--mi-profile-sync-h', 'auto');
  b.style.setProperty('--mi-profile-sync-h', 'auto');

  // Wait for any DOM writes (copy injection / flip class changes) to land
  requestAnimationFrame(() => {
    const hA = a.scrollHeight || 0;
    const hB = b.scrollHeight || 0;
    const maxH = Math.max(hA, hB);

    if (maxH > 0) {
      const px = `${maxH}px`;
      a.style.setProperty('--mi-profile-sync-h', px);
      b.style.setProperty('--mi-profile-sync-h', px);
    }
  });
}

/* =========================================================
   PROFILE MARKS — HEIGHT EQUALIZER
   - Measures front/back for each marks tile
   - Takes the tallest face per tile
   - Then normalizes Tile A and Tile B to the same height
   ========================================================= */

function measureFaceHeight(faceEl, widthPx) {
  if (!faceEl) return 0;

  // Clone into an offscreen measurer so transforms/flip layout don't lie.
  const clone = faceEl.cloneNode(true);

  // Strip flip-related layout effects
  clone.style.transform = 'none';
  clone.style.position = 'static';
  clone.style.height = 'auto';
  clone.style.minHeight = '0';
  clone.style.maxHeight = 'none';
  clone.style.overflow = 'visible';
  clone.style.backfaceVisibility = 'visible';

  const measurer = document.createElement('div');
  measurer.style.position = 'absolute';
  measurer.style.left = '-99999px';
  measurer.style.top = '0';
  measurer.style.visibility = 'hidden';
  measurer.style.pointerEvents = 'none';
  measurer.style.width = (widthPx ? `${widthPx}px` : '600px');

  measurer.appendChild(clone);
  document.body.appendChild(measurer);

  // offsetHeight tends to be the most reliable “rendered” height.
  const h = measurer.offsetHeight || clone.scrollHeight || 0;

  document.body.removeChild(measurer);
  return h;
}

function computeMarksTileNeededHeight(tileEl) {
  if (!tileEl) return 0;

  const inner = tileEl.querySelector('.flip-tile-inner');
  const front = tileEl.querySelector('.tile-face.tile-front');

  const width = (inner && inner.clientWidth) ? inner.clientWidth : tileEl.clientWidth;

  // Measure ONLY the FRONT face for footprint.
  const hFront = measureFaceHeight(front, width);

  // Tiny buffer so borders/glows never clip.
  return (hFront || 0) + 2;
}

function equalizeProfileMarksTiles() {
  const tileA = document.getElementById('marksTileA');
  const tileB = document.getElementById('marksTileB');
  if (!tileA || !tileB) return;

  // Clear previous front height so measurement isn't poisoned.
  tileA.style.removeProperty('--marks-front-h');
  tileB.style.removeProperty('--marks-front-h');

  const neededA = computeMarksTileNeededHeight(tileA);
  const neededB = computeMarksTileNeededHeight(tileB);

  // Normalize both tiles to the taller FRONT.
  const target = Math.max(neededA, neededB);

  // Fallback min so 0-marks doesn't collapse too hard.
  const finalH = Math.max(180, Math.round(target));

  tileA.style.setProperty('--marks-front-h', `${finalH}px`);
  tileB.style.setProperty('--marks-front-h', `${finalH}px`);
}

// Keep it stable on resize
(function bindMarksEqualizer() {
  let t = null;
  window.addEventListener('resize', () => {
    window.clearTimeout(t);
    t = window.setTimeout(() => {
      equalizeProfileMarksTiles();
    }, 80);
  });
})();

// ------------------------------------------------------------
// Volatility Meter Helpers
// Matchup-level overlay (separate from interaction scoring)
// ------------------------------------------------------------

function miSigmoid(x, k = 1.0) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return 1 / (1 + Math.exp(-k * n));
}

function miSafeZ(team, key, inverted = false) {
  return getZ(team, key, inverted) || 0;
}

function miAvg(a, b) {
  return (a + b) / 2;
}

function miAbsGap(a, b) {
  return Math.abs(a - b);
}

// Small, conditional 3P% modifier:
// 3P% only matters when the matchup is already above-average in 3P volume.
function computeThreePointPercentageModifier(a, b) {
  const avg_z_3pp = miAvg(
    miSafeZ(a, 'threepp'),
    miSafeZ(b, 'threepp')
  );

  const avg_z_3pr = miAvg(
    miSafeZ(a, 'threepr'),
    miSafeZ(b, 'threepr')
  );

  return avg_z_3pp * Math.max(0, avg_z_3pr);
}

function computeTempoVolRaw(a, b) {
  const zTempoA = miSafeZ(a, 'tempo');
  const zTempoB = miSafeZ(b, 'tempo');

  const avg_z_tempo = miAvg(zTempoA, zTempoB);
  const abs_z_tempo_gap = miAbsGap(zTempoA, zTempoB);

  return 0.55 * avg_z_tempo + 0.45 * abs_z_tempo_gap;
}

function computeEPRVolRaw(a, b) {
  const zEPRA = miSafeZ(a, 'epr');
  const zEPRB = miSafeZ(b, 'epr');

  const avg_z_epr = miAvg(zEPRA, zEPRB);
  const inverse_avg_z_epr = -avg_z_epr;
  const abs_z_epr_gap = miAbsGap(zEPRA, zEPRB);

  return 0.60 * inverse_avg_z_epr + 0.40 * abs_z_epr_gap;
}

function computeSCPGVolRaw(a, b) {
  const zSCPGA = miSafeZ(a, 'scpg');
  const zSCPGB = miSafeZ(b, 'scpg');

  const avg_z_scpg = miAvg(zSCPGA, zSCPGB);
  const abs_z_scpg_gap = miAbsGap(zSCPGA, zSCPGB);

  return 0.60 * avg_z_scpg + 0.40 * abs_z_scpg_gap;
}

function computeThreePointVolRaw(a, b) {
  const z3PRA = miSafeZ(a, 'threepr');
  const z3PRB = miSafeZ(b, 'threepr');

  const zPct3A = miSafeZ(a, 'pct_pts_3');
  const zPct3B = miSafeZ(b, 'pct_pts_3');

  const avg_z_3pr = miAvg(z3PRA, z3PRB);
  const avg_z_pct_pts_3 = miAvg(zPct3A, zPct3B);
  const abs_z_3pr_gap = miAbsGap(z3PRA, z3PRB);

  const three_point_percentage_modifier =
    computeThreePointPercentageModifier(a, b);

  return (
    0.45 * avg_z_3pr +
    0.35 * avg_z_pct_pts_3 +
    0.15 * abs_z_3pr_gap +
    0.05 * three_point_percentage_modifier
  );
}

function getVolatilityTier(score100) {
  const s = Number(score100) || 1;
  if (s >= 85) return 'Extreme';
  if (s >= 70) return 'High';
  if (s >= 50) return 'Moderate';
  if (s >= 30) return 'Low';
  return 'Stable';
}

function miDriverSide(delta, threshold = 0.18) {
  const d = Number(delta) || 0;
  if (Math.abs(d) < threshold) return 'balanced';
  return d > 0 ? 'A' : 'B';
}

function miDriverLabel(side, aName, bName) {
  if (side === 'A') return `${aName} ▲`;
  if (side === 'B') return `${bName} ▲`;
  return 'Balanced';
}

function miShortDriverLabel(side) {
  if (side === 'A') return '▲ A';
  if (side === 'B') return '▲ B';
  return '=';
}

function computeVolatilityOwnership(a, b) {
  const zTempoA = miSafeZ(a, 'tempo');
  const zTempoB = miSafeZ(b, 'tempo');

  const z3PRA = miSafeZ(a, 'threepr');
  const z3PRB = miSafeZ(b, 'threepr');
  const zPct3A = miSafeZ(a, 'pct_pts_3');
  const zPct3B = miSafeZ(b, 'pct_pts_3');

  const zEPRA = miSafeZ(a, 'epr');
  const zEPRB = miSafeZ(b, 'epr');

  const zSCPGA = miSafeZ(a, 'scpg');
  const zSCPGB = miSafeZ(b, 'scpg');

  const tempoDelta = zTempoA - zTempoB;
  const threeDelta = (0.60 * (z3PRA - z3PRB)) + (0.40 * (zPct3A - zPct3B));
  const eprDelta = zEPRA - zEPRB;
  const scpgDelta = zSCPGA - zSCPGB;

  const tempoSide = miDriverSide(tempoDelta, 0.15);
  const threeSide = miDriverSide(threeDelta, 0.15);
  const eprSide = miDriverSide(eprDelta, 0.15);
  const scpgSide = miDriverSide(scpgDelta, 0.15);

  return {
    tempo: {
      delta: tempoDelta,
      side: tempoSide,
      short: miShortDriverLabel(tempoSide),
      label: miDriverLabel(tempoSide, a.name, b.name)
    },
    threePoint: {
      delta: threeDelta,
      side: threeSide,
      short: miShortDriverLabel(threeSide),
      label: miDriverLabel(threeSide, a.name, b.name)
    },
    epr: {
      delta: eprDelta,
      side: eprSide,
      short: miShortDriverLabel(eprSide),
      label: miDriverLabel(eprSide, a.name, b.name)
    },
    scpg: {
      delta: scpgDelta,
      side: scpgSide,
      short: miShortDriverLabel(scpgSide),
      label: miDriverLabel(scpgSide, a.name, b.name)
    }
  };
}

function computeChaosProfile(a, b, ownership) {
  let aChaosPoints = 0;
  let bChaosPoints = 0;

  if (ownership.tempo.side === 'A') aChaosPoints += 1.0;
  if (ownership.tempo.side === 'B') bChaosPoints += 1.0;

  if (ownership.threePoint.side === 'A') aChaosPoints += 1.2;
  if (ownership.threePoint.side === 'B') bChaosPoints += 1.2;

  if (ownership.epr.side === 'A') aChaosPoints += 0.8;
  if (ownership.epr.side === 'B') bChaosPoints += 0.8;

  if (ownership.scpg.side === 'A') aChaosPoints += 1.0;
  if (ownership.scpg.side === 'B') bChaosPoints += 1.0;

  const diff = aChaosPoints - bChaosPoints;

  let beneficiary = 'balanced';
  if (diff > 0.35) beneficiary = 'A';
  else if (diff < -0.35) beneficiary = 'B';

  const thresholdBase = 54;
  const thresholdShift = Math.min(10, Math.abs(diff) * 4.5);
  const threshold = beneficiary === 'balanced'
    ? 50
    : Math.round(thresholdBase - thresholdShift);

  return {
    beneficiary,
    thresholdScore: miClamp(threshold, 18, 82),
    aChaosPoints,
    bChaosPoints,
    liveSide:
      beneficiary === 'A' ? (a.name || 'Team A')
      : beneficiary === 'B' ? (b.name || 'Team B')
      : 'Neither side'
  };
}

function computeMatchupVolatility(a, b, opts = {}) {
  const k = Number.isFinite(opts.k) ? opts.k : 1.0;

  const tempoRaw = computeTempoVolRaw(a, b);
  const eprRaw = computeEPRVolRaw(a, b);
  const scpgRaw = computeSCPGVolRaw(a, b);
  const threeRaw = computeThreePointVolRaw(a, b);

  const tempoVol = miSigmoid(tempoRaw, k);
  const eprVol = miSigmoid(eprRaw, k);
  const scpgVol = miSigmoid(scpgRaw, k);
  const threeVol = miSigmoid(threeRaw, k);

  const volatility01 =
    0.25 * tempoVol +
    0.25 * threeVol +
    0.25 * eprVol +
    0.25 * scpgVol;

  const volatility100 = Math.round(1 + 99 * volatility01);

  const ownership = computeVolatilityOwnership(a, b);
  const chaosProfile = computeChaosProfile(a, b, ownership);

  return {
    score01: volatility01,
    score100: volatility100,
    tier: getVolatilityTier(volatility100),

    quarters: {
      tempo: {
        raw: tempoRaw,
        norm: tempoVol,
        ownership: ownership.tempo
      },
      threePoint: {
        raw: threeRaw,
        norm: threeVol,
        modifier: computeThreePointPercentageModifier(a, b),
        ownership: ownership.threePoint
      },
      epr: {
        raw: eprRaw,
        norm: eprVol,
        ownership: ownership.epr
      },
      scpg: {
        raw: scpgRaw,
        norm: scpgVol,
        ownership: ownership.scpg
      }
    },

    chaos: chaosProfile,

    drivers: {
      avg_z_tempo: miAvg(miSafeZ(a, 'tempo'), miSafeZ(b, 'tempo')),
      abs_z_tempo_gap: miAbsGap(miSafeZ(a, 'tempo'), miSafeZ(b, 'tempo')),

      avg_z_3pr: miAvg(miSafeZ(a, 'threepr'), miSafeZ(b, 'threepr')),
      avg_z_pct_pts_3: miAvg(miSafeZ(a, 'pct_pts_3'), miSafeZ(b, 'pct_pts_3')),
      abs_z_3pr_gap: miAbsGap(miSafeZ(a, 'threepr'), miSafeZ(b, 'threepr')),

      avg_z_epr: miAvg(miSafeZ(a, 'epr'), miSafeZ(b, 'epr')),
      inverse_avg_z_epr: -miAvg(miSafeZ(a, 'epr'), miSafeZ(b, 'epr')),
      abs_z_epr_gap: miAbsGap(miSafeZ(a, 'epr'), miSafeZ(b, 'epr')),

      avg_z_scpg: miAvg(miSafeZ(a, 'scpg'), miSafeZ(b, 'scpg')),
      abs_z_scpg_gap: miAbsGap(miSafeZ(a, 'scpg'), miSafeZ(b, 'scpg'))
    }
  };
}

function miClamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function getVolatilityTierClass(tier) {
  switch (String(tier || '').toLowerCase()) {
    case 'low': return 'is-low';
    case 'moderate': return 'is-moderate';
    case 'high': return 'is-high';
    case 'extreme': return 'is-extreme';
    default: return 'is-stable';
  }
}

function getVolatilityTierKey(volatility) {
  const tier = String(volatility?.tier || getVolatilityTier(volatility?.score100 || 1) || 'stable')
    .trim()
    .toLowerCase();

  if (tier === 'stable') return 'stable';
  if (tier === 'low') return 'low';
  if (tier === 'moderate') return 'moderate';
  if (tier === 'high') return 'high';
  if (tier === 'extreme') return 'extreme';
  return 'stable';
}

function buildVolatilitySummaryText(volatility) {
  if (!volatility) {
    return miGetCopy(
      'volatility.copy.environment.empty',
      'Run a matchup to populate the volatility environment.'
    );
  }

  const tierKey = getVolatilityTierKey(volatility);

  return miGetCopy(
    `volatility.copy.environment.${tierKey}`,
    miGetCopy(
      'volatility.copy.environment.empty',
      'Run a matchup to populate the volatility environment.'
    )
  );
}

function buildVolatilityChaosLineText(result) {
  const volatility = result?.volatility || null;
  const chaos = volatility?.chaos || null;

  if (!volatility || !chaos) {
    return miGetCopy(
      'volatility.copy.chaos_line.empty',
      'Run a matchup to reveal the chaos line.'
    );
  }

  if (chaos.beneficiary === 'A') {
    const tpl = miGetCopy(
      'volatility.copy.chaos_line.favors_a',
      'Chaos line: {{threshold}} • above this, {{team}} benefits more from volatility.'
    );
    return miFillTemplate(tpl, {
      threshold: chaos.thresholdScore,
      team: result?.a?.name || chaos.liveSide || 'Team A'
    });
  }

  if (chaos.beneficiary === 'B') {
    const tpl = miGetCopy(
      'volatility.copy.chaos_line.favors_b',
      'Chaos line: {{threshold}} • above this, {{team}} benefits more from volatility.'
    );
    return miFillTemplate(tpl, {
      threshold: chaos.thresholdScore,
      team: result?.b?.name || chaos.liveSide || 'Team B'
    });
  }

  return miGetCopy(
    'volatility.copy.chaos_line.balanced',
    'Chaos line: balanced matchup • neither side shows a strong volatility ownership edge.'
  );
}

function miVolGaugeClamp(v, min = 0, max = 100) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/*
  Tick coordinates need true polar angles around the circle:
    0   => 180deg (left)
    50  => 270deg (top)
    100 => 360deg (right)
*/
function miVolGaugePolarAngle(score100) {
  return 180 + (miVolGaugeClamp(score100, 0, 100) * 1.8);
}

function initVolatilityGaugeTicks() {
  const ticksRoot = document.getElementById("volatilityGaugeTicks");
  if (!ticksRoot || ticksRoot.dataset.ready === "1") return;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const cx = 170;
  const cy = 170;
  const rOuter = 136;

  ticksRoot.innerHTML = "";

  for (let value = 0; value <= 100; value += 5) {
    const angleDeg = miVolGaugePolarAngle(value);
    const angleRad = angleDeg * Math.PI / 180;
    const isMajor = value % 10 === 0;

    const rInner = isMajor ? 112 : 120;

    const x1 = cx + Math.cos(angleRad) * rInner;
    const y1 = cy + Math.sin(angleRad) * rInner;
    const x2 = cx + Math.cos(angleRad) * rOuter;
    const y2 = cy + Math.sin(angleRad) * rOuter;

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", x1.toFixed(2));
    line.setAttribute("y1", y1.toFixed(2));
    line.setAttribute("x2", x2.toFixed(2));
    line.setAttribute("y2", y2.toFixed(2));
    line.setAttribute("class", isMajor ? "is-major" : "is-minor");

    ticksRoot.appendChild(line);
  }

  ticksRoot.dataset.ready = "1";
}

function renderVolatilityGauge(score100 = 0, chaosThreshold = 50) {
  initVolatilityGaugeTicks();

  const score = miVolGaugeClamp(score100, 0, 100);

  const fill = document.getElementById("volatilityGaugeFill");
  const scoreText = document.getElementById("volatilityScoreValue");
  const gaugeShell = document.getElementById("volatilityGauge");

  if (fill) {
    fill.setAttribute("stroke-dasharray", `${score} 100`);
  }

  if (scoreText) {
    scoreText.textContent = Number.isFinite(score) ? String(Math.round(score)) : "—";
  }

  if (gaugeShell) {
    gaugeShell.dataset.score = String(Math.round(score));
    gaugeShell.dataset.threshold = String(Math.round(miVolGaugeClamp(chaosThreshold, 0, 100)));
  }
}

function renderVolatilityMeter(result) {
  const volatility = result?.volatility || null;

  const gaugeEl = document.getElementById('volatilityGauge');
  const scoreEl = document.getElementById('volatilityScoreValue');
  const tierEl = document.getElementById('volatilityTierPill');
  const summaryEl = document.getElementById('volatilitySummaryText');
  const thresholdTextEl = document.getElementById('volatilityThresholdText');

  const qTempo = document.getElementById('volQuarterTempo');
  const qThree = document.getElementById('volQuarterThree');
  const qEpr = document.getElementById('volQuarterEpr');
  const qScpg = document.getElementById('volQuarterScpg');

  const qTempoValue = document.getElementById('volQuarterTempoValue');
  const qThreeValue = document.getElementById('volQuarterThreeValue');
  const qEprValue = document.getElementById('volQuarterEprValue');
  const qScpgValue = document.getElementById('volQuarterScpgValue');

  const qTempoDriver = document.getElementById('volQuarterTempoDriver');
  const qThreeDriver = document.getElementById('volQuarterThreeDriver');
  const qEprDriver = document.getElementById('volQuarterEprDriver');
  const qScpgDriver = document.getElementById('volQuarterScpgDriver');

  const qTempoLean = document.getElementById('volQuarterTempoLean');
  const qThreeLean = document.getElementById('volQuarterThreeLean');
  const qEprLean = document.getElementById('volQuarterEprLean');
  const qScpgLean = document.getElementById('volQuarterScpgLean');

  if (!gaugeEl || !scoreEl || !tierEl || !summaryEl) return;

  const setDriverState = (el, side, text) => {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('is-a', 'is-b', 'is-balanced');

    if (side === 'A') el.classList.add('is-a');
    else if (side === 'B') el.classList.add('is-b');
    else el.classList.add('is-balanced');
  };

  const resetQuarter = (fillEl, valueEl, driverEl, leanEl) => {
    if (fillEl) fillEl.style.width = '0%';
    if (valueEl) valueEl.textContent = '—';
    setDriverState(driverEl, 'balanced', 'Balanced');
    if (leanEl) leanEl.textContent = '—';
  };

  if (!volatility) {
    renderVolatilityGauge(0, 50);

    scoreEl.textContent = '—';
    tierEl.textContent = 'Stable';
    tierEl.className = 'volatility-tier-pill is-stable';
    summaryEl.textContent = buildVolatilitySummaryText(null);

    if (thresholdTextEl) {
      thresholdTextEl.textContent = buildVolatilityChaosLineText(null);
    }

    resetQuarter(qTempo, qTempoValue, qTempoDriver, qTempoLean);
    resetQuarter(qThree, qThreeValue, qThreeDriver, qThreeLean);
    resetQuarter(qEpr, qEprValue, qEprDriver, qEprLean);
    resetQuarter(qScpg, qScpgValue, qScpgDriver, qScpgLean);

    return;
  }

  const score100 = miClamp(volatility?.score100, 0, 100);
  const tier = volatility?.tier || getVolatilityTier(score100);
  const chaosThreshold = miClamp(volatility?.chaos?.thresholdScore ?? 50, 0, 100);

  const tempoPct = Math.round(100 * miClamp(volatility?.quarters?.tempo?.norm ?? 0, 0, 1));
  const threePct = Math.round(100 * miClamp(volatility?.quarters?.threePoint?.norm ?? 0, 0, 1));
  const eprPct = Math.round(100 * miClamp(volatility?.quarters?.epr?.norm ?? 0, 0, 1));
  const scpgPct = Math.round(100 * miClamp(volatility?.quarters?.scpg?.norm ?? 0, 0, 1));

  renderVolatilityGauge(score100, chaosThreshold);

  scoreEl.textContent = String(score100);
  tierEl.textContent = tier;
  tierEl.className = `volatility-tier-pill ${getVolatilityTierClass(tier)}`;
  summaryEl.textContent = buildVolatilitySummaryText(volatility);

  if (thresholdTextEl) {
    thresholdTextEl.textContent = buildVolatilityChaosLineText(result);
  }

  if (qTempo) qTempo.style.width = `${tempoPct}%`;
  if (qThree) qThree.style.width = `${threePct}%`;
  if (qEpr) qEpr.style.width = `${eprPct}%`;
  if (qScpg) qScpg.style.width = `${scpgPct}%`;

  if (qTempoValue) qTempoValue.textContent = `${tempoPct}`;
  if (qThreeValue) qThreeValue.textContent = `${threePct}`;
  if (qEprValue) qEprValue.textContent = `${eprPct}`;
  if (qScpgValue) qScpgValue.textContent = `${scpgPct}`;

  const ownTempo = volatility?.quarters?.tempo?.ownership || {};
  const ownThree = volatility?.quarters?.threePoint?.ownership || {};
  const ownEpr = volatility?.quarters?.epr?.ownership || {};
  const ownScpg = volatility?.quarters?.scpg?.ownership || {};

  setDriverState(qTempoDriver, ownTempo.side, ownTempo.label || 'Balanced');
  setDriverState(qThreeDriver, ownThree.side, ownThree.label || 'Balanced');
  setDriverState(qEprDriver, ownEpr.side, ownEpr.label || 'Balanced');
  setDriverState(qScpgDriver, ownScpg.side, ownScpg.label || 'Balanced');

  if (qTempoLean) qTempoLean.textContent = ownTempo.short || '=';
  if (qThreeLean) qThreeLean.textContent = ownThree.short || '=';
  if (qEprLean) qEprLean.textContent = ownEpr.short || '=';
  if (qScpgLean) qScpgLean.textContent = ownScpg.short || '=';
}

function resetVolatilityMeter() {
  renderVolatilityMeter({ volatility: null });
}

// ------------------------------------------------------------
// Matchup comparison - live engine entry point
// Baseline now uses split breadth embedded into foundation
// ------------------------------------------------------------
function compareTeams(teamAName, teamBName, roleMode = 'auto', opts = MI_V2_DEFAULTS) {
  const a = getTeamByName(teamAName);
  const b = getTeamByName(teamBName);

  if (!a || !b) {
    console.error('Invalid team selection:', teamAName, teamBName);
    return;
  }

  if (a.opp_ast_poss == null && a.oapp != null) a.opp_ast_poss = a.oapp;
  if (b.opp_ast_poss == null && b.oapp != null) b.opp_ast_poss = b.oapp;

  // Ensure full-field résumé stats exist
  prepareResumeContextStatsV2();

  // Refresh selected teams
  computeResumeContextForTeam(a, opts);
  computeResumeContextForTeam(b, opts);

  // Canonical core pass now includes split breadth inside foundation
  computeCoreForTeam(a, opts);
  computeCoreForTeam(b, opts);

  // Field-wide baseline calibration
  const fieldMean = computeBaselineFieldMean(opts);

  const baseA = computeMIBase(a, opts, fieldMean);
  const baseB = computeMIBase(b, opts, fieldMean);

  const interactions = computeInteractions(a, b);
  const volatility = computeMatchupVolatility(a, b);  

  const activeRound = CURRENT_ROUND;
  const seedMeta = getSeedRoundMeta(a.seed, b.seed, activeRound);

  const miA_raw = computeFinalMI(a, interactions.a, opts);
  const miB_raw = computeFinalMI(b, interactions.b, opts);

  const intA = miA_raw - baseA;
  const intB = miB_raw - baseB;

  const base_diff = baseA - baseB;
  const int_diff  = intA - intB;
  
  const final_delta = miA_raw - miB_raw;

  const activeRoleMode = roleMode || 'auto';
  const roleAssignment = resolveIdentityContext(a, b, activeRound);

  const result = {
    a,
    b,
    baseA,
    baseB,
    interactions,
    volatility,
    miA_raw,
    miB_raw,
    intA,
    intB,
    base_diff,
    int_diff,
    final_delta,
    roleMode: activeRoleMode,
    activeRound,
    seedMeta,
    roles: roleAssignment,
    v2: {
      fieldMean,

      // Final baseline values
      baseA,
      baseB,
      rawBaseA: Number.isFinite(a.raw_base) ? a.raw_base : a.foundation,
      rawBaseB: Number.isFinite(b.raw_base) ? b.raw_base : b.foundation,

      // Canonical adjusted foundation
      foundationA: a.foundation,
      foundationB: b.foundation,

      // Resume trust
      resumeA: a.resumeBaseTrust,
      resumeB: b.resumeBaseTrust,

      // Base efficiency signals
      miOffEffBaseA: a.mi_off_eff_base,
      miOffEffBaseB: b.mi_off_eff_base,
      miDefEffBaseA: a.mi_def_eff_base,
      miDefEffBaseB: b.mi_def_eff_base,
      miEffMarginBaseA: a.mi_eff_margin_base,
      miEffMarginBaseB: b.mi_eff_margin_base,

      // Split breadth adjustments
      offBreadthA: a.offBreadth,
      offBreadthB: b.offBreadth,
      defBreadthA: a.defBreadth,
      defBreadthB: b.defBreadth,

      offBreadthSDA: a.offBreadthSD,
      offBreadthSDB: b.offBreadthSD,
      defBreadthSDA: a.defBreadthSD,
      defBreadthSDB: b.defBreadthSD,

      // Adjusted efficiency signals
      miOffEffA: a.mi_off_eff,
      miOffEffB: b.mi_off_eff,
      miDefEffA: a.mi_def_eff,
      miDefEffB: b.mi_def_eff,
      miEffMarginA: a.mi_eff_margin,
      miEffMarginB: b.mi_eff_margin,

      // Compatibility-only aggregate breadth mirrors
      breadthA: a.breadth,
      breadthB: b.breadth,
      breadthSDA: a.breadthSD,
      breadthSDB: b.breadthSD
    }
  };

  window.LAST_RESULT = result;

  renderTeamCards(result);
  miUpdateMatchupLensHeaders(result);
  renderProfileMarks(a, "inlineMarksA");
  renderProfileMarks(b, "inlineMarksB");
  renderInteractionsTable(result);
  renderVolatilityMeter(result);
  renderInteractionsConsole(result);
  renderSummary(result);
  
  miApplyCanonicalTeamHeaderBranding(a.name, b.name);
  miApplyScorebugAmbientBranding(a.name, b.name);
 
  updateMatchupBarFromDOM();
  updateCoreBacksForResult(result);
  updateBreadthBacksForResult(result);
  updateResumeBacksForResult(result);
  updateMarksBacksForResult(result);
  updateFormulaBacksForResult(result);
  updateIdentityBacksForResult(result);

  const copy = window.MI_COPY;
  if (copy) {
    updateMadnessBacksForResult(result, window.MI_COPY, roleMode);
  }

  miPushLogFromResult(result);
  miRenderShelf();
  syncCoreTraitsProfileSectionHeights();

  console.log('V2 RESULT', result);
  return result;
}

// Optional convenience alias if you still call compareTeamsV2 anywhere
function compareTeamsV2(teamAName, teamBName, roleMode = 'auto', opts = MI_V2_DEFAULTS) {
  return compareTeams(teamAName, teamBName, roleMode, opts);
}

// ---------- DOM Hooks ----------

function populateTeamDropdowns() {
  const selectA =
    document.getElementById('teamA') ||
    document.getElementById('teamASelect') ||
    document.getElementById('cindTeamSelect');
  const selectB =
    document.getElementById('teamB') ||
    document.getElementById('teamBSelect') ||
    document.getElementById('favTeamSelect');

  if (!selectA || !selectB) return;

  selectA.innerHTML = '<option value="" disabled selected>Select Team A</option>';
  selectB.innerHTML = '<option value="" disabled selected>Select Team B</option>';

  // 1) Populate options fully first
  TEAM_LIST.slice().sort().forEach(name => {
    const optA = document.createElement('option');
    optA.value = name;
    optA.textContent = name;
    selectA.appendChild(optA);

    const optB = document.createElement('option');
    optB.value = name;
    optB.textContent = name;
    selectB.appendChild(optB);
  });

  // Always reset both team selects to placeholder after rebuilding options
  // so no orphaned team from a previous dataset can survive.
  forceTeamSelectPlaceholder(selectA, 'Select Team A');
  forceTeamSelectPlaceholder(selectB, 'Select Team B');

  // 2) Mount searchable dropdown UI once
  const wrapA = document.getElementById('teamASelectWrap');
  const wrapB = document.getElementById('teamBSelectWrap');

  const ctxA = selectA.getAttribute('data-dd-context') || (wrapA && wrapA.getAttribute('data-dd-context')) || '';
  const ctxB = selectB.getAttribute('data-dd-context') || (wrapB && wrapB.getAttribute('data-dd-context')) || '';

  if (wrapA) ensureSearchableTeamDropdown(selectA, wrapA, 'Select Team A', ctxA);
  if (wrapB) ensureSearchableTeamDropdown(selectB, wrapB, 'Select Team B', ctxB);

  // Force the visible searchable-dropdown buttons back to placeholder too.
  if (wrapA) syncSearchableTeamDropdownUi(selectA, wrapA, 'Select Team A');
  if (wrapB) syncSearchableTeamDropdownUi(selectB, wrapB, 'Select Team B');

  // 3) listeners
  if (!selectA.__miTeamChangeBound || !selectB.__miTeamChangeBound) {
    let lastTeamsOk = false;

    const onTeamChange = () => {
      updateRoundOptionsForCurrentSeeds();
      updateInteractionHeadersFromSelections();
      updatePreMatchupHubProgress();
      refreshCompareButtonState();

      const teamsOk = getSelectedTeams().ok;
      const roundReady = isRoundSelected();

      if (!lastTeamsOk && teamsOk && !roundReady && !MI_ROUND_TOUCHED && !MI_ROUND_NUDGE_SHOWN) {
        MI_ROUND_NUDGE_SHOWN = true;
        nudgeRoundSelector();
      }

      lastTeamsOk = teamsOk;
    };

    if (!selectA.__miTeamChangeBound) {
      selectA.addEventListener('change', onTeamChange);
      selectA.__miTeamChangeBound = true;
    }

    if (!selectB.__miTeamChangeBound) {
      selectB.addEventListener('change', onTeamChange);
      selectB.__miTeamChangeBound = true;
    }
  }

  // Re-emit empty selection state so all downstream workflow logic
  // treats the newly loaded dataset as unselected until the user picks teams.
  selectA.dispatchEvent(new Event('change', { bubbles: true }));
  selectB.dispatchEvent(new Event('change', { bubbles: true }));

  updatePreMatchupHubProgress();
  updateRoundOptionsForCurrentSeeds();
  refreshCompareButtonState();
}

function miNorm(s) {
  return (s || '').toLowerCase().trim();
}

function miEscapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

function miHighlight(name, q) {
  const n = name;
  const query = miNorm(q);
  if (!query) return miEscapeHtml(n);

  const idx = miNorm(n).indexOf(query);
  if (idx < 0) return miEscapeHtml(n);

  const a = miEscapeHtml(n.slice(0, idx));
  const b = miEscapeHtml(n.slice(idx, idx + query.length));
  const c = miEscapeHtml(n.slice(idx + query.length));
  return `${a}<mark>${b}</mark>${c}`;
}

function miRankMatch(name, q) {
  const n = miNorm(name);
  const query = miNorm(q);
  if (!query) return 999;

  // Only match beginning of full team name
  if (n.startsWith(query)) return 0;

  return 999;
}

function ensureSearchableTeamDropdown(selectEl, wrapEl, placeholderText, contextKey) {
  if (!selectEl || !wrapEl) return;

  // Already mounted?
  if (wrapEl.querySelector('.mi-team-dd')) return;

  // Hide the native select but keep it functional for existing code
  selectEl.style.position = 'absolute';
  selectEl.style.opacity = '0';
  selectEl.style.pointerEvents = 'none';
  selectEl.style.width = '1px';
  selectEl.style.height = '1px';

  // Build base structure
  const root = document.createElement('div');
  root.className = 'mi-team-dd';

  // ✅ Context hook for CSS scoping
  const ctx = contextKey || selectEl.getAttribute('data-dd-context') || wrapEl.getAttribute('data-dd-context') || '';
  if (ctx) root.setAttribute('data-dd-context', ctx);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mi-team-dd-btn';
  btn.innerHTML = `<span class="mi-label">${miEscapeHtml(placeholderText)}</span><span class="mi-chev">▾</span>`;

  const panel = document.createElement('div');
  panel.className = 'mi-team-dd-panel';
  panel.hidden = true;

  const search = document.createElement('input');
  search.className = 'mi-team-dd-search';
  search.type = 'search';
  search.placeholder = 'Type to search:';
  search.autocomplete = 'off';
  search.spellcheck = false;

  const list = document.createElement('div');
  list.className = 'mi-team-dd-list';

  panel.appendChild(search);
  panel.appendChild(list);
  root.appendChild(btn);
  root.appendChild(panel);

  // Put our UI in the wrap (keep whatever else you already have in there)
  wrapEl.appendChild(root);

  // Pull team names from current <option> list (so it respects your population logic)
  const getNames = () =>
    Array.from(selectEl.options)
      .map(o => o.value)
      .filter(v => v && v.trim().length);

  let activeIndex = -1;
  let currentResults = [];
  let hasKeyboardNav = false;

  function renderResults(q) {
    const names = getNames();

    currentResults = names
      .map(name => ({ name, rank: miRankMatch(name, q) }))
      .filter(x => x.rank < 999)
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
      .map(x => x.name);

    // If empty query, show top alphabetical list (but don’t overwhelm)
    if (!miNorm(q)) {
      currentResults = names.slice().sort((a, b) => a.localeCompare(b));
    }

    // Hard cap render to keep it snappy
    const slice = currentResults.slice(0, 80);

    list.innerHTML = slice.map((name, i) => {
      const html = miHighlight(name, q);
      return `<button type="button" class="mi-team-dd-item" data-idx="${i}" data-name="${miEscapeHtml(name)}">${html}</button>`;
    }).join('');

    activeIndex = -1;
    hasKeyboardNav = false;
    syncActive();
  }

  function syncActive() {
    const items = list.querySelectorAll('.mi-team-dd-item');
    items.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));

    // ✅ Only auto-scroll the list when the user is navigating with keys
    if (hasKeyboardNav && activeIndex >= 0 && items[activeIndex]) {
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  function openPanel() {
    panel.hidden = false;
    search.value = '';
    renderResults('');
    // focus after render
    setTimeout(() => search.focus(), 0);
  }

  function closePanel() {
    panel.hidden = true;
  }

  function setValue(name) {
    selectEl.value = name;
    // Update button label to selected team
    const label = btn.querySelector('.mi-label');
    if (label) label.textContent = name;

    // Trigger your existing listeners
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    closePanel();
  }

  // Open/close behavior
  btn.addEventListener('click', () => {
    if (panel.hidden) openPanel();
    else closePanel();
  });

  // Click outside closes
  document.addEventListener('mousedown', (e) => {
    if (!root.contains(e.target)) closePanel();
  });

  // Live filter
  search.addEventListener('input', () => {
    renderResults(search.value);
  });

  // Keyboard nav
  search.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('.mi-team-dd-item');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
     e.preventDefault();
     if (!hasKeyboardNav) {
       hasKeyboardNav = true;
       activeIndex = 0;
     } else {
       activeIndex = Math.min(activeIndex + 1, items.length - 1);
     }
     syncActive();
   } else if (e.key === 'ArrowUp') {
     e.preventDefault();
     if (!hasKeyboardNav) {
       hasKeyboardNav = true;
       activeIndex = items.length - 1;
     } else {
       activeIndex = Math.max(activeIndex - 1, 0);
     }
     syncActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = (activeIndex >= 0) ? items[activeIndex] : items[0];
      if (pick) setValue(pick.getAttribute('data-name'));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
      btn.focus();
    }
  });

  // Click selection
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.mi-team-dd-item');
    if (!item) return;
    setValue(item.getAttribute('data-name'));
  });

  // Keep button label in sync if something else sets the select value
  selectEl.addEventListener('change', () => {
    const val = selectEl.value;
    const label = btn.querySelector('.mi-label');
    if (label) label.textContent = val || placeholderText;
  });

  list.addEventListener('mousemove', (e) => {
    const item = e.target.closest('.mi-team-dd-item');
    if (!item) return;

    const items = Array.from(list.querySelectorAll('.mi-team-dd-item'));
    const idx = items.indexOf(item);
    if (idx >= 0) {
      activeIndex = idx;

      // ✅ mouse hover is NOT keyboard navigation
      hasKeyboardNav = false;

      syncActive();
    }
  });
}

function getRoundLabelFromCode(code) {
  switch (code) {
    case "R64":    return "Round of 64";
    case "R32":    return "Round of 32";
    case "S16":    return "Sweet Sixteen";
    case "E8":     return "Elite Eight";
    case "First4": return "First Four";
    case "F4":     return "Final Four";
    case "Champ":  return "Championship";
    default:       return "Select Round";
  }
}

/* ==========================================
   v3.8 — Round-aware Identity (Canonical Modes + LCI/LFI)
   - Canonical mode map is round-specific (locked)
   - CIS/FAS become dampened baselines (0–100, headroom preserved)
   - LCI/LFI consume headroom smoothly based on wins-to-date + opponent context
   ========================================== */

function miClamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function miClamp(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function miSmoothstep01(t) {
  t = miClamp01(t);
  return t * t * (3 - 2 * t);
}

function miNormalizeRoundCode(roundCode) {
  const r = String(roundCode || CURRENT_ROUND || 'R64').trim();

  if (r === 'CH' || r === 'CHAMP' || r === 'CHAMPIONSHIP' || r === 'C') return 'Champ';
  if (r === 'FIRST4' || r === 'FIRST FOUR' || r === 'FIRST_FOUR' || r === 'FF') return 'First4';

  return r;
}

// Canonical wins-to-date mapping
function miWinsToDate(roundCode) {
  const r = miNormalizeRoundCode(roundCode);
  switch (r) {
    case 'First4': return 0; // treat like pre-R64 for stage weighting
    case 'R64':    return 0;
    case 'R32':    return 1;
    case 'S16':    return 2;
    case 'E8':     return 3;
    case 'F4':     return 4;
    case 'Champ':  return 5;
    default:       return 0;
  }
}

// Stage scalar: smooth across tournament; S16 already bumps (X=2 => >0)
function miStageScalar(roundCode) {
  const X = miWinsToDate(roundCode);
  const t = X / 5;               // 0..1 across whole tournament
  return miSmoothstep01(t);      // smooth, bounded, deterministic
}

// Dampened baseline: preserves ordering, creates headroom (raw is 0..100)
function miDampenBaselineScore(raw, cap, gamma) {
  const x = miClamp(raw, 0, 100) / 100;
  const y = Math.pow(x, gamma);
  return miClamp(cap * y, 0, 100);
}

// Opponent authority proxy (seed-only, deterministic, bounded)
function miOpponentAuthorityFromSeed(seedOpp) {
  const s = Number(seedOpp);
  if (!Number.isFinite(s)) return 0.5;
  const t = (Math.min(Math.max(s, 1), 16) - 1) / 15;  // 0..1
  return 1 - t;                                       // 1-seed => ~1, 16 => ~0
}

// Cinderella “earned evidence” proxy (seed-only, continuous)
function miDisplacementFromSeed(seed) {
  const s = Number(seed);
  if (!Number.isFinite(s)) return 0;
  // D = clamp((seed - 4)/12)
  return miClamp01((s - 4) / 12);
}

// Canonical mode map (round-specific, locked)
function miGetCanonicalMode(roundCode, seedA, seedB) {
  const r = miNormalizeRoundCode(roundCode);
  const a = Number(seedA), b = Number(seedB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'standard';

  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const pair = `${lo}-${hi}`;

  const isDoubleDouble = (lo >= 11 && hi >= 11);

  if (r === 'First4') {
    return 'neutral_mirror';
  }

  if (r === 'R64') {
    if (pair === '7-10' || pair === '8-9') return 'neutral_mirror';
    return 'standard';
  }

  if (r === 'R32') {
    if (pair === '4-5') return 'chalk_mirror';
    if (isDoubleDouble) return 'neutral_mirror';
    return 'standard';
  }

  if (r === 'S16') {
    if (pair === '2-3') return 'chalk_mirror';
    if (pair === '6-7') return 'chaos_mirror';
    if (pair === '7-11') return 'chaos_mirror';
    if (isDoubleDouble) return 'chaos_mirror';
    return 'standard';
  }

  if (r === 'E8') {
    if (pair === '1-2' || pair === '3-4') return 'chalk_mirror';
    return 'standard';
  }

  if (r === 'F4') {
    if (a === b) return 'chalk_mirror';
    return 'standard';
  }

  if (r === 'Champ') {
    if (a === b) return 'chalk_mirror';
    return 'standard';
  }

  return 'standard';
}

// Compute live favorite (LFI) from dampened baseline + stage + opponent authority
function miComputeLFI(team, opponent, roundCode) {
  const base = (typeof team.fasStatic === 'number') ? team.fasStatic : 0;
  const stage = miStageScalar(roundCode);
  const oppAuth = miOpponentAuthorityFromSeed(opponent?.seed);

  // EF = 0.85 + 0.15 * OppAuth
  const EF = 0.85 + 0.15 * oppAuth;

  // GF = clamp01(kF * stage * EF)
  const GF = miClamp01(MI_IDENTITY_V38.kF * stage * EF);

  // LFI = base + (100 - base) * GF
  return miClamp(base + (100 - base) * GF, 0, 100);
}

// Compute live cinderella (LCI) from dampened baseline + stage + seed displacement + opponent authority
function miComputeLCI(team, opponent, roundCode) {
  const base = (typeof team.cisStatic === 'number') ? team.cisStatic : 0;
  const stage = miStageScalar(roundCode);
  const oppAuth = miOpponentAuthorityFromSeed(opponent?.seed);
  const D = miDisplacementFromSeed(team?.seed);

  // EC = D * (0.6 + 0.4 * OppAuth)
  const EC = D * (0.6 + 0.4 * oppAuth);

  // GC = clamp01(kC * stage * EC)
  const GC = miClamp01(MI_IDENTITY_V38.kC * stage * EC);

  // LCI = base + (100 - base) * GC
  return miClamp(base + (100 - base) * GC, 0, 100);
}

function resolveIdentityContext(teamA, teamB, roundCode) {
  const r = miNormalizeRoundCode(roundCode);
  const seedA = Number(teamA?.seed);
  const seedB = Number(teamB?.seed);

  const mode = miGetCanonicalMode(r, seedA, seedB);

  const X = miWinsToDate(r);
  const isLegitPhase = (X >= 2); // S16+

  // Baselines (already dampened in computeStaticIdentities)
  const cisA = (typeof teamA?.cisStatic === 'number') ? teamA.cisStatic : 0;
  const fasA = (typeof teamA?.fasStatic === 'number') ? teamA.fasStatic : 0;
  const cisB = (typeof teamB?.cisStatic === 'number') ? teamB.cisStatic : 0;
  const fasB = (typeof teamB?.fasStatic === 'number') ? teamB.fasStatic : 0;

  // Helper to pick live vs baseline for a role
  const getFavValue = (t, o) => isLegitPhase ? miComputeLFI(t, o, r) : ((typeof t?.fasStatic === 'number') ? t.fasStatic : 0);
  const getCinValue = (t, o) => isLegitPhase ? miComputeLCI(t, o, r) : ((typeof t?.cisStatic === 'number') ? t.cisStatic : 0);

  // Mirrors first
  if (mode === 'neutral_mirror') {
    return {
      mode,
      roleA: 'none', roleB: 'none',
      metricA: 'CIS', metricB: 'CIS',
      valueA: cisA, valueB: cisB
    };
  }

  if (mode === 'chalk_mirror') {
    // Pre-S16: FAS/FAS; S16+: LFI/LFI
    const metric = isLegitPhase ? 'LFI' : 'FAS';
    return {
      mode,
      roleA: 'none', roleB: 'none',
      metricA: metric, metricB: metric,
      valueA: isLegitPhase ? miComputeLFI(teamA, teamB, r) : fasA,
      valueB: isLegitPhase ? miComputeLFI(teamB, teamA, r) : fasB
    };
  }

  if (mode === 'chaos_mirror') {
    // Pre-S16: CIS/CIS; S16+: LCI/LCI
    const metric = isLegitPhase ? 'LCI' : 'CIS';
    return {
      mode,
      roleA: 'none', roleB: 'none',
      metricA: metric, metricB: metric,
      valueA: isLegitPhase ? miComputeLCI(teamA, teamB, r) : cisA,
      valueB: isLegitPhase ? miComputeLCI(teamB, teamA, r) : cisB
    };
  }

  // Standard: better seed is Favorite; worse seed is Cinderella
  // (ties should be rare; if equal, treat as chalk mirror by later-round rules)
  const aIsFav = (Number.isFinite(seedA) && Number.isFinite(seedB)) ? (seedA < seedB) : true;

  return {
    mode: 'standard',
    roleA: aIsFav ? 'favorite' : 'cinderella',
    roleB: aIsFav ? 'cinderella' : 'favorite',
    metricA: aIsFav ? (isLegitPhase ? 'LFI' : 'FAS') : (isLegitPhase ? 'LCI' : 'CIS'),
    metricB: aIsFav ? (isLegitPhase ? 'LCI' : 'CIS') : (isLegitPhase ? 'LFI' : 'FAS'),
    valueA: aIsFav ? getFavValue(teamA, teamB) : getCinValue(teamA, teamB),
    valueB: aIsFav ? getCinValue(teamB, teamA) : getFavValue(teamB, teamA)
  };
}

function miUpdateMatchupLensHeaders(result) {
  if (!result || !result.a || !result.b) return;

  // Matchup bar labels
  const elA = document.getElementById('matchupRoleA');
  const elB = document.getElementById('matchupRoleB');

  // Scorecard header pills/tags
  const cardA = document.getElementById('roleTagA');
  const cardB = document.getElementById('roleTagB');

  // Outer shells that need to inherit the active lens
  const analysisShell = document.getElementById('analysisShell');
  const cindCard = document.getElementById('cindCard');
  const favCard  = document.getElementById('favCard');

  if (!elA && !elB && !cardA && !cardB && !analysisShell && !cindCard && !favCard) return;

  const roundCode = result.round || CURRENT_ROUND || 'R64';
  const ctx = (typeof resolveIdentityContext === 'function')
    ? resolveIdentityContext(result.a, result.b, roundCode)
    : null;

  if (!ctx) return;

  const copy = window.MI_COPY || {};
  const card = copy.card || {};

  const LABEL = {
    favorite: card.favorite_label || 'Favorite',
    cinderella: card.cinderella_label || 'Cinderella',
    chalk: card.chalk_mirror_label || 'Chalk Mirror',
    chaos: card.chaos_mirror_label || 'Chaos Mirror',
    neutral: card.neutral_mirror_label || 'Neutral Mirror'
  };

  const roleClassMap = {
    favorite: 'mi-lens-favorite',
    cinderella: 'mi-lens-cinderella',
    chalk_mirror: 'mi-lens-chalk',
    chaos_mirror: 'mi-lens-chaos',
    neutral_mirror: 'mi-lens-neutral'
  };

  const clearLensClasses = (el) => {
    if (!el) return;
    el.classList.remove(
      'mi-lens-favorite',
      'mi-lens-cinderella',
      'mi-lens-chalk',
      'mi-lens-chaos',
      'mi-lens-neutral'
    );
  };

  const applyLensState = (el, lensKey) => {
    if (!el) return;
    clearLensClasses(el);
    el.setAttribute('data-lens', lensKey);
    const cls = roleClassMap[lensKey];
    if (cls) el.classList.add(cls);
  };

  // ===== Helpers =====
  const setLabel = (el, text, lensKey) => {
    if (!el) return;
    el.textContent = text;
    el.setAttribute('data-lens', lensKey);
  };

  const applyRoleTagClass = (tagEl, lensKey) => {
    if (!tagEl) return;

    tagEl.classList.remove('fav-tag', 'cind-tag', 'chalk-tag', 'chaos-tag', 'neutral-tag');

    const map = {
      favorite: 'fav-tag',
      cinderella: 'cind-tag',
      chalk_mirror: 'chalk-tag',
      chaos_mirror: 'chaos-tag',
      neutral_mirror: 'neutral-tag'
    };

    const cls = map[lensKey];
    if (cls) tagEl.classList.add(cls);

    tagEl.setAttribute('data-lens', lensKey);
  };

  // ===== Mirrors =====
  if (ctx.mode === 'chalk_mirror') {
    setLabel(elA, LABEL.chalk, 'chalk_mirror');
    setLabel(elB, LABEL.chalk, 'chalk_mirror');
    setLabel(cardA, LABEL.chalk, 'chalk_mirror');
    setLabel(cardB, LABEL.chalk, 'chalk_mirror');

    applyRoleTagClass(cardA, 'chalk_mirror');
    applyRoleTagClass(cardB, 'chalk_mirror');

    applyLensState(analysisShell, 'chalk_mirror');
    return;
  }

  if (ctx.mode === 'chaos_mirror') {
    setLabel(elA, LABEL.chaos, 'chaos_mirror');
    setLabel(elB, LABEL.chaos, 'chaos_mirror');
    setLabel(cardA, LABEL.chaos, 'chaos_mirror');
    setLabel(cardB, LABEL.chaos, 'chaos_mirror');

    applyRoleTagClass(cardA, 'chaos_mirror');
    applyRoleTagClass(cardB, 'chaos_mirror');

    applyLensState(analysisShell, 'chaos_mirror');
    return;
  }

  if (ctx.mode === 'neutral_mirror') {
    setLabel(elA, LABEL.neutral, 'neutral_mirror');
    setLabel(elB, LABEL.neutral, 'neutral_mirror');
    setLabel(cardA, LABEL.neutral, 'neutral_mirror');
    setLabel(cardB, LABEL.neutral, 'neutral_mirror');

    applyRoleTagClass(cardA, 'neutral_mirror');
    applyRoleTagClass(cardB, 'neutral_mirror');

    applyLensState(analysisShell, 'neutral_mirror');
    return;
  }

  // ===== Standard =====
  const roleA = (ctx.roleA || '').toLowerCase();
  const roleB = (ctx.roleB || '').toLowerCase();

  const textA = (roleA === 'favorite') ? LABEL.favorite : LABEL.cinderella;
  const textB = (roleB === 'favorite') ? LABEL.favorite : LABEL.cinderella;

  setLabel(elA, textA, roleA);
  setLabel(elB, textB, roleB);
  setLabel(cardA, textA, roleA);
  setLabel(cardB, textB, roleB);

  applyRoleTagClass(cardA, roleA);
  applyRoleTagClass(cardB, roleB);

  applyLensState(analysisShell, roleA || 'cinderella');
}

// ---------- Lean band helper (for ΔMI) ----------
function getLeanBand(diff) {
  const d = Math.abs(diff);
  if (d < 0.10) return 'Toss-Up';
  if (d < 0.25) return 'Very Slight Lean';
  if (d < 0.50) return 'Lean';
  if (d < 0.80) return 'Strong Lean';
  return 'Heavy Lean';
}

function getSummaryGapKey(diff) {
  const d = Math.abs(typeof diff === 'number' ? diff : 0);

  // Δ < 1.00 (Volatility regime — granular)
  if (d < 0.25) return 'tiny_0_25';
  if (d < 0.50) return 'tiny_0_50';
  if (d < 0.75) return 'tiny_0_75';
  if (d < 1.00) return 'tiny_1_00';

  // Empirical bands (validated across 2023–2025)
  if (d < 2.00) return 'small_gap';   // 1.0–2.0
  if (d < 4.00) return 'medium_gap';  // 2.0–4.0
  return 'large_gap';                // 4.0+
}

/* =========================================================
   MATCHUP LOG (v4.2) — Option A Shelf
   - stores only 10 recent (localStorage)
   - shelf hidden until introduced
   - shows top 3 always; "More" reveals next 7
   - aligned to new compareTeams() result shape
   ========================================================= */

const MI_LOG_STORAGE_KEY = "mi.v4_2.matchupLog";
const MI_LOG_MAX_ENTRIES = 10;
const MI_LOG_INTRO_KEY = "MI_LOG_INTRODUCED_V1";
const MI_LOG_LASTNEW_KEY = "MI_LOG_LASTNEW_ID_V1";

function miLogIntroduced(){
  try{ return localStorage.getItem(MI_LOG_INTRO_KEY) === "1"; }catch(e){ return false; }
}

function miSetLogIntroduced(){
  try{ localStorage.setItem(MI_LOG_INTRO_KEY, "1"); }catch(e){}
}

function miSetLastNewId(id){
  try{
    // allow clearing the marker so the "new row" animation doesn't replay
    if (id) localStorage.setItem(MI_LOG_LASTNEW_KEY, String(id));
    else localStorage.removeItem(MI_LOG_LASTNEW_KEY);
  }catch(e){}
}

function miGetLastNewId(){
  try{ return localStorage.getItem(MI_LOG_LASTNEW_KEY) || ""; }catch(e){ return ""; }
}

function miSandboxOn(){
  try{
    if (typeof window !== "undefined" && typeof window.SANDBOX_MODE !== "undefined") return !!window.SANDBOX_MODE;
  }catch(e){}
  try{
    if (typeof SANDBOX_MODE !== "undefined") return !!SANDBOX_MODE;
  }catch(e){}
  return false;
}

function miFormatMI(x){
  return (typeof x === "number" && isFinite(x)) ? x.toFixed(3) : "—";
}

function miLeanTierFromDiff(diff){
  const band = (typeof getLeanBand === "function") ? getLeanBand(diff) : "";
  switch (band) {
    case "Toss-Up":          return 1;
    case "Very Slight Lean": return 1;
    case "Lean":             return 2;
    case "Strong Lean":      return 3;
    case "Heavy Lean":       return 4;
    default:                 return 1;
  }
}

function miLoadLog(){
  try{
    const raw = localStorage.getItem(MI_LOG_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);

    // Normal case: already an array
    if (Array.isArray(parsed)) return parsed;

    // Migration: if a single entry object was stored
    if (parsed && typeof parsed === "object") {
      const vals = Object.values(parsed);

      if (vals.length && typeof vals[0] === "object") {
        return vals
          .filter(Boolean)
          .sort((a,b) => (b.ts || 0) - (a.ts || 0));
      }

      return [parsed];
    }

    return [];
  }catch(e){
    return [];
  }
}

function miSaveLog(arr){
  try{
    const safe = Array.isArray(arr) ? arr : (arr ? [arr] : []);
    localStorage.setItem(MI_LOG_STORAGE_KEY, JSON.stringify(safe));
  }catch(e){}
}

function miBuildLogId(result){
  const roundCode = result?.activeRound || result?.round || "NOROUND";
  const mode = miSandboxOn() ? "SBX" : roundCode;
  return `${Date.now()}__${mode}__${result.a?.name || "A"}__${result.b?.name || "B"}`;
}

function miPushLogFromResult(result){
  if (!result || !result.a || !result.b) return;

  const sandbox = miSandboxOn();
  const round = sandbox ? null : (result.activeRound || result.round || null);

  const miA = (typeof result.miA_raw === "number" && Number.isFinite(result.miA_raw))
    ? result.miA_raw
    : ((typeof result.miA === "number" && Number.isFinite(result.miA)) ? result.miA : null);

  const miB = (typeof result.miB_raw === "number" && Number.isFinite(result.miB_raw))
    ? result.miB_raw
    : ((typeof result.miB === "number" && Number.isFinite(result.miB)) ? result.miB : null);

  const diff = (typeof result.final_delta === "number" && Number.isFinite(result.final_delta))
    ? result.final_delta
    : ((typeof result.diff === "number" && Number.isFinite(result.diff))
        ? result.diff
        : ((Number.isFinite(miA) ? miA : 0) - (Number.isFinite(miB) ? miB : 0)));

  const entry = {
    id: miBuildLogId(result),
    ts: Date.now(),

    sandbox,
    round,

    teamA: result.a.name,
    teamB: result.b.name,

    miA,
    miB,
    diff,

    leanSide: diff > 0 ? "a" : (diff < 0 ? "b" : "push"),
    leanTier: miLeanTierFromDiff(diff)
  };

  const existing = miLoadLog();
  existing.unshift(entry);
  miSaveLog(existing.slice(0, MI_LOG_MAX_ENTRIES));

  miSetLastNewId(entry.id);
  if (typeof miRenderShelf === "function") miRenderShelf();
}

function miArrowsHTML(tier, side){
  const t = Math.max(1, Math.min(4, Number(tier) || 1));
  const arrows = Array.from({ length: t })
    .map(() => `<span class="mi-log-arrow" aria-hidden="true"></span>`)
    .join("");

  if (side === "a") return `<span class="mi-log-arrows left">${arrows}</span>`;
  if (side === "b") return `<span class="mi-log-arrows right">${arrows}</span>`;
  return `<span class="mi-log-arrows"></span>`;
}

function miBuildRow(entry){
  const tag = entry.sandbox ? "SBX" : (entry.round || "—");

  const leftSlot  = (entry.leanSide === "a")
    ? miArrowsHTML(entry.leanTier, "a")
    : `<span class="mi-log-arrows left"></span>`;

  const rightSlot = (entry.leanSide === "b")
    ? miArrowsHTML(entry.leanTier, "b")
    : `<span class="mi-log-arrows right"></span>`;

  const el = document.createElement("div");
  el.className = "mi-log-row";
  el.innerHTML = `
    <span class="mi-log-tag">${tag}</span>

    <span class="mi-log-name a" title="${entry.teamA}">${entry.teamA}</span>
    <span class="mi-log-mi a">${miFormatMI(entry.miA)}</span>

    ${leftSlot}
    <span class="mi-log-lean">LEAN</span>
    ${rightSlot}

    <span class="mi-log-mi b">${miFormatMI(entry.miB)}</span>
    <span class="mi-log-name b" title="${entry.teamB}">${entry.teamB}</span>
  `.trim();

  return el;
}

function miShelfPhaseOk(){
  const shell = document.querySelector(".app-shell");
  const bar = document.getElementById("matchupBar");
  if (!shell || !bar) return false;

  // must not be on landing / pre-matchup
  if (shell.classList.contains("pre-matchup")) return false;

  // must actually be in “has matchup” world
  if (!shell.classList.contains("has-matchup")) return false;

  return true;
}

function miRenderShelf(){
  const plate = document.querySelector("#matchupBar .mi-matchup-backplate");
  const top3 = document.getElementById("miLogTop3");
  const moreBtn = document.getElementById("miLogMoreBtn");
  const morePanel = document.getElementById("miLogMorePanel");
  const moreList = document.getElementById("miLogMoreList");
  const bar = document.getElementById("matchupBar");
  if (!plate || !top3 || !moreBtn || !morePanel || !moreList || !bar) return;

  if (!miShelfPhaseOk()){
    plate.hidden = true;
    plate.classList.remove("is-open", "is-more-open", "is-intro");
    morePanel.hidden = true;
    moreBtn.hidden = true;
    moreBtn.setAttribute("aria-expanded", "false");
    if (bar.classList.contains("has-shelf")) bar.classList.remove("has-shelf");
    return;
  }

  if (!bar.classList.contains("has-shelf")) bar.classList.add("has-shelf");

  const entries = miLoadLog().slice(0, MI_LOG_MAX_ENTRIES);
  if (entries.length < 1){
    plate.hidden = true;
    plate.classList.remove("is-open", "is-more-open", "is-intro");
    morePanel.hidden = true;
    moreBtn.hidden = true;
    moreBtn.setAttribute("aria-expanded", "false");
    return;
  }

  const introduced = miLogIntroduced();

  // Before introduction: do NOT show in normal has-matchup view.
  // Only reveal the first time the bar enters edit mode.
  if (!introduced && !bar.classList.contains("is-editing")){
    plate.hidden = true;
    plate.classList.remove("is-open", "is-more-open", "is-intro");
    morePanel.hidden = true;
    moreBtn.hidden = true;
    moreBtn.setAttribute("aria-expanded", "false");
    return;
  }

  if (!introduced && bar.classList.contains("is-editing")){
    miSetLogIntroduced();
    plate.classList.add("is-intro");
  } else {
    plate.classList.remove("is-intro");
  }

  const topEntries = entries.slice(0, 3);
  const topRender = topEntries.slice().reverse();
  const moreEntries = entries.slice(3);

  top3.innerHTML = "";
  for (const e of topRender) top3.appendChild(miBuildRow(e));

  const lastNewId = miGetLastNewId();
  if (lastNewId && topEntries.length && topEntries[0].id === lastNewId){
    const newestRow = top3.lastElementChild;
    if (newestRow){
      newestRow.classList.add("is-new");
      miSetLastNewId("");
      setTimeout(() => newestRow.classList.remove("is-new"), 2000);
    }
  }

  moreList.innerHTML = "";
  for (const e of moreEntries) moreList.appendChild(miBuildRow(e));

  if (moreEntries.length > 0){
    moreBtn.hidden = false;
  } else {
    moreBtn.hidden = true;
    morePanel.hidden = true;
    moreBtn.setAttribute("aria-expanded", "false");
  }

  plate.hidden = false;
  requestAnimationFrame(() => plate.classList.add("is-open"));
}

function miToggleMore(){
  const moreBtn = document.getElementById("miLogMoreBtn");
  const morePanel = document.getElementById("miLogMorePanel");
  const plate = document.querySelector("#matchupBar .mi-matchup-backplate");
  if (!moreBtn || !morePanel || !plate) return;

  const willOpen = !!morePanel.hidden;
  morePanel.hidden = !willOpen;
  moreBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");

  if (willOpen) plate.classList.add("is-more-open");
  else plate.classList.remove("is-more-open");
}

function miInitShelf(){
  const plate = document.querySelector("#matchupBar .mi-matchup-backplate");
  const moreBtn = document.getElementById("miLogMoreBtn");
  if (!plate || !moreBtn) return;

  if (plate.dataset.bound === "1"){
    miRenderShelf();
    return;
  }
  plate.dataset.bound = "1";

  moreBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    miToggleMore();
  });

  document.addEventListener("click", (e) => {
    const panel = document.getElementById("miLogMorePanel");
    const btn = document.getElementById("miLogMoreBtn");
    if (!panel || !btn) return;
    if (panel.hidden) return;
    if (!plate.contains(e.target)){
      panel.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      plate.classList.remove("is-more-open");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const panel = document.getElementById("miLogMorePanel");
    const btn = document.getElementById("miLogMoreBtn");
    if (!panel || !btn) return;
    if (!panel.hidden){
      panel.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      plate.classList.remove("is-more-open");
    }
  });

  miRenderShelf();
}

function miObserveShelfPhases(){
  const shell = document.querySelector(".app-shell");
  const bar = document.getElementById("matchupBar");
  if (!shell || !bar) return;

  const mo = new MutationObserver(() => miRenderShelf());
  mo.observe(shell, { attributes: true, attributeFilter: ["class"] });
  mo.observe(bar, { attributes: true, attributeFilter: ["class"] });
}

document.addEventListener("DOMContentLoaded", () => {
  miInitShelf();
  miObserveShelfPhases();
  initVersionPatchNotes();
});

function miPickBandLine(block, gapKey) {
  // block shape:
  // { tiny_gap:[...], small_gap:[...], medium_gap:[...], large_gap:[...], default:[...] }
  if (!block || typeof block !== 'object') return '';

  const pool =
    (Array.isArray(block[gapKey]) && block[gapKey].length ? block[gapKey] : null) ||
    (Array.isArray(block.default) && block.default.length ? block.default : null) ||
    null;

  if (!pool) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}

function miApplyVerdictTokens(str, winner, loser) {
  if (!str) return '';
  return String(str)
    .replaceAll('{{WINNER}}', winner || '')
    .replaceAll('{{LOSER}}',  loser  || '');
}

function miSetVerdictCopy({ winner, loser, gapKey }) {
  const copy = window.MI_COPY || {};
  const metrics = copy.verdict && copy.verdict.metrics ? copy.verdict.metrics : {};

  const lineEl = document.getElementById('miVerdictLine');
  if (!lineEl) return;

  // ----- Stable random picker (per matchup render) -----
  // Keeps the sentence from "shuffling" on re-renders (toggle UI, etc.)
  const _cache = (window.__MI_VERDICT_LINE_CACHE ||= new Map());

  const miRandInt = (n) => {
    n = Math.floor(Number(n) || 0);
    if (n <= 1) return 0;
    if (window.crypto && crypto.getRandomValues) {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return buf[0] % n;
    }
    return Math.floor(Math.random() * n);
  };

  const pickBandLineStable = (block, bandKey, channel) => {
    if (!block || typeof block !== 'object') return "";

    const matchupKey = `${String(winner || "")}|${String(loser || "")}|${String(bandKey || "default")}`;
    const cacheKey = `${channel}::${matchupKey}`;

    if (_cache.has(cacheKey)) return _cache.get(cacheKey) || "";

    const bucket =
      (block[bandKey] != null) ? block[bandKey] :
      (String(bandKey || '').startsWith('tiny_') && block.tiny_gap != null) ? block.tiny_gap :
      block.default;
    let pool = [];

    if (Array.isArray(bucket)) pool = bucket.filter(Boolean);
    else if (typeof bucket === "string" && bucket.trim()) pool = [bucket.trim()];

    const picked = pool.length ? pool[miRandInt(pool.length)] : "";
    _cache.set(cacheKey, picked || "");
    return picked || "";
  };

  // ----- Primary (headline) -----
  const primaryBlock = metrics.primary_text;
  const primaryLineRaw = pickBandLineStable(primaryBlock, gapKey, "primary");
  const primaryLine = miApplyVerdictTokens(primaryLineRaw, winner, loser);

  // Ensure structured children exist (because your CSS expects split styling)
  let headlineSpan = lineEl.querySelector('.mi-verdict-headline');
  let whySpan = lineEl.querySelector('.mi-verdict-why');

  if (!headlineSpan || !whySpan) {
    // Preserve any existing wrapper text as a fallback headline
    const existingText = (lineEl.textContent || '').trim();

    // Reset wrapper and recreate the two spans your own code expects
    lineEl.textContent = '';

    headlineSpan = document.createElement('span');
    headlineSpan.className = 'mi-verdict-headline';

    whySpan = document.createElement('span');
    whySpan.className = 'mi-verdict-why';

    if (existingText) headlineSpan.textContent = existingText;

    lineEl.appendChild(headlineSpan);
    lineEl.appendChild(whySpan);

    lineEl.classList.add('is-structured');
  }

  // Write primary into the dedicated headline span
  headlineSpan.textContent = primaryLine || '—';

  // ----- Secondary (why) -----
  const secondaryBlock = metrics.secondary_text;
  const secondaryLineRaw = pickBandLineStable(secondaryBlock, gapKey, "secondary");
  const secondaryLine = miApplyVerdictTokens(secondaryLineRaw, winner, loser);

  // Write secondary into the dedicated why span
  whySpan.textContent = secondaryLine || '';
  whySpan.classList.toggle('is-empty', !secondaryLine);

  // IMPORTANT: Do NOT touch verdict.metrics.back_text here.
}

/* =========================================================
   Verdict Presentation Enhancer
   ========================================================= */

function enhanceVerdictPresentation() {
  const line = document.getElementById('miVerdictLine');
  if (!line) return;

  // If the wrapper says "structured" but the DOM no longer has the spans,
  // we are in the quick-edit failure mode: something flattened children via textContent.
  // In that case, remove the flag so we can rebuild.
  if (line.classList.contains('is-structured')) {
    const hasHeadline = !!line.querySelector('.mi-verdict-headline');
    const hasWhy = !!line.querySelector('.mi-verdict-why');

    // If spans still exist, do nothing (already structured).
    if (hasHeadline || hasWhy) return;

    // Otherwise, it is stale and must be repaired.
    line.classList.remove('is-structured');
  }

  const raw = (line.textContent || '').trim();
  if (!raw || raw === '—') return;

  // Pull team names from existing scorebug labels
  const teamA = (document.getElementById('miScorebugTeamA')?.textContent || '').trim();
  const teamB = (document.getElementById('miScorebugTeamB')?.textContent || '').trim();

  // --- Sentence split (Headline = sentence 1, Subdeck = sentence 2+), abbreviation-safe
  const { headlineText, subText } = miSplitHeadlineSubdeckSafe(raw);

  // Build DOM safely (no innerHTML injection)
  line.textContent = '';
  line.classList.add('is-structured');

  const headline = document.createElement('span');
  headline.className = 'mi-verdict-headline';
  headline.appendChild(highlightTeamsFragment(headlineText, teamA, teamB));
  line.appendChild(headline);

  if (subText) {
    const brk = document.createElement('span');
    brk.className = 'mi-verdict-break';
    line.appendChild(brk);

    // IMPORTANT: this must match what miSetVerdictCopy searches for
    const why = document.createElement('span');
    why.className = 'mi-verdict-why';
    why.appendChild(highlightTeamsFragment(subText, teamA, teamB));
    line.appendChild(why);
  }
}

function highlightTeamsFragment(text, teamA, teamB) {
  // If team names aren’t available yet, return plain text
  if (!teamA && !teamB) return document.createTextNode(text);

  const teams = [
    { name: teamA, cls: 'mi-team mi-team--a' },
    { name: teamB, cls: 'mi-team mi-team--b' }
  ].filter(t => t.name);

  // Sort by length to avoid partial overlap issues
  teams.sort((a, b) => b.name.length - a.name.length);

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = teams.map(t => escapeRegExp(t.name)).join('|');
  if (!pattern) return document.createTextNode(text);

  const re = new RegExp(`\\b(${pattern})\\b`, 'g');

  const frag = document.createDocumentFragment();
  let last = 0;

  text.replace(re, (match, _grp, offset) => {
    if (offset > last) frag.appendChild(document.createTextNode(text.slice(last, offset)));

    const t = teams.find(x => x.name === match);
    const span = document.createElement('span');
    span.className = t ? t.cls : 'mi-team';
    span.textContent = match;

    frag.appendChild(span);
    last = offset + match.length;
    return match;
  });

  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function miGetPath(obj, path){
  if (!obj || !path) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts){
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function miRenderMadnessDelta(gapSepMiSpace) {
  const deltaTxt = miFormatUiAbsPointsFromMiSpace(gapSepMiSpace);

  // Score Synthesis
  document.querySelectorAll('[data-value="gap.sep"]').forEach(el => {
    el.textContent = deltaTxt;
  });

  // Verdict shell
  const scorebugDeltaEl = document.getElementById("miVerdictGapTop");
  if (scorebugDeltaEl) {
    scorebugDeltaEl.textContent = deltaTxt;
  }
}

function miBuildSecondaryDynamicVerdict({
  interactions,
  winName,
  loseName,
  baseDiff,
  diff
}) {
  const metricsCopy = (window.MI_COPY && window.MI_COPY.verdict && window.MI_COPY.verdict.metrics)
    ? window.MI_COPY.verdict.metrics
    : null;

  if (!metricsCopy || !metricsCopy.secondary_dynamic || !metricsCopy.secondary_driver_phrases) {
    return '';
  }

  const dyn = metricsCopy.secondary_dynamic;
  const phraseMap = metricsCopy.secondary_driver_phrases;

  const breakdown = (interactions && interactions.breakdown && typeof interactions.breakdown === 'object')
    ? interactions.breakdown
    : null;

  const ranked = breakdown
    ? Object.entries(breakdown)
        .map(([key, ch]) => ({
          key,
          value: Number(ch && ch.contribution) || 0,
          abs: Math.abs(Number(ch && ch.contribution) || 0)
        }))
        .filter(d => d.abs > 0.0001)
    : [];

  const PRIORITY_ORDER = [
    'rebounding_pressure',
    'turnover_pressure',
    'rim_access_pressure',
    'foul_pressure',
    'perimeter_variance_pressure'
  ];

  ranked.sort((a, b) => {
    if (b.abs !== a.abs) return b.abs - a.abs;
    return PRIORITY_ORDER.indexOf(a.key) - PRIORITY_ORDER.indexOf(b.key);
  });

  const nonZeroCount = ranked.length;
  const ia = (interactions && typeof interactions.a === 'number') ? interactions.a : null;
  const ib = (interactions && typeof interactions.b === 'number') ? interactions.b : null;

  const netComparable = (typeof ia === 'number' && typeof ib === 'number');
  const netDelta = netComparable ? (ia - ib) : 0;
  const netBalanced = Math.abs(netDelta) <= 0.03;
  const netNotEqual = Math.abs(netDelta) > 0.03;

  function selectTopDrivers(items) {
    const out = items.slice(0, 2).map(d => d.key);

    if (items.length >= 3 && items[2] && items[2].abs >= 0.20) {
      out.push(items[2].key);
    }

    return out;
  }

  let plan = {
    caseId: 'case4',
    drivers: ['mibs', 'breadth']
  };

  if (nonZeroCount >= 2 && netNotEqual) {
    plan.caseId = 'case1';
    plan.drivers = selectTopDrivers(ranked);
  } else if (nonZeroCount >= 2 && netBalanced) {
    plan.caseId = 'case2';
    plan.drivers = selectTopDrivers(ranked);
  } else if (nonZeroCount === 1) {
    plan.caseId = 'case3';
    plan.drivers = [ranked[0].key, 'mibs'];
  }

  const d1 = plan.drivers[0] ? (phraseMap[plan.drivers[0]] || '') : '';
  const d2 = plan.drivers[1] ? (phraseMap[plan.drivers[1]] || '') : '';
  const d3 = plan.drivers[2] ? (phraseMap[plan.drivers[2]] || '') : '';

  const bank =
    plan.caseId === 'case1'
      ? ((d3 && Array.isArray(dyn.case1_major3) && dyn.case1_major3.length) ? dyn.case1_major3 : dyn.case1)
      : plan.caseId === 'case2'
        ? ((d3 && Array.isArray(dyn.case2_major3) && dyn.case2_major3.length) ? dyn.case2_major3 : dyn.case2)
        : plan.caseId === 'case3'
          ? dyn.case3
          : dyn.case4;

  const tpl = (Array.isArray(bank) && bank.length) ? bank[0] : '';
  if (!tpl) return '';

  return String(tpl)
    .replace(/{{DRIVER_1}}/g, d1)
    .replace(/{{DRIVER_2}}/g, d2)
    .replace(/{{DRIVER_3}}/g, d3)
    .replace(/{{WINNER}}/g, winName || '')
    .replace(/{{LOSER}}/g, loseName || '')
    .trim();
}

function renderSummary(result = {}) {
  const {
    a,
    b,
    interactions,
    seedMeta,
    v2
  } = result || {};

  if (!a || !b) return;

  const summarySection = document.getElementById('summarySection');
  const table = document.getElementById('summaryTable');
  const tbody = table ? table.querySelector('tbody') : null;

  const brandA = getTeamBranding(a.name);
  const brandB = getTeamBranding(b.name);

  if (summarySection) {
    summarySection.style.setProperty('--mi-brand-a', brandA.primary || '#6b7280');
    summarySection.style.setProperty('--mi-brand-b', brandB.primary || '#6b7280');
  }

  const getNum = (v, fallback = 0) =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;

  // =========================================================
  // Canonical result compatibility layer
  // =========================================================
  const round = result.activeRound || result.round || CURRENT_ROUND;

  const baseDiff = getNum(result.base_diff, 0);
  const intDiff = getNum(result.int_diff, 0);

  const diff = getNum(
    result.final_delta,
    getNum(result.diff, baseDiff + intDiff)
  );

  const absDiff = getNum(
    result.absDiff,
    Math.abs(diff)
  );

  const baseAFromResult = getNum(result.baseA, NaN);
  const baseBFromResult = getNum(result.baseB, NaN);

  const intAFromResult = getNum(result.intA, NaN);
  const intBFromResult = getNum(result.intB, NaN);

  const finalAFromResult = getNum(
    result.miA,
    getNum(result.miA_raw, NaN)
  );

  const finalBFromResult = getNum(
    result.miB,
    getNum(result.miB_raw, NaN)
  );

  const predicted =
    (typeof result.predicted === 'string' && result.predicted.trim())
      ? result.predicted
      : (diff > 0)
        ? a.name
        : (diff < 0)
          ? b.name
          : 'Push';

  // =========================================================
  // Canonical V4.2 score state
  // foundation already includes split breadth
  // raw_base = foundation
  // =========================================================
  const foundationA = getNum(
    a.foundation,
    getNum(v2?.foundationA, getNum(a.mi_eff_margin, 0))
  );

  const foundationB = getNum(
    b.foundation,
    getNum(v2?.foundationB, getNum(b.mi_eff_margin, 0))
  );

  // Split breadth (canonical display fields)
  const offBreadthA = getNum(
    a.offBreadth,
    getNum(v2?.offBreadthA, 0)
  );

  const offBreadthB = getNum(
    b.offBreadth,
    getNum(v2?.offBreadthB, 0)
  );

  const defBreadthA = getNum(
    a.defBreadth,
    getNum(v2?.defBreadthA, 0)
  );

  const defBreadthB = getNum(
    b.defBreadth,
    getNum(v2?.defBreadthB, 0)
  );

  // Compatibility aggregate breadth
  const breadthA = getNum(
    a.breadth,
    getNum(v2?.breadthA, offBreadthA + defBreadthA)
  );

  const breadthB = getNum(
    b.breadth,
    getNum(v2?.breadthB, offBreadthB + defBreadthB)
  );

  // raw_base is now just foundation
  const rawBaseA = getNum(
    a.raw_base,
    getNum(v2?.rawBaseA, foundationA)
  );

  const rawBaseB = getNum(
    b.raw_base,
    getNum(v2?.rawBaseB, foundationB)
  );

  const baseTrustA = getNum(
    a.resumeBaseTrust,
    getNum(v2?.resumeA, 1.00)
  );

  const baseTrustB = getNum(
    b.resumeBaseTrust,
    getNum(v2?.resumeB, 1.00)
  );

  const intTrustA = getNum(a.resumeIntTrust, 1.00);
  const intTrustB = getNum(b.resumeIntTrust, 1.00);

  const confTrustA = getNum(a.resumeConfidenceTrust, 1.00);
  const confTrustB = getNum(b.resumeConfidenceTrust, 1.00);

  const fieldMean = getNum(
    v2?.fieldMean,
    getNum(window.LAST_RESULT?.v2?.fieldMean, 0)
  );

  const fieldMeanA = getNum(a.field_mean_base, fieldMean);
  const fieldMeanB = getNum(b.field_mean_base, fieldMean);

  const baseA = Number.isFinite(baseAFromResult)
    ? baseAFromResult
    : getNum(
        a.mi_base,
        (baseTrustA * rawBaseA) + ((1 - baseTrustA) * fieldMeanA)
      );

  const baseB = Number.isFinite(baseBFromResult)
    ? baseBFromResult
    : getNum(
        b.mi_base,
        (baseTrustB * rawBaseB) + ((1 - baseTrustB) * fieldMeanB)
      );

  const intRawA = getNum(
    a.mi_int_raw,
    getNum(interactions?.a, getNum(interactions?.teamA, 0))
  );

  const intRawB = getNum(
    b.mi_int_raw,
    getNum(interactions?.b, getNum(interactions?.teamB, 0))
  );

  const intA = Number.isFinite(intAFromResult)
    ? intAFromResult
    : getNum(a.mi_int, intRawA * intTrustA);

  const intB = Number.isFinite(intBFromResult)
    ? intBFromResult
    : getNum(b.mi_int, intRawB * intTrustB);

  const finalA = Number.isFinite(finalAFromResult)
    ? finalAFromResult
    : getNum(a.mi_matchup, baseA + intA);

  const finalB = Number.isFinite(finalBFromResult)
    ? finalBFromResult
    : getNum(b.mi_matchup, baseB + intB);

  const totalAdjA = finalA - foundationA;
  const totalAdjB = finalB - foundationB;

  // Base efficiency signals
  const miOffEffBaseA = getNum(a.mi_off_eff_base, getNum(v2?.miOffEffBaseA, 0));
  const miOffEffBaseB = getNum(b.mi_off_eff_base, getNum(v2?.miOffEffBaseB, 0));

  const miDefEffBaseA = getNum(a.mi_def_eff_base, getNum(v2?.miDefEffBaseA, 0));
  const miDefEffBaseB = getNum(b.mi_def_eff_base, getNum(v2?.miDefEffBaseB, 0));

  const miEffMarginBaseA = getNum(a.mi_eff_margin_base, getNum(v2?.miEffMarginBaseA, 0));
  const miEffMarginBaseB = getNum(b.mi_eff_margin_base, getNum(v2?.miEffMarginBaseB, 0));

  // Adjusted efficiency signals
  const miOffEffA = getNum(a.mi_off_eff, getNum(v2?.miOffEffA, foundationA));
  const miOffEffB = getNum(b.mi_off_eff, getNum(v2?.miOffEffB, foundationB));

  const miDefEffA = getNum(a.mi_def_eff, getNum(v2?.miDefEffA, foundationA));
  const miDefEffB = getNum(b.mi_def_eff, getNum(v2?.miDefEffB, foundationB));

  const miEffMarginA = getNum(a.mi_eff_margin, getNum(v2?.miEffMarginA, foundationA));
  const miEffMarginB = getNum(b.mi_eff_margin, getNum(v2?.miEffMarginB, foundationB));

  // Split breadth SDs
  const offBreadthSDA = getNum(a.offBreadthSD, getNum(v2?.offBreadthSDA, 0));
  const offBreadthSDB = getNum(b.offBreadthSD, getNum(v2?.offBreadthSDB, 0));

  const defBreadthSDA = getNum(a.defBreadthSD, getNum(v2?.defBreadthSDA, 0));
  const defBreadthSDB = getNum(b.defBreadthSD, getNum(v2?.defBreadthSDB, 0));

  // Compatibility aggregate SD
  const breadthSDA = getNum(a.breadthSD, getNum(v2?.breadthSDA, offBreadthSDA + defBreadthSDA));
  const breadthSDB = getNum(b.breadthSD, getNum(v2?.breadthSDB, offBreadthSDB + defBreadthSDB));

// =========================================================
// Summary section + summary center + verdict shell winner emphasis
// =========================================================
  const summaryCenterCard = summarySection
    ? summarySection.querySelector('.syn-center')
    : null;

  const winnerSide = (diff === 0)
    ? 'neutral'
    : (diff > 0 ? 'a' : 'b');

  if (summarySection) {
    summarySection.classList.remove(
      'mi-winner-a',
      'mi-winner-b',
      'mi-winner-neutral'
    );
    summarySection.classList.add(`mi-winner-${winnerSide}`);
  }

  const summarySectionMobileWinnerEl = document.getElementById('summarySectionMobile');

  if (summarySectionMobileWinnerEl) {
    summarySectionMobileWinnerEl.classList.remove(
      'mi-winner-a',
      'mi-winner-b',
      'mi-winner-neutral'
    );
    summarySectionMobileWinnerEl.classList.add(`mi-winner-${winnerSide}`);
  }

  if (summaryCenterCard) {
    summaryCenterCard.classList.remove(
      'mi-winner-a',
      'mi-winner-b',
      'mi-winner-neutral'
    );
    summaryCenterCard.classList.add(`mi-winner-${winnerSide}`);
  }

  const verdictShellWinnerEl = document.getElementById('verdictShell');

  if (verdictShellWinnerEl) {
    verdictShellWinnerEl.classList.remove(
      'mi-winner-a',
      'mi-winner-b',
      'mi-winner-neutral'
    );
    verdictShellWinnerEl.classList.add(`mi-winner-${winnerSide}`);
  }

  miApplyWinnerTokens(winnerSide, brandA, brandB);

  // =========================================================
  // Score Synthesis lens / side token wiring
  // Re-applies the canonical color-token system used by the
  // bottom summary section:
  // - standard        => cinderella / favorite split
  // - chaos_mirror    => red / red
  // - chalk_mirror    => blue / blue
  // - neutral_mirror  => purple / purple
  // =========================================================
  const verdictShellEl = document.getElementById('verdictShell');
  const analysisShellEl = document.getElementById('analysisShell');

  if (summarySection) {
    summarySection.removeAttribute('data-lens');
    summarySection.removeAttribute('data-side-a');
    summarySection.removeAttribute('data-side-b');
  }

  const summarySectionMobile = document.getElementById('summarySectionMobile');
  if (summarySectionMobile) {
    summarySectionMobile.removeAttribute('data-lens');
    summarySectionMobile.removeAttribute('data-side-a');
    summarySectionMobile.removeAttribute('data-side-b');
    summarySectionMobile.classList.add('visible');
  }

  // =========================================================
  // Copy wiring
  // =========================================================
  const copy        = window.MI_COPY || {};
  const summaryCopy = copy.summary || {};
  const tableLabels = summaryCopy.table_labels || {};
  const phrases     = copy.summary_phrases || {};

  const cTeamLabel = brandA.shortName || a.name || 'Team A';
  const fTeamLabel = brandB.shortName || b.name || 'Team B';

  const cTeamLabelLong = brandA.team || a.name || 'Team A';
  const fTeamLabelLong = brandB.team || b.name || 'Team B';

  const baselineLabel    = tableLabels.baseline_label    || 'Baseline MI';
  const matchupLabel     = tableLabels.matchup_label     || 'Matchup MI';
  const interactionLabel = tableLabels.interaction_label || 'Interaction Leverage';
  const predictedLabel   = tableLabels.predicted_label   || 'Predicted Winner';

  const neutralText = summaryCopy.neutral_matchup || 'Neutral matchup';
  const towardWord  = summaryCopy.toward_phrase   || 'toward';

  const centerHeaderLabel = summaryCopy.matchup_header || 'Matchup Edge';

  // =========================================================
  // Gap band / lean text
  // =========================================================
  const gapKey    = getSummaryGapKey(diff);
  const gapCfg    = phrases[gapKey] || {};
  const bandLabel = (gapCfg.label || '').trim();
  const bandDesc  = (gapCfg.description || '').trim();

  let leanText;

  if (diff === 0) {
    if (bandLabel && bandDesc) {
      leanText = bandLabel + ' — ' + bandDesc;
    } else {
      leanText = bandDesc || neutralText;
    }
  } else {
    const winnerName = diff > 0 ? a.name : b.name;

    if (bandLabel && bandDesc) {
      leanText = bandLabel + ' ' + towardWord + ' ' + winnerName + '. ' + bandDesc;
    } else if (bandDesc) {
      leanText = bandDesc + ' ' + towardWord + ' ' + winnerName + '.';
    } else if (bandLabel) {
      leanText = bandLabel + ' ' + towardWord + ' ' + winnerName;
    } else {
      const fallbackBand = getLeanBand(diff);
      leanText = fallbackBand
        ? (fallbackBand + ' ' + towardWord + ' ' + winnerName)
        : (towardWord + ' ' + winnerName);
    }
  }

  // =========================================================
  // Verdict copy helpers
  // =========================================================
  const verdictCopy = summaryCopy.verdict || {};

  const confidenceLabelText = verdictCopy.confidence_label || tableLabels.confidence_label || '';
  const driverLabelText     = verdictCopy.driver_label     || tableLabels.driver_label     || '';
  const riskLabelText       = verdictCopy.risk_label       || tableLabels.risk_label       || '';

  const confidenceBand = (bandLabel || getLeanBand(diff) || '').trim();

  const winnerIsA =
    (diff > 0) ? true :
    (diff < 0) ? false :
    (predicted === a.name);

  const winName   = winnerIsA ? a.name : b.name;
  const loseName  = winnerIsA ? b.name : a.name;

  const winInt  = winnerIsA ? intA : intB;
  const loseInt = winnerIsA ? intB : intA;

  const INT_SOFT = typeof verdictCopy.int_soft_threshold === 'number'
    ? verdictCopy.int_soft_threshold
    : 0.20;

  const intBalanced   = (Math.abs(winInt) <= INT_SOFT && Math.abs(loseInt) <= INT_SOFT);
  const intReinforces = (winInt >  INT_SOFT && loseInt < -INT_SOFT);
  const intResists    = (winInt < -INT_SOFT && loseInt >  INT_SOFT);

  const renderTpl = (tpl, tokens) => {
    if (!tpl) return '';
    return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => {
      return (tokens && tokens[k] != null) ? String(tokens[k]) : '';
    });
  };

  const gapSep = absDiff;
  const edgeTier = (gapSep >= 4) ? 'heavy'
                : (gapSep >= 2) ? 'solid'
                : (gapSep >  0) ? 'slight'
                : 'coin';

  let driverCase = '';
  if (diff === 0) {
    driverCase = intBalanced ? 'neutral_balanced' : 'neutral_swingy';
  } else if (intBalanced) {
    driverCase = 'edge_balanced';
  } else if (intReinforces) {
    driverCase = 'reinforces_winner';
  } else if (intResists) {
    driverCase = 'resists_winner';
  } else {
    driverCase = (Math.abs(winInt) >= Math.abs(loseInt)) ? 'mixed_still_winner' : 'mixed_live_loser';
  }

  const riskCase = `${edgeTier}_${intResists ? 'resists' : 'default'}`;

  const driverTpl = (verdictCopy.driver_templates && verdictCopy.driver_templates[driverCase]) || '';
  const riskTpl   = (verdictCopy.risk_templates   && verdictCopy.risk_templates[riskCase])   || '';

  const sep = Math.abs(diff);
  const sepText = (sep < 0.05) ? '~0.0' : `~${sep.toFixed(1)}`;

  const tokens = {
    WINNER: winName,
    LOSER: loseName,
    DIFF: fmt(diff, 3),
    EDGE_TIER: edgeTier,
    WIN_INT: fmt(winInt, 3),
    LOSE_INT: fmt(loseInt, 3),
    SEP: sepText,
    BAND: confidenceBand || (bandLabel || '')
  };

  const driverText = renderTpl(driverTpl, tokens);
  const riskText   = renderTpl(riskTpl, tokens);

    // =========================================================
  // Verdict metrics flip tile (back)
  // Supports both:
  // 1) legacy 3-part copy: base + matchup + gap[gapKey]
  // 2) newer single-pool copy: back_text[gapKey] / back_text.default
  // =========================================================
  const metricsCfg  = (copy.verdict && copy.verdict.metrics) ? copy.verdict.metrics : {};
  const backTextCfg = (metricsCfg.back_text || {});

  const pickOne = (arr) => (
    Array.isArray(arr) && arr.length
      ? arr[Math.floor(Math.random() * arr.length)]
      : ''
  );

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const ensureEndPunct = (s) => {
    const t = clean(s);
    if (!t) return '';
    return /[.!?]$/.test(t) ? t : (t + '.');
  };

  const backTokens = {
    ...tokens,

    // lowercase / narrative-friendly tokens
    winner: winName,
    loser: loseName,
    teamA: a.name,
    teamB: b.name,
    diff: fmt(diff, 3),
    absDiff: fmt(Math.abs(diff), 3),
    baseA: fmt(baseA, 3),
    baseB: fmt(baseB, 3),
    finalA: fmt(finalA, 3),
    finalB: fmt(finalB, 3),
    intA: fmt(intA, 3),
    intB: fmt(intB, 3),
    rawBaseA: fmt(rawBaseA, 3),
    rawBaseB: fmt(rawBaseB, 3),

    // helpful carry-through context
    gapKey,
    band: confidenceBand || (bandLabel || ''),
    leanText: leanText || '',
    bandDesc: bandDesc || ''
  };

  // --- Legacy 3-sentence mode ---
  const baseTpl = Array.isArray(backTextCfg.base)
    ? backTextCfg.base.map(s => ensureEndPunct(renderTpl(s, backTokens))).filter(Boolean).join(' ')
    : ensureEndPunct(renderTpl(backTextCfg.base, backTokens));

  const matchTpl = pickOne(backTextCfg.matchup);

  const gapBucket = (backTextCfg.gap && backTextCfg.gap[gapKey] != null)
    ? backTextCfg.gap[gapKey]
    : (backTextCfg.gap ? backTextCfg.gap.default : null);

  let gapTpl = '';
  if (Array.isArray(gapBucket)) gapTpl = pickOne(gapBucket);
  else if (typeof gapBucket === 'string') gapTpl = gapBucket;

  const s1 = baseTpl;
  const s2 = ensureEndPunct(renderTpl(matchTpl, backTokens));
  const s3 = ensureEndPunct(renderTpl(gapTpl, backTokens));

  const legacyBackText = [s1, s2, s3].filter(Boolean).join(' ');

  // --- New single-pool mode fallback ---
  const modernTpl =
    pickOne(backTextCfg[gapKey]) ||
    pickOne(backTextCfg.default);

  const modernBackText = ensureEndPunct(renderTpl(modernTpl, backTokens));

  const metricsBackText = legacyBackText || modernBackText;

  const verdictBackEl =
    document.getElementById('backVerdictMetrics') ||
    document.querySelector('#verdictShell .mi-verdict-metrics-tile .tile-back .mi-metrics-back-text') ||
    document.querySelector('#verdictShell .mi-metrics-back-text[data-copy="verdict.metrics.back_text"]');

  if (verdictBackEl && metricsBackText) {
    verdictBackEl.textContent = metricsBackText;
  }

  // =========================================================
  // Center explainer content
  // =========================================================   
  const summaryLeanEl = document.getElementById('summarySynLean');
  const verdictLineEl = document.getElementById('miVerdictLine');
  const confEl = document.getElementById('miSummaryConfidence');
  const driverEl = document.getElementById('miSummaryDriver');
  const riskEl = document.getElementById('miSummaryRisk');

  if (summaryLeanEl) summaryLeanEl.textContent = leanText;
  
  const summaryLeanMobEl = document.getElementById('summarySynLeanMob');
  if (summaryLeanMobEl) summaryLeanMobEl.textContent = leanText;

  // =========================================================
  // Verdict scorebug metrics
  // Must happen before enhanceVerdictPresentation(), because
  // the verdict headline enhancer pulls team names from the
  // scorebug name slots for inline highlighting.
  // =========================================================
  miRenderScorebugMetrics({
    aName: a.name || 'Team A',
    bName: b.name || 'Team B',
    baseA,
    baseB,
    finalA,
    finalB,
    gap: absDiff
  });

  const scoreBox = document.querySelector('#verdictShell .mi-scorebug-score');
  if (scoreBox) {
    scoreBox.classList.add('mi-nums-pop');
    window.setTimeout(() => scoreBox.classList.remove('mi-nums-pop'), 220);
  }

  if (verdictLineEl) {
    const verdictWinner = predicted === 'Push' ? a.name : winName;
    const verdictLoser = predicted === 'Push' ? b.name : loseName;

    miSetVerdictCopy({
      winner: verdictWinner,
      loser: verdictLoser,
      gapKey
    });

    const dynamicWhy = miBuildSecondaryDynamicVerdict({
      interactions,
      winName: verdictWinner,
      loseName: verdictLoser,
      baseDiff,
      diff
    });

    const whySpan = verdictLineEl.querySelector('.mi-verdict-why');
    if (whySpan && dynamicWhy) {
      const existingWhy = (whySpan.textContent || '').trim();
      whySpan.textContent = [existingWhy, dynamicWhy].filter(Boolean).join(' ');
      whySpan.classList.toggle('is-empty', !whySpan.textContent.trim());
    }

    enhanceVerdictPresentation();
  }

  if (confEl) {
    confEl.textContent = confidenceLabelText
      ? `${confidenceLabelText}: ${confidenceBand || bandLabel || '—'}`
      : (confidenceBand || bandLabel || '—');
  }

  if (driverEl) {
    driverEl.textContent = driverLabelText
      ? `${driverLabelText}: ${driverText || 'Interactions were relatively balanced.'}`
      : (driverText || 'Interactions were relatively balanced.');
  }

  if (riskEl) {
    riskEl.textContent = riskLabelText
      ? `${riskLabelText}: ${riskText || 'No major instability signal materially overrides the baseline.'}`
      : (riskText || 'No major instability signal materially overrides the baseline.');
  }
  // =========================================================
  // Canonical Score Synthesis binder
  // =========================================================
  const setSummaryValue = (key, val) => {
    const root = document;
    const els = root.querySelectorAll(`[data-value="${key}"]`);
    if (!els || !els.length) return;
    const out = (val == null ? '—' : val);
    els.forEach(el => { el.textContent = out; });
  };

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const resumeCalA = baseA - rawBaseA;
  const resumeCalB = baseB - rawBaseB;

  // team headers
  setText('summaryTeamAHeader', a.name || cTeamLabelLong);
  setText('summaryTeamBHeader', b.name || fTeamLabelLong);

  document.querySelectorAll('[data-sum-team="a"]').forEach(el => el.textContent = a.name || cTeamLabelLong);
  document.querySelectorAll('[data-sum-team="b"]').forEach(el => el.textContent = b.name || fTeamLabelLong);

  // center lean
  setText('summarySynLean', leanText || '');

  // score synthesis values (canonical UI point scale: signed 1-decimal)
  setSummaryValue('a.base', miFormatUiPointsFromMiSpace(baseA));
  setSummaryValue('b.base', miFormatUiPointsFromMiSpace(baseB));

  setSummaryValue('a.off_breadth', miFormatUiPointsFromMiSpace(offBreadthA));
  setSummaryValue('b.off_breadth', miFormatUiPointsFromMiSpace(offBreadthB));

  setSummaryValue('a.def_breadth', miFormatUiPointsFromMiSpace(defBreadthA));
  setSummaryValue('b.def_breadth', miFormatUiPointsFromMiSpace(defBreadthB));

  setSummaryValue('a.int_eff', miFormatUiPointsFromMiSpace(intA));
  setSummaryValue('b.int_eff', miFormatUiPointsFromMiSpace(intB));

  setSummaryValue('a.resume_cal', miFormatUiPointsFromMiSpace(resumeCalA));
  setSummaryValue('b.resume_cal', miFormatUiPointsFromMiSpace(resumeCalB));

  setSummaryValue('a.final', miFormatUiPointsFromMiSpace(finalA));
  setSummaryValue('b.final', miFormatUiPointsFromMiSpace(finalB));

  // value-state classes for new inline synthesis cells + finals
  miSetDataValueState(summarySection, 'a.base', baseA);
  miSetDataValueState(summarySection, 'b.base', baseB);

  miSetDataValueState(summarySection, 'a.off_breadth', offBreadthA);
  miSetDataValueState(summarySection, 'b.off_breadth', offBreadthB);

  miSetDataValueState(summarySection, 'a.def_breadth', defBreadthA);
  miSetDataValueState(summarySection, 'b.def_breadth', defBreadthB);

  miSetDataValueState(summarySection, 'a.int_eff', intA);
  miSetDataValueState(summarySection, 'b.int_eff', intB);

  miSetDataValueState(summarySection, 'a.resume_cal', resumeCalA);
  miSetDataValueState(summarySection, 'b.resume_cal', resumeCalB);

  miSetDataValueState(summarySection, 'a.final', finalA);
  miSetDataValueState(summarySection, 'b.final', finalB);

  // inline synthesis bars
  miSetSummaryInlineMetric('synBase', 'A', 'Baseline MI', baseA);
  miSetSummaryInlineMetric('synBase', 'B', 'Baseline MI', baseB);

  miSetSummaryInlineMetric('synOffBreadth', 'A', 'Offensive Breadth', offBreadthA);
  miSetSummaryInlineMetric('synOffBreadth', 'B', 'Offensive Breadth', offBreadthB);

  miSetSummaryInlineMetric('synDefBreadth', 'A', 'Defensive Breadth', defBreadthA);
  miSetSummaryInlineMetric('synDefBreadth', 'B', 'Defensive Breadth', defBreadthB);

  miSetSummaryInlineMetric('synIntEff', 'A', 'Effective Matchup Adjustment', intA);
  miSetSummaryInlineMetric('synIntEff', 'B', 'Effective Matchup Adjustment', intB);

  miSetSummaryInlineMetric('synResume', 'A', 'Résumé Calibration', resumeCalA);
  miSetSummaryInlineMetric('synResume', 'B', 'Résumé Calibration', resumeCalB);

  // delta
  miRenderMadnessDelta(absDiff);

  // =========================================================
  // Score Synthesis micro-volatility strip
  // =========================================================
  const vol = result?.volatility || {};
  const volScore = getNum(
    vol.score100,
    getNum(vol.score, 0)
  );

  const volFill = document.getElementById('summaryVolatilityFill');
  const volScoreEl = document.getElementById('summaryVolatilityScore');
  const volBeneficiaryEl = document.getElementById('summaryVolatilityBeneficiary');
  const volMiniEl = document.getElementById('summaryVolatilityMini');

  if (volScoreEl) {
    volScoreEl.textContent = Number.isFinite(volScore) ? Math.round(volScore) : '—';
  }

  const volScoreMobEl = document.getElementById('summaryVolatilityScoreMob');
  if (volScoreMobEl) volScoreMobEl.textContent = Number.isFinite(volScore) ? Math.round(volScore) : '—';

  if (volFill) {
    const pct = Math.max(0, Math.min(100, volScore));
    volFill.style.width = `${pct}%`;
  }

  if (volMiniEl) {
    volMiniEl.classList.remove(
      'is-stable',
      'is-low',
      'is-moderate',
      'is-high',
      'is-extreme',
      'is-a',
      'is-b',
      'is-balanced'
    );

    const tier = String(vol.tier || '').toLowerCase();
    if (tier) volMiniEl.classList.add(`is-${tier}`);

    const beneficiary =
      (vol?.chaos?.beneficiary || vol?.beneficiary || '').toString().toUpperCase();

    if (beneficiary === 'A') volMiniEl.classList.add('is-a');
    else if (beneficiary === 'B') volMiniEl.classList.add('is-b');
    else volMiniEl.classList.add('is-balanced');
  }

  if (volBeneficiaryEl) {
    const beneficiary =
      (vol?.chaos?.beneficiary || vol?.beneficiary || '').toString().toUpperCase();

    let beneficiaryText = 'Balanced';

    if (beneficiary === 'A') {
      beneficiaryText = `${a.name} ▲`;
    } else if (beneficiary === 'B') {
      beneficiaryText = `${b.name} ▲`;
    }

    volBeneficiaryEl.textContent = beneficiaryText;
  }

  // =========================================================
  // Optional legacy/debug targets kept harmlessly alive
  // =========================================================
  setText('summaryTeamAName', a.name || cTeamLabel);
  setText('summaryTeamBName', b.name || fTeamLabel);

  setText('sumFoundationA', fmt(foundationA, 3));
  setText('sumFoundationB', fmt(foundationB, 3));

  setText('sumOffBreadthA', fmt(offBreadthA, 3));
  setText('sumOffBreadthB', fmt(offBreadthB, 3));
  setText('sumDefBreadthA', fmt(defBreadthA, 3));
  setText('sumDefBreadthB', fmt(defBreadthB, 3));

  setText('sumBreadthA', fmt(breadthA, 3));
  setText('sumBreadthB', fmt(breadthB, 3));

  setText('sumRawBaseA', fmt(rawBaseA, 3));
  setText('sumRawBaseB', fmt(rawBaseB, 3));

  setText('sumResumeTrustA', fmt(baseTrustA, 3));
  setText('sumResumeTrustB', fmt(baseTrustB, 3));

  setText('sumFieldMeanA', fmt(fieldMeanA, 3));
  setText('sumFieldMeanB', fmt(fieldMeanB, 3));

  setText('sumIntRawA', fmt(intRawA, 3));
  setText('sumIntRawB', fmt(intRawB, 3));

  setText('sumIntTrustA', fmt(intTrustA, 3));
  setText('sumIntTrustB', fmt(intTrustB, 3));

  setText('sumIntA', fmt(intA, 3));
  setText('sumIntB', fmt(intB, 3));

  setText('sumAdjA', fmt(totalAdjA, 3));
  setText('sumAdjB', fmt(totalAdjB, 3));

  setText('sumOffEffBaseA', fmt(miOffEffBaseA, 3));
  setText('sumOffEffBaseB', fmt(miOffEffBaseB, 3));
  setText('sumDefEffBaseA', fmt(miDefEffBaseA, 3));
  setText('sumDefEffBaseB', fmt(miDefEffBaseB, 3));
  setText('sumEffMarginBaseA', fmt(miEffMarginBaseA, 3));
  setText('sumEffMarginBaseB', fmt(miEffMarginBaseB, 3));

  setText('sumOffEffA', fmt(miOffEffA, 3));
  setText('sumOffEffB', fmt(miOffEffB, 3));
  setText('sumDefEffA', fmt(miDefEffA, 3));
  setText('sumDefEffB', fmt(miDefEffB, 3));
  setText('sumEffMarginA', fmt(miEffMarginA, 3));
  setText('sumEffMarginB', fmt(miEffMarginB, 3));

  setText('sumOffBreadthSDA', fmt(offBreadthSDA, 3));
  setText('sumOffBreadthSDB', fmt(offBreadthSDB, 3));
  setText('sumDefBreadthSDA', fmt(defBreadthSDA, 3));
  setText('sumDefBreadthSDB', fmt(defBreadthSDB, 3));
  setText('sumBreadthSDA', fmt(breadthSDA, 3));
  setText('sumBreadthSDB', fmt(breadthSDB, 3));

  setText('sumConfTrustA', fmt(confTrustA, 3));
  setText('sumConfTrustB', fmt(confTrustB, 3));
  setText('sumFieldMean', fmt(fieldMean, 3));

  if (typeof resetPostMatchupDefaultView === 'function') {
    resetPostMatchupDefaultView();
  }

  // =========================================================
  // Round pill
  // =========================================================
  const roundSpan = document.getElementById('currentRoundLabel');
  if (roundSpan) {
    roundSpan.textContent = getRoundLabelFromCode(round || CURRENT_ROUND);
  }

  miUpdateMatchupRoundPill(round || CURRENT_ROUND);

  // =========================================================
  // Legacy spans
  // =========================================================
  const miASpan  = document.getElementById('miA');
  const miBSpan  = document.getElementById('miB');
  const predSpan = document.getElementById('predictedWinner');

  if (miASpan)  miASpan.textContent  = finalA.toFixed(3);
  if (miBSpan)  miBSpan.textContent  = finalB.toFixed(3);
  if (predSpan) predSpan.textContent = predicted;

  if (summarySection) {
    summarySection.classList.add('visible');
  }

  // =========================================================
  // Seed / bracket compatibility note
  // =========================================================
  const seedNoteEl = document.getElementById('summarySeedNote');
  if (seedNoteEl && seedMeta && typeof a.seed === 'number' && typeof b.seed === 'number') {
    const { seedA, seedB, possible, isAllowed, earliest } = seedMeta;

    const friendlyRounds = Array.isArray(possible)
      ? possible.map(getRoundLabelFromCode)
      : [];

    const currentLabel   = getRoundLabelFromCode(round || CURRENT_ROUND);
    const earliestLabel  = earliest ? getRoundLabelFromCode(earliest) : null;

    if (!friendlyRounds.length) {
      seedNoteEl.textContent = '';
    } else if (isAllowed) {
      seedNoteEl.textContent =
        `Bracket note: As seeds ${seedA} and ${seedB}, these teams can meet in ${friendlyRounds.join(', ')}. ${currentLabel} is a valid meeting round.`;
    } else {
      seedNoteEl.textContent =
        `Bracket note: As seeds ${seedA} and ${seedB}, these teams can meet in ${friendlyRounds.join(', ')}. ${currentLabel} is not a valid meeting round in a standard 64-team bracket.`;
    }

    if (earliestLabel && !isAllowed) {
      seedNoteEl.textContent += ` Earliest possible meeting: ${earliestLabel}.`;
    }
  }

  miRenderMadnessDelta(absDiff);
}

const MI_INTERACTION_UI_ORDER = [
  "turnover_pressure",
  "perimeter_variance_pressure",
  "rim_access_pressure",
  "rebounding_pressure",
  "foul_pressure"
];

const MI_INTERACTION_UI_LABELS = {
  turnover_pressure: "Turnover Pressure",
  perimeter_variance_pressure: "Perimeter Variance",
  rim_access_pressure: "Rim Access",
  rebounding_pressure: "Rebounding Pressure",
  foul_pressure: "Foul Pressure"
};

function miNormalizeInteractionEntry(raw, aName = "Team A", bName = "Team B") {
  let aAdj = 0;
  let bAdj = 0;
  let edgeText = "EVEN";
  let winner = null;
  let displayStrength = "none";

  if (typeof raw === "number") {
    aAdj = raw;
    bAdj = -raw;
    winner = raw > 0 ? "A" : raw < 0 ? "B" : null;
    edgeText =
      raw > 0 ? `FAVORS ${aName}` :
      raw < 0 ? `FAVORS ${bName}` :
      "EVEN";
  } else if (raw && typeof raw === "object") {
    aAdj = Number(raw.aAdj ?? 0);
    bAdj = Number(raw.bAdj ?? 0);
    winner = raw.winner ?? (aAdj > 0 ? "A" : aAdj < 0 ? "B" : null);
    displayStrength = raw.display_strength || "none";

    edgeText =
      raw.edge ||
      (winner === "A" ? `FAVORS ${aName}` :
       winner === "B" ? `FAVORS ${bName}` :
       "EVEN");
  }

  return {
    aAdj,
    bAdj,
    edgeText,
    winner,
    displayStrength
  };
}

function miInteractionCapValue() {
  return 1.25;
}

function miInteractionIntensityMeta(raw, normalized) {
  const strength = String(
    raw?.display_strength ??
    normalized?.displayStrength ??
    ""
  ).toLowerCase();

  if (strength === "high") {
    return { label: "High", pillClass: "is-high", rowClass: "tier-high" };
  }
  if (strength === "medium") {
    return { label: "Medium", pillClass: "is-mid", rowClass: "tier-mid" };
  }
  if (strength === "low") {
    return { label: "Low", pillClass: "is-low", rowClass: "tier-low" };
  }

  const x = Math.max(
    Math.abs(Number(normalized?.aAdj ?? 0)),
    Math.abs(Number(normalized?.bAdj ?? 0))
  );

  if (x >= 0.45) return { label: "High", pillClass: "is-high", rowClass: "tier-high" };
  if (x >= 0.20) return { label: "Medium", pillClass: "is-mid", rowClass: "tier-mid" };
  if (x > 0) return { label: "Low", pillClass: "is-low", rowClass: "tier-low" };

  return { label: "None", pillClass: "is-low", rowClass: "tier-low" };
}

function miInteractionBarWidths(normalized) {
  const cap = miInteractionCapValue();

  const aAdj = Number(normalized?.aAdj ?? 0);
  const bAdj = Number(normalized?.bAdj ?? 0);
  const winner = normalized?.winner ?? null;

  const edgeMag = Math.max(Math.abs(aAdj), Math.abs(bAdj));
  const pct = Math.max(0, Math.min(100, (edgeMag / cap) * 100));

  return {
    aWidth: winner === "A" ? pct : 0,
    bWidth: winner === "B" ? pct : 0
  };
}

function miInteractionSubLabel(normalized, aName, bName) {
  if (normalized?.winner === "A") return `Leans ${aName}`;
  if (normalized?.winner === "B") return `Leans ${bName}`;
  return "Balanced";
}

function miInteractionSrLabel(label, normalized, intensity, aName, bName) {
  const aAdj = Number(normalized?.aAdj ?? 0);
  const bAdj = Number(normalized?.bAdj ?? 0);

  const aDisplay = miFormatDisplayTotal(miDisplayImpactRaw(aAdj));
  const bDisplay = miFormatDisplayTotal(miDisplayImpactRaw(bAdj));

  if (normalized?.winner === "A") {
    return `${label}. Favors ${aName}. Intensity ${intensity}. Display impact ${aDisplay} to ${aName} and ${bDisplay} to ${bName}.`;
  }
  if (normalized?.winner === "B") {
    return `${label}. Favors ${bName}. Intensity ${intensity}. Display impact ${aDisplay} to ${aName} and ${bDisplay} to ${bName}.`;
  }
  return `${label}. Balanced. Intensity ${intensity}.`;
}

function renderInteractionsTable(result) {
  const table = document.getElementById("interactionsTable");
  const totalsBar = document.getElementById("interactionTotalsBar");
  if (!table) return;

  const aName = result?.a?.name || result?.teamA?.name || result?.a?.team || "Team A";
  const bName = result?.b?.name || result?.teamB?.name || result?.b?.team || "Team B";

  const breakdown = result?.interactions?.breakdown || {};
  const tbody = table.querySelector("tbody");
  const rowTpl = document.getElementById("miInteractionRowTemplate");
  if (!tbody || !rowTpl) return;

  tbody.innerHTML = "";

  MI_INTERACTION_UI_ORDER.forEach((key) => {
    const raw = breakdown[key];
    const normalized = miNormalizeInteractionEntry(raw, aName, bName);
    const intensity = miInteractionIntensityMeta(raw, normalized);
    const widths = miInteractionBarWidths(normalized);

    const rowFrag = rowTpl.content.cloneNode(true);    
    const tr = rowFrag.querySelector(".mi-int-row");
    const labelMain = rowFrag.querySelector(".mi-int-label-main");
    const labelSub = rowFrag.querySelector(".mi-int-label-sub");
    const barCell = rowFrag.querySelector(".mi-int-bar-cell");
    const barWrap = rowFrag.querySelector(".mi-int-bar-wrap");
    const fillA = rowFrag.querySelector(".mi-int-bar-fill-a");
    const fillB = rowFrag.querySelector(".mi-int-bar-fill-b");
    const sr = rowFrag.querySelector(".mi-int-bar-sr");
    const pill = rowFrag.querySelector(".mi-int-intensity-pill");
    
    if (tr) {
      tr.setAttribute("data-int-key", key);
      tr.classList.add(intensity.rowClass);
    }

    if (labelMain) {
      labelMain.textContent = MI_INTERACTION_UI_LABELS[key] || key;
    }

    if (labelSub) {
      labelSub.textContent = miInteractionSubLabel(normalized, aName, bName);

      /* move the sublabel under the leverage bar instead of under the left label */
      if (barCell && barWrap) {
        labelSub.classList.add("mi-int-bar-sub");
        barCell.appendChild(labelSub);
      }
    }

    if (fillA) {
      fillA.style.width = `${widths.aWidth}%`;
    }

    if (fillB) {
      fillB.style.width = `${widths.bWidth}%`;
    }

    if (sr) {
      sr.textContent = miInteractionSrLabel(
        MI_INTERACTION_UI_LABELS[key] || key,
        normalized,
        intensity.label,
        aName,
        bName
      );
    }

    if (pill) {
      pill.textContent = intensity.label;
      pill.classList.add(intensity.pillClass);
    }

    tbody.appendChild(rowFrag);
  });

  const totalA = Number(result?.interactions?.a ?? 0);
  const totalB = Number(result?.interactions?.b ?? 0);

  const totalADisplay = miDisplayImpactRaw(totalA);
  const totalBDisplay = miDisplayImpactRaw(totalB);

  if (totalsBar) {
    const totalAClass = totalADisplay >= 0 ? "pos" : "neg";
    const totalBClass = totalBDisplay >= 0 ? "pos" : "neg";

    totalsBar.innerHTML = `
      <div class="totals-inline">
        <span class="totals-team">${aName}</span>
        <span class="totals-val ${totalAClass}">${miFormatDisplayTotal(totalADisplay)}</span>
        <span class="totals-sep">/</span>
        <span class="totals-team">${bName}</span>
        <span class="totals-val ${totalBClass}">${miFormatDisplayTotal(totalBDisplay)}</span>
      </div>
    `;
   }
}

/* ==========================================================================
   Interaction Console (v3.5) — Wiring + Selection + Sync
   Depends on:
   - #interactionConsoleBody (HTML)
   - #interactionsTable (HTML)
   - window.MI_COPY.interactions_console (copy.json)
   ========================================================================== */

const INT_CONSOLE_KEYMAP = {
  turnover_pressure: "turnover_pressure",
  perimeter_variance_pressure: "three_pt_tension",
  rim_access_pressure: "paint_tension",
  rebounding_pressure: "glass_tension",
  foul_pressure: "ft_pressure"
};

function miHash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function miStrength(absAdj) {
  if (absAdj >= 0.50) return 'major';
  if (absAdj >= 0.25) return 'moderate';
  if (absAdj >  0.00) return 'thin';
  return 'none';
}

function miCaseFor(adj, eps = 1e-9) {
  if (Math.abs(adj) <= eps) return 'even';
  return adj > 0 ? 'a_adv' : 'b_adv';
}

function miFillTeamTokens(text, aName, bName, tokenA = "{{TEAM_A}}", tokenB = "{{TEAM_B}}") {
  if (!text) return "";
  return String(text)
    .split(tokenA).join(aName)
    .split(tokenB).join(bName);
}

function miPickPool({ seedBase, rerunIndex, hasAlt }) {
  // stable flip only on rerun; if no alt, always primary
  if (!hasAlt) return 'primary';
  const h = miHash32(seedBase);
  const preferAlt = ((h + (rerunIndex || 0)) % 2) === 1;
  return preferAlt ? 'alt' : 'primary';
}

function miPickLine(lines, seedBase, rerunIndex, salt) {
  if (!Array.isArray(lines) || lines.length === 0) return "";
  const h = miHash32(seedBase + "::" + salt);
  const idx = (h + (rerunIndex || 0)) % lines.length;
  return lines[idx];
}

function miPairsToRender({ card, isTopDriver, defaults }) {
  let pairs = Number(defaults?.pair_count_default ?? 1);

  if (isTopDriver) {
    pairs = Math.max(pairs, Number(defaults?.pair_count_if_top_driver ?? 2));
  }

  const threshold = String(defaults?.pair_count_if_strength_at_least ?? 'moderate').toLowerCase();
  const s = miStrength(Math.abs(card.adj));

  const meetsThreshold =
    threshold === 'thin' ||
    (threshold === 'moderate' && (s === 'moderate' || s === 'major')) ||
    (threshold === 'major' && s === 'major');

  if (meetsThreshold) pairs = Math.max(pairs, 2);

  // Even interactions: keep them single-line unless they’re also a true driver
  if (card.case === 'even' && !(isTopDriver && s !== 'none')) pairs = 1;

  return Math.max(1, Math.min(2, pairs));
}

function renderInteractionsConsole(result) {
  const host = document.getElementById("interactionsNarrativeHost");
  if (!host) return;

  const breakdown = result?.interactions?.breakdown || null;

  if (!breakdown) {
    host.innerHTML = `
      <div class="int-console-card is-placeholder">
        <div class="int-console-label">
          <span class="int-console-title">READY</span>
        </div>
        <div class="int-console-text">
          Run a matchup to populate the interaction channel narratives.
        </div>
      </div>
    `;
    return;
  }

  const copyRoot = window.MI_COPY?.interactions_console || null;
  const defaults = copyRoot?.meta?.defaults || {};
  const aName = result?.a?.name || result?.teamA?.name || result?.a?.team || "Team A";
  const bName = result?.b?.name || result?.teamB?.name || result?.b?.team || "Team B";

  host.innerHTML = "";

  const cardsMeta = MI_INTERACTION_UI_ORDER.map((key) => {
    const raw = breakdown?.[key];
    const normalized = miNormalizeInteractionEntry(raw, aName, bName);
    const adj = Math.abs(Number(normalized.aAdj ?? 0));

    return {
      key,
      raw,
      normalized,
      adj
    };
  });

  const sortedByAdj = [...cardsMeta].sort((a, b) => b.adj - a.adj);
  const topDriverKey = sortedByAdj[0]?.adj > 0 ? sortedByAdj[0]?.key : null;

  cardsMeta.forEach((meta, idx) => {
    const { key, normalized, adj } = meta;

    const copyKey = INT_CONSOLE_KEYMAP[key] || key;
    const copyCh = copyRoot?.channels?.[copyKey] || null;

    const title =
      copyCh?.label ||
      MI_INTERACTION_UI_LABELS[key] ||
      key;

    const resolvedCaseKey =
      normalized.winner === "A" ? "a_adv" :
      normalized.winner === "B" ? "b_adv" :
      "even";

    const caseObj = copyCh?.cases?.[resolvedCaseKey] || null;

    const seedBase = [
      result?.a?.name || "A",
      result?.b?.name || "B",
      result?.activeRound || result?.round || "",
      key,
      resolvedCaseKey
    ].join("::");

    const hasAlt = !!(caseObj?.alt || caseObj?.sentence_sets?.alt);

    const variant = miPickPool({
      seedBase,
      rerunIndex: 0,
      hasAlt
    });

    const pools =
      caseObj?.[variant] ||
      caseObj?.primary ||
      caseObj?.sentence_sets?.[variant] ||
      caseObj?.sentence_sets?.primary ||
      null;

    const isTopDriver = key === topDriverKey;
    const pairsToRender = miPairsToRender({
      card: { adj, case: resolvedCaseKey },
      isTopDriver,
      defaults
    });

    const line1 = pools?.s1
      ? miFillTeamTokens(
          miPickLine(pools.s1, seedBase, 0, `${key}::${resolvedCaseKey}::s1`),
          aName,
          bName
        )
      : "";

    const line2 = (pairsToRender >= 2 && pools?.s2?.length)
      ? miFillTeamTokens(
          miPickLine(pools.s2, seedBase, 0, `${key}::${resolvedCaseKey}::s2`),
          aName,
          bName
        )
      : "";

    const text = [line1, line2].filter(Boolean).join(" ");

    const card = document.createElement("div");
    card.className = "int-console-card";
    card.dataset.intKey = key;

    const labelEl = document.createElement("div");
    labelEl.className = "int-console-label";

    const titleSpan = document.createElement("span");
    titleSpan.className = "int-console-title";
    titleSpan.textContent = title.toUpperCase();

    const pill = document.createElement("span");
    pill.classList.add("int-edge-pill");

    if (normalized.winner === "A") {
      pill.classList.add("int-edge-A");
      pill.textContent = `FAVORS ${aName}`;
    } else if (normalized.winner === "B") {
      pill.classList.add("int-edge-B");
      pill.textContent = `FAVORS ${bName}`;
    } else {
      pill.classList.add("int-edge-even");
      pill.textContent = "EVEN";
    }

    labelEl.appendChild(titleSpan);
    labelEl.appendChild(pill);

    const textEl = document.createElement("div");
    textEl.className = "int-console-text";
    textEl.textContent = text || "—";

    card.appendChild(labelEl);
    card.appendChild(textEl);
    host.appendChild(card);
  });
}

function clearInteractionConsoleSpotlight() {
  const body = document.getElementById('interactionsNarrativeHost');
  if (!body) return;

  body.querySelectorAll('.int-console-card.is-active').forEach(el => {
    el.classList.remove('is-active');
  });

  const table = document.getElementById('interactionsTable');
  if (table) {
    table.querySelectorAll('tbody tr.is-console-active').forEach(tr => {
      tr.classList.remove('is-console-active');
    });
  }
}

function spotlightInteractionConsole(key) {
  if (!key) return;

  const body = document.getElementById('interactionsNarrativeHost');
  if (!body) return;

  clearInteractionConsoleSpotlight();

  const card = body.querySelector(`.int-console-card[data-int-key="${key}"]`);
  if (card) card.classList.add('is-active');

  const table = document.getElementById('interactionsTable');
  if (table) {
    const tr = table.querySelector(`tbody tr[data-int-key="${key}"]`);
    if (tr) tr.classList.add('is-console-active');
  }
}

function initInteractionConsoleSync() {
  const table = document.getElementById('interactionsTable');
  if (!table || table.__miInteractionSyncBound) return;
  table.__miInteractionSyncBound = true;

  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  tbody.addEventListener('mouseover', (e) => {
    const tr = e.target.closest('tr[data-int-key]');
    if (!tr) return;
    spotlightInteractionConsole(tr.dataset.intKey);
  });

  tbody.addEventListener('mouseout', (e) => {
    const related = e.relatedTarget;
    if (related && tbody.contains(related)) return;
    clearInteractionConsoleSpotlight();
  });

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-int-key]');
    if (!tr) return;

    const key = tr.dataset.intKey;
    const body = document.getElementById('interactionsNarrativeHost');
    const active = body?.querySelector(`.int-console-card.is-active[data-int-key="${key}"]`);

    if (active) {
      clearInteractionConsoleSpotlight();
      return;
    }

    spotlightInteractionConsole(key);

    window.clearTimeout(window.__MI_INT_CONSOLE_TAP_TIMER);
    window.__MI_INT_CONSOLE_TAP_TIMER = window.setTimeout(() => {
      clearInteractionConsoleSpotlight();
    }, 1800);
  });
}

// ========== RENDER PROFILE MARK BADGES ==========
function renderProfileMarks(team, containerId) {
  const el = document.getElementById(containerId);
  if (!el || !team || !Array.isArray(team.profileMarks)) return;

  const PROFILE_MARK_BADGE_PATH = "assets/img/badges/";

  el.innerHTML = '';
  
  // Empty state
  if (team.profileMarks.length === 0) {
    el.innerHTML = `
      <div class="pm-empty" role="status" aria-live="polite">
        <div class="pm-empty-inner">
          <svg class="pm-empty-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 8v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M12 16.5h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
            <path d="M10.3 3.9 2.6 19.2A2 2 0 0 0 4.4 22h15.2a2 2 0 0 0 1.8-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z"
                  stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" opacity="0.9"/>
          </svg>

          <div class="pm-empty-title">No Profile Marks Detected</div>
          <div class="pm-empty-text">
            This team does not meet the criteria for any profile marks.
          </div>
        </div>
      </div>
    `;
    return;
  }

  const BADGE_MAP = {
    "Offensive Rigidity — Moderate": "badge_offensive_rigidity_moderate.svg",
    "Offensive Rigidity — Severe":   "badge_offensive_rigidity_severe.svg",

    "Unstable Perimeter — Moderate": "badge_unstable_perimeter_moderate.svg",
    "Unstable Perimeter — Severe":   "badge_unstable_perimeter_severe.svg",

    "Cold Arc Team — Moderate": "badge_cold_arc_moderate.svg",
    "Cold Arc Team — Severe":   "badge_cold_arc_severe.svg",

    "Undisciplined Defense — Moderate": "badge_undisciplined_defense_moderate.svg",
    "Undisciplined Defense — Severe":   "badge_undisciplined_defense_severe.svg",

    "Soft Interior — Moderate": "badge_soft_interior_moderate.svg",
    "Soft Interior — Severe":   "badge_soft_interior_severe.svg",

    "Perimeter Leakage — Moderate": "badge_perimeter_leakage_moderate.svg",
    "Perimeter Leakage — Severe":   "badge_perimeter_leakage_severe.svg",

    "Tempo Strain — Moderate": "badge_tempo_strain_moderate.svg",
    "Tempo Strain — Severe":   "badge_tempo_strain_severe.svg",
  };

  team.profileMarks.forEach(mark => {
    const filename = BADGE_MAP[mark];
    if (!filename) return;

    // Example mark string: "Tempo Strain — Severe"
    const parts    = mark.split('—');
    const baseName = (parts[0] || mark).trim();
    const severity = mark.includes('Severe')   ? 'Severe'
                    : mark.includes('Moderate') ? 'Moderate'
                    : 'Neutral';

    const chip = document.createElement('div');
    chip.className = 'mark-chip';
    if (severity === 'Severe')   chip.classList.add('severe');
    if (severity === 'Moderate') chip.classList.add('moderate');

    const iconPlate = document.createElement('div');
    iconPlate.className = 'mark-icon-plate';

    const img = document.createElement('img');
    img.src = PROFILE_MARK_BADGE_PATH + filename;
    img.alt = baseName;
    img.className = 'mark-badge';
    iconPlate.appendChild(img);

    const info = document.createElement('div');
    info.className = 'mark-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'mark-title';
    titleEl.textContent = baseName;

    const subEl = document.createElement('div');
    subEl.className = 'mark-subtext';
    subEl.textContent = getMarkDescription(baseName, severity);

    info.appendChild(titleEl);
    info.appendChild(subEl);

    chip.appendChild(iconPlate);
    chip.appendChild(info);

    chip.title = mark;

    el.appendChild(chip);
  });
}

// ========== SMALL HELPERS FOR RENDERING ==========

function fmt(val, digits) {
  if (val === null || val === undefined || isNaN(val)) return '—';
  return Number(val).toFixed(digits);
}

function showFooter() {
  const f = document.getElementById('appFooter');
  if (f) f.classList.remove('hidden');
}

function hideFooter() {
  const f = document.getElementById('appFooter');
  if (f) f.classList.add('hidden');
}

function miSyncGlossaryToMatchupState() {
  const appShell = document.querySelector('.app-shell');
  const hasMatchup = !!(appShell && appShell.classList.contains('has-matchup'));

  if (window.miSetGlossaryAvailable) {
    window.miSetGlossaryAvailable(hasMatchup);
  }
}

function detectMatchupVisible(){
  const appShell = document.querySelector('.app-shell');
  return !!(appShell && appShell.classList.contains('has-matchup'));
}

// ========== MATCHUP BAR TOGGLING ==========

function updateMatchupBarFromDOM() {
  const matchupBar = document.getElementById('matchupBar');
  const topBar = document.querySelector('.top-bar') || document.getElementById('preSetupRow');
  const appShell = document.querySelector('.app-shell');

  if (!matchupBar || !topBar || !appShell) return;

  // Show the matchup bar (your existing behavior may differ; keep this consistent with your app)
  matchupBar.classList.remove('hidden');

  // Canonical: entering matchup mode
  appShell.classList.add('has-matchup');
  appShell.classList.remove('pre-matchup');

  const teamANameEl  = document.getElementById('teamATitle');
  const teamBNameEl  = document.getElementById('teamBTitle');
  const seedAEl      = document.getElementById('teamASeed');
  const seedBEl      = document.getElementById('teamBSeed');

  const cName = teamANameEl ? teamANameEl.textContent.trim() : 'Team A';
  const fName = teamBNameEl ? teamBNameEl.textContent.trim() : 'Team B';
  const cSeed = seedAEl ? seedAEl.textContent.trim() : '';
  const fSeed = seedBEl ? seedBEl.textContent.trim() : '';

  const cNameOut = document.getElementById('matchupCinderName');
  const fNameOut = document.getElementById('matchupFavoriteName');
  const cSeedOut = document.getElementById('matchupCinderSeed');
  const fSeedOut = document.getElementById('matchupFavoriteSeed');

  if (cNameOut) cNameOut.textContent = cName;
  if (fNameOut) fNameOut.textContent = fName;
  if (cSeedOut) cSeedOut.textContent = cSeed ? `(${cSeed})` : '';
  if (fSeedOut) fSeedOut.textContent = fSeed ? `(${fSeed})` : '';

  // Round pill should be state-driven
  if (typeof miUpdateMatchupRoundPill === 'function') {
    miUpdateMatchupRoundPill(CURRENT_ROUND);
  }

  matchupBar.classList.add('visible');
  topBar.classList.add('collapsed');

  showFooter();

  // Sync glossary to true matchup state (will reveal affordance)
  miSyncGlossaryToMatchupState();
}

function hideMatchupBar() {
  const matchupBar = document.getElementById('matchupBar');
  if (matchupBar) {
    matchupBar.classList.add('hidden');
  }

  // Canonical app-mode reset
  const appShell = document.querySelector('.app-shell');
  if (appShell) {
    appShell.classList.remove('has-matchup');
    appShell.classList.add('pre-matchup');
  }

  // Sync glossary to true matchup state (will close + hide)
  miSyncGlossaryToMatchupState();
}

function ensureQuickEditSandboxToggle() {
  const matchupBar = document.getElementById('matchupBar');
  if (!matchupBar) return;

  // IMPORTANT: round selector lives here (and gets moved into #matchupQuickRound in edit mode)
  const rWrap = document.getElementById('roundSelectorWrap');
  if (!rWrap) return;

  // Helper: set sandbox in a way ALL code paths see
  function setSandboxMode(next) {
    const on = !!next;

    // Write BOTH (some code reads window.SANDBOX_MODE, some reads SANDBOX_MODE)
    try { window.SANDBOX_MODE = on; } catch(e) {}
    try { SANDBOX_MODE = on; } catch(e) {}

    // Visual hook for the bar (header swap + styling)
    matchupBar.classList.toggle('is-sandbox', on);

    // Mirror the pre-matchup toggle if it exists (AND trigger its listeners)
    const hubToggle = document.getElementById('sandboxModeToggle');
    if (hubToggle && hubToggle.checked !== on) {
      hubToggle.checked = on;
      // IMPORTANT: fire change so any existing constraint logic runs
      hubToggle.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Existing logic hooks (safe to keep)
    if (typeof updateRoundOptionsForCurrentSeeds === 'function') {
      updateRoundOptionsForCurrentSeeds();
    }
    if (typeof refreshCompareButtonState === 'function') {
      refreshCompareButtonState();
    }
  }

  // Create once (mounted next to #roundSelectBtn)
  let quickToggle = document.getElementById('sandboxModeToggleQuick');
  if (!quickToggle) {
    const wrap = document.createElement('label');
    wrap.id = 'miSandboxQuickLabel';
    // Reuse the SAME classes as the pre-matchup toggle
    wrap.className = 'sandbox-toggle enhanced-sandbox mi-sandbox-quick';
    wrap.setAttribute('data-tooltip', 'Ignores bracket round constraints');

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'sandboxModeToggleQuick';

    const text = document.createElement('span');
    text.textContent = 'Sandbox Mode';

    wrap.appendChild(input);
    wrap.appendChild(text);

    // Place immediately after the round button inside the same wrap
    const roundBtn = document.getElementById('roundSelectBtn');
    if (roundBtn && roundBtn.parentElement === rWrap) {
      roundBtn.insertAdjacentElement('afterend', wrap);
    } else {
      rWrap.appendChild(wrap);
    }

    // Wire behavior
    input.addEventListener('change', () => {
      setSandboxMode(input.checked);
    });

    quickToggle = input;
  }

  // Sync state every time we enter edit mode (prefer hub toggle if present)
  const hubToggle = document.getElementById('sandboxModeToggle');
  const current =
    (hubToggle ? !!hubToggle.checked :
      (typeof window !== 'undefined' && typeof window.SANDBOX_MODE !== 'undefined'
        ? !!window.SANDBOX_MODE
        : !!SANDBOX_MODE));

  quickToggle.checked = current;
  setSandboxMode(current);
}

// ===== MATCHUP BAR QUICK EDIT (INLINE) =====
let __MI_QUICK_EDIT_HOME = null;
let __MI_DATASET_CHANGE_SEQ = 0;
let __MI_DATASET_CHANGE_IN_FLIGHT = false;

function enterMatchupQuickEdit() {
  const matchupBar = document.getElementById('matchupBar');
  if (!matchupBar) return;

  const slotA = document.getElementById('matchupQuickA');
  const slotB = document.getElementById('matchupQuickB');
  const slotD = document.getElementById('matchupQuickDataset');
  const slotR = document.getElementById('matchupQuickRound');
  if (!slotA || !slotB || !slotR) return;

  const aWrap = document.getElementById('teamASelectWrap');
  const bWrap = document.getElementById('teamBSelectWrap');
  const rWrap = document.getElementById('roundSelectorWrap');

  if (!aWrap || !bWrap || !rWrap) {
    console.warn('[MI] Quick edit could not find select wrappers (teamASelectWrap/teamBSelectWrap/roundSelectorWrap).');
    return;
  }

  // Cache original locations once
  if (!__MI_QUICK_EDIT_HOME) {
    __MI_QUICK_EDIT_HOME = {
      aParent: aWrap.parentElement,
      bParent: bWrap.parentElement,
      rParent: rWrap.parentElement,
      aNext: aWrap.nextSibling,
      bNext: bWrap.nextSibling,
      rNext: rWrap.nextSibling
    };
  }

  matchupBar.classList.add('is-editing');
  slotA.setAttribute('aria-hidden', 'false');
  slotB.setAttribute('aria-hidden', 'false');
  slotD.setAttribute('aria-hidden', 'false');
  slotR.setAttribute('aria-hidden', 'false');

  // Show actions container
  const actions = matchupBar.querySelector('.matchup-quick-actions');
  if (actions) {
    actions.setAttribute('aria-hidden', 'false');
    actions.inert = false;
  }

  // =========================================================
  // QUICK EDIT: build dedicated controls (DO NOT MOVE home UI)
  // =========================================================

  slotA.innerHTML = '';
  slotB.innerHTML = '';
  slotD.innerHTML = '';
  slotR.innerHTML = '';

  // --- Dataset ---
  const datasetHome = document.getElementById('datasetSelect');

  const dWrapQ = document.createElement('div');
  dWrapQ.className = 'select-wrap quick-dataset-select';
  dWrapQ.id = 'datasetQuickSelectWrap';

  const dSelQ = document.createElement('select');
  dSelQ.id = 'datasetSelectQuick';
  dSelQ.setAttribute('aria-label', 'Select dataset');

  if (datasetHome) {
    Array.from(datasetHome.options).forEach(opt => {
      const clone = opt.cloneNode(true);

      // Quick edit should allow the placeholder to remain selectable as a reset path.
      if (clone.value === '') {
        clone.disabled = false;
      }

      dSelQ.appendChild(clone);
    });

    dSelQ.value = datasetHome.value || '';
  } else {
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = 'Select a dataset…';
    dSelQ.appendChild(fallback);
    dSelQ.value = '';
  }

  dWrapQ.appendChild(dSelQ);
  slotD.appendChild(dWrapQ);

  dSelQ.addEventListener('change', async () => {
    const home = document.getElementById('datasetSelect');
    if (!home) return;

    const nextValue = dSelQ.value || '';

    // Even if the values match visually, keep quick + home perfectly synced.
    if (home.value !== nextValue) {
      home.value = nextValue;
    }

    await miHandleCanonicalDatasetChange();
  });

  // --- Team A ---
  const aWrapQ = document.createElement('div');
  aWrapQ.className = 'select-wrap quick-team-select';
  aWrapQ.id = 'teamAQuickSelectWrap';

  const aSelQ = document.createElement('select');
  aSelQ.id = 'teamAQuick';
  aSelQ.setAttribute('data-dd-context', 'quick');
  aSelQ.innerHTML = `<option value="" disabled selected>Select Team A</option>`;

  const homeA = document.getElementById('teamA');
  if (homeA) {
    for (const opt of homeA.options) {
      if (opt.value === '') continue;
      aSelQ.appendChild(opt.cloneNode(true));
    }
    if (homeA.value) aSelQ.value = homeA.value;
  }

  aWrapQ.appendChild(aSelQ);
  slotA.appendChild(aWrapQ);

  // --- Team B ---
  const bWrapQ = document.createElement('div');
  bWrapQ.className = 'select-wrap quick-team-select';
  bWrapQ.id = 'teamBQuickSelectWrap';

  const bSelQ = document.createElement('select');
  bSelQ.id = 'teamBQuick';
  bSelQ.setAttribute('data-dd-context', 'quick');
  bSelQ.innerHTML = `<option value="" disabled selected>Select Team B</option>`;

  const homeB = document.getElementById('teamB');
  if (homeB) {
    for (const opt of homeB.options) {
      if (opt.value === '') continue;
      bSelQ.appendChild(opt.cloneNode(true));
    }
    if (homeB.value) bSelQ.value = homeB.value;
  }

  bWrapQ.appendChild(bSelQ);
  slotB.appendChild(bWrapQ);

  // --- Round (custom button UI + hidden select backing model) ---
  const rWrapQ = document.createElement('div');
  rWrapQ.className = 'select-wrap quick-round-select';
  rWrapQ.id = 'roundQuickSelectWrap';

  // Button that should look like the home button
  const rBtnQ = document.createElement('button');
  rBtnQ.id = 'roundSelectBtnQuick';
  rBtnQ.className = 'btn ghost round-btn';
  rBtnQ.type = 'button';
  rBtnQ.setAttribute('aria-haspopup', 'listbox');
  rBtnQ.setAttribute('aria-expanded', 'false');
  rBtnQ.textContent = 'Select Round';

  // Dropdown panel (we’ll fill with .round-option divs)
  const rDdQ = document.createElement('div');
  rDdQ.id = 'roundDropdownQuick';
  rDdQ.className = 'round-dropdown'; // important: matches home class if your CSS is class-scoped
  rDdQ.setAttribute('role', 'listbox');
  rDdQ.hidden = true;

  // Hidden select (keeps your existing round constraint logic intact)
  const rSelQ = document.createElement('select');
  rSelQ.id = 'roundSelectorQuick';
  rSelQ.setAttribute('data-dd-context', 'quick');
  rSelQ.hidden = true;
  rSelQ.innerHTML = `<option value="" disabled selected>Select Round</option>`;

  // Build both: <option> list AND custom panel items from home roundDropdown
  const homeRoundDd = document.getElementById('roundDropdown');
  if (homeRoundDd) {
    homeRoundDd.querySelectorAll('.round-option[data-round]').forEach(div => {
      const roundVal = div.dataset.round;
      const roundLabel = div.textContent.trim();

      // option for the hidden select
      const opt = document.createElement('option');
      opt.value = roundVal;
      opt.textContent = roundLabel;
      rSelQ.appendChild(opt);

      // visible item for the custom dropdown
      const item = document.createElement('div');
      item.className = 'round-option';
      item.dataset.round = roundVal;
      item.textContent = roundLabel;
      item.setAttribute('role', 'option');

      item.addEventListener('click', () => {
        // set model
        rSelQ.value = roundVal;
        // reflect on button
        rBtnQ.textContent = roundLabel;
        rBtnQ.dataset.selected = roundVal;

        // drive your existing listener path
        rSelQ.dispatchEvent(new Event('change', { bubbles: true }));

        // close panel
        rDdQ.hidden = true;
        rBtnQ.setAttribute('aria-expanded', 'false');
      });

      rDdQ.appendChild(item);
    });
  }

  // Initialize from current home selection if present
  const currentRoundBtn = document.getElementById('roundSelectBtn');
  if (currentRoundBtn && currentRoundBtn.dataset.selected) {
    const val = currentRoundBtn.dataset.selected;
    rSelQ.value = val;
    rBtnQ.dataset.selected = val;

    const matchOpt = [...rSelQ.options].find(o => o.value === val);
    if (matchOpt) rBtnQ.textContent = matchOpt.textContent;
  }

  // Button toggle behavior
  rBtnQ.addEventListener('click', (e) => {
    e.preventDefault();
    const nowOpen = rDdQ.hidden;
    rDdQ.hidden = !nowOpen;
    rBtnQ.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
  });

  // Click-away close
  document.addEventListener('click', (e) => {
    if (rDdQ.hidden) return;
    if (e.target === rBtnQ || rDdQ.contains(e.target)) return;
    rDdQ.hidden = true;
    rBtnQ.setAttribute('aria-expanded', 'false');
  });

  // Mount
  rWrapQ.appendChild(rBtnQ);
  rWrapQ.appendChild(rDdQ);
  rWrapQ.appendChild(rSelQ);
  slotR.appendChild(rWrapQ);

  // =========================================================
  // ROUND CONSTRAINT FILTER
  // Reads seeds from the selected option's data-seed attribute,
  // then enables only the rounds that are valid for that matchup.
  // When sandbox mode is on, all rounds are enabled.
  // =========================================================
  function updateQuickRoundOptions() {
    const sandboxOn =
      !!(typeof window !== 'undefined' && window.SANDBOX_MODE) ||
      !!(typeof SANDBOX_MODE !== 'undefined' && SANDBOX_MODE);

    const teamAName = aSelQ.value || '';
    const teamBName = bSelQ.value || '';

    const teamA = teamAName ? getTeamByName(teamAName) : null;
    const teamB = teamBName ? getTeamByName(teamBName) : null;

    const seedA = teamA && teamA.seed != null ? teamA.seed : null;
    const seedB = teamB && teamB.seed != null ? teamB.seed : null;

    const hasBothSeeds = seedA != null && seedB != null && seedA !== '' && seedB !== '';
    const isFirst4Pair = hasBothSeeds && isFirstFourSeedPlayIn(seedA, seedB);

    let possibleRounds = null;
    if (hasBothSeeds) {
      possibleRounds = getPossibleRoundsForSeeds(seedA, seedB);
    }

    for (const opt of rSelQ.options) {
      if (opt.value === '') continue; // placeholder stays visible

      const val = opt.value;

      // First4 is never a generic sandbox round; only expose it for actual play-in pairs
      if (val === 'First4' && !isFirst4Pair) {
        opt.hidden = true;
        opt.disabled = true;
        continue;
      }

      if (!hasBothSeeds || !possibleRounds) {
        opt.hidden = false;
        opt.disabled = false;
        continue;
      }

      if (sandboxOn) {
        // Sandbox shows all standard rounds, but still keeps First4 restricted
        opt.hidden = false;
        opt.disabled = false;
        continue;
      }

      const ok = possibleRounds.includes(val);
      opt.hidden = !ok;
      opt.disabled = !ok;
    }

    // Mirror the select state onto the custom dropdown items
    const quickItems = slotR.querySelectorAll('#roundDropdownQuick .round-option[data-round]');
    quickItems.forEach(item => {
      const val = item.dataset.round;
      const opt = [...rSelQ.options].find(o => o.value === val);
      if (!opt) return;
      item.style.display = (opt.hidden || opt.disabled) ? 'none' : '';
    });

    const currentAllowed = hasBothSeeds && possibleRounds ? new Set(possibleRounds) : null;

    // If selected round became invalid, clear it
    if (rSelQ.value) {
      const selectedVal = rSelQ.value;
      const stillValid =
        hasBothSeeds
          ? (
              (selectedVal === 'First4' ? isFirst4Pair : true) &&
              (
                sandboxOn
                  ? (selectedVal !== 'First4' || isFirst4Pair)
                  : currentAllowed?.has(selectedVal)
              )
            )
          : true;

      if (!stillValid) {
        rSelQ.value = '';
      }
    }

    // Auto-default canonical play-ins to First4 if nothing valid is selected yet
    if (!rSelQ.value && isFirst4Pair) {
      rSelQ.value = 'First4';
    }

    if (rSelQ.value) {
      const sel = [...rSelQ.options].find(o => o.value === rSelQ.value);
      const label = sel ? sel.textContent : getRoundLabelFromCode(rSelQ.value);
      rBtnQ.textContent = label;
      rBtnQ.dataset.selected = rSelQ.value;
    } else {
      rBtnQ.textContent = 'Select Round';
      delete rBtnQ.dataset.selected;
    }
  }

  // Run once on open with whatever is already selected
  updateQuickRoundOptions();

  // --- Sync listeners ---
  aSelQ.addEventListener('change', () => {
    const home = document.getElementById('teamA');
    if (home) { home.value = aSelQ.value; home.dispatchEvent(new Event('change', { bubbles: true })); }
    updateQuickRoundOptions();
  });

  bSelQ.addEventListener('change', () => {
    const home = document.getElementById('teamB');
    if (home) { home.value = bSelQ.value; home.dispatchEvent(new Event('change', { bubbles: true })); }
    updateQuickRoundOptions();
  });

  rSelQ.addEventListener('change', () => {
    const matching = document.querySelector(
      `#roundDropdown .round-option[data-round="${rSelQ.value}"]`
    );
    if (matching) matching.click();
  });

  // --- Searchable dropdowns ---
  ensureSearchableTeamDropdown(aSelQ, aWrapQ, 'Select Team A', 'quick');
  ensureSearchableTeamDropdown(bSelQ, bWrapQ, 'Select Team B', 'quick');

  // --- Sandbox toggle ---
  ensureQuickEditSandboxToggle();

  const sandboxLabel = document.getElementById('miSandboxQuickLabel');
  if (sandboxLabel && slotR) {
    const clone = sandboxLabel.cloneNode(true);
    clone.id = 'miSandboxQuickLabelBar';
    const cloneInput = clone.querySelector('input');
    if (cloneInput) {
      cloneInput.id = 'sandboxModeToggleQuickBar';
      const original = document.getElementById('sandboxModeToggleQuick');
      if (original) cloneInput.checked = original.checked;
      cloneInput.addEventListener('change', () => {
        const orig = document.getElementById('sandboxModeToggleQuick');
        if (orig && orig.checked !== cloneInput.checked) {
          orig.checked = cloneInput.checked;
          orig.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Re-filter round options immediately when sandbox toggles
        updateQuickRoundOptions();
      });
    }
    slotR.appendChild(clone);
  }

  dSelQ.focus();
}

function exitMatchupQuickEdit() {
  const matchupBar = document.getElementById('matchupBar');
  if (!matchupBar) return;

  const slotA = document.getElementById('matchupQuickA');
  const slotB = document.getElementById('matchupQuickB');
  const slotD = document.getElementById('matchupQuickDataset');
  const slotR = document.getElementById('matchupQuickRound');

  const actions = matchupBar.querySelector('.matchup-quick-actions');

  const active = document.activeElement;
  const focusIsInside =
    !!active &&
    (
      (actions && actions.contains(active)) ||
      (slotA && slotA.contains(active)) ||
      (slotB && slotB.contains(active)) ||
      (slotD && slotD.contains(active)) ||
      (slotR && slotR.contains(active))
    );

  if (focusIsInside) {
    const fallback =
      document.getElementById('teamA') ||
      document.getElementById('teamB') ||
      document.getElementById('roundSelector') ||
      document.getElementById('matchupRunBtn');

    if (fallback && typeof fallback.focus === 'function') {
      fallback.focus();
    } else if (active && typeof active.blur === 'function') {
      active.blur();
    }
  }

  matchupBar.classList.remove('is-editing');
  slotA?.setAttribute('aria-hidden', 'true');
  slotB?.setAttribute('aria-hidden', 'true');
  slotD?.setAttribute('aria-hidden', 'true');
  slotR?.setAttribute('aria-hidden', 'true');

  if (actions) {
    actions.setAttribute('aria-hidden', 'true');
    actions.inert = true;
  }

  slotA && (slotA.innerHTML = '');
  slotB && (slotB.innerHTML = '');
  slotD?.setAttribute('aria-hidden', 'true');
  slotR && (slotR.innerHTML = '');

  const roundDropdown = document.getElementById('roundDropdown');
  if (roundDropdown) roundDropdown.classList.add('hidden');
}

function showAnalysisShell() {
  const shell = document.getElementById('analysisShell');
  if (!shell) return;

  shell.classList.remove('hidden');
  requestAnimationFrame(() => shell.classList.add('analysis-visible'));
}

function hideAnalysisShell() {
  const shell = document.getElementById('analysisShell');
  if (!shell) return;

  shell.classList.remove('analysis-visible');
  window.setTimeout(() => {
    shell.classList.add('hidden');
  }, 280);
}

function getCoreThresholdText(rowKey, row = null) {
  const copy = window.MI_COPY || {};
  const ui = copy.core_profile_ui || {};
  const fallbackCfg = (copy.core_profile && copy.core_profile.breadth_row) || {};

  const avgLabel = ui.avg_label || 'Avg';
  const sdLabel = ui.sd_label || 'SD';

  const mean =
    Number.isFinite(Number(row?.mean)) ? Number(row.mean) :
    Number.isFinite(Number(row?.fieldMean)) ? Number(row.fieldMean) :
    Number.isFinite(Number(row?.field_mean)) ? Number(row.field_mean) :
    null;

  const sd =
    Number.isFinite(Number(row?.sd)) ? Number(row.sd) :
    Number.isFinite(Number(row?.fieldSd)) ? Number(row.fieldSd) :
    Number.isFinite(Number(row?.field_sd)) ? Number(row.field_sd) :
    null;

  const avgText = mean == null
    ? (fallbackCfg.threshold_text || '—')
    : fmt(mean, 3);

  const sdText = sd == null
    ? (fallbackCfg.threshold_text || '—')
    : fmt(sd, 3);

  return `
    <div class="threshold-stack">
      <span class="threshold-chip">${avgLabel} ${avgText}</span>
      <span class="threshold-chip">${sdLabel} ${sdText}</span>
    </div>
  `;
}

function getCoreFieldSpreadText(rowKey, row = null) {
  const copy = window.MI_COPY || {};
  const ui = copy.core_profile_ui || {};

  const spreadLabel = ui.spread_short_label || 'σ';
  const spreadTitle =
    ui.spread_tooltip ||
    'Standard deviation of this battlefield score across the tournament field. Larger spread means more separation between teams in this area.';

  const keyMap = {
    orb: 'orb',
    efg: 'efg',
    to_inv: 'to',
    ftr: 'ftr',
    def_efg: 'def_efg',
    drb: 'drb',
    opp_to: 'otpp',
    opp_ftr: 'opp_ftr'
  };

  const fallbackFieldKey = keyMap[rowKey] || rowKey;

  const sd =
    Number.isFinite(Number(row?.sd)) ? Number(row.sd) :
    Number.isFinite(Number(row?.fieldSd)) ? Number(row.fieldSd) :
    Number.isFinite(Number(row?.field_sd)) ? Number(row.field_sd) :
    Number.isFinite(Number(FIELD_STATS?.[fallbackFieldKey]?.sd)) ? Number(FIELD_STATS[fallbackFieldKey].sd) :
    null;

  return `
    <div class="threshold-stack">
      <span class="threshold-chip" title="${spreadTitle}">
        ${spreadLabel} ${sd == null ? '—' : fmt(sd, 3)}
      </span>
    </div>
  `;
}

function getCoreScoreColorClass(score) {
  const v = Number(score);
  if (!Number.isFinite(v)) return 'score-neutral';

  if (v >= 1.00) return 'score-elite';
  if (v >= 0.50) return 'score-strong';
  if (v > -0.50) return 'score-neutral';
  if (v > -1.00) return 'score-weak';
  return 'score-fragile';
}

function formatSignedScore(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n > 0 ? `+${n.toFixed(digits)}` : n.toFixed(digits);
}

const MI_CORE_OFF_KEYS = new Set(['orb', 'efg', 'to_inv', 'ftr']);
const MI_CORE_DEF_KEYS = new Set(['def_efg', 'drb', 'opp_to', 'opp_ftr']);

function miDisplayImpactRaw(points) {
  const n = Number(points);
  return Number.isFinite(n) ? n * 100 : 0;
}

function miFormatImpactCell(points) {
  const n = Math.round(miDisplayImpactRaw(points));
  if (n > 0) return `+${n}`;
  if (n < 0) return `${n}`;
  return '0';
}

function miFormatDisplayTotal(pointsSum) {
  const n = Number(pointsSum);
  if (!Number.isFinite(n)) return '0.0';
  return n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
}

function miFormatUiPointsFromMiSpace(miValue) {
  const n = Number(miValue);
  if (!Number.isFinite(n)) return '—';

  // canonical UI scale: MI-space -> points
  const pts = n * 100;

  // avoid "-0.0"
  const clean = (Math.abs(pts) < 0.05) ? 0 : pts;

  return miFormatDisplayTotal(clean);
}

function miFormatUiAbsPointsFromMiSpace(miValue) {
  const n = Number(miValue);
  if (!Number.isFinite(n)) return '—';

  // MI-space -> points, absolute magnitude for separation-style displays (gap/delta)
  const pts = Math.abs(n * 100);

  // avoid "-0.0" and tiny noise
  const clean = (pts < 0.05) ? 0 : pts;

  return clean.toFixed(1);
}

function miValueStateClass(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'is-flat';
  if (n > 0.0005) return 'is-pos';
  if (n < -0.0005) return 'is-neg';
  return 'is-flat';
}

function miApplyValueState(el, value) {
  if (!el) return;
  el.classList.remove('is-pos', 'is-neg', 'is-flat');
  el.classList.add(miValueStateClass(value));
}

function miSynthCapValue() {
  return 1.25;
}

function miSynthClamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function miSynthBarWidths(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { posWidth: 0, negWidth: 0 };
  }

  const cap = miSynthCapValue();
  const pctHalf = miSynthClamp((Math.abs(n) / cap) * 50, 0, 50);

  return {
    posWidth: n > 0 ? pctHalf : 0,
    negWidth: n < 0 ? pctHalf : 0
  };
}

function miSetDataValueState(root, key, value) {
  const host = root || document;
  const els = host.querySelectorAll(`[data-value="${key}"]`);
  if (!els || !els.length) return;
  els.forEach(el => miApplyValueState(el, value));
}

function miSetSummaryInlineMetric(stem, side, label, value) {
  const posEl = document.getElementById(`${stem}Bar${side}pos`);
  const negEl = document.getElementById(`${stem}Bar${side}neg`);

  const widths = miSynthBarWidths(value);

  if (posEl) posEl.style.width = `${widths.posWidth}%`;
  if (negEl) negEl.style.width = `${widths.negWidth}%`;
}

function miSynthCapValue() {
  return 1.25;
}

function miSynthClamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function miSynthValueClass(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'is-flat';
  if (n > 0.0005) return 'is-pos';
  if (n < -0.0005) return 'is-neg';
  return 'is-flat';
}

function miSynthBarWidths(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return { posWidth: 0, negWidth: 0 };
  }

  const cap = miSynthCapValue();
  const pctHalf = miSynthClamp((Math.abs(n) / cap) * 50, 0, 50);

  return {
    posWidth: n > 0 ? pctHalf : 0,
    negWidth: n < 0 ? pctHalf : 0
  };
}

function miSummaryValueKey(stem, side) {
  const map = {
    synBase: { A: 'a.base',        B: 'b.base' },
    synOffBreadth: { A: 'a.off_breadth', B: 'b.off_breadth' },
    synDefBreadth: { A: 'a.def_breadth', B: 'b.def_breadth' },
    synIntEff: { A: 'a.int_eff',   B: 'b.int_eff' },
    synResume: { A: 'a.resume_cal', B: 'b.resume_cal' }
  };

  return map?.[stem]?.[side] || null;
}

function miEnsureSummaryInlineMetricCell(stem, side) {
  const key = miSummaryValueKey(stem, side);
  if (!key) return {};

  const cell = document.querySelector(`#summarySection [data-value="${key}"]`);
  if (!cell) return {};

  cell.classList.add('syn-contrib-cell');

  let wrap = cell.querySelector('.mi-synth-inline-wrap');
  let valueEl = cell.querySelector('.mi-synth-inline-value');
  let posEl = cell.querySelector('.mi-synth-inline-fill-pos');
  let negEl = cell.querySelector('.mi-synth-inline-fill-neg');
  let srEl = cell.querySelector('.mi-synth-inline-sr');

  if (!wrap) {
    const currentText = String(cell.textContent || '—').trim() || '—';
    cell.innerHTML = `
      <div class="mi-synth-inline-wrap">
        <div class="mi-synth-inline-bar" aria-hidden="true">
          <span class="mi-synth-inline-center"></span>
          <span id="${stem}Bar${side}neg" class="mi-synth-inline-fill mi-synth-inline-fill-neg"></span>
          <span id="${stem}Bar${side}pos" class="mi-synth-inline-fill mi-synth-inline-fill-pos"></span>
        </div>
        <span class="mi-synth-inline-value">${currentText}</span>
        <span class="mi-synth-inline-sr sr-only"></span>
      </div>
    `;

    wrap = cell.querySelector('.mi-synth-inline-wrap');
    valueEl = cell.querySelector('.mi-synth-inline-value');
    posEl = cell.querySelector('.mi-synth-inline-fill-pos');
    negEl = cell.querySelector('.mi-synth-inline-fill-neg');
    srEl = cell.querySelector('.mi-synth-inline-sr');
  }

  return { cell, wrap, valueEl, posEl, negEl, srEl };
}

function miEnsureScorebugMetricRow(prefix, valueId) {
  const valueEl = document.getElementById(valueId);
  if (!valueEl) return {};

  const line = valueEl.closest('.mi-scorebug-team-line');
  if (!line) return {};

  let wrap = line.querySelector('.mi-scorebug-inline-wrap');
  let posEl = document.getElementById(`${prefix}pos`);
  let negEl = document.getElementById(`${prefix}neg`);
  let srEl  = document.getElementById(prefix.replace('Bar', 'Sr'));

  if (!wrap || !posEl || !negEl) {
    wrap = document.createElement('div');
    wrap.className = 'mi-scorebug-inline-wrap';
    wrap.innerHTML = `
      <div class="mi-scorebug-inline-bar" aria-hidden="true">
        <span class="mi-scorebug-inline-center"></span>
        <span id="${prefix}neg" class="mi-scorebug-inline-fill mi-scorebug-inline-fill-neg"></span>
        <span id="${prefix}pos" class="mi-scorebug-inline-fill mi-scorebug-inline-fill-pos"></span>
      </div>
      <span id="${prefix.replace('Bar', 'Sr')}" class="sr-only"></span>
    `;

    line.appendChild(wrap);
    wrap.appendChild(valueEl);

    posEl = document.getElementById(`${prefix}pos`);
    negEl = document.getElementById(`${prefix}neg`);
    srEl  = document.getElementById(prefix.replace('Bar', 'Sr'));
  }

  valueEl.classList.add('mi-scorebug-inline-value');
  line.classList.add('is-enhanced');

  return { line, wrap, valueEl, posEl, negEl, srEl };
}

function miSetSummaryInlineMetric(stem, side, label, value) {
  const table = document.querySelector('#summarySection .summary-synthesis-table');
  if (table) table.classList.add('mi-summary-synthesis-table');

  let posEl = document.getElementById(`${stem}Bar${side}pos`);
  let negEl = document.getElementById(`${stem}Bar${side}neg`);
  let srEl  = document.getElementById(`${stem}Sr${side}`);
  let valueEl = null;

  if (!posEl || !negEl) {
    const ensured = miEnsureSummaryInlineMetricCell(stem, side);
    posEl = ensured.posEl || posEl;
    negEl = ensured.negEl || negEl;
    srEl = ensured.srEl || srEl;
    valueEl = ensured.valueEl || null;
  }

  const widths = miSynthBarWidths(value);

  if (posEl) posEl.style.width = `${widths.posWidth}%`;
  if (negEl) negEl.style.width = `${widths.negWidth}%`;

  if (valueEl) {
    valueEl.textContent = fmt(value, 3);
    valueEl.classList.remove('is-pos', 'is-neg', 'is-flat');
    valueEl.classList.add(miSynthValueClass(value));
  }

  if (srEl) {
    srEl.textContent = `${label}. Contribution ${miFormatUiPointsFromMiSpace(value)}.`;
  }
}

function miSetTextClassById(id, value) {
  const el = document.getElementById(id);
  if (!el) return;

  el.classList.remove('is-pos', 'is-neg', 'is-flat');
  el.classList.add(miSynthValueClass(value));
}

function miRenderScorebugMetric(prefix, label, value) {
  const posEl = document.getElementById(`${prefix}pos`);
  const negEl = document.getElementById(`${prefix}neg`);
  const srId = prefix
    .replace('Bar', 'Sr')
    .replace(/pos$|neg$/, '');
  const srEl = document.getElementById(srId);

  const widths = miSynthBarWidths(value);

  if (posEl) posEl.style.width = `${widths.posWidth}%`;
  if (negEl) negEl.style.width = `${widths.negWidth}%`;

  if (srEl) {
    srEl.textContent = `${label}. Contribution ${miFormatDisplayTotal(value)}.`;
  }
}

function miRenderScorebugMetrics({
  aName,
  bName,
  baseA,
  baseB,
  finalA,
  finalB,
  gap
}) {
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const gapAbs = Math.abs(Number(gap) || 0);

  const brandA = getTeamBranding(aName);
  const brandB = getTeamBranding(bName);

  miApplyTeamLogo(document.getElementById('miScorebugLogoA'), brandA, aName || 'Team A');
  miApplyTeamLogo(document.getElementById('miScorebugLogoB'), brandB, bName || 'Team B');

  const metricsTile = document.getElementById('miVerdictMetricsTile');

  if (metricsTile) {
    metricsTile.style.setProperty('--mi-brand-a', brandA.primary || '#6b7280');
    metricsTile.style.setProperty('--mi-brand-b', brandB.primary || '#6b7280');
  }

  setText('miScorebugTeamA', brandA.shortName || aName || 'Team A');
  setText('miScorebugTeamB', brandB.shortName || bName || 'Team B');

  miApplyScorebugAmbientBranding(aName, bName);
  miApplyCanonicalTeamHeaderBranding(aName, bName);

  setText('miScorebugBaseA', miFormatUiPointsFromMiSpace(baseA));
  setText('miScorebugBaseB', miFormatUiPointsFromMiSpace(baseB));
  setText('miScorebugMatchA', miFormatUiPointsFromMiSpace(finalA));
  setText('miScorebugMatchB', miFormatUiPointsFromMiSpace(finalB));
  setText('miScorebugGapValue', miFormatUiAbsPointsFromMiSpace(gap));

  miSetTextClassById('miScorebugBaseA', baseA);
  miSetTextClassById('miScorebugBaseB', baseB);
  miSetTextClassById('miScorebugMatchA', finalA);
  miSetTextClassById('miScorebugMatchB', finalB);
  miSetTextClassById('miScorebugGapValue', gapAbs);

  miRenderScorebugMetric('miScorebugBaseBarA', 'Baseline MI', baseA);
  miRenderScorebugMetric('miScorebugBaseBarB', 'Baseline MI', baseB);
  miRenderScorebugMetric('miScorebugMatchBarA', 'Matchup MI', finalA);
  miRenderScorebugMetric('miScorebugMatchBarB', 'Matchup MI', finalB);
}

function miCorePercentile(values, p) {
  const arr = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!arr.length) return 0;
  if (arr.length === 1) return arr[0];

  const idx = (p / 100) * (arr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const t = idx - lo;

  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * t;
}

function miCoreClamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function miCoreGetRowRawValue(row) {
  const v =
    row?.value ??
    row?.score ??
    row?.z ??
    row?.display ??
    0;

  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

function miCoreGetFieldValuesForKey(metricKey) {
  const values = [];
  const teams = Object.values(TEAMS || {});

  teams.forEach(team => {
    if (!team) return;

    // Breadth rows are not in coreDetails; they live directly on team
    if (metricKey === 'off_breadth') {
      const v = Number(team.offBreadth);
      if (Number.isFinite(v)) values.push(v);
      return;
    }

    if (metricKey === 'def_breadth') {
      const v = Number(team.defBreadth);
      if (Number.isFinite(v)) values.push(v);
      return;
    }

    const rows = Array.isArray(team.coreDetails) ? team.coreDetails : [];
    const match = rows.find(r => r && r.key === metricKey);
    if (!match) return;

    const v = miCoreGetRowRawValue(match);
    if (Number.isFinite(v)) values.push(v);
  });

  return values;
}

function miCoreGetStandingStats(metricKey) {
  const values = miCoreGetFieldValuesForKey(metricKey);

  if (!values.length) {
    return {
      p05: 0,
      p50: 0,
      p95: 0
    };
  }

  return {
    p05: miCorePercentile(values, 5),
    p50: miCorePercentile(values, 50),
    p95: miCorePercentile(values, 95)
  };
}

function miCoreGetStandingPositions(metricKey, rawValue) {
  const stats = miCoreGetStandingStats(metricKey);

  const p05 = Number(stats.p05);
  const p50 = Number(stats.p50);
  const p95 = Number(stats.p95);

  const span = p95 - p05;

  if (!Number.isFinite(span) || Math.abs(span) < 1e-9) {
    return {
      fillPct: 50,
      medianPct: 50
    };
  }

  const fill = miCoreClamp((Number(rawValue) - p05) / span, 0, 1);
  const median = miCoreClamp((p50 - p05) / span, 0, 1);

  return {
    fillPct: +(fill * 100).toFixed(2),
    medianPct: +(median * 100).toFixed(2)
  };
}

function miCoreFormatImpact(points) {
  const n = Math.round(Number(points || 0) * 100);
  if (n > 0) return `+${n}`;
  if (n < 0) return `${n}`;
  return '0';
}

function miCoreImpactClass(points) {
  const n = Math.round(Number(points || 0) * 100);
  if (n > 0) return 'is-pos';
  if (n < 0) return 'is-neg';
  return 'is-flat';
}

function miCoreRenderStandingCell(rowKey, rawValue, ariaLabel) {
  const pos = miCoreGetStandingPositions(rowKey, rawValue);

  return `
    <div class="mi-standing-wrap">
      <div class="mi-standing-bar" aria-hidden="true">
        <span class="mi-standing-fill" style="width:${pos.fillPct}%;"></span>
        <span class="mi-standing-median" style="left:${pos.medianPct}%;"></span>
      </div>
      <span class="mi-standing-sr sr-only">${ariaLabel}</span>
    </div>
  `;
}

function renderCoreProfileTable(team, tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;

  const copy = window.MI_COPY || {};
  const ui = copy.core_profile_ui || {};

  const rows = Array.isArray(team?.coreDetails) ? team.coreDetails : [];

  const titleLabel  = ui.title_label  || 'Battlefield';
  const spreadLabel = ui.spread_label || 'Spread';
  const scoreLabel  = ui.score_label  || 'Team Score';
  const tierLabel   = ui.tier_label   || 'Tier';
  const pointsLabel = ui.points_label || 'Impact';

  const noDataText = ui.no_data_text || 'No core trait data.';

  const offensiveSectionLabel = ui.offensive_section_label || 'Offensive Profile';
  const defensiveSectionLabel = ui.defensive_section_label || 'Defensive Profile';

  const offensiveBreadthLabel = ui.off_breadth_label || 'Offensive Breadth';
  const defensiveBreadthLabel = ui.def_breadth_label || 'Defensive Breadth';

  const spreadTooltip =
    ui.spread_tooltip ||
    'Standard deviation of this battlefield across the tournament field. Larger spread means more separation between teams in this area.';

  const scoreTooltip =
    ui.score_tooltip ||
    'Standardized team score in this battlefield. 0 = tournament average. Positive values are above average; negative values are below average.';

  const pointsTooltip =
    ui.points_tooltip ||
    'Contribution of this battlefield to the profile scoring display.';

  const defaultHeader = `
    <thead>
      <tr class="table-header">
        <th>${titleLabel}</th>
        <th title="${spreadTooltip}">${spreadLabel}</th>
        <th title="${scoreTooltip}">${scoreLabel}</th>
        <th>${tierLabel}</th>
        <th title="${pointsTooltip}">${pointsLabel}</th>
      </tr>
    </thead>
  `;

  if (!rows.length) {
    table.innerHTML = `
      ${defaultHeader}
      <tbody>
        <tr>
          <td colspan="5">${noDataText}</td>
        </tr>
      </tbody>
    `;
    return;
  }

  const rowLabelMap = ui.row_labels || {};
  const rowTooltipMap = ui.row_tooltips || {};

  const renderMetricRow = (row) => {
    const key = row?.key || '';
    const label = rowLabelMap[key] || row?.label || key || '—';
    const tooltip = rowTooltipMap[key] || '';

    const score = Number(
      row?.score ??
      row?.value ??
      row?.z ??
      row?.display ??
      0
    );

    const points = Number(
      row?.points ??
      row?.point ??
      row?.contribution ??
      0
    );

    const tierText = row?.tier || getTierLabelFromZ(score);
    const spreadHtml = getCoreFieldSpreadText(key, row);

    const scoreHtml = Number.isFinite(score)
      ? `<span class="metric-score ${getCoreScoreColorClass(score)}" title="${scoreTooltip}">${formatSignedScore(score, 2)}</span>`
      : '—';

    const pointsHtml = `<span title="${pointsTooltip}">${miFormatImpactCell(points)}</span>`;

    return `
      <tr>
        <td title="${tooltip}">${label}</td>
        <td class="metric-block">${spreadHtml}</td>
        <td class="metric-block">${scoreHtml}</td>
        <td class="metric-block">${tierText}</td>
        <td class="metric-block">${pointsHtml}</td>
      </tr>
    `;
  };

  const renderSectionRow = (label) => `
    <tr class="core-section-row">
      <td colspan="5"><span class="core-section-label">${label}</span></td>
    </tr>
  `;

  const renderBreadthRow = ({ label, breadth, breadthSD, rowClass }) => {
    const spreadHtml = `
      <div class="threshold-stack">
        <span class="threshold-chip" title="${spreadTooltip}">
          σ ${Number.isFinite(breadthSD) ? fmt(breadthSD, 3) : '—'}
        </span>
      </div>
    `;

    const scoreHtml = Number.isFinite(breadth)
      ? `<span class="metric-score ${getCoreScoreColorClass(breadth)}" title="${scoreTooltip}">${formatSignedScore(breadth, 3)}</span>`
      : '—';

    const tierText = Number.isFinite(breadth)
      ? getTierLabelFromZ(breadth)
      : '—';

    const pointsHtml = `<span title="${pointsTooltip}">${miFormatImpactCell(breadth)}</span>`;

    return `
      <tr class="${rowClass}">
        <td>${label}</td>
        <td class="metric-block">${spreadHtml}</td>
        <td class="metric-block">${scoreHtml}</td>
        <td class="metric-block">${tierText}</td>
        <td class="metric-block">${pointsHtml}</td>
      </tr>
    `;
  };

  const offensiveRows = rows.filter(row => MI_CORE_OFF_KEYS.has(row?.key));
  const defensiveRows = rows.filter(row => MI_CORE_DEF_KEYS.has(row?.key));

  const offensiveHtml = offensiveRows.map(renderMetricRow).join('');
  const defensiveHtml = defensiveRows.map(renderMetricRow).join('');

  const offBreadth = Number(team?.offBreadth);
  const offBreadthSD = Number(team?.offBreadthSD);

  const defBreadth = Number(team?.defBreadth);
  const defBreadthSD = Number(team?.defBreadthSD);

  const offBreadthRow = renderBreadthRow({
    label: offensiveBreadthLabel,
    breadth: offBreadth,
    breadthSD: offBreadthSD,
    rowClass: 'breadth-row breadth-row--offense'
  });

  const defBreadthRow = renderBreadthRow({
    label: defensiveBreadthLabel,
    breadth: defBreadth,
    breadthSD: defBreadthSD,
    rowClass: 'breadth-row breadth-row--defense'
  });

  table.innerHTML = `
    ${defaultHeader}
    <tbody>
      ${renderSectionRow(offensiveSectionLabel)}
      ${offensiveHtml}
      ${offBreadthRow}
      ${renderSectionRow(defensiveSectionLabel)}
      ${defensiveHtml}
      ${defBreadthRow}
    </tbody>
  `;
}

function renderProfileSupportModules(side, team, result, resumeTrust) {
  const isA = side === 'A';
  const suffix = isA ? 'A' : 'B';

  const rows = Array.isArray(team?.coreDetails) ? team.coreDetails : [];

  const offBreadthRaw = miDisplayImpactRaw(team?.offBreadth ?? 0);
  const defBreadthRaw = miDisplayImpactRaw(team?.defBreadth ?? 0);

  const offSignalRaw = rows
    .filter(row => MI_CORE_OFF_KEYS.has(row?.key))
    .reduce((sum, row) => sum + miDisplayImpactRaw(row?.points), 0) + offBreadthRaw;

  const defSignalRaw = rows
    .filter(row => MI_CORE_DEF_KEYS.has(row?.key))
    .reduce((sum, row) => sum + miDisplayImpactRaw(row?.points), 0) + defBreadthRaw;

  const combinedSignalRaw = offSignalRaw + defSignalRaw;

  const miEffOffEl = document.getElementById(`miEffOff${suffix}`);
  const miEffDefEl = document.getElementById(`miEffDef${suffix}`);
  const miEffMarginEl = document.getElementById(`miEffMargin${suffix}`);

  if (miEffOffEl) {
    miEffOffEl.textContent = miFormatDisplayTotal(offSignalRaw);
    miApplyValueState(miEffOffEl, offSignalRaw);
  }

  if (miEffDefEl) {
    miEffDefEl.textContent = miFormatDisplayTotal(defSignalRaw);
    miApplyValueState(miEffDefEl, defSignalRaw);
  }

  if (miEffMarginEl) {
    miEffMarginEl.textContent = miFormatDisplayTotal(combinedSignalRaw);
    miApplyValueState(miEffMarginEl, combinedSignalRaw);
  }

  // =========================
  // Embedded résumé tile
  // =========================
  const resume = Number(team?.resumeR ?? team?.resumeIndex ?? 0);
  const resumeTile   = document.getElementById(`resumeTile${suffix}`);
  const resumeAdjEl  = document.getElementById(`resumeAdj${suffix}`);
  const resumeTierEl = document.getElementById(`resumeTier${suffix}`);
  const backResumeEl = document.getElementById(`backResumeTile${suffix}`);

  if (resumeTile && resumeAdjEl && resumeTierEl) {
    let tier = team.resumeRTier || team.resumeTier || team.resumeTier_v2;

    const tierRules = window.MI_COPY?.resume_tile_ui?.tier_rules || [];

    if (!tier) {
      if (Array.isArray(tierRules) && tierRules.length) {
        const hit = tierRules.find(r => typeof r.min === 'number' && resume >= r.min);
        tier = hit?.label || 'Average';
      } else {
        tier =
          (resume >= 1.00 ? 'Elite' :
           resume >= 0.80 ? 'Strong' :
           resume >= 0.60 ? 'Above Average' :
           resume > -0.80 ? 'Average' :
           resume > -1.20 ? 'Weak' : 'Fragile');
      }
    }

    const tierRule = Array.isArray(tierRules)
      ? tierRules.find(r => r && r.label === tier)
      : null;

    const tierClass = tierRule?.class || (
      tier === 'Elite' ? 'resume-tier-strong' :
      tier === 'Strong' ? 'resume-tier-strong' :
      tier === 'Above Average' ? 'resume-tier-above' :
      tier === 'Average' ? 'resume-tier-average' :
      tier === 'Weak' ? 'resume-tier-weak' :
      tier === 'Fragile' ? 'resume-tier-fragile' :
      'context-neutral'
    );

    resumeAdjEl.textContent = tier;
    resumeTierEl.textContent = `Base Trust ×${Number(resumeTrust || 1).toFixed(2)}`;

    resumeTile.classList.remove(
      'resume-tier-strong',
      'resume-tier-above',
      'resume-tier-average',
      'resume-tier-weak',
      'resume-tier-fragile',
      'context-neutral'
    );

    resumeTile.classList.add(tierClass);

    if (backResumeEl) {
      const tierTileCopy =
        window.MI_COPY?.back?.resume?.tier_tile?.[tier];

      const candidates = Array.isArray(tierTileCopy)
        ? tierTileCopy
        : (typeof tierTileCopy === 'string' ? [tierTileCopy] : []);

      const fallbackPool =
        window.MI_COPY?.back?.resume?.tier_tile?.fallback;

      const fallbackCandidates = Array.isArray(fallbackPool)
        ? fallbackPool
        : (typeof fallbackPool === 'string' ? [fallbackPool] : []);

      const genericFallback =
        window.MI_COPY?.back?.resume?.tile || '';

      const pool = candidates.length
        ? candidates
        : (fallbackCandidates.length ? fallbackCandidates : [genericFallback]);

      const chosen = pool.filter(Boolean).length
        ? pool.filter(Boolean)[Math.floor(Math.random() * pool.filter(Boolean).length)]
        : '';

      backResumeEl.textContent = chosen || '';
    }
  }

  // =========================
  // Identity inline module
  // =========================
  const identityInline = document.getElementById(`identityInline${suffix}`);
  const identityScore  = document.getElementById(`identityScore${suffix}`);
  const identityRole   = document.getElementById(`identityRole${suffix}`);
  const identityDetail = document.getElementById(`identityDetail${suffix}`);
  const identityMeter  = document.getElementById(`identityMeterFill${suffix}`);

  if (identityInline && identityScore && identityRole && identityDetail && identityMeter) {
    const roundCode =
      result?.activeRound ||
      result?.round ||
      CURRENT_ROUND ||
      'R64';

    const opponent = isA ? result?.b : result?.a;

    const ctx =
      (result && result.roles) ||
      (typeof resolveIdentityContext === 'function'
        ? resolveIdentityContext(team, opponent, roundCode)
        : null);

    let role = 'Neutral';
    let score = 0;
    let detail = 'No active identity signal';

    if (ctx) {
      const mode = ctx.mode || '';

      if (mode === 'chalk_mirror') {
        role = 'Chalk Mirror';
        score = Number(isA ? ctx.valueA : ctx.valueB) || 0;
        detail = 'Mirror matchup using favorite identity pressure';
      } else if (mode === 'chaos_mirror') {
        role = 'Chaos Mirror';
        score = Number(isA ? ctx.valueA : ctx.valueB) || 0;
        detail = 'Mirror matchup using Cinderella identity pressure';
      } else if (mode === 'neutral_mirror') {
        role = 'Neutral Mirror';
        score = Number(isA ? ctx.valueA : ctx.valueB) || 0;
        detail = 'No clean favorite / Cinderella split in this matchup';
      } else {
        const rawRole = isA ? ctx.roleA : ctx.roleB;
        const rawScore = Number(isA ? ctx.valueA : ctx.valueB) || 0;
        const rawMetric = isA ? ctx.metricA : ctx.metricB;

        role =
          rawRole === 'favorite' ? 'Favorite' :
          rawRole === 'cinderella' ? 'Cinderella' :
          'Neutral';

        score = rawScore;

        detail =
          rawMetric === 'LFI' ? 'Live favorite identity signal' :
          rawMetric === 'LCI' ? 'Live Cinderella identity signal' :
          rawMetric === 'FAS' ? 'Favorite identity baseline' :
          rawMetric === 'CIS' ? 'Cinderella identity baseline' :
          'No active identity signal';
      }
    }

    identityInline.classList.remove(
      'identity-inline-cinderella',
      'identity-inline-favorite',
      'identity-inline-neutral'
    );

    const toneClass =
      role === 'Cinderella' ? 'identity-inline-cinderella' :
      role === 'Favorite' ? 'identity-inline-favorite' :
      'identity-inline-neutral';

    identityInline.classList.add(toneClass);

    identityScore.textContent = Number.isFinite(score) ? formatSignedScore(score, 2) : '—';
    identityRole.textContent = role;
    identityDetail.textContent = detail;

    const pct = Math.max(0, Math.min(100, Math.abs(score)));
    identityMeter.style.width = `${pct}%`;
  }
}

function renderNeutralTable(team, mi, interactionsTotal, tableId, subtotalSpanId) {
  const table = document.getElementById(tableId);
  const subtotalSpan = document.getElementById(subtotalSpanId);
  if (!table || !subtotalSpan) return;

  const core    = team.mibs    || 0;
  const breadth = team.breadth || 0;
  const resume  = team.resumeR || 0;

  // interactionAdj = whatever is left after core + breadth + resume
  const interactionAdj = (mi || 0) - (core + breadth + resume);

  // Use the explicit interactions.a / interactions.b if available for display
  const shownInt = (interactionsTotal != null ? interactionsTotal : interactionAdj);

  const neutralSubtotal = resume + interactionAdj;

  table.innerHTML = `
    <tr class="table-header">
      <th>Category</th>
      <th>Thresholds</th>
      <th>Team Value</th>
      <th>Tier</th>
      <th>Points Given</th>
    </tr>
    <tr>
      <td>Résumé Context (R)</td>
      <td>Field-relative W/L &amp; Schedule</td>
      <td>${fmt(resume, 3)}</td>
      <td>${resume >= 0 ? 'Favorable' : 'Skeptical'}</td>
      <td>${fmt(resume, 3)}</td>
    </tr>
    <tr>
      <td>Interaction Metrics</td>
      <td>3P, FT, Paint, TO, Glass, Résumé Pressure</td>
      <td>${fmt(shownInt, 3)}</td>
      <td>${interactionAdj >= 0 ? 'Leverage' : 'Headwind'}</td>
      <td>${fmt(interactionAdj, 3)}</td>
    </tr>
  `;

  subtotalSpan.textContent = fmt(neutralSubtotal, 3);
}

function buildTeamSummary(team, opponent, result, side) {
  const isA = side === 'A';

  const coreRows = team.coreDetails || [];
  let strongest = null, weakest = null;
  if (coreRows.length) {
    strongest = coreRows.reduce((best, r) => r.points > (best?.points ?? -Infinity) ? r : best, null);
    weakest   = coreRows.reduce((worst, r) => r.points < (worst?.points ?? Infinity) ? r : worst, null);
  }

  const breadthHits = team.breadthHits ?? 0;
  const offBreadth = Number(team.offBreadth ?? 0);
  const defBreadth = Number(team.defBreadth ?? 0);
  const resumeScore  = team.resumeR ?? 0;
  const resumeTier   = team.resumeRTier || 'Average';

  const marks = Array.isArray(team.profileMarks) ? team.profileMarks : [];
  const severeCount   = marks.filter(m => m.includes('Severe')).length;
  const moderateCount = marks.filter(m => m.includes('Moderate')).length;

  const intSide = isA ? result.interactions.a : result.interactions.b;
  const topInts = (intSide?.details || [])
    .slice()
    .sort((x, y) => Math.abs(y.points) - Math.abs(x.points))
    .slice(0, 2);

  const coreClause = (strongest && weakest)
    ? `${strongest.label} is the main edge, while ${weakest.label} is the soft spot.`
    : `Core Traits show this team’s main statistical shape.`;

  const breadthParts = [];
  if (Math.abs(offBreadth) > 0.0005) {
    breadthParts.push(`offensive breadth ${offBreadth >= 0 ? 'adds' : 'subtracts'} ${fmt(offBreadth, 3)}`);
  }
  if (Math.abs(defBreadth) > 0.0005) {
    breadthParts.push(`defensive breadth ${defBreadth >= 0 ? 'adds' : 'subtracts'} ${fmt(defBreadth, 3)}`);
  }

  const breadthClause = breadthParts.length
    ? `${breadthHits} supportive drivers overall; ${breadthParts.join(' and ')}.`
    : `Breadth adjustments are neutral on both sides of the ball.`;

  const resumeClause = (resumeScore > 0.0001)
    ? `${resumeTier} résumé adds +${fmt(resumeScore,3)}.`
    : (resumeScore < -0.0001)
      ? `${resumeTier} résumé subtracts ${fmt(resumeScore,3)}.`
      : `${resumeTier} résumé is neutral.`;

  const marksClause = (!marks.length)
    ? `No Profile Marks — clean structural profile.`
    : (severeCount > 0)
      ? `${severeCount} Severe / ${moderateCount} Moderate marks flag volatility or structural risk.`
      : `${moderateCount} Moderate marks flag matchup-sensitive weaknesses.`;

  const interactionClause = (topInts.length)
    ? `Biggest matchup swing: ${topInts.map(i => `${i.label} (${fmt(i.points,3)})`).join(', ')}.`
    : `No major matchup leverage flagged.`;

  return {
    strongest,
    weakest,
    coreClause,
    breadthClause,
    resumeClause,
    marksClause,
    interactionClause,
    severeCount,
    moderateCount,
    breadthHits
  };
}

function renderTeamSide(side, result) {
  const isA    = side === 'A';
  const team   = isA ? result.a   : result.b;
  const mi     = isA ? result.miA : result.miB; // matchup MI (still used elsewhere if needed)
  const intTot = isA ? result.interactions.a : result.interactions.b;

  if (!team) return;

  const brand = getTeamBranding(team.name);
  miApplyTeamLogo(
    document.getElementById(isA ? 'teamALogo' : 'teamBLogo'),
    brand,
    team.name || 'Team'
  );

  const titleEl           = document.getElementById(isA ? 'teamATitle'    : 'teamBTitle');
  const seedEl            = document.getElementById(isA ? 'teamASeed'     : 'teamBSeed');
  const profileSubtotalEl = document.getElementById(isA ? 'cindSubtotalA' : 'favSubtotalB');
  const teamTotalEl       = document.getElementById(isA ? 'teamTotalA'    : 'teamTotalB');
  const coreTableId       = isA ? 'cindProfileTableA' : 'favProfileTableB';
  const neutralTableId    = isA ? 'neutralTableA'     : 'neutralTableB';
  const neutralSubtotalId = isA ? 'neutralSubtotalA'  : 'neutralSubtotalB';

  const offBreadth = Number(team.offBreadth || 0);
  const defBreadth = Number(team.defBreadth || 0);
  const totalBreadth = offBreadth + defBreadth;
  const resume   = Number(team.resumeR || 0);
  const opponent = isA ? result.b : result.a;

  const miBase = (typeof team.mi_base === 'number' && Number.isFinite(team.mi_base))
    ? team.mi_base
    : computeMIBase(team);

  // -------------------------------------------------
  // V2 display bridge:
  // raw profile (pre-trust) -> resume trust -> adjusted base
  // -------------------------------------------------

    const coreRows = Array.isArray(team.coreDetails) ? team.coreDetails : [];

  // Visible table row sum (debug / optional future use only)
  const visibleRowSum = coreRows.reduce((sum, row) => {
    const pts =
      Number(row?.points ?? row?.point ?? row?.score ?? row?.value ?? 0);
    return sum + (Number.isFinite(pts) ? pts : 0);
  }, 0) + totalBreadth;

  // Canonical V2 résumé trust must come from the résumé context pipeline,
  // not from reverse-engineering mi_base against the visible row sum.
  let resumeTrust = Number(team.resumeBaseTrust);

  if (!Number.isFinite(resumeTrust)) {
    resumeTrust = 1.00;
  }

  // This is the actual pre-résumé baseline layer that feeds mi_base.
  const rawProfile = Number.isFinite(team.raw_base) ? team.raw_base : 0;

  // =========================================================
  // Profile Subtotal (UI-facing scaled version)
  // Uses the same scaled signal system shown in MI Efficiency Metrics:
  // (offensive signal + defensive signal) * résumé trust
  // =========================================================
  const coreRowsForSubtotal = Array.isArray(team?.coreDetails) ? team.coreDetails : [];

  const offBreadthDisplay = miDisplayImpactRaw(team?.offBreadth ?? 0);
  const defBreadthDisplay = miDisplayImpactRaw(team?.defBreadth ?? 0);

  const offSignalDisplay = coreRowsForSubtotal
    .filter(row => MI_CORE_OFF_KEYS.has(row?.key))
    .reduce((sum, row) => sum + miDisplayImpactRaw(row?.points), 0) + offBreadthDisplay;

  const defSignalDisplay = coreRowsForSubtotal
    .filter(row => MI_CORE_DEF_KEYS.has(row?.key))
    .reduce((sum, row) => sum + miDisplayImpactRaw(row?.points), 0) + defBreadthDisplay;

  const combinedSignalDisplay = offSignalDisplay + defSignalDisplay;

  // UI subtotal = scaled combined margin × résumé trust
  const profileSubtotal = combinedSignalDisplay * resumeTrust;

  // Build display name with seed prefix (e.g., "#1 Seed Florida")
  const baseName = team.name || (isA ? 'Team A' : 'Team B');
  const seedStr  = (team.seed != null && team.seed !== '') ? String(team.seed) : '';

  if (titleEl) {
    titleEl.textContent = seedStr ? `#${seedStr} Seed ${baseName}` : baseName;
  }

  // Keep the raw numeric seed in the hidden span so the matchup HUD can read it
  if (seedEl) {
    seedEl.textContent = seedStr;
  }

  if (profileSubtotalEl) {
    profileSubtotalEl.textContent = miFormatDisplayTotal(profileSubtotal);
    miApplyValueState(profileSubtotalEl, profileSubtotal);
  }

  if (teamTotalEl) {
    // Prefer the precomputed 1–99 cosmetic rating
    let rating = (typeof team.mi_rating === 'number') ? team.mi_rating : null;

    // If somehow missing, derive from performancePercentile or mi_base
    if (rating == null) {
      const P = (typeof team.performancePercentile === 'number')
        ? team.performancePercentile
        : 0.5;
      rating = Math.round(P * 100);
    }

    if (rating < 1)  rating = 1;
    if (rating > 99) rating = 99;

    // Optional: keep the raw MI_base accessible for debugging
    teamTotalEl.setAttribute('title', `Baseline MI: ${fmt(miBase, 3)}`);

    // Display as a two-digit badge
    teamTotalEl.textContent = rating.toString().padStart(2, '0');
  }

  // =========================
  // Core profile support modules
  // =========================
  renderProfileSupportModules(side, team, result, resumeTrust);

  // Core Traits big table
  renderCoreProfileTable(team, coreTableId);

  // Neutral Modifiers table (Résumé + Interactions)
  renderNeutralTable(team, mi, intTot, neutralTableId, neutralSubtotalId);
}

function renderTeamCards(result) {
  renderTeamSide('A', result);
  renderTeamSide('B', result);
}

function setCompareButtonEnabled(isEnabled) {
  const btn =
    document.getElementById('compareBtn') ||
    document.getElementById('runCompare');

  if (!btn) return;

  btn.disabled = !isEnabled;
  btn.setAttribute('aria-disabled', isEnabled ? 'false' : 'true');

  btn.classList.toggle('compare-btn-disabled', !isEnabled);
  btn.classList.toggle('compare-btn-enabled',  isEnabled);
}

function miGetPreHubEls() {
  return {
    step1: document.getElementById('preStep1'),
    step2: document.getElementById('preStep2'),
    step3: document.getElementById('preStep3'),
    text1: document.getElementById('preStepText1'),
    text2: document.getElementById('preStepText2'),
    text3: document.getElementById('preStepText3'),
    st1: document.getElementById('preStepStatus1'),
    st2: document.getElementById('preStepStatus2'),
    st3: document.getElementById('preStepStatus3'),
  };
}

function isCSVLoaded() {
  return Array.isArray(RAW_ROWS) && RAW_ROWS.length > 0 && Array.isArray(TEAM_LIST) && TEAM_LIST.length > 0;
}

function getSelectedTeams() {
  const a = document.getElementById('teamA')?.value || '';
  const b = document.getElementById('teamB')?.value || '';
  return { a, b, ok: !!a && !!b && a !== b };
}

function isRoundSelected() {
  return !!SANDBOX_MODE || !!CURRENT_ROUND;
}

function refreshCompareButtonState() {
  const ready = isCSVLoaded() && getSelectedTeams().ok && isRoundSelected();
  setCompareButtonEnabled(ready);
  if (typeof syncNextHalo === 'function') syncNextHalo();
  return ready;
}

function updatePreMatchupHubProgress() {
  const copy = (window.MI_COPY && window.MI_COPY.prematch && window.MI_COPY.prematch.progress)
    ? window.MI_COPY.prematch.progress
    : null;

  const hub = document.getElementById('preMatchupHub');
  if (!hub) return;

  const els = {
    statusWrap: document.querySelector('#preHubStatusWrap .pre-hub-status'),
    fill: document.getElementById('preStatusFill'),

    stepsWrap: hub.querySelector('.pre-hub-steps'),
    step1: document.getElementById('preStep1'),
    step2: document.getElementById('preStep2'),
    step3: document.getElementById('preStep3'),

    t1: document.getElementById('preStepText1'),
    t2: document.getElementById('preStepText2'),
    t3: document.getElementById('preStepText3'),

    s1: document.getElementById('preStepStatus1'),
    s2: document.getElementById('preStepStatus2'),
    s3: document.getElementById('preStepStatus3')
  };

  const csvLoaded = (typeof isCSVLoaded === 'function')
    ? isCSVLoaded()
    : (Array.isArray(TEAM_LIST) && TEAM_LIST.length > 0);

  const sel = (typeof getSelectedTeams === 'function')
    ? getSelectedTeams()
    : { a: '', b: '', ok: false };

  const hasA = !!sel.a;
  const hasB = !!sel.b && sel.b !== sel.a;
  const teamsOk = !!sel.ok;
  const roundChosen = !!SANDBOX_MODE || !!CURRENT_ROUND;

  let pct = 0;
  if (csvLoaded) pct = 25;
  if (csvLoaded && hasA) pct = 50;
  if (csvLoaded && hasA && hasB) pct = 75;
  if (csvLoaded && teamsOk && roundChosen) pct = 100;

  if (els.statusWrap) {
    els.statusWrap.classList.remove('is-idle', 'is-25', 'is-50', 'is-75', 'is-100');

    const cls =
      pct >= 100 ? 'is-100' :
      pct >= 75  ? 'is-75'  :
      pct >= 50  ? 'is-50'  :
      pct >= 25  ? 'is-25'  : 'is-idle';

    els.statusWrap.classList.add(cls);
  }

  if (els.fill) els.fill.style.width = `${pct}%`;

  const setStepState = (el, state) => {
    if (!el) return;
    el.classList.remove('is-done', 'is-next', 'is-locked');
    el.classList.add(state);
    el.classList.remove('is-hidden');
    el.setAttribute('aria-hidden', 'false');
  };

  // Row 1 — Dataset
  if (els.t1) {
    els.t1.textContent = csvLoaded
      ? ((copy && copy.step1_ready) || 'Field loaded')
      : ((copy && copy.step1_pending) || 'Not loaded');
  }

  if (els.s1) {
    els.s1.textContent = csvLoaded
      ? 'Ready'
      : 'Required';
  }

  if (!csvLoaded) setStepState(els.step1, 'is-next');
  else setStepState(els.step1, 'is-done');

  // Row 2 — Teams
  if (els.t2) {
    if (!csvLoaded) {
      els.t2.textContent = 'Locked until dataset is loaded';
    } else if (!hasA) {
      els.t2.textContent = 'Waiting for Team A';
    } else if (!hasB) {
      els.t2.textContent = 'Waiting for Team B';
    } else if (teamsOk) {
      els.t2.textContent = (copy && copy.step2_ready) || 'Both teams selected';
    } else {
      els.t2.textContent = 'Select two different teams';
    }
  }

  if (els.s2) {
    if (!csvLoaded) els.s2.textContent = 'Locked';
    else if (teamsOk) els.s2.textContent = 'Ready';
    else els.s2.textContent = 'Pending';
  }

  if (!csvLoaded) setStepState(els.step2, 'is-locked');
  else if (teamsOk) setStepState(els.step2, 'is-done');
  else setStepState(els.step2, 'is-next');

  // Row 3 — Round + Run
  if (els.t3) {
    if (!csvLoaded || !teamsOk) {
      els.t3.textContent = 'Locked until matchup inputs are complete';
    } else if (!roundChosen) {
      els.t3.textContent = (copy && copy.step3_pending) || 'Round not selected';
    } else {
      els.t3.textContent = (copy && copy.step3_ready) || 'Ready to compare';
    }
  }

  if (els.s3) {
    if (!csvLoaded || !teamsOk) els.s3.textContent = 'Locked';
    else if (!roundChosen) els.s3.textContent = 'Pending';
    else els.s3.textContent = 'Ready';
  }

  if (!csvLoaded || !teamsOk) setStepState(els.step3, 'is-locked');
  else if (!roundChosen) setStepState(els.step3, 'is-next');
  else setStepState(els.step3, 'is-done');

  if (els.stepsWrap) els.stepsWrap.classList.remove('is-single');

  if (csvLoaded && pct === 25) {
    logWorkflowEvent('Dataset loaded');
  }

  if (teamsOk && pct === 75) {
    logWorkflowEvent('Teams selected');
  }

  if (roundChosen && pct === 100) {
    logWorkflowEvent('Round selected');
  }

  /* =========================================================
   FINAL SYSTEM READY STATE
   ========================================================= */

  const compareBtn = document.getElementById('compareMatchupBtn');

  const systemReady =
    csvLoaded &&
    teamsOk &&
    roundChosen;

  if (compareBtn) {
  compareBtn.disabled = !systemReady;

    compareBtn.classList.toggle(
      'is-ready',
      systemReady
    );
  }

  persistWorkflowState();
  updateActiveStepHighlight();
}

function updateActiveStepHighlight() {
  const csvLoaded = isCSVLoaded();
  const sel = getSelectedTeams();

  let activeId = "step1Card";

  if (csvLoaded && !sel.ok) {
    activeId = "step2Card";
  }

  if (csvLoaded && sel.ok && !CURRENT_ROUND) {
    activeId = "step3Card";
  }

  if (csvLoaded && sel.ok && CURRENT_ROUND) {
    activeId = "step4Card";
  }

  const cards = document.querySelectorAll(".workflow-step-card");

  cards.forEach(card => {
    card.classList.remove("is-active-step");
  });

  const active = document.getElementById(activeId);

  if (active) {
    active.classList.add("is-active-step");
  }
}

// Dynamically filter which rounds are available based on selected teams' seeds
function updateRoundOptionsForCurrentSeeds() {
  const roundBtn = document.getElementById("roundSelectBtn");
  const roundDropdown = document.getElementById("roundDropdown");
  if (!roundBtn || !roundDropdown) return;

  const selectA =
    document.getElementById('teamA') ||
    document.getElementById('teamASelect') ||
    document.getElementById('cindTeamSelect');

  const selectB =
    document.getElementById('teamB') ||
    document.getElementById('teamBSelect') ||
    document.getElementById('favTeamSelect');

  const teamAName = selectA?.value || '';
  const teamBName = selectB?.value || '';

  const showBaseRoundsOnly = ({ resetRound = true } = {}) => {
    roundDropdown.querySelectorAll(".round-option").forEach(opt => {
      const code = opt.getAttribute("data-round");
      opt.style.display = (code === 'First4') ? "none" : "";
    });

    if (resetRound) {
      CURRENT_ROUND = null;
      roundBtn.textContent = "Select Round";
      delete roundBtn.dataset.selected;
    }

    if (typeof refreshCompareButtonState === 'function') {
      refreshCompareButtonState();
    }
  };

  if (!teamAName || !teamBName) {
    showBaseRoundsOnly();
    return;
  }

  const teamA = getTeamByName(teamAName);
  const teamB = getTeamByName(teamBName);

  if (!teamA || !teamB || teamA.seed == null || teamB.seed == null) {
    showBaseRoundsOnly();
    return;
  }

  const isFirst4Pair = isFirstFourSeedPlayIn(teamA.seed, teamB.seed);
  const allowedRounds = new Set(getPossibleRoundsForSeeds(teamA.seed, teamB.seed));

  roundDropdown.querySelectorAll(".round-option").forEach(opt => {
    const code = opt.getAttribute("data-round");

    // First4 is only exposed for actual play-in matchups, even in sandbox
    if (code === 'First4' && !isFirst4Pair) {
      opt.style.display = "none";
      return;
    }

    if (SANDBOX_MODE) {
      opt.style.display = "";
      return;
    }

    opt.style.display = allowedRounds.has(code) ? "" : "none";
  });

  const currentStillValid =
    !!CURRENT_ROUND &&
    (
      SANDBOX_MODE
        ? (CURRENT_ROUND !== 'First4' || isFirst4Pair)
        : allowedRounds.has(CURRENT_ROUND)
    );

  // Auto-default actual play-ins to First4 unless the user already has a legal round selected
  if (!currentStillValid && isFirst4Pair) {
    CURRENT_ROUND = 'First4';
    roundBtn.textContent = getRoundLabelFromCode('First4');
    roundBtn.dataset.selected = 'First4';
    miUpdateMatchupRoundPill(CURRENT_ROUND);

    if (typeof refreshCompareButtonState === 'function') {
      refreshCompareButtonState();
    }
    if (typeof updatePreMatchupHubProgress === 'function') {
      updatePreMatchupHubProgress();
    }
    return;
  }

  // For non-play-in pairs, or when current selection became illegal, reset
  if (!currentStillValid) {
    CURRENT_ROUND = null;
    roundBtn.textContent = "Select Round";
    delete roundBtn.dataset.selected;
    setCompareButtonEnabled(false);
  }

  if (typeof refreshCompareButtonState === 'function') {
    refreshCompareButtonState();
  }
}

function syncNextHalo() {
  const datasetCard = document.getElementById('datasetCard');
  const stepsCard   = document.getElementById('matchupSetupCard');

  const r1 = document.getElementById('mcRow1');
  const r2 = document.getElementById('mcRow2');
  const r3 = document.getElementById('mcRow3');

  const csvLoaded   = (typeof isCSVLoaded === 'function') ? isCSVLoaded() : false;
  const teamsOk     = (typeof getSelectedTeams === 'function') ? !!getSelectedTeams().ok : false;
  const roundChosen = (typeof isRoundSelected === 'function') ? !!isRoundSelected() : false;

  // Clear any previous step halos
  [stepsCard, r1, r2, r3].forEach(el => el && el.classList.remove('is-primary-entry'));

  // Before CSV: halo stays on dataset card (existing behavior)
  if (datasetCard) datasetCard.classList.toggle('is-primary-entry', !csvLoaded);
  if (!csvLoaded) return;

  // After CSV: halo moves to the next actionable step row
  if (!teamsOk) {
    if (r1) r1.classList.add('is-primary-entry');      // STEP 1: teams
  } else if (!roundChosen) {
    if (r2) r2.classList.add('is-primary-entry');      // STEP 2: round/sandbox
  } else {
    if (r3) r3.classList.add('is-primary-entry');      // STEP 3: run
  }
}

async function loadOfficialDatasetFromUrl(url, filename) {
  const statusEl = document.getElementById('status');
  const appShell = document.querySelector('.app-shell');

  try {
    if (statusEl) {
      statusEl.className = 'status warn';
      statusEl.textContent = 'Loading dataset…';
    }

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);

    const text = await res.text();

    // 1) Load into the app (no user upload required)
    const { headers, rows } = parseCSV(text);
    RAW_ROWS = rows;

    buildTeamsFromCSV(headers, rows);

    const count = (TEAM_LIST || []).length;
    updatePreMatchupHubProgress();
    refreshCompareButtonState();

    if (appShell) {
      const isLoaded = count > 0;
      if (isLoaded) appShell.classList.add('csv-loaded');
      else appShell.classList.remove('csv-loaded');

      // ✅ move the “next action” halo to the Steps card after dataset loads
      syncNextHalo();
    }

    if (statusEl) {
      if (count > 0) {
        statusEl.className = 'status ok';
        statusEl.textContent = `Loaded ${count} teams (${filename || 'dataset'})`;
      } else {
        statusEl.className = 'status warn';
        statusEl.textContent = 'Dataset loaded, but 0 teams detected.';
      }
    }

  } catch (err) {
    console.error('[MI] Dataset load error:', err);
    if (statusEl) {
      statusEl.className = 'status error';
      statusEl.textContent = `Dataset load error: ${err.message}`;
    }
    if (appShell) appShell.classList.remove('csv-loaded');
    syncNextHalo();
  }
}

async function miHandleCanonicalDatasetChange() {
  const datasetSelect = document.getElementById('datasetSelect');
  const datasetDownloadBtn = document.getElementById('datasetDownloadBtn');
  const matchupBar = document.getElementById('matchupBar');

  if (!datasetSelect) return;

  const requestId = ++__MI_DATASET_CHANGE_SEQ;
  const wasQuickEditing =
    !!matchupBar &&
    matchupBar.classList.contains('is-editing');

  const url = datasetSelect.value;
  const opt = datasetSelect.options[datasetSelect.selectedIndex];
  const filename = opt?.getAttribute('data-filename') || 'MadnessIndex_Dataset.csv';

  const syncDatasetDownloadState = () => {
    if (!datasetDownloadBtn || !datasetSelect) return;

    const hasSelection = !!datasetSelect.value;
    datasetDownloadBtn.disabled = !hasSelection;
    datasetDownloadBtn.classList.toggle('hidden', !hasSelection);

    if (hasSelection) {
      const selectedOpt = datasetSelect.options[datasetSelect.selectedIndex];
      const niceName = selectedOpt?.textContent?.trim() || 'dataset';
      datasetDownloadBtn.textContent = `Download: ${niceName}`;
    } else {
      datasetDownloadBtn.textContent = 'Download Dataset';
    }
  };

  // Prevent overlapping dataset loads from fighting each other.
  // The newest request always wins.
  __MI_DATASET_CHANGE_IN_FLIGHT = true;

  try {
    // If the user clears the selection, return fully to pre-dataset state
    if (!url) {
      hardResetWorkflow({
        clearDatasetSelection: true,
        preserveDatasetSelection: false,
        statusText: 'Select a dataset to begin.'
      });

      syncDatasetDownloadState();

      if (wasQuickEditing && requestId === __MI_DATASET_CHANGE_SEQ) {
        requestAnimationFrame(() => {
          enterMatchupQuickEdit();

          const quickDataset = document.getElementById('datasetSelectQuick');
          if (quickDataset) quickDataset.value = '';
        });
      }

      return;
    }

    // Tear down old workflow first, but preserve the newly selected dataset value
    hardResetWorkflow({
      clearDatasetSelection: false,
      preserveDatasetSelection: true,
      statusText: 'Loading dataset…'
    });

    syncDatasetDownloadState();

    await loadOfficialDatasetFromUrl(url, filename);

    // Ignore stale completions if the user already picked another dataset
    if (requestId !== __MI_DATASET_CHANGE_SEQ) return;

    persistWorkflowState();

    // Rebuild quick edit only after the new dataset is fully canonical
    if (wasQuickEditing) {
      requestAnimationFrame(() => {
        enterMatchupQuickEdit();

        const quickDataset = document.getElementById('datasetSelectQuick');
        if (quickDataset) {
          quickDataset.value = datasetSelect.value || '';
        }
      });
    }
  } finally {
    if (requestId === __MI_DATASET_CHANGE_SEQ) {
      __MI_DATASET_CHANGE_IN_FLIGHT = false;
    }
  }
}

function triggerCsvDownload(csvText, filename) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || 'MadnessIndex_Dataset.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

async function downloadDatasetFromUrl(url, filename) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  const text = await res.text();
  triggerCsvDownload(text, filename);
}

// ========== EVENT WIRING & DOM READY ==========

function setupEventListeners() {
  // ---- CSV upload ----
  const fileInput =
    document.getElementById('csvFile') ||
    document.getElementById('csvUpload') ||
    document.getElementById('dataFile') ||
    document.querySelector('input[type="file"]');

  const statusEl = document.getElementById('status');

  const datasetSelect = document.getElementById('datasetSelect');
  const datasetDownloadBtn = document.getElementById('datasetDownloadBtn');

  // --- Helper: sync download button (only if it exists) ---
  const syncDatasetDownloadState = () => {
    if (!datasetDownloadBtn || !datasetSelect) return;

    const hasSelection = !!datasetSelect.value;
    datasetDownloadBtn.disabled = !hasSelection;
    datasetDownloadBtn.classList.toggle('hidden', !hasSelection);

    if (hasSelection) {
      const opt = datasetSelect.options[datasetSelect.selectedIndex];
      const niceName = opt?.textContent?.trim() || 'dataset';
      datasetDownloadBtn.textContent = `Download: ${niceName}`;
    }
  };

  // ✅ ALWAYS auto-load when a dataset is selected (download button not required)
  if (datasetSelect) {
    datasetSelect.addEventListener('change', async () => {
      await miHandleCanonicalDatasetChange();
    });
  }

  // ✅ ONLY wire download behavior if the button exists
  if (datasetSelect && datasetDownloadBtn) {
    // initialize state (hidden until selection)
    syncDatasetDownloadState();

    datasetDownloadBtn.addEventListener('click', async () => {
      const url = datasetSelect.value;
      const opt = datasetSelect.options[datasetSelect.selectedIndex];
      const filename = opt?.getAttribute('data-filename') || 'MadnessIndex_Dataset.csv';
      if (!url) return;

      try {
        datasetDownloadBtn.disabled = true;
        await downloadDatasetFromUrl(url, filename);
      } catch (err) {
        console.error('[MI] Dataset download error:', err);
        const statusEl = document.getElementById('status');
        if (statusEl) {
          statusEl.className = 'status error';
          statusEl.textContent = `Download error: ${err.message}`;
        }
      } finally {
        datasetDownloadBtn.disabled = false;
      }
    });
  }

  if (!fileInput) {
    console.warn('[MI] No file input found.');
    if (statusEl) {
      statusEl.className = 'status error';
      statusEl.textContent = 'No file input found in HTML.';
    }
  } else {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const { headers, rows } = parseCSV(ev.target.result);
          RAW_ROWS = rows;
          console.log('[MI] CSV headers:', headers);
          console.log('[MI] First data row:', rows[0]);

          buildTeamsFromCSV(headers, rows);

          const count = (TEAM_LIST || []).length;
          console.log('[MI] Teams parsed:', count);
          updatePreMatchupHubProgress();
          refreshCompareButtonState();

          const appShell = document.querySelector('.app-shell');
          if (appShell) {
            const isLoaded = count > 0;

            if (isLoaded) appShell.classList.add('csv-loaded');
            else appShell.classList.remove('csv-loaded');

            syncNextHalo();
          } 

          if (statusEl) {
            if (count > 0) {
              statusEl.className = 'status ok';
              statusEl.textContent = `Loaded ${count} teams`;
            } else {
              statusEl.className = 'status warn';
              statusEl.textContent = 'CSV parsed, but 0 teams detected. Check the Team column header.';
            }
          }
        } catch (err) {
          console.error('[MI] CSV parse error:', err);
          if (statusEl) {
            statusEl.className = 'status error';
            statusEl.textContent = `CSV parse error: ${err.message}`;
          }
        }
      };
      reader.readAsText(file);
    });
  }

  const compareBtn =
    document.getElementById('compareBtn') ||
    document.getElementById('runCompare');

  if (compareBtn) {
    setCompareButtonEnabled(false);
    
    compareBtn.addEventListener('click', () => {

      if (!RAW_ROWS || RAW_ROWS.length === 0) {
        alert('Please load tournament dataset first.');
        return;
      }

      if (__MI_DATASET_CHANGE_IN_FLIGHT) {
        alert('Dataset is still loading. Please wait a moment.');
        return;
      }

      const selectA = document.getElementById('teamA');
      const selectB = document.getElementById('teamB');

      if (!selectA || !selectB || !selectA.value || !selectB.value) {
        alert('Please select both teams before comparing.');
        return;
      }

      const teamA = getTeamByName(selectA.value);
      const teamB = getTeamByName(selectB.value);

      if (!teamA || !teamB) {
        alert('Selected teams are not recognized. Try reloading the data.');
        return;
      }

      // ✅ Round is required ONLY when Sandbox mode is OFF
      if (!SANDBOX_MODE && !CURRENT_ROUND) {
        alert('Please select a round before comparing.');
        return;
      }

      // ✅ Provide a stable round code for downstream round-aware functions when sandbox is ON.
      // (This avoids null round causing weirdness in getSeedRoundMeta / round labels.)
      if (SANDBOX_MODE && !CURRENT_ROUND) {
        CURRENT_ROUND = 'R64';
        const roundBtn = document.getElementById('roundSelectBtn');
        if (roundBtn) roundBtn.textContent = getRoundLabelFromCode(CURRENT_ROUND);
      }

      // 🔥 ONLY enforce legal rounds when Sandbox mode is OFF
      if (!SANDBOX_MODE) {
        const allowedRounds = getPossibleRoundsForSeeds(teamA.seed, teamB.seed);
        if (!allowedRounds.includes(CURRENT_ROUND)) {
          alert(
            `As seeds ${teamA.seed} and ${teamB.seed}, these teams can only meet in: ` +
            allowedRounds.map(getRoundLabelFromCode).join(', ') +
            `. Please choose one of those rounds.`
          );
          return;
        }
      }

      // ----- Role routing: who goes on Cinderella vs Favorite card? -----
      // We now always auto-assign by seed.
      const roleMode = 'auto';

      let cinderellaName;
      let favoriteName;

      // Auto (by seed): lower seed number = Favorite
      const seedA = Number(teamA.seed);
      const seedB = Number(teamB.seed);

      if (Number.isFinite(seedA) && Number.isFinite(seedB) && seedA !== seedB) {
        if (seedA < seedB) {
          favoriteName   = teamA.name;
          cinderellaName = teamB.name;
        } else {
          favoriteName   = teamB.name;
          cinderellaName = teamA.name;
        }
      } else {
        // Same seed or weird data: fall back to dropdown order
        cinderellaName = teamA.name;
        favoriteName   = teamB.name;
      }

      compareTeams(cinderellaName, favoriteName, roleMode);

      // reveal analysis mode UI - LEGACY
      resetPostMatchupDefaultView();

      const appShell = document.querySelector('.app-shell');
      if (appShell) appShell.classList.remove('pre-matchup');
    });
  }

  const editMatchupBtn = document.getElementById('editMatchupBtn');
  if (editMatchupBtn) {
    editMatchupBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const matchupBar = document.getElementById('matchupBar');
      if (matchupBar && matchupBar.classList.contains('is-editing')) {
        exitMatchupQuickEdit();
      } else {
        enterMatchupQuickEdit();
      }
    });
  }

  const quickRun = document.getElementById('matchupQuickRun');
  if (quickRun) {
    quickRun.addEventListener('click', () => {

      if (__MI_DATASET_CHANGE_IN_FLIGHT) {
        alert('Dataset is still loading. Please wait a moment.');
        return;
      }

      exitMatchupQuickEdit();

      const compareBtn = document.getElementById('compareBtn');
      if (compareBtn) compareBtn.click();
    });
  }

  const quickCancel = document.getElementById('matchupQuickCancel');
  if (quickCancel) {
    quickCancel.addEventListener('click', () => exitMatchupQuickEdit());
  }

  // Keyboard: Enter to Run, Escape to Cancel (only while editing)
  document.addEventListener('keydown', (e) => {
    const matchupBar = document.getElementById('matchupBar');
    if (!matchupBar || !matchupBar.classList.contains('is-editing')) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      exitMatchupQuickEdit();
    }

    if (e.key === 'Enter') {
      // Don’t hijack Enter while the round dropdown is open
      const roundDropdown = document.getElementById('roundDropdown');
      const dropdownOpen = roundDropdown && !roundDropdown.classList.contains('hidden');
      if (dropdownOpen) return;

      e.preventDefault();
      exitMatchupQuickEdit();
      const compareBtn = document.getElementById('compareBtn');
      if (compareBtn) compareBtn.click();
    }
  });

  // ---- Debug toggle button ----
  const toggleDebugBtn = document.getElementById('toggleDebugBtn');
  if (toggleDebugBtn) {
    toggleDebugBtn.addEventListener('click', () => {
      const panel = document.getElementById('debugPanel');
      if (!panel) return;
      panel.classList.toggle('hidden');

      const dc = document.getElementById('debugContent');
      if (dc) {
        dc.textContent = JSON.stringify(
          { TEAMS: TEAMS, FIELD_STATS: FIELD_STATS },
          null,
          2
        );
      }
    });
  }

  // ---- Badge Legend collapsible toggle ----
  const badgeCard    = document.getElementById('badgeKeyCard');
  const badgeContent = document.getElementById('badgeKeyContent');
  const badgeToggle  = document.getElementById('toggleBadgeKey');

  if (badgeCard && badgeContent && badgeToggle) {
    badgeToggle.addEventListener('click', () => {
      const collapsed = badgeCard.classList.toggle('collapsed');
      badgeToggle.textContent = collapsed ? 'Show Legend' : 'Hide Legend';
    });
  }

// ===== ROUND SELECTOR =====
const roundBtn = document.getElementById("roundSelectBtn");
const roundDropdown = document.getElementById("roundDropdown");

if (roundBtn && roundDropdown) {
  // Initialize button label safely
  roundBtn.textContent = CURRENT_ROUND
    ? getRoundLabelFromCode(CURRENT_ROUND)
    : (miGetCopy("controls.step2_label") ? "Select Round" : "Select Round");

  // Open/close dropdown
  roundBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    MI_ROUND_TOUCHED = true;
    clearRoundNudge();
    roundDropdown.classList.toggle("hidden");
  });

  // Handle selecting a round
  roundDropdown.querySelectorAll(".round-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      const value = opt.getAttribute("data-round");
      if (!value) return;

      CURRENT_ROUND = value;
      miUpdateMatchupRoundPill(CURRENT_ROUND);

      MI_ROUND_TOUCHED = true;
      clearRoundNudge();

      roundBtn.textContent = opt.textContent;
      roundDropdown.classList.add("hidden");

      refreshCompareButtonState();
      updatePreMatchupHubProgress();
      persistWorkflowState();
    });
  });

  // Close dropdown if clicking outside
  document.addEventListener("click", (e) => {
    if (!roundDropdown.contains(e.target) && e.target !== roundBtn) {
      roundDropdown.classList.add("hidden");
    }
  });

    // v3.3: we no longer flip the entire team card.
    // Only the inner mini flip-tiles (Core, Résumé, Marks, Madness Index) are interactive.

    // const teamCards = document.querySelectorAll('.team-card');
    // teamCards.forEach(card => {
    //   card.addEventListener('click', (e) => {
    //     // Ignore clicks that originate inside mini flip tiles or buttons/links
    //     if (
    //       e.target.closest('.flip-tile') ||
    //       e.target.closest('button') ||
    //       e.target.closest('a') ||
    //       e.target.closest('.link-btn')
    //     ) {
    //       return;
    //     }
    //     card.classList.toggle('flipped');
    //   });
    // });

    // ---- Click-to-flip for individual tiles (Core, Résumé, Marks, Madness) ----
    const flipTiles = document.querySelectorAll('.flip-tile');
    flipTiles.forEach(tile => {
      tile.addEventListener('click', (e) => {
        if (
          e.target.closest('button') ||
          e.target.closest('a') ||
          e.target.closest('.link-btn')
        ) {
          return;
        }

        e.stopPropagation();
        tile.classList.toggle('flipped');

        // Core Traits (big sections)
        if (tile.matches('section.profile-section.flip-tile')) {
          syncCoreTraitsProfileSectionHeights();
        }

        // ✅ Profile Marks: when flipping BACK TO FRONT, re-equalize
        if (tile.id === 'marksTileA' || tile.id === 'marksTileB') {
          requestAnimationFrame(() => {
            equalizeProfileMarksTiles();
            });
          }
        });
      });
  }

  const moreBtn  = document.getElementById('prematchMoreBtn');
  const preview  = document.getElementById('preMatchupPreview');

  if (moreBtn && preview) {
    // Ensure closed on boot
    preview.classList.remove('is-open');
    preview.setAttribute('aria-hidden', 'true');
    moreBtn.setAttribute('aria-expanded', 'false');

    moreBtn.addEventListener('click', () => {
      const open = preview.classList.toggle('is-open');
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      preview.setAttribute('aria-hidden', open ? 'false' : 'true');

      // Keep your JSON-driven label swap (if you already implemented it)
      const labelOpen   = miGetCopy('prematch.progress.more_hide') || 'Hide details';
      const labelClosed = miGetCopy('prematch.progress.more_show') || 'What you’ll get (optional)';
      moreBtn.textContent = open ? labelOpen : labelClosed;
    });
  }

  // ---- Sandbox Mode toggle ----
  const sandboxToggle = document.getElementById('sandboxModeToggle');
  if (sandboxToggle) {
    // Initialize from UI
    setSandboxMode(!!sandboxToggle.checked);

    sandboxToggle.addEventListener('change', () => {
      setSandboxMode(!!sandboxToggle.checked);
    });

    initInteractionConsoleSync();
  }
}

/* =========================================================
   Glossary Drawer (matchup-only; category-driven accordion)
   ========================================================= */
(function(){
  const FALLBACK_CATEGORY_ORDER = [
    "Overview",
    "Score Synthesis",
    "Core Traits",
    "Profile Marks",
    "Tournament Identities",
    "Résumé Context",
    "Interaction Channels",
    "Volatility",
    "Profile Marks"
  ];

  const CATEGORY_ALIASES = {
    "resume context": "Résumé Context",
    "resumé context": "Résumé Context",
    "résumé context": "Résumé Context",
    "interaction channel": "Interaction Channels",
    "interaction channels": "Interaction Channels",
    "interactions channels": "Interaction Channels",
    "interactions channel": "Interaction Channels"
  };

  const state = {
    available: false,
    open: false,
    indexByKey: Object.create(null),
    grouped: null,
    categoryOrder: [],
    searchQuery: ""
  };

  function $(id){ return document.getElementById(id); }

  function normalizeKey(term, abbr){
    const t = (term || "").trim();
    const a = (abbr || "").trim();
    return (t + (a ? `|${a}` : "")).toLowerCase();
  }

  function normalizeCategoryLabel(label){
    const raw = String(label || "").trim();
    if (!raw) return "";

    const aliasKey = raw.toLowerCase();
    if (CATEGORY_ALIASES[aliasKey]) return CATEGORY_ALIASES[aliasKey];

    return raw;
  }

  function safeCopy(){
    const copy = window.MI_COPY || {};
    const g = copy.glossary || {};

    const title =
      (typeof g.title === "string" && g.title.trim())
        ? g.title.trim()
        : "Glossary";

    const help =
      (typeof g.help === "string" && g.help.trim())
        ? g.help.trim()
        : "Definitions for key terms used in this app.";

    const entries = Array.isArray(g.entries) ? g.entries : [];
    const categoryOrder = Array.isArray(g.category_order) ? g.category_order : [];

    return { title, help, entries, categoryOrder };
  }

  function deriveCategoryOrder(entries, requestedOrder){
    const ordered = [];
    const seen = new Set();

    const pushLabel = (label) => {
      const normalized = normalizeCategoryLabel(label);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      ordered.push(normalized);
    };

    // 1) explicit order from copy.json, if present
    requestedOrder.forEach(pushLabel);

    // 2) fallback canonical order
    FALLBACK_CATEGORY_ORDER.forEach(pushLabel);

    // 3) anything present in entries but not covered above
    entries.forEach(entry => {
      const cat = normalizeCategoryLabel(entry && entry.category);
      if (cat) pushLabel(cat);
    });

    return ordered;
  }

  function sectionForEntry(entry){
    const cat = normalizeCategoryLabel(entry && entry.category);
    return cat || null;
  }

  function buildIndex(entries){
    state.indexByKey = Object.create(null);

    entries.forEach(e => {
      if (!e || !e.term) return;

      const term = String(e.term).trim();
      if (!term) return;

      const abbr = e.abbr ? String(e.abbr).trim() : "";
      const def  = e.definition ? String(e.definition).trim() : "";
      const category = normalizeCategoryLabel(e.category);

      const key = normalizeKey(term, abbr);
      state.indexByKey[key] = {
        term,
        abbr,
        category,
        definition: def || ""
      };
    });
  }

  function groupEntries(entries, categoryOrder){
    const groups = Object.create(null);

    categoryOrder.forEach(label => {
      groups[label] = [];
    });

    entries.forEach(e => {
      if (!e || !e.term) return;

      const term = String(e.term).trim();
      if (!term) return;

      const abbr = e.abbr ? String(e.abbr).trim() : "";
      const def  = e.definition ? String(e.definition).trim() : "";
      const category = sectionForEntry(e);

      if (!category) return;
      if (!groups[category]) groups[category] = [];

      groups[category].push({
        term,
        abbr,
        category,
        definition: def || ""
      });
    });

    return groups;
  }

  function closeOtherSections(openSection){
    const toc = $("glossaryTOC");
    if (!toc) return;

    toc.querySelectorAll("details.mi-glossary-section").forEach(sec => {
      if (sec !== openSection) sec.open = false;
    });
  }

  function renderTOC(groups, categoryOrder){
    const toc = $("glossaryTOC");
    if (!toc) return;

    toc.innerHTML = "";

    categoryOrder.forEach(categoryName => {
      const list = groups[categoryName] || [];
      if (!list.length) return;

      const details = document.createElement("details");
      details.className = "mi-glossary-section";
      details.dataset.category = categoryName.toLowerCase();
      details.open = false;

      details.addEventListener("toggle", () => {
        if (details.open) closeOtherSections(details);
      });

      const summary = document.createElement("summary");
      summary.innerHTML = `
        <span class="mi-glossary-section-title">${categoryName}</span>
        <span class="mi-glossary-caret">›</span>
      `;
      details.appendChild(summary);

      const container = document.createElement("div");
      container.className = "mi-glossary-term-list";

      list.forEach(e => {
        const term = String(e.term || "").trim();
        if (!term) return;

        const abbr = e.abbr ? String(e.abbr).trim() : "";
        const def  = e.definition ? String(e.definition).trim() : "";

        const termDetails = document.createElement("details");
        termDetails.className = "mi-glossary-item mi-glossary-term";
        termDetails.dataset.term = term.toLowerCase();
        termDetails.dataset.abbr = abbr.toLowerCase();
        termDetails.dataset.category = categoryName.toLowerCase();
        termDetails.open = false;

        const termSummary = document.createElement("summary");
        termSummary.className = "mi-glossary-item-header";
        termSummary.innerHTML = `
          <span class="mi-glossary-item-term mi-glossary-term-name">${term}</span>
          ${abbr ? `<span class="mi-glossary-item-abbr mi-glossary-term-abbr">${abbr}</span>` : ""}
        `;

        const body = document.createElement("div");
        body.className = "mi-glossary-item-def";
        body.textContent = def || "Definition unavailable.";

        termDetails.appendChild(termSummary);
        termDetails.appendChild(body);
        container.appendChild(termDetails);
      });

      details.appendChild(container);
      toc.appendChild(details);
    });
  }

  function clampDrawerWidthToLeftLane(){
    const drawer = $("glossaryDrawer");
    const panel  = $("glossaryPanel");
    const verdict = document.getElementById("verdictShell");
    if (!drawer || !panel || !verdict) return;

    const vr = verdict.getBoundingClientRect();
    const leftEdge = 0;
    const safeGap = Math.max(0, Math.floor(vr.left - leftEdge - 12));

    const minW = 260;
    const maxW = 360;
    const w = Math.max(minW, Math.min(maxW, safeGap));

    panel.style.maxWidth = w + "px";
    panel.style.width = w + "px";
  }

  function setOpen(next){
    const root = $("glossaryDrawer");
    const handle = $("glossaryHandle");
    if (!root || !handle) return;

    state.open = !!next;
    root.classList.toggle("mi-glossary--open", state.open);
    handle.setAttribute("aria-expanded", state.open ? "true" : "false");

    if (state.open){
      clampDrawerWidthToLeftLane();
    }
  }

  function onKeyDown(e){
    if (!state.available) return;
    if (e.key === "Escape" && state.open){
      setOpen(false);
    }
  }

  function bindOnce(){
    const root = $("glossaryDrawer");
    const handle = $("glossaryHandle");
    const closeBtn = $("glossaryClose");
    if (!root || !handle || !closeBtn) return;

    if (!handle.__miGlossaryBound) {
      handle.addEventListener("click", () => setOpen(!state.open));
      handle.__miGlossaryBound = true;
    }

    if (!closeBtn.__miGlossaryBound) {
      closeBtn.addEventListener("click", () => setOpen(false));
      closeBtn.__miGlossaryBound = true;
    }

    if (!document.__miGlossaryMouseDownBound) {
      document.addEventListener("mousedown", (e) => {
        if (!state.open) return;
        const panel = $("glossaryPanel");
        if (!panel) return;
        if (panel.contains(e.target) || handle.contains(e.target)) return;
        setOpen(false);
      });
      document.__miGlossaryMouseDownBound = true;
    }

    if (!window.__miGlossaryResizeBound) {
      window.addEventListener("resize", () => {
        if (state.open) clampDrawerWidthToLeftLane();
      });
      window.__miGlossaryResizeBound = true;
    }

    if (!document.__miGlossaryKeydownBound) {
      document.addEventListener("keydown", onKeyDown);
      document.__miGlossaryKeydownBound = true;
    }
  }

  function applySearchFilter(){
    const toc = $("glossaryTOC");
    const input = $("glossarySearchInput");
    if (!toc || !input) return;

    const q = (input.value || "").trim().toLowerCase();
    state.searchQuery = q;

    const allSections = toc.querySelectorAll("details.mi-glossary-section");

    allSections.forEach(sec => {
      let anyVisible = false;

      sec.querySelectorAll("details.mi-glossary-term").forEach(termDetails => {
        const term = termDetails.dataset.term || "";
        const abbr = termDetails.dataset.abbr || "";
        const cat  = termDetails.dataset.category || "";
        const def  = (termDetails.querySelector(".mi-glossary-item-def")?.textContent || "").toLowerCase();

        const hit = !q ||
          term.includes(q) ||
          abbr.includes(q) ||
          cat.includes(q) ||
          def.includes(q);

        termDetails.style.display = hit ? "" : "none";

        if (q && hit) {
          termDetails.open = true;
        } else if (!q) {
          termDetails.open = false;
        }

        if (hit) anyVisible = true;
      });

      sec.style.display = (!q || anyVisible) ? "" : "none";

      if (q && anyVisible) {
        sec.open = true;
      } else if (!q) {
        sec.open = false;
      }
    });
  }

  function prepGlossaryTopArea(){
    const toc  = $("glossaryTOC");
    const host = $("glossarySearchHost");
    if (!toc || !host) return;

    if (!$("glossarySearchInput")){
      const row = document.createElement("div");
      row.className = "mi-glossary-searchrow";
      row.innerHTML = `
        <input id="glossarySearchInput"
               class="mi-glossary-search"
               type="search"
               placeholder="Search glossary…"
               autocomplete="off"
               spellcheck="false" />
        <button id="glossarySearchClear"
                class="mi-glossary-searchclear"
                type="button"
                aria-label="Clear search">×</button>
      `;

      host.appendChild(row);

      const input = $("glossarySearchInput");
      const clear = $("glossarySearchClear");

      input.addEventListener("input", applySearchFilter);

      clear.addEventListener("click", () => {
        input.value = "";
        input.focus();
        applySearchFilter();
      });

      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape"){
          input.value = "";
          applySearchFilter();
        }
      });
    }

    applySearchFilter();
  }

  function renderGlossary(){
    const { title, help, entries, categoryOrder } = safeCopy();
    const root = $("glossaryDrawer");
    if (!root) return;

    const t = $("glossaryTitle");
    const h = $("glossaryHelp");
    if (t) t.textContent = title;
    if (h) h.textContent = help;

    state.categoryOrder = deriveCategoryOrder(entries, categoryOrder);
    buildIndex(entries);
    state.grouped = groupEntries(entries, state.categoryOrder);
    renderTOC(state.grouped, state.categoryOrder);
    prepGlossaryTopArea();
  }

  function detectMatchupVisible(){
    const shell = document.getElementById("analysisShell");
    if (shell && shell.classList.contains("analysis-visible")) return true;

    if (document.body && document.body.classList.contains("analysis-visible")) return true;

    return false;
  }

  window.miInitGlossary = function(){
    bindOnce();
    renderGlossary();
    window.miSetGlossaryAvailable(detectMatchupVisible());
  };

  window.miSetGlossaryAvailable = function(isAvailable){
    const root = $("glossaryDrawer");
    if (!root) return;

    state.available = !!isAvailable;

    if (!state.available){
      setOpen(false);
      root.setAttribute("hidden", "");
    } else {
      root.removeAttribute("hidden");
    }
  };

  window.miRefreshGlossary = function(){
    renderGlossary();
    if (state.open) clampDrawerWidthToLeftLane();
  };
})();

let miDeferredInstallPrompt = null;
let miInstallPromptSupported = false;

function miIsIosLike() {
  const ua = window.navigator.userAgent || '';
  const platform = window.navigator.platform || '';
  return /iPhone|iPad|iPod/i.test(ua) ||
    (platform === 'MacIntel' && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
}

function miIsStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
}

function miUpdateInstallUI() {
  const installBtn = document.getElementById('miInstallBtn');
  const helpEl = document.getElementById('miInstallHelp');

  if (!installBtn || !helpEl) return;

  installBtn.hidden = true;
  helpEl.hidden = true;
  helpEl.textContent = '';

  if (miIsStandaloneMode()) {
    return;
  }

  // iPhone / iPad: show a real button that opens instructions
  if (miIsIosLike()) {
    installBtn.hidden = false;
    installBtn.textContent = 'Add to Home Screen';
    installBtn.setAttribute('aria-label', 'Show iPhone install instructions');
    return;
  }

  // Chromium / supported browsers: show install prompt button
  if (miInstallPromptSupported && miDeferredInstallPrompt) {
    installBtn.hidden = false;
    installBtn.textContent = 'Install App';
    installBtn.setAttribute('aria-label', 'Install app');
    return;
  }
}

function miInitInstallPromptUI() {
  const installBtn = document.getElementById('miInstallBtn');
  const helpEl = document.getElementById('miInstallHelp');

  if (!installBtn || !helpEl) return;

  installBtn.addEventListener('click', async () => {
    console.log('[MI] Install button clicked', {
      hasPrompt: !!miDeferredInstallPrompt,
      promptSupported: miInstallPromptSupported,
      standalone: miIsStandaloneMode(),
      isIosLike: miIsIosLike()
    });

    if (miIsStandaloneMode()) {
      return;
    }

    // iPhone / iPad flow: show manual install instructions
    if (miIsIosLike()) {
      helpEl.hidden = false;
      helpEl.textContent = 'To install on iPhone: open this site in Safari, tap Share, then tap Add to Home Screen.';
      return;
    }

    // Standard browser install prompt flow
    if (!miDeferredInstallPrompt) {
      helpEl.hidden = false;
      helpEl.textContent = 'Install is not available in this browser right now.';
      miUpdateInstallUI();
      return;
    }

    try {
      miDeferredInstallPrompt.prompt();
      await miDeferredInstallPrompt.userChoice;
    } catch (err) {
      console.warn('[MI] Install prompt failed:', err);
    } finally {
      miDeferredInstallPrompt = null;
      miInstallPromptSupported = false;
      miUpdateInstallUI();
    }
  });

  window.addEventListener('beforeinstallprompt', (event) => {
    console.log('[MI] beforeinstallprompt captured');
    event.preventDefault();
    miDeferredInstallPrompt = event;
    miInstallPromptSupported = true;
    miUpdateInstallUI();
  });

  window.addEventListener('appinstalled', () => {
    miDeferredInstallPrompt = null;
    miInstallPromptSupported = false;
    miUpdateInstallUI();
  });

  miUpdateInstallUI();
}

function miForceMobileScrollUnlock() {
  try {
    document.documentElement.classList.remove('mi-verdict-scroll-lock');
    document.body.classList.remove('mi-verdict-scroll-lock');
    document.body.classList.remove('mi-entry-lock');

    document.documentElement.style.overflowY = '';
    document.documentElement.style.overflowX = '';
    document.body.style.overflowY = '';
    document.body.style.overflowX = '';
    document.body.style.touchAction = '';
  } catch (err) {
    console.warn('[MI] Mobile scroll unlock failed:', err);
  }
}

// =========================================================
// Build Version — must match service-worker.js and index.html
// =========================================================

const MI_BUILD = '26';

function bootMadnessIndex() {
  console.log("[MI] bootMadnessIndex fired");

  let tries = 0;
  const tick = async () => {
    tries += 1;

    miForceMobileScrollUnlock();

    const hub = document.getElementById('preMatchupHub');
    if (!hub && tries < 10) {
      setTimeout(tick, 50);
      return;
    }

    await loadTeamBranding();

    miInitInstallPromptUI();
    setupEventListeners();
    loadCopyJSON();

    if (typeof miInitGlossary === 'function') {
      miInitGlossary();
    }

    miSyncGlossaryToMatchupState();
    restoreWorkflowState();
    updatePreMatchupHubProgress();
  };

  tick();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js')
      .then((registration) => {
        console.log('[MI] Service worker registered:', registration.scope);
      })
      .catch((error) => {
        console.error('[MI] Service worker registration failed:', error);
      });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootMadnessIndex, { once: true });
} else {
  bootMadnessIndex();
}

document
  .getElementById("clearWorkflowStateBtn")
  ?.addEventListener("click", () => {

    if (!confirm("Reset the current workflow?")) return;

    clearWorkflowState();

  });