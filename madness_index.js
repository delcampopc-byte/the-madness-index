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

// Default Profile Mark descriptions (fallback if JSON not present)
const DEFAULT_MARK_DESCRIPTIONS = {
  "Offensive Rigidity":         "Predictable, inflexible offense.",
  "Unstable Perimeter": "Volatile 3-point identity.",
  "Cold Arc Team":              "Translation risk from deep.",
  "Undisciplined Defense":      "Foul-prone, mistake-heavy defense.",
  "Soft Interior":              "Weak rim protection / deterrence.",
  "Perimeter Leakage":          "Allows clean perimeter looks.",
  "Tempo Strain":               "Pace identity strains possessions.",
  "Turnover Fragility":         "High-risk ball security profile."
};

// getMarkDescription Looks up the description text for a profile mark (e.g., Offensive Rigidity), preferring copy.marks.descriptions (including severity-specific text) and falling back to DEFAULT_MARK_DESCRIPTIONS.

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
    }
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

function resetPostMatchupDefaultView() {
  // After each run: verdict visible, evidence closed
  showVerdictShell();
  initEvidenceToggleOnce();
  setEvidenceOpen(false);
}

// loadCopyJSON() { Fetches copy.json, stores it on window.MI_COPY, then calls applyCopyToDOM, buildGlossaryFromCopy, populateBackExplanations, and populateInteractionsHowToList. Handles fetch/parse errors.

function loadCopyJSON() {
  console.log("[MI] loadCopyJSON fired");

  fetch('copy.json')
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
      buildGlossaryFromCopy(data);
      populateBackExplanations(data);
      populateInteractionsHowToList(data);

      // 🔁 Glossary arrives empty on first init — refresh once copy exists
      if (typeof window.miRefreshGlossary === 'function') {
        window.miRefreshGlossary();
      }

      // 🔐 Re-sync availability now that copy + matchup state are both known
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

// Map internal core keys to the keys we store in JSON (core_explain.metrics)
// All 8 core traits from team.coreDetails:
const CORE_KEYS_FOR_EXPLAIN = [
  'offeff',   // Offensive Efficiency
  'defeff',   // Defensive Efficiency
  'adjem',    // Adjusted Efficiency Margin
  'ts',       // True Shooting %
  'efg',      // Effective FG %
  'def_efg',  // Defensive eFG %
  'epr',      // Effective Possession Ratio
  'to'        // Turnover %
];

// getCoreTierForMetric(team, key) { Reads team.coreDetails to find the row for a given core metric key and returns its tier label (“Elite”, “Strong”, etc.), or null if missing.

function getCoreTierForMetric(team, key) {
 
  if (!team.coreDetails) return null;
  const row = team.coreDetails.find(r => r.key === key);
  return row ? row.tier : null;
}

// Generates the full core-traits scouting paragraph for one team by looping through the 8 core metrics and stitching together tier-aware back_phrases (plus the breadth sentence).

function buildCoreBackTextForTeam(team, copy, variantMap) {
  if (!team || !copy || !copy.core_explain) return '';

  const cx = copy.core_explain;
  const metricsConfig = cx.metrics || {};

  // Prefer explicit ordering from JSON if present, otherwise fall back
  const metricKeys = Array.isArray(cx.metric_order) && cx.metric_order.length
    ? cx.metric_order
    : CORE_KEYS_FOR_EXPLAIN;

  const sentences = [];

  metricKeys.forEach(key => {
    const cfg = metricsConfig[key];
    if (!cfg) return;

    const tier = getCoreTierForMetric(team, key); // "Elite", "Strong", etc.
    if (!tier) return;

    // Should this metric use the alt phrase for this team?
    const useAlt = !!(variantMap && Object.prototype.hasOwnProperty.call(variantMap, key) && variantMap[key]);

    const sentence = selectCoreBackSentence(cfg, tier, useAlt);
    if (sentence) {
      sentences.push(sentence);
    }
  });

  // Nothing resolved → fallback template
  if (!sentences.length) {
    const fallback = cx.fallback_template ||
      '{{team}} shows a generally balanced core profile with no extreme strengths or weaknesses.';
    return fallback.replace('{{team}}', team.name || 'This team');
  }

  // Optional paragraph prefix (includes team name once)
  let paragraph = sentences.join(' ');
  if (cx.paragraph_prefix) {
    const prefix = cx.paragraph_prefix.replace('{{team}}', team.name || 'This team');
    paragraph = prefix + ' ' + paragraph;
  }

  return paragraph.trim();
}

// For a given metric config, tier, and variant flag, returns the appropriate back-phrase string. Handles primary vs. alternate phrases and fallback behavior.

function selectCoreBackSentence(cfg, tier, useAltVariant) {
  if (!cfg || !tier) return '';

  const baseMap = cfg.back_phrases || {};
  const altMap  = cfg.back_phrases_alt || {};

  let sentence = '';

  // 1) Try alternate phrase if flagged and available
  if (useAltVariant && altMap && typeof altMap[tier] === 'string') {
    const trimmed = altMap[tier].trim();
    if (trimmed) {
      sentence = trimmed;
    }
  }

  // 2) Fallback to primary back_phrases
  if (!sentence && baseMap && typeof baseMap[tier] === 'string') {
    sentence = baseMap[tier];
  }

  // 3) Final fallback: short tier phrase as a sentence
  if (!sentence && cfg.phrases && typeof cfg.phrases[tier] === 'string') {
    sentence = cfg.phrases[tier];
    if (!/[.!?]\s*$/.test(sentence)) {
      sentence += '.';
    }
  }

  return sentence;
}

// Builds a structured representation of the team’s core explanation: an array of { key, label, tier, text } objects for the UI bullet layout instead of one long string.

function buildCoreBackStructured(team, copy) {
  if (!team || !copy || !copy.core_explain) return [];

  const cx = copy.core_explain;
  const metricsConfig = cx.metrics || {};

  // Use JSON ordering if present, otherwise fall back to the hard-coded array
  const metricKeys = Array.isArray(cx.metric_order) && cx.metric_order.length
    ? cx.metric_order
    : CORE_KEYS_FOR_EXPLAIN;

  const out = [];

  metricKeys.forEach(key => {
    const cfg = metricsConfig[key];
    if (!cfg) return;

    const tier = getCoreTierForMetric(team, key); // "Elite", "Strong", etc.
    if (!tier) return;

    // Prefer the long back phrase; fall back to the short phrase if needed
    const phrase =
      (cfg.back_phrases && cfg.back_phrases[tier]) ||
      (cfg.phrases && cfg.phrases[tier]);

    if (!phrase) return;

    out.push({
      label: cfg.label || key, // e.g. "Offensive Efficiency"
      text: phrase             // the sentence you already wrote in JSON
    });
  });

  return out;
}

// Convenience wrapper: calls buildCoreBackStructured for a team and tile, then pipes that into renderCoreBackList to render the list inside the specified element.

function renderStructuredCoreBack(el, items) {
  if (!el) return;

  // Clear anything that was there before
  el.innerHTML = "";

  items.forEach(item => {
    const block = document.createElement("div");
    block.className = "core-back-block";

    block.innerHTML = `
      <div class="core-back-label">${item.label}</div>
      <div class="core-back-text">${item.text}</div>
    `;

    el.appendChild(block);
  });
}

// Core worker for structured backs: uses getCoreTierForMetric + JSON config to return the array of items { key, label, tier, text } in display order.

function buildCoreBackItemsForTeam(team, copy, variantMap) {
  if (!team || !copy || !copy.core_explain) return [];

  const cx = copy.core_explain;
  const metricsConfig = cx.metrics || {};

  // Prefer explicit JSON ordering if present, fall back to CORE_KEYS_FOR_EXPLAIN
  const metricKeys = Array.isArray(cx.metric_order) && cx.metric_order.length
    ? cx.metric_order
    : CORE_KEYS_FOR_EXPLAIN;

  const items = [];

  metricKeys.forEach(key => {
    const cfg = metricsConfig[key];
    if (!cfg) return;

    const tier = getCoreTierForMetric(team, key); // "Elite", "Strong", etc.
    if (!tier) return;

    // Prefer label from team.coreDetails (matches Core Traits table UI)
    let label = key;
    if (Array.isArray(team.coreDetails)) {
      const row = team.coreDetails.find(r => r.key === key);
      if (row && row.label) {
        label = row.label;
      }
    } else if (cfg.label) {
      // Optional: if you later store a label in JSON
      label = cfg.label;
    }

    // Decide whether to use the alt phrase for this metric
    const useAlt = !!(
      variantMap &&
      Object.prototype.hasOwnProperty.call(variantMap, key) &&
      variantMap[key]
    );

    // Try to pull the tiered back phrase (primary/alt) using the same helper
    let text = selectCoreBackSentence(cfg, tier, useAlt);

    // Fallback: if no back_phrases exist, use the shorter "phrases" map
    if (!text) {
      const baseMap = cfg.phrases || {};
      text = (baseMap[tier] || '').trim();
    }

    // If we still don't have anything, skip this metric
    if (!text) return;

    // Ensure each row ends with punctuation
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

// Given a DOM container and the structured core items, builds a <ul> where each item shows metric label, tier pill, and explanation text.

function renderCoreBackList(containerId, items, fallbackText) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Clear any previous content
  container.innerHTML = '';

  // If for some reason we have no items, fall back to the paragraph version
  if (!items || !items.length) {
    if (fallbackText) {
      container.textContent = fallbackText;
    }
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'core-back-list';

  items.forEach(item => {
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

  container.appendChild(ul);
}

function pickCoreSupportPhraseKey(team) {
  if (!team || !team.coreZ) return 'balanced';

  const vals = Object.values(team.coreZ).filter(v => typeof v === 'number');
  if (!vals.length) return 'balanced';

  const eliteCount  = vals.filter(v => v >= 1.0).length;
  const strongCount = vals.filter(v => v >= 0.8 && v < 1.0).length;

  // FIXED: spread the array into Math.min / Math.max
  const worst = Math.min(...vals);
  const best  = Math.max(...vals);

  if (eliteCount >= 2) return 'two_plus_elite';
  if (eliteCount >= 1 && (eliteCount + strongCount) >= 3) return 'one_elite_plus_depth';
  if (best - worst >= 1.5) return 'polarized';
  return 'balanced';
}

function buildCoreVariantMaps(result, copy) {
  const cx = copy.core_explain;
  const metricsConfig = cx.metrics || {};

  const metricKeys = Array.isArray(cx.metric_order) && cx.metric_order.length
    ? cx.metric_order
    : CORE_KEYS_FOR_EXPLAIN;

  const variantsA = {};
  const variantsB = {};

  metricKeys.forEach(key => {
    const cfg = metricsConfig[key];
    if (!cfg) return;

    const tierA = getCoreTierForMetric(result.a, key);
    const tierB = getCoreTierForMetric(result.b, key);
    if (!tierA || !tierB) return;

    // Only care when both teams are in the same tier for this metric
    if (tierA !== tierB) return;

    const altMap = cfg.back_phrases_alt || {};
    const alt = altMap && typeof altMap[tierA] === 'string' ? altMap[tierA].trim() : '';

    // If no alt is provided for this tier, just skip – both sides use primary
    if (!alt) return;

    // Design choice: Team A uses primary, Team B uses alt when both are same tier
    variantsA[key] = false;
    variantsB[key] = true;
  });

  return { variantsA, variantsB };
}

function updateCoreBacksForResult(result) {
  const copy = window.MI_COPY;
  if (!copy || !copy.core_explain || !result || !result.a || !result.b) return;

  // 1) Decide which metrics use alt phrases for each team
  const { variantsA, variantsB } = buildCoreVariantMaps(result, copy);

  // 2) Build the long paragraph text for each team (full-card backs)
  const textA = buildCoreBackTextForTeam(result.a, copy, variantsA);
  const textB = buildCoreBackTextForTeam(result.b, copy, variantsB);

  const cardBackA = document.getElementById('backCoreA');
  const cardBackB = document.getElementById('backCoreB');

  if (cardBackA) cardBackA.textContent = textA || '';
  if (cardBackB) cardBackB.textContent = textB || '';

  // 3) Build metric-aware rows for the flip tiles
  const itemsA = buildCoreBackItemsForTeam(result.a, copy, variantsA);
  const itemsB = buildCoreBackItemsForTeam(result.b, copy, variantsB);

  // These use the new metric/tier layout:
  // - metric label top-left
  // - tier pill top-right
  // - JSON phrase underneath
  renderCoreBackList('backCoreTileA', itemsA, textA);
  renderCoreBackList('backCoreTileB', itemsB, textB);
}

function buildBreadthBackTextForTeam(team, copy) {
  if (!team || !copy || !copy.breadth_explain) return '';

  const bx = copy.breadth_explain;
  const template = bx.template || "{{team}}’s breadth score reflects {{summary}}.";
  const fallbackTemplate = bx.fallback_template || "{{team}} shows a narrow core profile.";

  const lanesCfg = bx.lanes || {};

  const effHits   = team.breadthEffHits   != null ? team.breadthEffHits   : 0;
  const shootHits = team.breadthShootHits != null ? team.breadthShootHits : 0;
  const possHits  = team.breadthPossHits  != null ? team.breadthPossHits  : 0;
  const totalHits = team.breadthTotalHits != null ? team.breadthTotalHits : 0;

  // Helper to pick key "0" / "1" / "2plus"
  const laneKey = (hits, maxTwoPlus) => {
    if (hits <= 0) return "0";
    if (hits === 1) return "1";
    if (maxTwoPlus && hits >= maxTwoPlus) return "2plus";
    return "1";
  };

  const effLaneKey   = laneKey(effHits,   2); // 0–1–2+ for efficiency
  const shootLaneKey = laneKey(shootHits, 2); // 0–1–2+ for shooting
  const possLaneKey  = laneKey(possHits,  2); // 0–1–2+ for possession

  const effPhrase =
    lanesCfg.efficiency &&
    lanesCfg.efficiency[effLaneKey] || '';

  const shootPhrase =
    lanesCfg.shooting &&
    lanesCfg.shooting[shootLaneKey] || '';

  const possPhrase =
    lanesCfg.possession &&
    lanesCfg.possession[possLaneKey] || '';

  const parts = [effPhrase, shootPhrase, possPhrase].filter(Boolean);

  if (!parts.length) {
    return fallbackTemplate.replace('{{team}}', team.name);
  }

  // Build a natural-sounding summary string
  let summary = '';
  if (parts.length === 1) {
    summary = parts[0];
  } else if (parts.length === 2) {
    summary = `${parts[0]} and ${parts[1]}`;
  } else {
    summary = `${parts[0]}, ${parts[1]}, and ${parts[2]}`;
  }

  // Choose support phrase based on total hits
  const supportKey = pickBreadthSupportKey(totalHits);
  const supportText =
    bx.support_phrases &&
    bx.support_phrases[supportKey] || '';

  let text = template
    .replace('{{team}}', team.name)
    .replace('{{summary}}', summary);

  if (supportText) {
    // Ensure we only add a space if template didn't already end with punctuation
    if (!/[.!?]\s*$/.test(text)) text += '.';
    text += ' ' + supportText;
  }

  return text;
}

function pickBreadthSupportKey(totalHits) {
  if (totalHits >= 5) return 'high';
  if (totalHits >= 3) return 'medium';
  if (totalHits >= 1) return 'low';
  return 'none';
}

function updateBreadthBacksForResult(result) {
  const copy = window.MI_COPY;
  if (!copy || !copy.breadth_explain || !result || !result.a || !result.b) return;

  const textA = buildBreadthBackTextForTeam(result.a, copy);
  const textB = buildBreadthBackTextForTeam(result.b, copy);

  const elA = document.getElementById('backBreadthA');
  const elB = document.getElementById('backBreadthB');

  if (elA && textA) elA.textContent = textA;
  if (elB && textB) elB.textContent = textB;
}

function buildResumeBackTextForTeam(team, copy) {
  if (!team || !copy || !copy.resume_explain) return '';

  const rx = copy.resume_explain;

  const tier    = team.resumeRTier || 'Average';
  const rIndex  = typeof team.resumeIndex === 'number' ? team.resumeIndex : 0;
  const rAdjust = typeof team.resumeR     === 'number' ? team.resumeR     : 0;

  const isPositive = rAdjust >= 0;

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

  // If we somehow have nothing to say, fall back to generic
  if (!recordPhrase && !schedulePhrase) {
    return (rx.fallback_template || '').replace('{{team}}', team.name);
  }

  const text = template
    .replace('{{team}}', team.name)
    .replace('{{tier}}', tier)
    .replace('{{record}}', recordPhrase)
    .replace('{{schedule}}', schedulePhrase)
    .replace('{{impact}}', impactPhrase);

  return text;
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
    (copy && copy.formula_explain && copy.formula_explain.template) ||
    "Team Total ({{total}}) = Core Traits ({{core}}) + Breadth Bonus ({{breadth}}) + Résumé Context ({{resume}}) + Matchup Interactions ({{interactions}}).";

  const core = team.mibs || 0;
  const breadth = team.breadth || 0;
  const resume = team.resumeR || 0;
  const total = side === 'A' ? (result.miA ?? 0) : (result.miB ?? 0);
  const interactions = side === 'A'
    ? (result.interactions?.a ?? 0)
    : (result.interactions?.b ?? 0);

  return miFillTemplate(tpl, {
    total: fmt(total, 3),
    core: fmt(core, 3),
    breadth: fmt(breadth, 3),
    resume: fmt(resume, 3),
    interactions: fmt(interactions, 3)
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

// ---------- Madness Index Tier Helper (1–99 cosmetic rating) ----------

function getMITierKeyForRating(rating) {
  if (rating == null || isNaN(rating)) return 'Balanced';

  if (rating >= 90) return 'Top';
  if (rating >= 75) return 'High';
  if (rating >= 60) return 'Solid';
  if (rating >= 40) return 'Balanced';
  if (rating >= 25) return 'Low';
  return 'Fragile';
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
const ROUND_ORDER = ['R64', 'R32', 'S16', 'E8', 'F4', 'Champ'];

// All possible rounds this *pair of seeds* can meet in,
// across all valid bracket layouts (same region vs different region).
function getPossibleRoundsForSeeds(seedA, seedB) {
  const a = Number(seedA);
  const b = Number(seedB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [];

  const possible = new Set();

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

// ---------- Config: Metric Aliases ----------
// Allows flexible CSV headers while mapping into canonical keys.
const ALIASES = {
  team: ['Team','TEAM','team','School','Team Name','TeamName','Team_Name','School Name','SchoolName','School_Name'],
  seed: ['Seed', 'seed'],

  // Core metrics
  offeff: ['OffEff', 'offeff', 'AdjOE', 'AdjO', 'Offensive Efficiency'],
  defeff: ['DefEff', 'defeff', 'AdjDE', 'AdjD', 'Defensive Efficiency'],
  adjem: ['AdjEM', 'adjem', 'AdjEMargin', 'AdjEMarg', 'Efficiency Margin'],
  ts: ['TS', 'TS%', 'ts', 'TS_pct', 'True Shooting %'],
  efg: ['eFG', 'eFG%', 'efg'],
  tempo: ['Tempo', 'tempo', 'Pace'],
  epr: ['EPR', 'epr', 'Effective Possession Ratio'],
  to: ['TO%', 'TOV%', 'to', 'to_pct', 'TO_pct', 'TO pct'],

  // Resume / SOS
  w: ['W', 'Wins'],
  l: ['L', 'Losses'],
  sos: ['SOS', 'sos', 'Sos'],
  cgw: ['CGW%', 'CGW_pct', 'CGW pct', 'Close Game Win %'],

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
  'offeff', 'defeff', 'adjem', 'ts', 'efg', 'tempo', 'epr', 'to',
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
function _normHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/[%]/g, 'pct')
    .replace(/[.\-_/]/g, ' ')      // dots and punctuation -> spaces
    .replace(/\s+/g, ' ')          // collapse spaces
    .trim();
}

// EXACT map for "Official MM Sheet 2.csv"
const HEADER_MAP = new Map([
  // identity
  ['team',                    'name'],
  ['seed',                    'seed'],

  // core 8
  ['off eff',                 'offeff'],
  ['def eff',                 'defeff'],
  ['efficiency margin',       'adjem'],
  ['true shooting pct',       'ts'],
  ['efg',                     'efg'],
  ['tempo',                   'tempo'],
  ['effective possession ratio','epr'],
  ['to pct',                  'to'],

  // defensive eFG
  ['def efgpct',               'def_efg'],   // for "Def. eFG%"
  ['def efg pct',              'def_efg'],   // for "Def. eFG pct" style headers

  // distribution (points share)
  ['pct of points from 2',    'pct_pts_2'],  // note: CSV header had a trailing space — normalizer strips it
  ['pct of points from 3',    'pct_pts_3'],
  ['pct of points from ft',   'pct_pts_ft'],

  // shooting + rates used by interactions
  ['3p pct',                  'threepp'],
  ['3p rate',                 'threepr'],
  ['ftr',                     'ftr'],

  // extras used in breadth / interactions / marks
  ['extra scoring chances game', 'scpg'],
  ['non blocked 2pt pct',     'nb2'],
  ['orb pct',                 'orb'],
  ['drb pct',                 'drb'],
  ['block pct',               'blk'],
  ['steals per possession',   'spp'],
  ['opp asst poss',           'opp_ast_poss'],
  ['opp to poss',             'otpp'],
  ['opp fta fga',             'opp_ftr'],
  ['opp 3pt pct',             'opp_3pp'],
  ['opp 3p rate',             'opp_3pr'],
  ['ft_pct',                  'ft_pct'],

  // résumé bits
  ['close game win pct',      'close_win_pct'],
  ['wins',                    'w'],
  ['losses',                  'l'],
  ['strength of schedule',    'sos'],
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
    const team = {
      name:   getStr(row, 'name'),
      seed:   getNum(row, 'seed'),

      // core 8
      offeff: getNum(row, 'offeff'),
      defeff: getNum(row, 'defeff'),
      adjem:  getNum(row, 'adjem'),
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
      w:             getNum(row, 'w'),
      l:             getNum(row, 'l'),
      sos:           getNum(row, 'sos'),
    };

    if (!team.name) continue; // skip empties

    TEAMS[team.name] = team;
    TEAM_LIST.push(team.name);
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
    if (t.w != null && t.l != null) {
      const total = t.w + t.l;
      if (total > 0) {
        t.wp = t.w / total;
        wpArr.push(t.wp);
      }
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

// ---------- Core Metric Layer + Breadth ----------
function computeCoreForTeam(team) {
  // 1) Core z-scores (v3.2 Core set: 8 metrics, Tempo removed)
  const zOff    = getZ(team, 'offeff',  false);
  const zDef    = getZ(team, 'defeff',  true);   // lower DefEff better
  const zAdjEM  = getZ(team, 'adjem',   false);
  const zTS     = getZ(team, 'ts',      false);
  const zEFG    = getZ(team, 'efg',     false);
  const zDefEFG = getZ(team, 'def_efg', true);   // lower Def eFG% better
  const zEPR    = getZ(team, 'epr',     false);
  const zTO     = getZ(team, 'to',      true);   // lower TO% better

  // Store for downstream layers (Breadth, Profile Marks, Interactions)
  team.coreZ = {
    offeff:  zOff,
    defeff:  zDef,
    adjem:   zAdjEM,
    ts:      zTS,
    efg:     zEFG,
    def_efg: zDefEFG,
    epr:     zEPR,
    to:      zTO,
  };

  // Core tier points (explain-mode only; do not affect MIBS)
  team.coreTierPts = {};
  Object.keys(team.coreZ).forEach((key) => {
    team.coreTierPts[key] = getTierPointsFromZ(team.coreZ[key]);
  });

  // 2) Core weighted composite — MIBS (v3.2 weights)
  // OffEff + -DefEff = 45%
  // TS% + eFG% + -Def eFG% = 35%
  // EPR + -TO% = 20%
  // AdjEM = stabilizer lane
  const wOffDef = 0.45 / 2.0;  // 0.225 each
  const wShoot  = 0.35 / 3.0;  // ≈0.1167 each
  const wPoss   = 0.20 / 2.0;  // 0.10 each
  const wAdjEM  = 0.10;        // stabilizer

  const mibsCore =
    wOffDef * zOff +
    wOffDef * zDef +
    wShoot  * zTS +
    wShoot  * zEFG +
    wShoot  * zDefEFG +
    wPoss   * zEPR +
    wPoss   * zTO;

  const mibs = mibsCore + wAdjEM * zAdjEM;
  team.mibs = mibs;

  // 3) Per-stat rows for the Core Traits table (UI only)
  const fsOff    = FIELD_STATS.offeff  || {};
  const fsDef    = FIELD_STATS.defeff  || {};
  const fsAdjEM  = FIELD_STATS.adjem   || {};
  const fsTS     = FIELD_STATS.ts      || {};
  const fsEFG    = FIELD_STATS.efg     || {};
  const fsDefEFG = FIELD_STATS.def_efg || {};
  const fsEPR    = FIELD_STATS.epr     || {};
  const fsTO     = FIELD_STATS.to      || {};

  const L = getTierLabelFromZ;

  team.coreDetails = [
    {
      key:   'offeff',
      label: 'Offensive Efficiency',
      mean:  fsOff.mean,
      sd:    fsOff.sd,
      value: team.offeff,
      z:     zOff,
      tier:  L(zOff),
      weight: wOffDef,
      points: wOffDef * zOff,
    },
    {
      key:   'defeff',
      label: 'Defensive Efficiency',
      mean:  fsDef.mean,
      sd:    fsDef.sd,
      value: team.defeff,
      z:     zDef,
      tier:  L(zDef),
      weight: wOffDef,
      points: wOffDef * zDef,
    },
    {
      key:   'adjem',
      label: 'Efficiency Margin',
      mean:  fsAdjEM.mean,
      sd:    fsAdjEM.sd,
      value: team.adjem,
      z:     zAdjEM,
      tier:  L(zAdjEM),
      weight: wAdjEM,
      points: wAdjEM * zAdjEM,
    },
    {
      key:   'ts',
      label: 'True Shooting %',
      mean:  fsTS.mean,
      sd:    fsTS.sd,
      value: team.ts,
      z:     zTS,
      tier:  L(zTS),
      weight: wShoot,
      points: wShoot * zTS,
    },
    {
      key:   'efg',
      label: 'Effective FG %',
      mean:  fsEFG.mean,
      sd:    fsEFG.sd,
      value: team.efg,
      z:     zEFG,
      tier:  L(zEFG),
      weight: wShoot,
      points: wShoot * zEFG,
    },
    {
      key:   'def_efg',
      label: 'Defensive eFG %',
      mean:  fsDefEFG.mean,
      sd:    fsDefEFG.sd,
      value: team.def_efg,
      z:     zDefEFG,
      tier:  L(zDefEFG),
      weight: wShoot,
      points: wShoot * zDefEFG,
    },
    {
      key:   'epr',
      label: 'Effective Possession Ratio',
      mean:  fsEPR.mean,
      sd:    fsEPR.sd,
      value: team.epr,
      z:     zEPR,
      tier:  L(zEPR),
      weight: wPoss,
      points: wPoss * zEPR,
    },
    {
      key:   'to',
      label: 'Turnover %',
      mean:  fsTO.mean,
      sd:    fsTO.sd,
      value: team.to,
      z:     zTO,
      tier:  L(zTO),
      weight: wPoss,
      points: wPoss * zTO,
    },
  ];
}

function computeBreadthForTeam(team) {
  const z = team.coreZ || {};

  // v3.2 hit criterion: z ≥ 0.60
  const isHit = (val) => typeof val === 'number' && val >= 0.60;

  // A. Efficiency Quartet (OffEff, -DefEff, AdjEM, -Def eFG%) — max +0.40
  let effHits = 0;
  if (isHit(z.offeff))  effHits++;
  if (isHit(z.defeff))  effHits++;
  if (isHit(z.adjem))   effHits++;
  if (isHit(z.def_efg)) effHits++;

  let effBonus = 0;
  if (effHits === 1)      effBonus = 0.10;
  else if (effHits === 2) effBonus = 0.20;
  else if (effHits === 3) effBonus = 0.30;
  else if (effHits === 4) effBonus = 0.40;

  // B. Shooting Pair (TS%, eFG%) — max +0.30
  let shootHits = 0;
  if (isHit(z.ts))  shootHits++;
  if (isHit(z.efg)) shootHits++;

  let shootBonus = 0;
  if (shootHits === 1)      shootBonus = 0.15;
  else if (shootHits === 2) shootBonus = 0.30;

  // C. Possession Stability Pair (EPR, -TO%) — max +0.30
  let possHits = 0;
  if (isHit(z.epr)) possHits++;
  if (isHit(z.to))  possHits++; // already inverted in z

  let possBonus = 0;
  if (possHits === 1)      possBonus = 0.15;
  else if (possHits === 2) possBonus = 0.30;

  const breadth = effBonus + shootBonus + possBonus;

  // For debugging / UI
  team.breadthEffHits   = effHits;
  team.breadthShootHits = shootHits;
  team.breadthPossHits  = possHits;
  team.breadthTotalHits = effHits + shootHits + possHits;

  team.breadth = breadth;                   // BreadthWeight = 1.00
  team.breadthHits = team.breadthTotalHits; // backwards-compatible
}

// ---------- Résumé Context Score (R) — MI_base Component ----------

function computeResumeContextForTeam(team) {
  // If we’re missing résumé data or field stats, treat as neutral résumé.
  if (!FIELD_STATS.wp || !FIELD_STATS.P || team.wp == null || team.P == null) {
    team.resumeIndex = 0;          // underlying R index
    team.resumeR     = 0;          // adjustment actually added to MI_base
    team.resumeRTier = 'Average';

    computeMIBase(team);
    return;
  }

  const z_wp = zScore(team.wp, FIELD_STATS.wp.mean, FIELD_STATS.wp.sd || 0.00001);
  const z_P  = zScore(team.P,  FIELD_STATS.P.mean,  FIELD_STATS.P.sd  || 0.00001);

  const R = (z_wp + z_P) / 2;

  let adj, tier;

  if (R >= 1.00) {
    adj = 0.15; tier = 'Elite';
  } else if (R >= 0.80) {
    adj = 0.10; tier = 'Strong';
  } else if (R >= 0.60) {
    adj = 0.05; tier = 'Above Average';
  } else if (R >= 0.00) {
    adj = 0.00; tier = 'Average';
  } else if (R > -0.80) {
    adj = -0.15; tier = 'Weak';
  } else { // R <= -0.80
    adj = -0.25; tier = 'Fragile';
  }

  team.resumeIndex = R;
  team.resumeR     = adj;
  team.resumeRTier = tier;

  computeMIBase(team);
}

// ---------- Interaction Metrics (Directional, Tiered, Half-Mirrored) ----------

function halfMirroredAdjust(gap) {
  const mag = Math.abs(gap);
  if (mag < 0.50) return 0;
  if (mag < 1.00) return 0.25;
  return 0.50;
}

// Shared interaction accumulator (reset in computeInteractions)
let __INT = { a: 0, b: 0, breakdown: {} };

// Small helpers to apply mirrored adjustments and record a breakdown entry
function _applyToA(base, tag) {
  if (!base) return;
  __INT.a += base;
  __INT.b -= base;
  __INT.breakdown[tag] = (__INT.breakdown[tag] || 0) + base;
}

function _applyToB(base, tag) {
  if (!base) return;
  __INT.b += base;
  __INT.a -= base;
  __INT.breakdown[tag] = (__INT.breakdown[tag] || 0) - base;
}

/* 1) 3PT Tension */
function interaction3PT(a, b) {
  const offA = (getZ(a, 'threepr') + getZ(a, 'threepp') + getZ(a, 'pct_pts_3')) / 3;
  const offB = (getZ(b, 'threepr') + getZ(b, 'threepp') + getZ(b, 'pct_pts_3')) / 3;

  // Defensive perimeter resistance (invert: lower opp values = stronger defense)
  const defA = (getZ(a, 'opp_3pr', true) + getZ(a, 'opp_3pp', true)) / 2;
  const defB = (getZ(b, 'opp_3pr', true) + getZ(b, 'opp_3pp', true)) / 2;

  const gapA = offA - defB; // A offense vs B perimeter D
  const gapB = offB - defA; // B offense vs A perimeter D

  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (gapA > 0) _applyToA(base, '3pt'); else _applyToB(base, '3pt');
  } else {
    const base = halfMirroredAdjust(gapB);
    if (gapB > 0) _applyToB(base, '3pt'); else _applyToA(base, '3pt');
  }
}

/* 2) FT Pressure (FT% + FTR + %Pts from FT vs foul discipline) */
function interactionFT(a, b) {
  // Offensive FT score: blend FTR, FT%, and % of points from FT (all z-scored)
  const offFTA =
    (getZ(a, 'ftr') + getZ(a, 'ft_pct') + getZ(a, 'pct_pts_ft')) / 3;
  const offFTB =
    (getZ(b, 'ftr') + getZ(b, 'ft_pct') + getZ(b, 'pct_pts_ft')) / 3;

  // Defensive FT discipline: lower OppFTR = better, so invert
  const defFTA = getZ(a, 'opp_ftr', true);
  const defFTB = getZ(b, 'opp_ftr', true);

  // Tension gaps: offense vs the *other* team’s FT discipline
  const gapA = offFTA - defFTB; // Team A offense vs Team B FT defense
  const gapB = offFTB - defFTA; // Team B offense vs Team A FT defense

  // Choose the side with the stronger leverage signal
  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (base) {
      if (gapA > 0) _applyToA(base, 'ft');
      else          _applyToB(base, 'ft');
    }
  } else {
    const base = halfMirroredAdjust(gapB);
    if (base) {
      if (gapB > 0) _applyToB(base, 'ft');
      else          _applyToA(base, 'ft');
    }
  }
}

/* 3) Paint Presence (2P profile vs rim protection) */
function interactionPaint(a, b) {
  const offA = (getZ(a, 'pct_pts_2') + getZ(a, 'nb2')) / 2;
  const offB = (getZ(b, 'pct_pts_2') + getZ(b, 'nb2')) / 2;

  // Rim protection: invert def_efg (lower = better), blk is normal
  const rimDefA = (getZ(a, 'def_efg', true) + getZ(a, 'blk')) / 2;
  const rimDefB = (getZ(b, 'def_efg', true) + getZ(b, 'blk')) / 2;

  const gapA = offA - rimDefB;
  const gapB = offB - rimDefA;

  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (gapA > 0) _applyToA(base, 'paint'); else _applyToB(base, 'paint');
  } else {
    const base = halfMirroredAdjust(gapB);
    if (gapB > 0) _applyToB(base, 'paint'); else _applyToA(base, 'paint');
  }
}

/* 4) Turnover Pressure (ball pressure + disruption vs ball security) */
function interactionTO(a, b) {
  // Defensive pressure: steals, forced TOs, and limiting assisted possessions
  const pressA = (
    getZ(a, 'spp') +                 // steals / possession
    getZ(a, 'otpp') +                // opponent TO / possession
    getZ(a, 'opp_ast_poss', true)    // invert: lower opp AST/poss = more disruption
  ) / 3;

  const pressB = (
    getZ(b, 'spp') +
    getZ(b, 'otpp') +
    getZ(b, 'opp_ast_poss', true)
  ) / 3;

  // Offensive ball security (already inverted in Core): higher = safer
  const secA = getZ(a, 'to', true);
  const secB = getZ(b, 'to', true);

  const gapA = pressA - secB; // A defense vs B offense
  const gapB = pressB - secA; // B defense vs A offense

  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (base) {
      if (gapA > 0) _applyToA(base, 'to');
      else          _applyToB(base, 'to');
    }
  } else {
    const base = halfMirroredAdjust(gapB);
    if (base) {
      if (gapB > 0) _applyToB(base, 'to');
      else          _applyToA(base, 'to');
    }
  }
}

/* 5) Possession Manager (second chances vs denial) */
function interactionGlass(a, b) {
  // Use 'scpg' for extra scoring chances per game
  const offGlassA = (getZ(a, 'orb') + getZ(a, 'scpg')) / 2;
  const offGlassB = (getZ(b, 'orb') + getZ(b, 'scpg')) / 2;
  const defGlassA = getZ(a, 'drb');
  const defGlassB = getZ(b, 'drb');

  const gapA = offGlassA - defGlassB;
  const gapB = offGlassB - defGlassA;

  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (gapA > 0) _applyToA(base, 'glass'); else _applyToB(base, 'glass');
  } else {
    const base = halfMirroredAdjust(gapB);
    if (gapB > 0) _applyToB(base, 'glass'); else _applyToA(base, 'glass');
  }
}

/* 6) Resume Pressure (matchup version) */
function interactionResume(a, b) {
  if (!FIELD_STATS.wp || !FIELD_STATS.P || a.wp == null || b.wp == null || a.P == null || b.P == null) return;

  const z_wp_a = zScore(a.wp, FIELD_STATS.wp.mean, FIELD_STATS.wp.sd || 1e-5);
  const z_P_a  = zScore(a.P,  FIELD_STATS.P.mean,  FIELD_STATS.P.sd  || 1e-5);
  const idxA   = (z_wp_a + z_P_a) / 2;

  const z_wp_b = zScore(b.wp, FIELD_STATS.wp.mean, FIELD_STATS.wp.sd || 1e-5);
  const z_P_b  = zScore(b.P,  FIELD_STATS.P.mean,  FIELD_STATS.P.sd  || 1e-5);
  const idxB   = (z_wp_b + z_P_b) / 2;

  const gap = idxA - idxB;
  const base = halfMirroredAdjust(gap);
  if (gap > 0) _applyToA(base, 'resume'); else if (gap < 0) _applyToB(base, 'resume');
}

/* 7) Physicality / Contact Tolerance */
function interactionPhysicality(a, b) {
  // Offensive physicality: lives in contact and the paint
  const physOffA = (
    getZ(a, 'ftr') +          // draw fouls
    getZ(a, 'pct_pts_2') +    // % of points from 2s
    getZ(a, 'nb2')            // non-blocked 2s
  ) / 3;

  const physOffB = (
    getZ(b, 'ftr') +
    getZ(b, 'pct_pts_2') +
    getZ(b, 'nb2')
  ) / 3;

  // Defensive contact tolerance: rim resistance + foul discipline
  const tolDefA = (
    getZ(a, 'blk') +              // rim challenge
    getZ(a, 'def_efg', true) +    // invert: lower Def eFG% = better
    getZ(a, 'opp_ftr', true)      // invert: lower OppFTR = better discipline
  ) / 3;

  const tolDefB = (
    getZ(b, 'blk') +
    getZ(b, 'def_efg', true) +
    getZ(b, 'opp_ftr', true)
  ) / 3;

  const gapA = physOffA - tolDefB; // A's physical style vs B's tolerance
  const gapB = physOffB - tolDefA; // B's physical style vs A's tolerance

  // Choose the stronger directional signal, then half-mirror
  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (!base) return;
    if (gapA > 0) _applyToA(base, 'phys');  // A's physicality stresses B
    else          _applyToB(base, 'phys');  // B's interior toughness wins
  } else {
    const base = halfMirroredAdjust(gapB);
    if (!base) return;
    if (gapB > 0) _applyToB(base, 'phys');
    else          _applyToA(base, 'phys');
  }
}

/* 8) Shot Quality / Shot Discipline */
function interactionShotQuality(a, b) {
  // Offensive shot quality: efficiency + geometry + clean interior looks
  const sqA = (
    getZ(a, 'efg') +          // overall shot efficiency
    getZ(a, 'threepr') +      // 3P rate (spacing / geometry)
    getZ(a, 'nb2')            // non-blocked 2s (clean paint looks)
  ) / 3;

  const sqB = (
    getZ(b, 'efg') +
    getZ(b, 'threepr') +
    getZ(b, 'nb2')
  ) / 3;

  // Defensive shot discipline: suppress eFG and assisted, in-rhythm looks
  const sdA = (
    getZ(a, 'def_efg', true) +      // invert: lower Def eFG% = better
    getZ(a, 'opp_ast_poss', true)   // invert: lower opp AST/poss = more disruption
  ) / 2;

  const sdB = (
    getZ(b, 'def_efg', true) +
    getZ(b, 'opp_ast_poss', true)
  ) / 2;

  const gapA = sqA - sdB; // A's shot diet vs B's ability to distort it
  const gapB = sqB - sdA; // B's shot diet vs A's disruption

  if (Math.abs(gapA) >= Math.abs(gapB)) {
    const base = halfMirroredAdjust(gapA);
    if (!base) return;
    if (gapA > 0) _applyToA(base, 'shotq'); // A keeps its shot diet intact
    else          _applyToB(base, 'shotq'); // B meaningfully distorts A
  } else {
    const base = halfMirroredAdjust(gapB);
    if (!base) return;
    if (gapB > 0) _applyToB(base, 'shotq');
    else          _applyToA(base, 'shotq');
  }
}

/* 9) Variance Sensitivity */
function interactionVariance(a, b) {
  // --- Helper: Turnover Fragility index (same logic as the mark, but numeric)
  function getTurnoverFragility(team) {
    // stability = good if -TO% high and EPR high
    const stability = (-getZ(team, 'to') + getZ(team, 'epr')) / 2;
    // fragility = inverse of stability
    return -stability;
  }

  // --- Helper: small bonus for shot-volatility marks
  function getVarianceMarkBonus(team) {
    const marks = Array.isArray(team.profileMarks) ? team.profileMarks : [];
    let bonus = 0;

    if (marks.includes('Unstable Perimeter — Severe')) bonus += 0.10;
    else if (marks.includes('Unstable Perimeter — Moderate')) bonus += 0.05;

    if (marks.includes('Cold Arc Team — Severe')) bonus += 0.10;
    else if (marks.includes('Cold Arc Team — Moderate')) bonus += 0.05;

    return bonus;
  }

  // Variance Exposure Index (VEI): how volatile this team's style is
  function getVEI(team) {
    const threeVol   = getZ(team, 'threepr');        // high 3P rate → more variance
    const lowFTR     = getZ(team, 'ftr', true);      // low FTR → fewer stabilizing FTs
    const lowORB     = getZ(team, 'orb', true);      // low ORB → fewer extra chances
    const toFrag     = getTurnoverFragility(team);   // bad TO/EPR mix → volatility
    const markBonus  = getVarianceMarkBonus(team);   // add small boost for bad marks

    return (
      0.40 * threeVol +
      0.20 * lowFTR +
      0.20 * lowORB +
      0.20 * toFrag +
      markBonus
    );
  }

  // Opponent Stabilization Index (OSI): how much this team suppresses volatility
  function getOSI(team) {
    const press     = getZ(team, 'otpp');          // forces TOs → punishes fragile styles
    const dReb      = getZ(team, 'drb');           // strong DRB → removes 2nd-chance safety
    const ftDisc    = getZ(team, 'opp_ftr', true); // invert: lower OppFTR = fewer free points
    const perimDisc = getZ(team, 'opp_3pp', true); // invert: lower Opp3P% = stabilizes 3-happy foes

    return (press + dReb + ftDisc + perimDisc) / 4;
  }

  const veiA = getVEI(a);
  const veiB = getVEI(b);
  const osiA = getOSI(a);
  const osiB = getOSI(b);

  // "Risk exposure" for each side: how much their volatility is *exposed* by this opponent
  const riskA = veiA - osiB;
  const riskB = veiB - osiA;

  // We treat higher risk as a liability and award leverage to the more stable side
  if (Math.abs(riskA) >= Math.abs(riskB)) {
    const base = halfMirroredAdjust(riskA);
    if (!base) return;

    if (riskA > 0) {
      // A's volatility is exposed by B → favors B
      _applyToB(base, 'var');
    } else if (riskA < 0) {
      // B cannot meaningfully punish A's volatility → favors A (A effectively more stable here)
      _applyToA(base, 'var');
    }
  } else {
    const base = halfMirroredAdjust(riskB);
    if (!base) return;

    if (riskB > 0) {
      // B's volatility is exposed by A → favors A
      _applyToA(base, 'var');
    } else if (riskB < 0) {
      // A cannot meaningfully punish B's volatility → favors B
      _applyToB(base, 'var');
    }
  }
}

function computeInteractions(a, b) {
  __INT = { a: 0, b: 0, breakdown: {} }; // reset

  interaction3PT(a, b);
  interactionFT(a, b);
  interactionPaint(a, b);
  interactionTO(a, b);
  interactionGlass(a, b);
  interactionPhysicality(a, b);
  interactionShotQuality(a, b);
  interactionVariance(a, b);

  return { a: __INT.a, b: __INT.b, breakdown: __INT.breakdown };
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

  // 8. Turnover Fragility
  if (FIELD_STATS.to && FIELD_STATS.epr && team.to != null && team.epr != null) {
    const stability = (-getZ(team, 'to') + getZ(team, 'epr')) / 2;
    const frag = -stability;
    if (frag >= 1.00) marks.push('Turnover Fragility — Severe');
    else if (frag >= 0.50) marks.push('Turnover Fragility — Moderate');
  }

  team.profileMarks = marks;
}

// ---------- Full Team Layer Computation ----------

function computeAllTeamLayers() {
  Object.values(TEAMS).forEach(team => {
    computeCoreForTeam(team);
    computeBreadthForTeam(team);
    computeResumeContextForTeam(team);
    computeProfileMarks(team);
  });
}

// ---------- CIS / FAS Static Identity Profiles (v4.0) ----------

// Small helper: count strong/weak cores from team.coreZ
function getCoreFractions(team) {
  const z = team.coreZ || {};
  const keys = Object.keys(z);
  if (!keys.length) {
    return {
      fStrong: 0,
      fWeak: 0,
      strongCount: 0,
      weakCount: 0
    };
  }

  let strongCount = 0;
  let weakCount   = 0;

  keys.forEach(k => {
    const val = z[k];
    if (typeof val !== 'number') return;
    if (val >= 0.80) strongCount++;
    else if (val < 0.50) weakCount++;
  });

  const total = keys.length;
  return {
    fStrong: strongCount / total,
    fWeak:   weakCount   / total,
    strongCount,
    weakCount
  };
}

// Compute CIS_static and FAS_static for every team once per CSV load
function computeStaticIdentities() {
  const teams = Object.values(TEAMS || {});
  const n = teams.length;
  if (!n) return;

  // 1) Make sure MI_base is populated and collect values
  const miValues = [];
  teams.forEach(t => {
    if (typeof t.mi_base !== 'number') {
      computeMIBase(t);
    }
    miValues.push(t.mi_base || 0);
  });

  // 2) Performance percentile P via rank-percentile of MI_base
  const sorted = teams.slice().sort((a, b) => (a.mi_base || 0) - (b.mi_base || 0));
  const perfMap = new Map();
  sorted.forEach((t, idx) => {
    // rank-percentile: lower MI_base = lower percentile
    const P = (idx + 0.5) / n;
    perfMap.set(t.name, P);
  });

  console.log("[IDENTITY DBG] perfMap size:", perfMap.size, "teams:", n);
  console.log("[IDENTITY DBG] P samples:",
    teams.slice(0, 5).map(t => ({
      name: t.name,
      seed: t.seed,
      mi_base: t.mi_base,
      P: perfMap.get(t.name)
    }))
  );

  // 3) Compute raw CIS/FAS
  let cisRawMax = 0;
  let fasRawMax = 0;

  teams.forEach(team => {
    const s = team.seed;
    if (s == null) {
      team.cis_raw = 0;
      team.fas_raw = 0;
      return;
    }

    const P = perfMap.get(team.name) ?? 0.5;
    team.performancePercentile = P;

  // 1–99 Madness Index Rating (cosmetic, based on MI_base percentile)
  let rating = Math.round(P * 100);
  if (rating < 1) rating = 1;
  if (rating > 99) rating = 99;
  team.mi_rating = rating;    

    const Sf = (17 - s) / 16; // favorite-side index
    const Su = (s - 1) / 16;  // underdog-side index

    const delta = P - Sf;
    const deltaPlus = Math.max(0, delta); // for CIS
    const APrime = 1 - Math.abs(delta);   // for FAS alignment

    const { fStrong, fWeak, strongCount, weakCount } = getCoreFractions(team);
    team.coreStrongCount = strongCount;
    team.coreWeakCount   = weakCount;
    team.coreStrongFrac  = fStrong;
    team.coreWeakFrac    = fWeak;

    const bCoreCIS = Math.max(0, fStrong - 0.5 * fWeak);
    const bCoreFAS = fStrong * (1 - fWeak);

    const R      = (typeof team.resumeR === 'number') ? team.resumeR : 0;
    const Rplus  = 0.5 + R / 4;

    const xCIS = 0.60 * deltaPlus +
                 0.25 * bCoreCIS +
                 0.15 * Rplus;

    const xFAS = 0.50 * APrime +
                 0.30 * bCoreFAS +
                 0.20 * Rplus;

    const cisRaw = Su * xCIS;
    const fasRaw = Sf * xFAS;

    team.cis_raw = cisRaw;
    team.fas_raw = fasRaw;

    if (cisRaw > cisRawMax) cisRawMax = cisRaw;
    if (fasRaw > fasRawMax) fasRawMax = fasRaw;
  });

  // 4) Normalize to 0–100 static scores
  const EPS = 1e-6;
  teams.forEach(team => {
    const cisRaw = team.cis_raw || 0;
    const fasRaw = team.fas_raw || 0;

    const cis = (cisRawMax > EPS && cisRaw > 0) ? (cisRaw / cisRawMax) * 100 : 0;
    const fas = (fasRawMax > EPS && fasRaw > 0) ? (fasRaw / fasRawMax) * 100 : 0;

    team.cisStatic_raw = cis;
    team.fasStatic_raw = fas;

    // v3.8: CIS/FAS become dampened baselines with headroom
    team.cisStatic = miDampenBaselineScore(cis, MI_IDENTITY_V38.capC, MI_IDENTITY_V38.gammaC);
    team.fasStatic = miDampenBaselineScore(fas, MI_IDENTITY_V38.capF, MI_IDENTITY_V38.gammaF);
  });

  const sample = teams
  .filter(t => t.seed != null)
  .slice(0, 8)
  .map(t => ({
    name: t.name,
    seed: t.seed,
    cisStatic_raw: t.cisStatic_raw,
    fasStatic_raw: t.fasStatic_raw,
    cisStatic: t.cisStatic,
    fasStatic: t.fasStatic
  }));

  console.table(sample);
}

// ---------- Baseline Madness Index (MI_base) ----------
function computeMIBase(team) {
  const mibs      = (typeof team.mibs === 'number') ? team.mibs : 0;
  const breadth   = (typeof team.breadth === 'number') ? team.breadth : 0;

  const miBase = mibs + breadth;

  team.mi_base = miBase;  // keep on the object for UI / downstream use
  return miBase;
}

// Scale interaction leverage by résumé quality.
// Stronger résumés "cash in" more of their matchup leverage.
function getResumeInteractionFactor(team) {
  const tier = team.resumeRTier || 'Average';

  switch (tier) {
    case 'Elite':
      return 1.00;
    case 'Strong':
      return 0.95;
    case 'Above Average':
      return 0.90;
    case 'Average':
      return 0.85;
    case 'Weak':
      return 0.70;
    case 'Fragile':
      return 0.50;
    default:
      return 0.85; // treat unknown as roughly Average
  }
}

// ---------- Matchup Madness Index (MI_matchup) ----------

function computeFinalMI(team, interactionAdj) {
  // Safeguard: ensure MI_base exists
  const base = (typeof team.mi_base === 'number')
    ? team.mi_base
    : computeMIBase(team);

  // Raw interaction total from the interaction engine
  const intRaw = (typeof interactionAdj === 'number') ? interactionAdj : 0;

  // Scale by résumé quality
  const rFactor = getResumeInteractionFactor(team);
  const intAdj  = intRaw * rFactor;

  const mi_matchup = base + intAdj;

  // Optional: store for debugging / Explain Mode
  team.mi_matchup   = mi_matchup;
  team.mi_int_raw   = intRaw;   // pre-scaling leverage
  team.mi_int       = intAdj;   // effective leverage after résumé scaling
  team.mi_int_rFact = rFactor;  // which factor was applied

  return mi_matchup;
}

function getTeamByName(name) {
  return TEAMS[name] || null;
}

function compareTeams(teamAName, teamBName, roleMode = 'auto') {
  const a = getTeamByName(teamAName);
  const b = getTeamByName(teamBName);

  if (!a || !b) {
    console.error('Invalid team selection:', teamAName, teamBName);
    return;
  }

  const interactions = computeInteractions(a, b);

  const activeRound = CURRENT_ROUND;  // e.g. "R64", "S16", etc.
  const seedMeta    = getSeedRoundMeta(a.seed, b.seed, activeRound);

  const miA = computeFinalMI(a, interactions.a);
  const miB = computeFinalMI(b, interactions.b);

  const diff      = miA - miB;
  const predicted = diff > 0 ? a.name : (diff < 0 ? b.name : 'Push');

  const result = {
    a,
    b,
    miA,
    miB,
    diff,
    predicted,
    interactions,
    round: activeRound,
    seedMeta,
  };

  window.LAST_RESULT = result;

  renderTeamCards(result);
  miUpdateMatchupLensHeaders(result);
  renderProfileMarks(a, "inlineMarksA");
  renderProfileMarks(b, "inlineMarksB");
  renderInteractionsTable(result);
  renderInteractionsConsole(result);
  renderSummary(result);
  updateMatchupBarFromDOM();
  updateCoreBacksForResult(result);
  updateBreadthBacksForResult(result);
  updateResumeBacksForResult(result);
  updateMarksBacksForResult(result);
  updateFormulaBacksForResult(result);
  updateIdentityBacksForResult(result);

  // New: pull copy.json from the global and feed it into the MI back-of-card builder
  const copy = window.MI_COPY;
  if (copy) {
    updateMadnessBacksForResult(result, window.MI_COPY, roleMode);
  }

  miPushLogFromResult(result);
  miRenderShelf();

  console.log(result);
  return result;
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

  TEAM_LIST.sort().forEach(name => {
    const optA = document.createElement('option');
    optA.value = name;
    optA.textContent = name;
    selectA.appendChild(optA);

    // Mount searchable dropdown UI (drives the native selects)
    const wrapA = document.getElementById('teamASelectWrap');
    const wrapB = document.getElementById('teamBSelectWrap');
    if (wrapA) ensureSearchableTeamDropdown(selectA, wrapA, 'Select Team A');
    if (wrapB) ensureSearchableTeamDropdown(selectB, wrapB, 'Select Team B');

    const optB = document.createElement('option');
    optB.value = name;
    optB.textContent = name;
    selectB.appendChild(optB);
  });

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

  selectA.addEventListener('change', onTeamChange);
  selectB.addEventListener('change', onTeamChange);

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

  if (n.startsWith(query)) return 0;

  // word-start match
  const words = n.split(/\s+/);
  if (words.some(w => w.startsWith(query))) return 1;

  // contains
  if (n.includes(query)) return 2;

  return 999;
}

function ensureSearchableTeamDropdown(selectEl, wrapEl, placeholderText) {
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
    if (activeIndex >= 0 && items[activeIndex]) {
      // Keep highlighted item in view
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
      hasKeyboardNav = true; // allow enter to pick hovered item
      syncActive();
    }
  });
}

function getRoundLabelFromCode(code) {
  switch (code) {
    case "R64":   return "Round of 64";
    case "R32":   return "Round of 32";
    case "S16":   return "Sweet Sixteen";
    case "E8":    return "Elite Eight";
    case "F4":    return "Final Four";
    case "Champ": return "Championship";
    default:      return "Select Round";
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
  return r;
}

// Canonical wins-to-date mapping
function miWinsToDate(roundCode) {
  const r = miNormalizeRoundCode(roundCode);
  switch (r) {
    case 'R64':   return 0;
    case 'R32':   return 1;
    case 'S16':   return 2;
    case 'E8':    return 3;
    case 'F4':    return 4;
    case 'Champ': return 5;
    default:      return 0;
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

  // New canonical matchup bar labels
  const elA = document.getElementById('matchupRoleA');
  const elB = document.getElementById('matchupRoleB');

  // (Optional) If you also added these IDs to the scorecard header pills, we’ll update them too.
  const cardA = document.getElementById('roleTagA');
  const cardB = document.getElementById('roleTagB');

  if (!elA && !elB && !cardA && !cardB) return;

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

  // Helper: set text + a lightweight data attribute (useful for CSS later if you want)
  const setLabel = (el, text, lensKey) => {
    if (!el) return;
    el.textContent = text;
    el.setAttribute('data-lens', lensKey);
  };

  // Mirrors: both sides get the mirror lens label
  if (ctx.mode === 'chalk_mirror') {
    setLabel(elA, LABEL.chalk, 'chalk_mirror');
    setLabel(elB, LABEL.chalk, 'chalk_mirror');
    setLabel(cardA, LABEL.chalk, 'chalk_mirror');
    setLabel(cardB, LABEL.chalk, 'chalk_mirror');
    return;
  }

  if (ctx.mode === 'chaos_mirror') {
    setLabel(elA, LABEL.chaos, 'chaos_mirror');
    setLabel(elB, LABEL.chaos, 'chaos_mirror');
    setLabel(cardA, LABEL.chaos, 'chaos_mirror');
    setLabel(cardB, LABEL.chaos, 'chaos_mirror');
    return;
  }

  if (ctx.mode === 'neutral_mirror') {
    setLabel(elA, LABEL.neutral, 'neutral_mirror');
    setLabel(elB, LABEL.neutral, 'neutral_mirror');
    setLabel(cardA, LABEL.neutral, 'neutral_mirror');
    setLabel(cardB, LABEL.neutral, 'neutral_mirror');
    return;
  }

  // Standard: label each side by its resolved role
  const roleA = (ctx.roleA || '').toLowerCase(); // "favorite" | "cinderella"
  const roleB = (ctx.roleB || '').toLowerCase();

  const textA = (roleA === 'favorite') ? LABEL.favorite : LABEL.cinderella;
  const textB = (roleB === 'favorite') ? LABEL.favorite : LABEL.cinderella;

  setLabel(elA, textA, roleA || 'standard');
  setLabel(elB, textB, roleB || 'standard');
  setLabel(cardA, textA, roleA || 'standard');
  setLabel(cardB, textB, roleB || 'standard');
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
  if (d < 0.10) return 'tiny_gap';   // "Coin flip"
  if (d < 0.25) return 'small_gap';  // "Slight lean"
  if (d < 0.50) return 'medium_gap'; // "Clear lean"
  return 'large_gap';                // "Strong favorite"
}

/* =========================================================
   MATCHUP LOG (v3.7) — Option A Shelf
   - stores only 10 recent (localStorage)
   - shelf hidden until 2+ runs
   - shows top 3 always; "More" reveals next 7
   ========================================================= */

const MI_LOG_STORAGE_KEY = "mi.v3_7.matchupLog";
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
  try{ if (id) localStorage.setItem(MI_LOG_LASTNEW_KEY, String(id)); }catch(e){}
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
  return (typeof x === "number" && isFinite(x)) ? x.toFixed(2) : "—";
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

    // ✅ Normal case: already an array
    if (Array.isArray(parsed)) return parsed;

    // ✅ Migration: if a single entry object was stored
    if (parsed && typeof parsed === "object") {
      // Keyed object-log → convert to array of entries
      const vals = Object.values(parsed);

      // If it looks like entries, use them
      if (vals.length && typeof vals[0] === "object") {
        return vals
          .filter(Boolean)
          .sort((a,b) => (b.ts || 0) - (a.ts || 0));
      }

      // Otherwise treat as one entry-like object
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
  const mode = miSandboxOn() ? "SBX" : (result.round || "NOROUND");
  // Unique per run, but still readable
  return `${Date.now()}__${mode}__${result.a?.name || "A"}__${result.b?.name || "B"}`;
}

function miPushLogFromResult(result){
  if (!result || !result.a || !result.b) return;

  const sandbox = miSandboxOn();
  const round = sandbox ? null : (result.round || null);

  const miA = result.miA;
  const miB = result.miB;
  const diff = (typeof result.diff === "number") ? result.diff : (miA - miB);

  const entry = {
    id: miBuildLogId(result),
    ts: Date.now(),

    sandbox,
    round,

    teamA: result.a.name,
    teamB: result.b.name,

    miA,
    miB,

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

  // must actually be in “has matchup” world (your app uses this class in DOM)
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

  // Hard phase gate
  if (!miShelfPhaseOk()){
    plate.hidden = true;
    plate.classList.remove("is-open", "is-more-open", "is-intro");
    morePanel.hidden = true;
    moreBtn.hidden = true;
    moreBtn.setAttribute("aria-expanded", "false");
    if (bar.classList.contains("has-shelf")) bar.classList.remove("has-shelf");

    return;
  }

  // Only set the class if it needs to change (prevents MutationObserver loop)
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

  // If we just crossed into editing for the first time, "introduce" the log
  if (!introduced && bar.classList.contains("is-editing")){
    miSetLogIntroduced();
    plate.classList.add("is-intro");
  } else {
    plate.classList.remove("is-intro");
  }

  // Build top 3 + rest
  const a = entries.slice(0, 3);
  const aRender = a.slice().reverse();
  const b = entries.slice(3);

  top3.innerHTML = "";
  for (const e of aRender) top3.appendChild(miBuildRow(e));

  // Option A shift animation: newest row (bottom) animates
  const lastNewId = miGetLastNewId();
  if (lastNewId && a.length && a[0].id === lastNewId){
    const newestRow = top3.lastElementChild; // bottom-most after reverse render
    if (newestRow){
      newestRow.classList.add("is-new");
      miSetLastNewId(""); // remove marker so it doesn't animate forever
      setTimeout(() => newestRow.classList.remove("is-new"), 520);
    }
  }

  moreList.innerHTML = "";
  for (const e of b) moreList.appendChild(miBuildRow(e));

  // More button visibility
  if (b.length > 0){
    moreBtn.hidden = false;
  } else {
    moreBtn.hidden = true;
    morePanel.hidden = true;
    moreBtn.setAttribute("aria-expanded", "false");
  }

  // Show plate
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

  // Prevent double-binding
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

  // click outside collapses More (but leaves plate visible)
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

  // esc collapses More
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

  // ----- Primary (headline) -----
  const primaryBlock = metrics.primary_text;
  const primaryLineRaw = miPickBandLine(primaryBlock, gapKey);
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
  const secondaryLineRaw = miPickBandLine(secondaryBlock, gapKey);
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

  // --- Sentence split (Headline = sentence 1, Subdeck = sentence 2+)
  const split = raw.match(/^(.+?[.!?])\s+(?=[A-Z“"‘])/);

  let headlineText = raw;
  let subText = '';

  if (split && split[1] && split[1].length < raw.length) {
    headlineText = split[1].trim();
    subText = raw.slice(split[0].length).trim();
  }

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

  console.log(
    '[enhanceVerdictPresentation] structured:',
    document.querySelectorAll('#miVerdictLine .mi-verdict-headline, #miVerdictLine .mi-verdict-why').length
  );
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

function renderSummary({ a, b, miA, miB, diff, predicted, interactions, round, seedMeta }) {
  const summarySection = document.getElementById('summarySection');
  const table = document.getElementById('summaryTable');

  // ===== Summary center: hue the Explain card like Verdict Shell =====
  const explainCard = summarySection
    ? summarySection.querySelector('.summary-mid-card--explain')
    : null;

  if (explainCard) {
    explainCard.classList.remove('mi-winner-cinderella', 'mi-winner-favorite', 'mi-winner-neutral');

    const winnerRole = (diff === 0)
      ? 'neutral'
      : (diff > 0 ? 'cinderella' : 'favorite'); // Team A = Cinderella, Team B = Favorite

    explainCard.classList.add(`mi-winner-${winnerRole}`);
  }

  // Do NOT return early just because summary layout changed.
  // Verdict Shell and scorebug updates must still run.
  const tbody = table ? table.querySelector('tbody') : null;

  // ----- JSON wiring for labels + gap phrases -----
  const copy        = window.MI_COPY || {};
  const summaryCopy = copy.summary || {};
  const tableLabels = summaryCopy.table_labels || {};
  const phrases     = copy.summary_phrases || {};

  const cTeamLabel = tableLabels.cinderella_label
    || (copy.card && copy.card.cinderella_label)
    || 'Cinderella';

  const fTeamLabel = tableLabels.favorite_label
    || (copy.card && copy.card.favorite_label)
    || 'Favorite';

  const baselineLabel    = tableLabels.baseline_label    || 'Baseline MI';
  const matchupLabel     = tableLabels.matchup_label     || 'Matchup MI';
  const interactionLabel = tableLabels.interaction_label || 'Interaction Leverage';
  const predictedLabel   = tableLabels.predicted_label   || 'Predicted Winner';

  const neutralText = summaryCopy.neutral_matchup || 'Neutral matchup';
  const towardWord  = summaryCopy.toward_phrase   || 'toward';

  // ----- Baseline vs matchup values (define BEFORE any narration logic) -----
  const baseA = typeof a.mi_base === 'number' ? a.mi_base : computeMIBase(a);
  const baseB = typeof b.mi_base === 'number' ? b.mi_base : computeMIBase(b);
  const intA  = interactions?.a || 0;
  const intB  = interactions?.b || 0;

  const centerHeaderLabel = summaryCopy.matchup_header || 'Matchup Edge';

  // ----- Gap band (JSON) -----
  const gapKey    = getSummaryGapKey(diff);
  const gapCfg    = phrases[gapKey] || {};
  const bandLabel = (gapCfg.label || '').trim();
  const bandDesc  = (gapCfg.description || '').trim();

  // ----- Build lean text (also feeds the hero HUD / other UI) -----
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

  // ----- Verdict → Confidence → Why → Risk (JSON-driven; NO hardcoded phrases) -----
  const verdictCopy = summaryCopy.verdict || {}; // namespace

  // Optional labels (can be blank until JSON is added)
  const confidenceLabelText = verdictCopy.confidence_label || tableLabels.confidence_label || '';
  const driverLabelText     = verdictCopy.driver_label     || tableLabels.driver_label     || '';
  const riskLabelText       = verdictCopy.risk_label       || tableLabels.risk_label       || '';

  // Confidence band comes from summary_phrases band label (already JSON-driven)
  const confidenceBand = (bandLabel || getLeanBand(diff) || '').trim();

  // Determine winner side
  const winnerIsA =
    (diff > 0) ? true :
    (diff < 0) ? false :
    (predicted === a.name); // only if diff === 0

  const winName   = winnerIsA ? a.name : b.name;
  const loseName  = winnerIsA ? b.name : a.name;

  // Interaction leverage (winner vs loser)
  const winInt  = winnerIsA ? intA : intB;
  const loseInt = winnerIsA ? intB : intA;

  // Thresholds: keep numeric logic in JS; wording lives in JSON
  const INT_SOFT = typeof verdictCopy.int_soft_threshold === 'number'
    ? verdictCopy.int_soft_threshold
    : 0.20;

  const intBalanced   = (Math.abs(winInt) <= INT_SOFT && Math.abs(loseInt) <= INT_SOFT);
  const intReinforces = (winInt >  INT_SOFT && loseInt < -INT_SOFT);
  const intResists    = (winInt < -INT_SOFT && loseInt >  INT_SOFT);

  // Helper: tiny template renderer with {{TOKENS}}
  const renderTpl = (tpl, tokens) => {
    if (!tpl) return '';
    return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => {
      return (tokens && tokens[k] != null) ? String(tokens[k]) : '';
    });
  };

  // Decide "edge tier" (keys only; wording comes from JSON)
  const absDiff = Math.abs(diff);
  const edgeTier = (absDiff >= 4) ? 'heavy'
                : (absDiff >= 2) ? 'solid'
                : (absDiff >  0) ? 'slight'
                : 'coin';

  // Decide driver case
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
    // mixed
    driverCase = (Math.abs(winInt) >= Math.abs(loseInt)) ? 'mixed_still_winner' : 'mixed_live_loser';
  }

  // Decide risk case (tier-aware + resistance-aware)
  const riskCase = `${edgeTier}_${intResists ? 'resists' : 'default'}`;

  // Pull templates from JSON (blank-safe)
  const driverTpl = (verdictCopy.driver_templates && verdictCopy.driver_templates[driverCase]) || '';
  const riskTpl   = (verdictCopy.risk_templates   && verdictCopy.risk_templates[riskCase])   || '';

  // We'll also compute sepText early for the new synthesis center & MI Δ
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

  // ----- Verdict metrics flip-tile (BACK) text (JSON-driven; 3-sentence paragraph; gap-band-aware) -----
  const metricsCfg   = (copy.verdict && copy.verdict.metrics) ? copy.verdict.metrics : {};
  const backTextCfg  = (metricsCfg.back_text || {});

  const pickOne = (arr) => (Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : "");

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const ensureEndPunct = (s) => {
    const t = clean(s);
    if (!t) return "";
    return /[.!?]$/.test(t) ? t : (t + ".");
  };

  const baseTpl  = pickOne(backTextCfg.base);
  const matchTpl = pickOne(backTextCfg.matchup);

  const gapBucket = (backTextCfg.gap && backTextCfg.gap[gapKey] != null)
    ? backTextCfg.gap[gapKey]
    : (backTextCfg.gap ? backTextCfg.gap.default : null);

  let gapTpl = "";
  if (Array.isArray(gapBucket)) gapTpl = pickOne(gapBucket);
  else if (typeof gapBucket === "string") gapTpl = gapBucket;

  const s1 = ensureEndPunct(renderTpl(baseTpl, tokens));
  const s2 = ensureEndPunct(renderTpl(matchTpl, tokens));
  const s3 = ensureEndPunct(renderTpl(gapTpl,  tokens));

  const metricsBackText = [s1, s2, s3].filter(Boolean).join(" ");

  const metricsBackEl =
    document.querySelector('#verdictShell .mi-verdict-metrics-tile .tile-back .mi-metrics-back-text') ||
    document.querySelector('#verdictShell .mi-metrics-back-text[data-copy="verdict.metrics.back_text"]');

  if (metricsBackEl && metricsBackText) {
    metricsBackEl.textContent = metricsBackText;
  }

  // Support line remains the band description (already JSON-driven via summary_phrases)
  let supportText = bandDesc || '';
  if (supportText && leanText && leanText.includes(supportText)) {
    supportText = '';
  }

  // ----- Summary table headers -----
  const headA = document.getElementById('summaryTeamAHeader');
  const headB = document.getElementById('summaryTeamBHeader');
  if (headA) headA.textContent = a.name;
  if (headB) headB.textContent = b.name;

  // Helper: set text for a data-value field inside #summarySection
  const setSummaryValue = (key, val) => {
    const root = summarySection || document;
    const els = root.querySelectorAll(`[data-value="${key}"]`);
    if (!els || !els.length) return;
    const out = (val == null ? '' : val);
    els.forEach(el => { el.textContent = out; });
  };

  // ===== SCORE SYNTHESIS (NEW HTML expects: base, breadth, int_eff, total_adj, final) =====
  const aBase    = (typeof a.mi_base === 'number')      ? a.mi_base      : baseA;
  const bBase    = (typeof b.mi_base === 'number')      ? b.mi_base      : baseB;

  // Keep these legacy components (safe no-ops if DOM doesn't have them)
  const aIntRaw  = (typeof a.mi_int_raw === 'number')   ? a.mi_int_raw   : (interactions?.a ?? 0);
  const bIntRaw  = (typeof b.mi_int_raw === 'number')   ? b.mi_int_raw   : (interactions?.b ?? 0);

  const aRFact   = (typeof a.mi_int_rFact === 'number') ? a.mi_int_rFact : null;
  const bRFact   = (typeof b.mi_int_rFact === 'number') ? b.mi_int_rFact : null;

  const aIntEff  = (typeof a.mi_int === 'number')       ? a.mi_int       : (interactions?.a ?? 0);
  const bIntEff  = (typeof b.mi_int === 'number')       ? b.mi_int       : (interactions?.b ?? 0);

  // Breadth bonus is stored on team objects as `breadth` in this codebase
  const aBreadth = (typeof a.breadth === 'number') ? a.breadth
                 : (typeof a.mi_breadth === 'number') ? a.mi_breadth
                 : 0;

  const bBreadth = (typeof b.breadth === 'number') ? b.breadth
                 : (typeof b.mi_breadth === 'number') ? b.mi_breadth
                 : 0;

  const aFinal   = (typeof a.mi_matchup === 'number')   ? a.mi_matchup   : miA;
  const bFinal   = (typeof b.mi_matchup === 'number')   ? b.mi_matchup   : miB;

  // Total adjustment should reflect whatever the engine actually applied.
  // Best: compute it from final - base (captures breadth + any effective matchup effects).
  const aTotalAdj = (typeof aFinal === 'number' && typeof aBase === 'number') ? (aFinal - aBase) : (aBreadth + aIntEff);
  const bTotalAdj = (typeof bFinal === 'number' && typeof bBase === 'number') ? (bFinal - bBase) : (bBreadth + bIntEff);

  // Fill required synthesis slots
  setSummaryValue('a.base',      fmt(aBase, 3));
  setSummaryValue('b.base',      fmt(bBase, 3));

  setSummaryValue('a.breadth',   fmt(aBreadth, 3));
  setSummaryValue('b.breadth',   fmt(bBreadth, 3));

  setSummaryValue('a.int_eff',   fmt(aIntEff, 3));
  setSummaryValue('b.int_eff',   fmt(bIntEff, 3));

  setSummaryValue('a.total_adj', fmt(aTotalAdj, 3));
  setSummaryValue('b.total_adj', fmt(bTotalAdj, 3));

  setSummaryValue('a.final',     fmt(aFinal, 3));
  setSummaryValue('b.final',     fmt(bFinal, 3));

  // Keep legacy keys populated if they still exist somewhere in DOM (harmless)
  setSummaryValue('a.int_raw', fmt(aIntRaw, 3));
  setSummaryValue('b.int_raw', fmt(bIntRaw, 3));
  setSummaryValue('a.rFact',   (aRFact == null ? '—' : fmt(aRFact, 3)));
  setSummaryValue('b.rFact',   (bRFact == null ? '—' : fmt(bRFact, 3)));

  // MI Δ (new bottom-center slot)
  setSummaryValue('gap.sep', sepText);

  // ===== NEW CENTER NARRATIVE: #summarySynLean uses JSON template, with leanText fallback =====
  const synLeanEl = document.getElementById('summarySynLean');
  if (synLeanEl) {
    const tpl =
      (copy.summary && copy.summary.synthesis && copy.summary.synthesis.syn_lean)
        ? copy.summary.synthesis.syn_lean
        : '';

    const rendered = clean(renderTpl(tpl, tokens));
    // If template is blank or not yet written, fall back to the computed lean text.
    synLeanEl.textContent = rendered || (leanText || '');
  }

  // ===== GAP ATTRIBUTION (numbers exist, but interpretation leads) =====
  const baseGap = aBase - bBase;
  const shift   = aIntEff - bIntEff;
  const netGap  = diff;

  setSummaryValue('gap.baseline', fmt(baseGap, 3));
  setSummaryValue('gap.shift',    fmt(shift, 3));
  setSummaryValue('gap.net',      fmt(netGap, 3));

  // NEW CENTER STRUCTURE (legacy-safe if those nodes no longer exist)
  const bandPillText =
    (diff === 0)
      ? 'NO CLEAR EDGE'
      : `${winName} HOLDS THE EDGE`;

  setSummaryValue('gap.band', bandPillText);

  const separationNote =
    bandDesc
      ? bandDesc
      : (diff === 0 ? 'Minimal separation — treat this as high-variance.' : `Model separation: ${sepText.replace('~','')} points.`);

  setSummaryValue('gap.net_note', separationNote);

  const micro =
    (diff === 0)
      ? ''
      : `${(bandLabel ? bandLabel + ' — ' : '')}${winName} over ${loseName}`;

  setSummaryValue('gap.micro', micro);

  // Driver notes in plain English
  const baselineNote =
    (baseGap === 0)
      ? 'Profiles start closely matched before opponent effects.'
      : `${baseGap > 0 ? a.name : b.name} looks stronger on baseline profile strength.`;

  const shiftNote =
    (shift === 0)
      ? 'Matchup interactions do not meaningfully change the baseline picture.'
      : `Matchup interactions ${Math.sign(shift) === Math.sign(diff) ? 'reinforce' : 'push against'} the edge.`;

  let resumeDriver = 'Résumé scaling informs how much trust to place in the matchup effects.';
  if (aRFact != null && bRFact != null) {
    if (Math.abs(aRFact - bRFact) < 0.02) {
      resumeDriver = 'Résumé scaling is similar on both sides — reliability is comparable.';
    } else {
      resumeDriver = `${(aRFact > bRFact) ? a.name : b.name} carries the stronger résumé multiplier.`;
    }
  }

  setSummaryValue('gap.baseline_note', baselineNote);
  setSummaryValue('gap.shift_note', shiftNote);
  setSummaryValue('gap.net_note2', resumeDriver);

  // If any legacy keys still exist in DOM, blank them to prevent confusing leakage
  setSummaryValue('gap.baseline_dir', '');
  setSummaryValue('gap.shift_dir', '');
  setSummaryValue('gap.net_dir', '');

  // ===== Center: kicker text (optional — safe cosmetic) =====
  const gapKickerEl = document.querySelector('#summaryGapAttribution .summary-mid-kicker');
  if (gapKickerEl) {
    gapKickerEl.textContent = (diff === 0) ? 'Why the model keeps this close' : 'Why the model leans this way';
  }

  // ===== Synthesis / Stitch Tag (deterministic) =====
  const stitchCopy = (summaryCopy && summaryCopy.stitch) ? summaryCopy.stitch : {};

  const EPS  = (typeof stitchCopy.eps === 'number')  ? stitchCopy.eps  : 0.001;
  const SOFT = (typeof stitchCopy.soft === 'number') ? stitchCopy.soft : 0.20;

  const sgn = (x) => (Math.abs(x) < EPS ? 0 : (x > 0 ? 1 : -1));

  const sBase = sgn(baseGap);
  const sNet  = sgn(netGap);
  const sShft = sgn(shift);

  let stitchKey = 'confirmed';

  if (sNet === 0) {
    stitchKey = 'deadlock';
  } else if (sBase !== 0 && sBase !== sNet) {
    stitchKey = 'redirected';
  } else {
    if (Math.abs(shift) < SOFT) {
      stitchKey = 'confirmed';
    } else if (sShft === sNet) {
      stitchKey = 'reinforced';
    } else if (sShft !== 0 && sShft !== sNet) {
      stitchKey = 'resisted';
    } else {
      stitchKey = 'confirmed';
    }
  }

  const stitchLabel =
    stitchCopy[stitchKey] ||
    (copy.summary && copy.summary.stitch && copy.summary.stitch[stitchKey]) ||
    stitchKey;

  // Do not show internal stitch labels in center UI
  setSummaryValue('stitch.label', '');

  const howToRead =
    (diff === 0)
      ? 'Minimal separation suggests a true toss-up — treat this as highly volatile.'
      : 'A strong edge reflects clearer separation between profiles — not a guaranteed outcome.';

  setSummaryValue('stitch.note', howToRead);

  const stitchKickerEl = document.querySelector('#summaryStitchTag .summary-mid-kicker');
  if (stitchKickerEl) stitchKickerEl.textContent = 'How to read this';

  // ===== VERDICT SHELL (single-source; no duplicate blocks) =====
  const verdictShellEl = document.getElementById('verdictShell');
  const verdictInner   = document.querySelector('#verdictShell .mi-verdict-shell-inner');

  if (verdictShellEl) {
    const winnerRole = (diff === 0)
      ? 'neutral'
      : (diff > 0 ? 'cinderella' : 'favorite');

    const tier = edgeTier;
    const roundCode = round || CURRENT_ROUND || 'R64';

    let lensKey = (winnerRole === 'neutral') ? 'neutral_mirror' : winnerRole;

    if (typeof resolveIdentityContext === 'function') {
      const ctx = resolveIdentityContext(a, b, roundCode);
      if (ctx && (ctx.mode === 'chalk_mirror' || ctx.mode === 'chaos_mirror' || ctx.mode === 'neutral_mirror')) {
        lensKey = ctx.mode;
      }
    }

    verdictShellEl.setAttribute('data-lens', lensKey);
    if (summarySection) summarySection.setAttribute('data-lens', lensKey);

    // ===== SIDE ROLE ATTRS for Score Synthesis (A/B tint) =====
    // Mirrors tint both sides the same. Standard matchups tint A/B as Cinderella/Favorite.
    if (summarySection) {
      let sideA = '';
      let sideB = '';

      // If identity resolver says mirror, both sides share the mirror token
      if (lensKey === 'chalk_mirror' || lensKey === 'chaos_mirror' || lensKey === 'neutral_mirror') {
        sideA = lensKey;
        sideB = lensKey;
      } else {
        // Standard: determine which TEAM is Cinderella vs Favorite in this matchup
        // In this codebase, diff > 0 means Team A is the winner and labeled Cinderella (per your existing logic).
        // Keep it consistent with winnerRole mapping above.
        const aIsCinderella = (diff > 0);
        sideA = aIsCinderella ? 'cinderella' : 'favorite';
        sideB = aIsCinderella ? 'favorite' : 'cinderella';

        // Neutral (diff === 0): keep both neutral-mirror so the table doesn't shout
        if (diff === 0) {
          sideA = 'neutral_mirror';
          sideB = 'neutral_mirror';
        }
      }

      summarySection.setAttribute('data-side-a', sideA);
      summarySection.setAttribute('data-side-b', sideB);
    }

    const analysisShellEl = document.getElementById('analysisShell');
    if (analysisShellEl) analysisShellEl.setAttribute('data-lens', lensKey);

    verdictShellEl.classList.remove(
      'mi-winner-cinderella', 'mi-winner-favorite', 'mi-winner-neutral',
      'mi-lean-coin', 'mi-lean-slight', 'mi-lean-solid', 'mi-lean-heavy',
      'mi-verdict-hit'
    );

    verdictShellEl.classList.add(`mi-winner-${winnerRole}`);
    verdictShellEl.classList.add(`mi-lean-${tier}`);

    verdictShellEl.classList.remove('hidden');

    verdictShellEl.classList.add('mi-verdict-hit');
    window.setTimeout(() => verdictShellEl.classList.remove('mi-verdict-hit'), 1100);
  }

  // ===== Primary + Secondary verdict line (JSON-driven; gap-band-aware) =====
  const primaryCfg = metricsCfg.primary_text;

  let primaryTpl = "";
  if (typeof primaryCfg === "string") {
    primaryTpl = primaryCfg;
  } else if (primaryCfg && typeof primaryCfg === "object") {
    const bucket = (primaryCfg[gapKey] != null) ? primaryCfg[gapKey] : primaryCfg.default;
    if (Array.isArray(bucket)) primaryTpl = pickOne(bucket);
    else if (typeof bucket === "string") primaryTpl = bucket;
  }

  const primaryText = renderTpl(primaryTpl, tokens).trim();

  const secondaryCfg = metricsCfg.secondary_text;

  let secondaryTpl = "";
  if (typeof secondaryCfg === "string") {
    secondaryTpl = secondaryCfg;
  } else if (secondaryCfg && typeof secondaryCfg === "object") {
    const bucket = (secondaryCfg[gapKey] != null) ? secondaryCfg[gapKey] : secondaryCfg.default;
    if (Array.isArray(bucket)) secondaryTpl = pickOne(bucket);
    else if (typeof bucket === "string") secondaryTpl = bucket;
  }

  const secondaryText = renderTpl(secondaryTpl, tokens).trim();

  const combinedVerdict = [primaryText, secondaryText].filter(Boolean).join(' ');

  const lineEl = document.getElementById('miVerdictLine');
  if (lineEl) {
    lineEl.classList.remove('is-structured');
    lineEl.textContent = combinedVerdict || (leanText || '');
    enhanceVerdictPresentation();
  }

  const whyEl = document.getElementById('miVerdictWhy');
  if (whyEl) {
    const parts = [];
    if (confidenceLabelText && confidenceBand) parts.push(`${confidenceLabelText}: ${confidenceBand}`);
    if (driverLabelText && driverText)        parts.push(`${driverLabelText}: ${driverText}`);
    if (!parts.length && driverText)          parts.push(driverText);
    whyEl.textContent = parts.join(' • ');
  }

  const watchEl = document.getElementById('miVerdictWatch');
  if (watchEl) {
    const parts = [];
    if (riskLabelText && riskText) parts.push(`${riskLabelText}: ${riskText}`);
    if (!parts.length) parts.push(riskText || supportText || '');
    watchEl.textContent = parts.join(' • ');
  }

  const gapTop = document.getElementById('miVerdictGapTop');
  if (gapTop) gapTop.textContent = fmt(diff, 2);

  // ===== Scorebug (rail): team names + base / matchup MI =====
  const sbA = document.getElementById('miScorebugTeamA');
  const sbB = document.getElementById('miScorebugTeamB');
  if (sbA) sbA.textContent = a.name;
  if (sbB) sbB.textContent = b.name;

  const sbBaseA  = document.getElementById('miScorebugBaseA');
  const sbBaseB  = document.getElementById('miScorebugBaseB');
  const sbMatchA = document.getElementById('miScorebugMatchA');
  const sbMatchB = document.getElementById('miScorebugMatchB');

  if (sbBaseA)  sbBaseA.textContent  = fmt(baseA, 2);
  if (sbBaseB)  sbBaseB.textContent  = fmt(baseB, 2);
  if (sbMatchA) sbMatchA.textContent = fmt(miA, 2);
  if (sbMatchB) sbMatchB.textContent = fmt(miB, 2);

  const scoreBox = document.querySelector('#verdictShell .mi-scorebug-score');
  if (scoreBox) {
    scoreBox.classList.add('mi-nums-pop');
    window.setTimeout(() => scoreBox.classList.remove('mi-nums-pop'), 220);
  }

  // Always enforce verdict-first post-matchup structure after each run
  if (typeof resetPostMatchupDefaultView === 'function') {
    resetPostMatchupDefaultView();
  }

  // ----- Round pill -----
  const roundSpan = document.getElementById('currentRoundLabel');
  if (roundSpan) {
    roundSpan.textContent = getRoundLabelFromCode(round || CURRENT_ROUND);
  }

  miUpdateMatchupRoundPill(round || CURRENT_ROUND);

  // Legacy spans (safe no-ops if not present)
  const miASpan  = document.getElementById('miA');
  const miBSpan  = document.getElementById('miB');
  const predSpan = document.getElementById('predictedWinner');

  if (miASpan)  miASpan.textContent  = miA.toFixed(3);
  if (miBSpan)  miBSpan.textContent  = miB.toFixed(3);
  if (predSpan) predSpan.textContent = predictedLabel ? `${predicted}` : `${predicted}`;

  if (summarySection) {
    summarySection.classList.add('visible');
  }

  // ----- Seed / bracket compatibility note -----
  const seedNoteEl = document.getElementById('summarySeedNote');
  if (seedNoteEl && seedMeta && typeof a.seed === 'number' && typeof b.seed === 'number') {
    const { seedA, seedB, possible, isAllowed, earliest } = seedMeta;

    const friendlyRounds = possible.map(getRoundLabelFromCode);
    const currentLabel   = getRoundLabelFromCode(round || CURRENT_ROUND);
    const earliestLabel  = earliest ? getRoundLabelFromCode(earliest) : null;

    if (!possible.length) {
      seedNoteEl.textContent = '';
    } else if (isAllowed) {
      seedNoteEl.textContent =
        `Bracket note: As seeds ${seedA} and ${seedB}, these teams ` +
        `can meet in ${friendlyRounds.join(', ')}. ` +
        `${currentLabel} is a valid meeting round.`;
    } else {
      seedNoteEl.textContent =
        `Bracket note: As seeds ${seedA} and ${seedB}, these teams ` +
        `can meet in ${friendlyRounds.join(', ')}. ` +
        `${currentLabel} is *not* a valid meeting round in a standard 64-team bracket.`;
    }
  }
}

function renderInteractionsTable(result) {
  const table = document.getElementById('interactionsTable');
  const totalsBar = document.getElementById('interactionTotalsBar');
  if (!table) return;

  // ==== Full canonical interaction list (ALWAYS displayed) ====
  const ORDER = [
    '3pt', 'ft', 'paint', 'to', 'glass', 'resume', 'phys', 'shotq', 'var'
  ];

  const LABEL = {
    '3pt':   '3PT Tension',
    'ft':    'FT Pressure',
    'paint': 'Paint Tension',
    'to':    'Turnover Pressure',
    'glass': 'Glass Tension',
    'resume':'Résumé Pressure',
    'phys':  'Physicality Tolerance',
    'shotq': 'Shot Discipline',
    'var':   'Variance Sensitivity',
  };

  const intensityLabel = (val) => {
    const x = Math.abs(val);
    if (x >= 0.50) return 'Major';
    if (x >= 0.25) return 'Moderate';
    return 'Minor';
  };

  // ===== Team names (robust fallback) =====
  const aName = result?.a?.name || result?.teamA?.name || result?.a?.team || "Team A";
  const bName = result?.b?.name || result?.teamB?.name || result?.b?.team || "Team B";

  // ===== Update table headers =====
  const adjAHeader = document.getElementById("adjAHeader");
  const adjBHeader = document.getElementById("adjBHeader");
  if (adjAHeader) adjAHeader.textContent = `Adj to ${aName}`;
  if (adjBHeader) adjBHeader.textContent = `Adj to ${bName}`;

  const breakdown = result.interactions?.breakdown || {};
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";

  // ===== Always render ALL interactions =====
  ORDER.forEach((key, i) => {
    const raw = breakdown[key];   // may be undefined, numeric, or object
    let aAdj = 0, bAdj = 0, edgeText = 'EVEN';

    if (typeof raw === 'number') {
      aAdj = raw;
      bAdj = -raw;
      if (raw > 0) edgeText = `FAVORS ${aName}`;
      else if (raw < 0) edgeText = `FAVORS ${bName}`;
    }
    else if (raw && typeof raw === 'object') {
      aAdj = raw.aAdj ?? 0;
      bAdj = raw.bAdj ?? 0;
      edgeText = raw.edge || 'EVEN';
    }

    const intensity = intensityLabel(aAdj);

    let pillClass = 'int-edge-even';
    if (aAdj > 0) pillClass = 'int-edge-A';
    if (aAdj < 0) pillClass = 'int-edge-B';

    const rowClass = i % 2 === 0 ? "int-row-even" : "int-row-odd";

    tbody.innerHTML += `
      <tr class="${rowClass}" data-int-key="${key}">
        <td class="int-name">${LABEL[key]}</td>
        <td class="int-edge"><span class="int-edge-pill ${pillClass}">${edgeText}</span></td>
        <td class="col-intensity">${intensity}</td>
        <td class="int-adj ${aAdj >= 0 ? 'pos' : 'neg'}">${fmt(aAdj, 3)}</td>
        <td class="int-adj ${bAdj >= 0 ? 'pos' : 'neg'}">${fmt(bAdj, 3)}</td>
      </tr>
    `;
  });

  // ===== Totals Bar =====
  const totalA = result.interactions?.a || 0;
  const totalB = result.interactions?.b || 0;

  if (totalsBar) {
    const favored =
      totalA > totalB ? aName :
      totalB > totalA ? bName :
      'EVEN';

    totalsBar.innerHTML = `
      <div class="totals-left">
        <div class="totals-title">Total Interaction Leverage</div>
        <div class="totals-favored">FAVORS <span>${favored}</span></div>
      </div>
      <div class="totals-right">
        <div class="totals-val ${totalA >= 0 ? 'pos' : 'neg'}">${fmt(totalA, 3)}</div>
        <div class="totals-sep">/</div>
        <div class="totals-val ${totalB >= 0 ? 'pos' : 'neg'}">${fmt(totalB, 3)}</div>
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
  '3pt':   'three_pt_tension',
  'ft':    'ft_pressure',
  'paint': 'paint_tension',
  'to':    'turnover_pressure',
  'glass': 'glass_tension',
  'phys':  'physicality_tolerance',
  'shotq': 'shot_discipline',
  'var':   'variance_sensitivity'
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
    threshold === 'minor' ||
    (threshold === 'moderate' && (s === 'moderate' || s === 'major')) ||
    (threshold === 'major' && s === 'major');

  if (meetsThreshold) pairs = Math.max(pairs, 2);

  // Even interactions: keep them single-line unless they’re also a true driver
  if (card.case === 'even' && !(isTopDriver && s !== 'none')) pairs = 1;

  return Math.max(1, Math.min(2, pairs));
}

/**
 * Interaction Console (right tile)
 * Renders ALL 9 interaction channels in a fixed order.
 * - No "TOP" chips.
 * - Safe fallbacks if a channel is missing narrative text (prevents blank cards like PHYS).
 */
function renderInteractionsConsole(result) {
  const host = document.getElementById('interactionConsoleBody');
  if (!host) return;

  // Your interactions object is keyed directly (threept, ft, paint, tov, glass, resume, phys, shotq, var)
  const breakdown = result?.interactions?.breakdown || null;

    // Pre-matchup / missing data
    if (!breakdown) {
    host.innerHTML = `
      <div class="int-console-card is-placeholder">
        <div class="int-console-label">Ready</div>
        <div class="int-console-text">
          Run a matchup to populate these interaction descriptions.
        </div>
      </div>
    `;
    return;
  }

  // Map JS interaction keys -> MI_COPY interactions_console channel keys
  const KEYMAP = {
    threept: "three_pt_tension",
    ft: "ft_pressure",
    paint: "paint_tension",
    tov: "turnover_pressure",
    glass: "glass_tension",
    phys: "physicality_tolerance",
    shotq: "shot_discipline",
    var: "variance_sensitivity",
  };

  // Console keys -> breakdown keys (must match interactions table)
  const BREAKDOWN_KEY = {
    threept: "3pt",
    ft: "ft",
    paint: "paint",
    tov: "to",
    glass: "glass",
    phys: "phys",
    shotq: "shotq",
    var: "var",
  };

  const ORDER = [
    { key: "threept", fallbackLabel: "3PT Tension" },
    { key: "ft", fallbackLabel: "FT Pressure" },
    { key: "paint", fallbackLabel: "Paint Tension" },
    { key: "tov", fallbackLabel: "Turnover Pressure" },
    { key: "glass", fallbackLabel: "Glass Tension" },
    { key: "phys", fallbackLabel: "Physicality Tolerance" },
    { key: "shotq", fallbackLabel: "Shot Discipline" },
    { key: "var", fallbackLabel: "Variance Sensitivity" },
  ];

  const copyRoot = window.MI_COPY && window.MI_COPY.interactions_console ? window.MI_COPY.interactions_console : null;

  // helper: random pick from array
  const pick = (arr) => (Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : "");

  host.innerHTML = "";

  ORDER.forEach(({ key, fallbackLabel }) => {
    // Always render the card, even if a channel is missing (prevents “only 5 show up” confusion)
    const longKey = KEYMAP[key];
    const copyCh = copyRoot && copyRoot.channels ? copyRoot.channels[longKey] : null;

    // Title: prefer JSON label, else fallback
    const title = (copyCh && copyCh.label) ? copyCh.label : fallbackLabel;

    // Pull the interaction adjustment from the SAME source as the table
    const bKey = BREAKDOWN_KEY[key];
    const raw = breakdown?.[bKey];

    // Determine case from adjustment (fallback to even)
    let aAdj = 0;
    if (typeof raw === "number") aAdj = raw;
    else if (raw && typeof raw === "object") aAdj = Number(raw.aAdj ?? 0);

    // Determine edge from the same sign logic the pill uses
    const edge =
      aAdj > 0 ? "A" :
      aAdj < 0 ? "B" :
      "EVEN";

    // Console case must match the pill edge (prevents inverted miCaseFor behavior)
    const resolvedCaseKey =
      edge === "A" ? "a_adv" :
      edge === "B" ? "b_adv" :
      "even";

    // Pull sentence pools from JSON (supports both schemas)
    const caseObj = copyCh?.cases?.[resolvedCaseKey] || null;

    const pools =
      caseObj?.sentence_sets?.primary ||
      caseObj?.primary ||
      null;

    const aName = result?.a?.name || result?.teamA?.name || result?.a?.team || "Team A";
    const bName = result?.b?.name || result?.teamB?.name || result?.b?.team || "Team B";

    const line1 = pools ? miFillTeamTokens(pick(pools.s1), aName, bName) : "";
    const line2 = pools ? miFillTeamTokens(pick(pools.s2), aName, bName) : "";

    // Always render as ONE paragraph per card
    const text = [line1, line2].filter(Boolean).join(" ");

    const card = document.createElement("div");
    card.className = "int-console-card";
    card.dataset.intKey = BREAKDOWN_KEY[key];
    const labelEl = document.createElement("div");
    labelEl.className = "int-console-label";

    /* Title */
    const titleSpan = document.createElement("span");
    titleSpan.textContent = title.toUpperCase();

    const pill = document.createElement("span");
    pill.classList.add("int-edge-pill");

    if (edge === "A") {
      pill.classList.add("int-edge-A");
      pill.textContent = `FAVORS ${aName}`;
    } else if (edge === "B") {
      pill.classList.add("int-edge-B");
      pill.textContent = `FAVORS ${bName}`;
    } else {
      pill.classList.add("int-edge-even"); // if your CSS uses this
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

/* --------------------------
   Table ↔ Console spotlight sync
   -------------------------- */

function clearInteractionConsoleSpotlight() {
  const body = document.getElementById('interactionConsoleBody');
  if (!body) return;

  body.querySelectorAll('.int-console-card.is-active').forEach(el => el.classList.remove('is-active'));

  const table = document.getElementById('interactionsTable');
  if (table) {
    table.querySelectorAll('tbody tr.is-console-active').forEach(tr => tr.classList.remove('is-console-active'));
  }
}

function spotlightInteractionConsole(key) {
  if (!key) return;

  const body = document.getElementById('interactionConsoleBody');
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
  if (!table) return;

  const tbody = table.querySelector('tbody');
  if (!tbody) return;

  // hover (desktop)
  tbody.addEventListener('mouseover', (e) => {
    const tr = e.target.closest('tr[data-int-key]');
    if (!tr) return;
    spotlightInteractionConsole(tr.dataset.intKey);
  });

  tbody.addEventListener('mouseout', (e) => {
    // If leaving the tbody entirely, clear
    const related = e.relatedTarget;
    if (related && tbody.contains(related)) return;
    clearInteractionConsoleSpotlight();
  });

  // tap/click (mobile-safe)
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-int-key]');
    if (!tr) return;

    const key = tr.dataset.intKey;
    const body = document.getElementById('interactionConsoleBody');
    const active = body?.querySelector(`.int-console-card.is-active[data-int-key="${key}"]`);

    if (active) {
      clearInteractionConsoleSpotlight();
      return;
    }

    spotlightInteractionConsole(key);

    // auto-clear after a moment so it doesn’t “stick” forever on mobile
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

    "Turnover Fragility — Moderate": "badge_turnover_fragility_moderate.svg",
    "Turnover Fragility — Severe":   "badge_turnover_fragility_severe.svg",
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

function enterMatchupQuickEdit() {
  const matchupBar = document.getElementById('matchupBar');
  if (!matchupBar) return;

  const slotA = document.getElementById('matchupQuickA');
  const slotB = document.getElementById('matchupQuickB');
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
  slotR.setAttribute('aria-hidden', 'false');

  ensureQuickEditSandboxToggle();

  // Show actions container
  const actions = matchupBar.querySelector('.matchup-quick-actions');
  if (actions) {
    actions.setAttribute('aria-hidden', 'false');
    actions.inert = false;
  }

  // Move existing controls into the bar
  slotA.appendChild(aWrap);
  slotR.appendChild(rWrap);
  slotB.appendChild(bWrap);

  // Focus Team A for speed
  const teamASelect = document.getElementById('teamA');
  if (teamASelect) teamASelect.focus();
}

function exitMatchupQuickEdit() {
  const matchupBar = document.getElementById('matchupBar');
  if (!matchupBar) return;

  const slotA = document.getElementById('matchupQuickA');
  const slotB = document.getElementById('matchupQuickB');
  const slotR = document.getElementById('matchupQuickRound');

  const actions = matchupBar.querySelector('.matchup-quick-actions');

  // --- A11y: don't aria-hide a region while a descendant still has focus ---
  const active = document.activeElement;
  const focusIsInside =
    !!active &&
    (
      (actions && actions.contains(active)) ||
      (slotA && slotA.contains(active)) ||
      (slotB && slotB.contains(active)) ||
      (slotR && slotR.contains(active))
    );

  if (focusIsInside) {
    // Prefer to focus a stable, always-visible control outside quick-edit regions.
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

  // Now it's safe to hide/toggle editing state
  matchupBar.classList.remove('is-editing');
  slotA?.setAttribute('aria-hidden', 'true');
  slotB?.setAttribute('aria-hidden', 'true');
  slotR?.setAttribute('aria-hidden', 'true');

  if (actions) {
    actions.setAttribute('aria-hidden', 'true');
    actions.inert = true;
  }

  const aWrap = document.getElementById('teamASelectWrap');
  const bWrap = document.getElementById('teamBSelectWrap');
  const rWrap = document.getElementById('roundSelectorWrap');

  if (__MI_QUICK_EDIT_HOME && aWrap && bWrap && rWrap) {
    const { aParent, bParent, rParent, aNext, bNext, rNext } = __MI_QUICK_EDIT_HOME;
    aParent?.insertBefore(aWrap, aNext || null);
    bParent?.insertBefore(bWrap, bNext || null);
    rParent?.insertBefore(rWrap, rNext || null);
  }

  // Close round dropdown if open (avoids weird floating menu)
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

function renderCoreProfileTable(team, tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;

  const rows = team.coreDetails || [];
  if (!rows.length) {
    table.innerHTML = `
      <thead>
        <tr class="table-header">
          <th>Category</th>
          <th>Thresholds</th>
          <th>Team Value</th>
          <th>Tier</th>
          <th>Points Given</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td colspan="5">No core trait data.</td>
        </tr>
      </tbody>
    `;
    return;
  }

  const header = `
    <thead>
      <tr class="table-header">
        <th>Category</th>
        <th>Thresholds</th>
        <th>Team Value</th>
        <th>Tier</th>
        <th>Points Given</th>
      </tr>
    </thead>
  `;

  const bodyRows = rows.map(r => {
    const tierClass = r.tier
      ? `tier-${r.tier.replace(/[\s/]+/g, '')}`   // e.g. "Slightly Above / Average" -> "tier-SlightlyAboveAverage"
      : '';

    return `
      <tr>
        <td>${r.label}</td>
        <td>Mean = ${fmt(r.mean, 3)}<br/>SD = ${fmt(r.sd, 3)}</td>
        <td class="metric-block">${fmt(r.value, 3)}</td>
        <td class="metric-block ${tierClass}">${r.tier}</td>
        <td class="metric-block">${fmt(r.points, 3)}</td>
      </tr>
    `;
  }).join('');

  const hits    = team.breadthHits != null ? team.breadthHits : 0;
  const breadth = team.breadth     != null ? team.breadth     : 0;

  const brConfig = window.MI_COPY?.core_profile?.breadth_row || {};
  const thresholdText =
    brConfig.threshold_text ||
    "Bonus scales with total 'hits' across Efficiency, Shooting, Possession, Tempo";
  const tierText =
    brConfig.tier_text ||
    "Tier placement skipped";

  const breadthRow = `
    <tr class="breadth-row">
      <td>Breadth Bonus</td>
      <td>${thresholdText}</td>
      <td>${hits} hits</td>
      <td>${tierText}</td>
      <td>${fmt(breadth, 3)}</td>
    </tr>
  `;

  table.innerHTML = header + `<tbody>` + bodyRows + breadthRow + `</tbody>`;
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
  const breadthScore = team.breadth ?? 0;
  const resumeScore  = team.resumeR ?? 0;
  const resumeTier   = team.resumeRTier || 'Average';

  const marks = Array.isArray(team.profileMarks) ? team.profileMarks : [];
  const severeCount   = marks.filter(m => m.includes('Severe')).length;
  const moderateCount = marks.filter(m => m.includes('Moderate')).length;

  // If you have interactions labeled with swings, grab top 1–2
  const intSide = isA ? result.interactions.a : result.interactions.b;
  const topInts = (intSide?.details || [])
    .slice()
    .sort((x, y) => Math.abs(y.points) - Math.abs(x.points))
    .slice(0, 2);

  // Opponent context (seed / MI gap etc if you want)
  const oppSeed = opponent?.seed;
  const mySeed  = team?.seed;

  // Build short clauses
  const coreClause = (strongest && weakest)
    ? `${strongest.label} is the main edge, while ${weakest.label} is the soft spot.`
    : `Core Traits show this team’s main statistical shape.`;

  const breadthClause = (breadthScore > 0)
    ? `${breadthHits} Above-Average hits earn a Breadth Bonus of +${fmt(breadthScore,3)}.`
    : `Breadth is neutral — strengths are concentrated rather than spread out.`;

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

  const titleEl           = document.getElementById(isA ? 'teamATitle'    : 'teamBTitle');
  const seedEl            = document.getElementById(isA ? 'teamASeed'     : 'teamBSeed');
  const profileSubtotalEl = document.getElementById(isA ? 'cindSubtotalA' : 'favSubtotalB');
  const teamTotalEl       = document.getElementById(isA ? 'teamTotalA'    : 'teamTotalB');
  const coreTableId       = isA ? 'cindProfileTableA' : 'favProfileTableB';
  const neutralTableId    = isA ? 'neutralTableA'     : 'neutralTableB';
  const neutralSubtotalId = isA ? 'neutralSubtotalA'  : 'neutralSubtotalB';

  const core     = team.mibs    || 0;
  const breadth  = team.breadth || 0;
  const resume   = team.resumeR || 0;
  const opponent = isA ? result.b : result.a;

  // Baseline profile subtotal and MI_base
  const profileSubtotal = core + breadth;

  const miBase = (typeof team.mi_base === 'number')
    ? team.mi_base
    : computeMIBase(team);

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
    profileSubtotalEl.textContent = fmt(profileSubtotal, 3);
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
  // Résumé context mini-tile
  // =========================
  const resumeTile    = document.getElementById(isA ? 'resumeTileA' : 'resumeTileB');
  const resumeAdjEl   = document.getElementById(isA ? 'resumeAdjA'  : 'resumeAdjB');
  const resumeTierEl  = document.getElementById(isA ? 'resumeTierA' : 'resumeTierB');
  const backResumeEl  = document.getElementById(isA ? 'backResumeTileA' : 'backResumeTileB');

  if (resumeTile && resumeAdjEl && resumeTierEl) {
    // Determine tier label (prefer precomputed on team if present)
    let tier = team.resumeRTier;

    if (!tier) {
      const tierRules = miGetCopy('resume_tile_ui.tier_rules', null);

      if (Array.isArray(tierRules) && tierRules.length) {
        // IMPORTANT: assumes tier_rules sorted high->low by "min"
        const hit = tierRules.find(r => typeof r.min === 'number' && resume >= r.min);
        tier = hit?.label || 'Average';
      } else {
        // Fallback heuristics
        tier =
          (resume >= 0.10 ? 'Strong' :
           resume >= 0.05 ? 'Above Average' :
           resume <= -0.10 ? 'Fragile' :
           resume <= -0.05 ? 'Weak' : 'Average');
      }
    }

    // FRONT: show tier in the big score spot
    resumeAdjEl.textContent = tier;

    // Optional: keep numeric resume on hover for debugging
    resumeAdjEl.setAttribute('title', `Résumé Context: ${fmt(resume, 3)}`);

    // Hide/remove tier subrow text for now (since tier is displayed above)
    resumeTierEl.textContent = '';

    // BACK: tier-aware résumé explanation (JSON-driven)
    if (backResumeEl) {
      const tierMap = miGetCopy('back.resume.tier_tile', {}) || {};
      const lines =
        (tier && Array.isArray(tierMap[tier])) ? tierMap[tier]
        : (Array.isArray(tierMap.fallback) ? tierMap.fallback : []);

      const tierText = (lines && lines.length) ? lines.slice(0, 2).join(' ') : '';

      // Combine generic + tier-specific
      backResumeEl.textContent = [tierText].filter(Boolean).join(' ');
    }

    // Reset state + tier classes
    resumeTile.classList.remove(
      'context-positive',
      'context-negative',
      'context-neutral',
      'resume-tier-strong',
      'resume-tier-above',
      'resume-tier-average',
      'resume-tier-weak',
      'resume-tier-fragile'
    );

    // Sign-based state (existing behavior)
    let stateClass = 'context-neutral';
    if (resume > 0.0001) stateClass = 'context-positive';
    else if (resume < -0.0001) stateClass = 'context-negative';

    // Tier-based color class (JSON-driven)
    let tierClass = 'resume-tier-average';
    const tierRules2 = miGetCopy('resume_tile_ui.tier_rules', []);
    if (Array.isArray(tierRules2)) {
      const rule = tierRules2.find(r => r.label === tier);
      if (rule?.class) tierClass = rule.class;
    }

    resumeTile.classList.add(stateClass, tierClass);
  }

  // =========================
  // Identity tile (CIS / FAS / LCI / LFI)
  // =========================
  const identityTile     = document.getElementById(isA ? 'identityTileA'   : 'identityTileB');
  const identityScoreEl  = document.getElementById(isA ? 'identityScoreA'  : 'identityScoreB');
  const identityRoleEl   = document.getElementById(isA ? 'identityRoleA'   : 'identityRoleB');
  const identityDetailEl = document.getElementById(isA ? 'identityDetailA' : 'identityDetailB');
  const backIdentityEl   = document.getElementById(isA ? 'backIdentityA'   : 'backIdentityB');

  if (identityTile && identityScoreEl && identityRoleEl && identityDetailEl) {
    const identityLabelEl = identityTile.querySelector('.context-label');
    const roundCode = result.round || CURRENT_ROUND || "R64";

    // v3.8 identity packet (single source of truth)
    const ctx = resolveIdentityContext(result.a, result.b, roundCode);

    const myRole   = isA ? ctx.roleA   : ctx.roleB;     // "favorite" | "cinderella" | "none"
    const myMetric = isA ? ctx.metricA : ctx.metricB;   // "CIS" | "FAS" | "LCI" | "LFI"
    const myValue  = isA ? ctx.valueA  : ctx.valueB;

    let activeScore = null;
    let label       = 'Mirror';
    let desc        = '';
    let tileClass   = 'identity-neutral';
    let headerText  = 'Tournament Identity';

    const roundLabel = (typeof getRoundLabelFromCode === 'function')
      ? getRoundLabelFromCode(roundCode)
      : roundCode;

    if (ctx.mode === "standard") {
      if (myRole === "favorite") {
        activeScore = myValue;
        label       = 'Favorite';
        tileClass   = 'identity-favorite';
        desc        = `${myMetric}: ${Math.round(myValue)}`;
      } else if (myRole === "cinderella") {
        activeScore = myValue;
        label       = 'Cinderella';
        tileClass   = 'identity-cinderella';
        desc        = `${myMetric}: ${Math.round(myValue)}`;
      } else {
        activeScore = myValue;
        label       = 'Mirror';
        tileClass   = 'identity-neutral';
        desc        = `${myMetric}: ${Math.round(myValue)}`;
      }
      headerText = `Tournament Identity — ${roundLabel}`;
    } else {
      activeScore = myValue;
      label       = 'Mirror';
      tileClass   = 'identity-neutral';

      const subtype =
        (ctx.mode === "neutral_mirror") ? "Neutral Mirror" :
        (ctx.mode === "chalk_mirror")   ? "Chalk Mirror"   :
        (ctx.mode === "chaos_mirror")   ? "Chaos Mirror"   :
                                          "Mirror";

      headerText = `${subtype} — ${roundLabel}`;
      desc = `${myMetric}: ${Math.round(myValue)}`;
    }

    identityScoreEl.textContent = (activeScore != null) ? fmt(activeScore, 1) : '—';
    identityRoleEl.textContent   = label;
    identityDetailEl.textContent = desc;

    if (identityLabelEl) identityLabelEl.textContent = headerText;

    identityTile.classList.remove('identity-favorite', 'identity-cinderella', 'identity-neutral');
    identityTile.classList.add('identity-tile', tileClass);
    identityTile.dataset.identityResolved = "true";

    // Back-of-card identity explanation (uses the same metric actually displayed)
    if (backIdentityEl && window.MI_COPY) {
      const roleForCopy =
        (label === "Favorite")   ? "Favorite" :
        (label === "Cinderella") ? "Cinderella" :
                                   "Neutral";

      const identityTeam = {
        name: team.name,
        identity: {
          CIS_static: (myMetric === "CIS" || myMetric === "LCI") ? myValue : 0,
          FAS_static: (myMetric === "FAS" || myMetric === "LFI") ? myValue : 0
        },
        role: roleForCopy
      };

      const expl = buildIdentityBackTextForTeam(identityTeam, window.MI_COPY);
      backIdentityEl.textContent = expl || '';
    }
  }

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
  return ready;
}

function updatePreMatchupHubProgress() {
  const copy = (window.MI_COPY && window.MI_COPY.prematch && window.MI_COPY.prematch.progress)
    ? window.MI_COPY.prematch.progress
    : null;

  const hub = document.getElementById('preMatchupHub');
  if (!hub) return;

  const els = {
    // progress bar (top)
    statusWrap: document.querySelector('#preHubStatusWrap .pre-hub-status'),
    fill: document.getElementById('preStatusFill'),

    // left “Start a matchup” steps
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

  // ----------------------------
  // State inputs
  // ----------------------------
  const csvLoaded = (typeof isCSVLoaded === 'function')
    ? isCSVLoaded()
    : (Array.isArray(TEAM_LIST) && TEAM_LIST.length > 0);

  const sel = (typeof getSelectedTeams === 'function')
    ? getSelectedTeams()
    : { a: '', b: '', ok: false };

  const hasA = !!sel.a;
  const hasB = !!sel.b && sel.b !== sel.a;
  const teamsOk = !!sel.ok;

  // ✅ Sandbox counts as “round selected”
  const roundChosen = !!SANDBOX_MODE || !!CURRENT_ROUND;

  // ----------------------------
  // Progress %
  // ----------------------------
  let pct = 0;
  if (csvLoaded) pct = 25;
  if (csvLoaded && hasA) pct = 50;
  if (csvLoaded && hasA && hasB) pct = 75;
  if (csvLoaded && teamsOk && roundChosen) pct = 100;

  // Paint progress (class-driven + inline fallback)
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

  // ----------------------------
  // Single-step visibility (LEFT HUB ONLY)
  // Rule: show only the current step
  // 1 until csv loaded
  // 2 until teams ok
  // 3 after teams ok (even if “done”)
  // ----------------------------
  let activeStep = 1;
  if (!csvLoaded) activeStep = 1;
  else if (!teamsOk) activeStep = 2;
  else activeStep = 3;

  const applyHidden = (el, shouldHide) => {
    if (!el) return;
    el.classList.toggle('is-hidden', !!shouldHide);
    el.setAttribute('aria-hidden', shouldHide ? 'true' : 'false');

    // Keep keyboard focus out of hidden steps
    el.querySelectorAll('button, a, input, select, textarea').forEach((node) => {
      node.tabIndex = shouldHide ? -1 : 0;
    });
  };

  applyHidden(els.step1, activeStep !== 1);
  applyHidden(els.step2, activeStep !== 2);
  applyHidden(els.step3, activeStep !== 3);

  if (els.stepsWrap) els.stepsWrap.classList.add('is-single');

  // ----------------------------
  // Step state helper
  // ----------------------------
  const setStepState = (el, state) => {
    if (!el) return;
    el.classList.remove('is-done', 'is-next', 'is-locked');
    el.classList.add(state);
  };

  // ----------------------------
  // Step 1 copy + state
  // ----------------------------
  if (els.t1) els.t1.textContent = (copy && copy.step1_pending) || 'Load tournament data to unlock team selection.';
  if (csvLoaded) {
    setStepState(els.step1, 'is-done');
    if (els.s1) els.s1.textContent = (copy && copy.step1_ready) || 'Field loaded and teams unlocked.';
  } else {
    setStepState(els.step1, 'is-next');
    if (els.s1) els.s1.textContent = (copy && copy.step1_pending) || 'Tournament field not loaded.';
  }

  // ----------------------------
  // Step 2 copy + state
  // ----------------------------
  if (els.t2) {
    if (!hasA) els.t2.textContent = (copy && copy.step2_pending) || 'Select two teams to compare.';
    else if (!hasB) els.t2.textContent = (copy && copy.step2_pending) || 'Select a second team to continue.';
    else els.t2.textContent = (copy && copy.step2_ready) || 'Teams selected.';
  }

  if (!csvLoaded) {
    setStepState(els.step2, 'is-locked');
    if (els.s2) els.s2.textContent = (copy && copy.status_pending) || 'Pending';
  } else if (teamsOk) {
    setStepState(els.step2, 'is-done');
    if (els.s2) els.s2.textContent = (copy && copy.step2_ready) || 'Teams selected. Matchup is queued.';
  } else {
    setStepState(els.step2, 'is-next');
    if (els.s2) els.s2.textContent = (copy && copy.step2_pending) || 'Select two different teams.';
  }

  // ----------------------------
  // Step 3 copy + state
  // ----------------------------
  if (els.t3) {
    els.t3.textContent = roundChosen
      ? ((copy && copy.step3_ready) || 'Ready. Run the comparison to begin analysis.')
      : ((copy && copy.step3_pending) || 'Choose a round, or choose Sandbox Mode to ignore constraints.');
  }

  if (!csvLoaded || !teamsOk) {
    setStepState(els.step3, 'is-locked');
    if (els.s3) els.s3.textContent = (copy && copy.status_pending) || 'Pending';
  } else if (roundChosen) {
    setStepState(els.step3, 'is-done');
    if (els.s3) els.s3.textContent = (copy && copy.step3_ready) || 'Briefing complete. Run Compare when ready.';
  } else {
    setStepState(els.step3, 'is-next');
    if (els.s3) els.s3.textContent = (copy && copy.step3_pending) || 'Choose a round, then run Compare.';
  }

  const step3Num = els.step3 && els.step3.querySelector('.pre-step-num');
  if (step3Num) step3Num.textContent = (teamsOk && roundChosen) ? '4' : '3';
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

  const showAllRounds = ({ resetRound = true } = {}) => {
    roundDropdown.querySelectorAll(".round-option").forEach(opt => {
      opt.style.display = "";
    });

    // ✅ Only reset round selection when NOT in sandbox behavior
    if (resetRound) {
      CURRENT_ROUND = null;
      roundBtn.textContent = "Select Round";
    }

    // ✅ Let the central gate decide (and it now respects SANDBOX_MODE)
    if (typeof refreshCompareButtonState === 'function') {
      refreshCompareButtonState();
    }
  };

  // ✅ Sandbox = no restrictions + no forced round clearing + no forced disable
  if (SANDBOX_MODE) {
    showAllRounds({ resetRound: false });
    return;
  }

  if (!teamAName || !teamBName) {
    showAllRounds();
    return;
  }

  const teamA = getTeamByName(teamAName);
  const teamB = getTeamByName(teamBName);

  if (!teamA || !teamB || teamA.seed == null || teamB.seed == null) {
    showAllRounds();
    return;
  }

  const allowedRounds = new Set(getPossibleRoundsForSeeds(teamA.seed, teamB.seed));

  roundDropdown.querySelectorAll(".round-option").forEach(opt => {
    const code = opt.getAttribute("data-round");
    opt.style.display = allowedRounds.has(code) ? "" : "none";
  });

  // Force user to pick a compatible round (non-sandbox only)
  CURRENT_ROUND = null;
  roundBtn.textContent = "Select Round";
  setCompareButtonEnabled(false);   // reset whenever allowed-round set changes
}


function syncNextHalo(isCsvLoaded) {
  const datasetCard = document.querySelector('.controls-card.is-primary-entry');
  const stepsCard = document.getElementById('matchupSetupCard');

  if (isCsvLoaded) {
    datasetCard?.classList.remove('mi-halo');
    stepsCard?.classList.add('mi-halo');
  } else {
    datasetCard?.classList.add('mi-halo');
    stepsCard?.classList.remove('mi-halo');
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
      if (count > 0) appShell.classList.add('csv-loaded');
      else appShell.classList.remove('csv-loaded');
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
    syncNextHalo(false);
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

function buildCsvTemplateText() {
  // Headers chosen to align with your HEADER_MAP normalizer expectations.
  // (Don’t add extra commas/spaces; keep these stable.)
  const headers = [
    'Team','Seed',
    'Off Eff','Def Eff','Efficiency Margin','True Shooting %','eFG','Tempo','Effective Possession Ratio','TO%',
    'Def. eFG%',
    '% of points from 2','% of points from 3','% of points from FT',
    '3P %','3P Rate','FTR',
    'Extra Scoring Chances Game','Non Blocked 2pt %','ORB %','DRB %','Block %','Steals per possession',
    'Opp Asst Poss','Opp TO Poss','Opp FTA FGA','Opp 3pt %','Opp 3P Rate',
    'FT_PCT',
    'Close game win pct','Wins','Losses','Strength of Schedule'
  ];

  // Header row only (clean template)
  return headers.join(',') + '\n';
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
    datasetSelect.addEventListener('change', () => {
      const url = datasetSelect.value;
      const opt = datasetSelect.options[datasetSelect.selectedIndex];
      const filename = opt?.getAttribute('data-filename') || 'MadnessIndex_Dataset.csv';
      if (!url) return;

      // Load into app immediately
      loadOfficialDatasetFromUrl(url, filename);

      // If a download button exists, update it
      syncDatasetDownloadState();
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

            syncNextHalo(isLoaded);
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
      console.log('[MI] Compare button clicked');

      if (!RAW_ROWS || RAW_ROWS.length === 0) {
        alert('Please load tournament dataset first.');
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

      console.log(
        `[MI] Running compareTeams (auto by seed) ` +
        `Cinderella = ${cinderellaName} Favorite = ${favoriteName}`
      );
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

      console.log("[MI] Round selected:", CURRENT_ROUND);
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
    // Don’t trigger on buttons/links
        if (
          e.target.closest('button') ||
          e.target.closest('a') ||
          e.target.closest('.link-btn')
        ) {
          return;
        }

        e.stopPropagation();
        tile.classList.toggle('flipped');
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
   Glossary Drawer (matchup-only; JSON-driven; deterministic)
   ========================================================= */
(function(){
  const TOC_ORDER = [
    "Verdict Shell",
    "Baseline MI",
    "Matchup MI",
    "Madness Delta",
    "Predicted Winner",
    "Lean Signals",
    "Team Scorecards",
    "Offensive Efficiency",
    "Defensive Efficiency",
    "Efficiency Margin",
    "True Shooting %",
    "Effective FG%",
    "Defensive eFG%",
    "Effective Possession Ratio",
    "Turnover %",
    "Breadth Bonus",
    "Profile Subtotal",
    "Tournament Identities",
    "Cinderella Index (CIS)",
    "Favorite Authority Score (FAS)",
    "Live Cinderella Index (LCI)",
    "Live Favorite Index (LFI)",
    "Résumé Context",
    "Résumé Context Index",
    "Strength of Schedule",
    "Win Percentage",
    "Résumé Tier",
    "Profile Marks",
    "Offensive Rigidity",
    "Unstable Perimeter",
    "Cold Arc Team",
    "Undisciplined Defense",
    "Soft Interior",
    "Perimeter Leakage",
    "Tempo Strain",
    "Interactions",
    "Three-Point Tension",
    "Free Throw Pressure",
    "Paint Tension",
    "Turnover Pressure",
    "Glass Tension",
    "Résumé Pressure",
    "Physicality Tolerance",
    "Shot Discipline",
    "Variance Sensitivity"
  ];

  const state = {
    available: false,
    open: false,
    activeKey: null,
    indexByKey: Object.create(null),
    grouped: null
  };

  function $(id){ return document.getElementById(id); }

  function normalizeKey(term, abbr){
    const t = (term || "").trim();
    const a = (abbr || "").trim();
    return (t + (a ? `|${a}` : "")).toLowerCase();
  }

  function safeCopy(){
    const copy = window.MI_COPY || {};
    const g = copy.glossary || {};
    const title = (typeof g.title === "string" && g.title.trim()) ? g.title.trim() : "Glossary";
    const help  = (typeof g.help === "string"  && g.help.trim())  ? g.help.trim()  : "Definitions for key terms used in this app.";
    const entries = Array.isArray(g.entries) ? g.entries : [];
    return { title, help, entries };
  }

  function sectionForEntry(entry){
    // Deterministic mapping: prefer explicit category match to TOC labels.
    const cat = (entry && entry.category ? String(entry.category).trim() : "");
    const term = (entry && entry.term ? String(entry.term).trim() : "");

    if (cat && TOC_ORDER.includes(cat)) return cat;
    if (term && TOC_ORDER.includes(term)) return term;

    // Lightweight term-based mapping for resilience (exact matches only)
    const termMap = Object.create(null);
    // Populate common exact matches that might come through w/ a different category
    TOC_ORDER.forEach(label => { termMap[label] = label; });
    if (term && termMap[term]) return termMap[term];

    // Final fallback bucket (kept deterministic)
    return "Other";
  }

  function buildIndex(entries){
    state.indexByKey = Object.create(null);

    entries.forEach(e => {
      if (!e || !e.term) return;
      const term = String(e.term).trim();
      if (!term) return;

      const abbr = e.abbr ? String(e.abbr).trim() : "";
      const def  = e.definition ? String(e.definition).trim() : "";

      const key = normalizeKey(term, abbr);
      state.indexByKey[key] = {
        term,
        abbr: abbr || "",
        category: e.category ? String(e.category).trim() : "",
        definition: def || ""
      };
    });
  }

  function groupEntries(entries){
    const groups = Object.create(null);

    // Initialize groups in TOC order to keep stable rendering
    TOC_ORDER.forEach(label => { groups[label] = []; });
    groups["Other"] = [];

    entries.forEach(e => {
      if (!e || !e.term) return;
      const term = String(e.term).trim();
      if (!term) return;

      const section = sectionForEntry(e);
      if (!groups[section]) groups[section] = [];
      groups[section].push(e);
    });

    // Within each section: stable alphabetical by term (deterministic)
    Object.keys(groups).forEach(k => {
      groups[k].sort((a,b) => {
        const ta = (a.term || "").toLowerCase();
        const tb = (b.term || "").toLowerCase();
        return ta.localeCompare(tb);
      });
    });

    return groups;
  }

  function setActive(term, abbr){
    const key = normalizeKey(term, abbr);
    state.activeKey = key;

    const viewTerm = $("glossaryViewTerm");
    const viewDef  = $("glossaryViewDef");

    const entry = state.indexByKey[key];

    // Graceful placeholder when missing
    if (!entry){
      if (viewTerm) viewTerm.textContent = term || "Unknown term";
      if (viewDef)  viewDef.textContent  = "Definition unavailable.";
      return;
    }

    if (viewTerm){
      viewTerm.textContent = entry.abbr ? `${entry.term} (${entry.abbr})` : entry.term;
    }
    if (viewDef){
      viewDef.textContent = entry.definition || "Definition unavailable.";
    }

    // Update active styling
    const toc = $("glossaryTOC");
    if (toc){
      toc.querySelectorAll(".mi-glossary-term-btn.is-active").forEach(btn => btn.classList.remove("is-active"));
      const activeBtn = toc.querySelector(`.mi-glossary-term-btn[data-key="${CSS.escape(key)}"]`);
      if (activeBtn) activeBtn.classList.add("is-active");
    }
  }

  function renderTOC(groups){
    const toc = $("glossaryTOC");
    if (!toc) return;

    toc.innerHTML = "";

    const ordered = [...TOC_ORDER];
    if (!ordered.includes("Other")) ordered.push("Other");

    ordered.forEach(sectionName => {
      const list = groups[sectionName] || [];
      // Render section only if it has entries OR it’s a named TOC section (keeps structure predictable)
      // If you prefer hiding empty sections: change condition to `if (!list.length) return;`
      const details = document.createElement("details");
      details.className = "mi-glossary-section";
      // Start collapsed by default
      details.open = false;

      const summary = document.createElement("summary");
      summary.innerHTML = `
        <span class="mi-glossary-section-title">${sectionName}</span>
        <span class="mi-glossary-caret">›</span>
      `;
      details.appendChild(summary);

      const container = document.createElement("div");
      container.className = "mi-glossary-term-list";

      if (!list.length){
        const empty = document.createElement("div");
        empty.className = "mi-glossary-term-empty";
        empty.style.fontSize = "12px";
        empty.style.opacity = "0.72";
        empty.style.padding = "6px 2px";
        empty.textContent = "No definitions found.";
        container.appendChild(empty);
      } else {
        list.forEach(e => {
          const term = String(e.term || "").trim();
          const abbr = e.abbr ? String(e.abbr).trim() : "";
          const key  = normalizeKey(term, abbr);

          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "mi-glossary-term-btn";
          btn.dataset.key = key;

          const name = document.createElement("div");
          name.className = "mi-glossary-term-name";
          name.textContent = term;

          const ab = document.createElement("div");
          ab.className = "mi-glossary-term-abbr";
          ab.textContent = abbr ? abbr : "";

          btn.appendChild(name);
          btn.appendChild(ab);

          btn.addEventListener("click", () => setActive(term, abbr));
          container.appendChild(btn);
        });
      }

      details.appendChild(container);
      toc.appendChild(details);
    });
  }

  function clampDrawerWidthToLeftLane(){
    // Contract: first open width must not intrude into Verdict Shell lane.
    // We’ll clamp to the left edge of #verdictShell if present.
    const drawer = $("glossaryDrawer");
    const panel  = $("glossaryPanel");
    const verdict = document.getElementById("verdictShell");
    if (!drawer || !panel || !verdict) return;

    const vr = verdict.getBoundingClientRect();
    const leftEdge = 0;
    const safeGap = Math.max(0, Math.floor(vr.left - leftEdge - 12)); // 12px breathing room

    // If verdict is very close to the edge, keep a tight minimum drawer width
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

    handle.addEventListener("click", () => setOpen(!state.open));
    closeBtn.addEventListener("click", () => setOpen(false));

    // Click outside panel closes (but doesn’t interfere with other UI)
    document.addEventListener("mousedown", (e) => {
      if (!state.open) return;
      const panel = $("glossaryPanel");
      if (!panel) return;
      if (panel.contains(e.target) || handle.contains(e.target)) return;
      setOpen(false);
    });

    window.addEventListener("resize", () => {
      if (state.open) clampDrawerWidthToLeftLane();
    });

    document.addEventListener("keydown", onKeyDown);
  }

  function renderGlossary(){
    const { title, help, entries } = safeCopy();

    const root = $("glossaryDrawer");
    if (!root) return;

    // Title/help
    const t = $("glossaryTitle");
    const h = $("glossaryHelp");
    if (t) t.textContent = title;
    if (h) h.textContent = help;

    buildIndex(entries);
    state.grouped = groupEntries(entries);
    renderTOC(state.grouped);

    // Default view
    const viewTerm = $("glossaryViewTerm");
    const viewDef  = $("glossaryViewDef");
    if (viewTerm) viewTerm.textContent = "Select a term";
    if (viewDef)  viewDef.textContent  = "Quick definitions appear here.";
  }

  function detectMatchupVisible(){
    // Primary gate: analysis-visible on #analysisShell
    const shell = document.getElementById("analysisShell");
    if (shell && shell.classList.contains("analysis-visible")) return true;

    // Secondary gate: body class (if you have it)
    if (document.body && document.body.classList.contains("analysis-visible")) return true;

    return false;
  }

  // Public hooks (attach to window for deterministic integration)
  window.miInitGlossary = function(){
    bindOnce();
    // Render once; availability is controlled separately
    renderGlossary();
    window.miSetGlossaryAvailable(detectMatchupVisible());
  };

  window.miSetGlossaryAvailable = function(isAvailable){
    const root = $("glossaryDrawer");
    if (!root) return;

    state.available = !!isAvailable;

    // Only exists in matchup state
    if (!state.available){
      setOpen(false);
      root.setAttribute("hidden", "");
    } else {
      root.removeAttribute("hidden");
    }
  };

  window.miRefreshGlossary = function(){
    // Call if glossary JSON changes or you reassign MI_COPY at runtime
    renderGlossary();
    if (state.open) clampDrawerWidthToLeftLane();
  };

})();

function bootMadnessIndex() {
  console.log("[MI] bootMadnessIndex fired");

  let tries = 0;
  const tick = () => {
    tries += 1;

    const hub = document.getElementById('preMatchupHub');
    if (!hub && tries < 10) {
      setTimeout(tick, 50);
      return;
    }

    setupEventListeners();
    loadCopyJSON();

    if (typeof miInitGlossary === 'function') {
      miInitGlossary();
    }

    miSyncGlossaryToMatchupState();

    updatePreMatchupHubProgress();
  };

  tick();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootMadnessIndex, { once: true });
} else {
  bootMadnessIndex();
}