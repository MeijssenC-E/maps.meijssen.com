/**
 * Topografie Trainer (maps.meijssen.com)
 * Core gameplay logic, settings management, and localStorage persistence (Tickets #5 & #6)
 */

(function () {
  'use strict';

  // Fixed list of the 12 Dutch provinces
  const PROVINCES = [
    'Drenthe',
    'Flevoland',
    'Fryslân',
    'Gelderland',
    'Groningen',
    'Limburg',
    'Noord-Brabant',
    'Noord-Holland',
    'Overijssel',
    'Utrecht',
    'Zeeland',
    'Zuid-Holland'
  ];

  // Supported GeoFeature categories
  const CATEGORIES = [
    { id: 'plaats', badge: 'plaats', label: 'Woonplaatsen', defaultTier: 2 },
    { id: 'snelweg', badge: 'snelweg', label: 'Snelwegen', defaultTier: 2 },
    { id: 'rivier', badge: 'rivier', label: 'Rivieren', defaultTier: 2 },
    { id: 'kanaal', badge: 'kanaal', label: 'Kanalen', defaultTier: 2 },
    { id: 'meer', badge: 'meer / water', label: 'Meren & Wateren', defaultTier: 2 },
    { id: 'natuurgebied', badge: 'natuurgebied', label: 'Natuurgebieden', defaultTier: 2 },
    { id: 'gebouw', badge: 'gebouw', label: 'Belangrijke gebouwen', defaultTier: 2 }
  ];

  const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

  // Storage keys for browser persistence
  const STORAGE_KEYS = {
    SETTINGS: 'topotrainer_settings_v1',
    MASTERED: 'topotrainer_mastered_v1'
  };

  const DEFAULT_CATEGORY_TIERS = {
    plaats: 2,        // 1: >50k, 2: >10k (standaard), 3: >2.5k, 4: alle
    snelweg: 2,       // 1: hoofdwegen, 2: middelgroot, 3: alle A-wegen
    rivier: 2,        // 1: hoofdrivieren, 2: regionaal, 3: alle rivieren
    kanaal: 2,        // 1: hoofdkanalen, 2: regionaal, 3: alle kanalen
    meer: 2,          // 1: grote wateren, 2: middelgroot, 3: alle meren
    natuurgebied: 2,  // 1: Nat. Parken, 2: Groot N2000, 3: Alle natuur
    gebouw: 2         // 1: Top-iconen, 2: Bekend, 3: Uitgebreid
  };

  const DEFAULT_SETTINGS = {
    baseLayer: 'normal',   // 'normal' | 'satellite'
    toleranceKm: 3,        // 0 (precies goed) | 3 (binnen 3 km)
    categories: ['plaats'],
    categoryTiers: { ...DEFAULT_CATEGORY_TIERS },
    provinces: []          // string[] (empty means all provinces / Heel Nederland)
  };

  // Game state
  const state = {
    allFeatures: [],              // All GeoFeatures loaded from datasets
    currentFilteredFeatures: [],  // Subset of GeoFeatures matching active settings filters
    questionPool: [],             // Active Vraagpool (filtered features minus Beheerst)
    masteredCodes: new Set(),     // Set of mastered (Beheerst) codes from localStorage
    settings: {
      ...DEFAULT_SETTINGS,
      categories: [...DEFAULT_SETTINGS.categories],
      categoryTiers: { ...DEFAULT_CATEGORY_TIERS }
    },
    isSettingsOpen: false,
    isResetModalOpen: false,
    isCompletionModalOpen: false,
    currentTarget: null,          // Currently active GeoFeature
    currentGok: null,             // Current player guess: [lat, lon]
    gokMarker: null,              // Leaflet marker for Gok
    targetPolygonLayer: null,     // Leaflet GeoJSON layer for showing target geometry
    targetHighlightLayer: null,   // Optional highlight marker for small building footprints
    feedbackLineLayer: null,      // Leaflet polyline for dashed distance line
    feedbackLabelLayer: null,     // Leaflet marker for distance label on midpoint
    activeBaseLayer: 'normal',    // 'normal' | 'satellite'
    isFeedbackPhase: false        // true when showing results before 'Volgende' is clicked
  };

  // Leaflet map instance and tile layers
  let map = null;
  let normalTileLayer = null;
  let satelliteTileLayers = [];

  // DOM Elements cache
  const el = {
    // Top-left settings & brand
    btnSettingsToggle: document.getElementById('btn-settings-toggle'),
    settingsPanel: document.getElementById('settings-panel'),
    settingsBackdrop: document.getElementById('settings-backdrop'),
    btnSettingsClose: document.getElementById('btn-settings-close'),

    // Settings controls
    settingsLayerNormal: document.querySelector('.segment-btn[data-style="normal"]'),
    settingsLayerSat: document.querySelector('.segment-btn[data-style="satellite"]'),
    toleranceBtns: document.querySelectorAll('.segment-btn[data-tolerance]'),
    inhabitantsBadge: document.getElementById('inhabitants-badge'),
    btnCatAll: document.getElementById('btn-cat-all'),
    btnCatPlacesOnly: document.getElementById('btn-cat-places-only'),
    categoriesContainer: document.getElementById('categories-container'),
    categoryCheckboxes: document.querySelectorAll('.category-checkbox'),
    tierBtns: document.querySelectorAll('.tier-btn'),
    btnProvAll: document.getElementById('btn-prov-all'),
    btnProvClear: document.getElementById('btn-prov-clear'),
    provinceGrid: document.getElementById('province-grid'),

    // Settings stats & actions
    statsCurrentMastered: document.getElementById('stats-current-mastered'),
    statsCurrentTotal: document.getElementById('stats-current-total'),
    statsCurrentPct: document.getElementById('stats-current-pct'),
    statsTotalMastered: document.getElementById('stats-total-mastered'),
    statsGrandTotal: document.getElementById('stats-grand-total'),
    btnResetProgress: document.getElementById('btn-reset-progress'),

    // Top-right quick layer switch
    styleNormalBtn: document.getElementById('style-normal'),
    styleSatBtn: document.getElementById('style-sat'),

    // Prompt Card (Opdrachtbalk)
    targetName: document.getElementById('target-name'),
    targetProvince: document.getElementById('target-province'),
    targetDetails: document.getElementById('target-details'),
    promptSubRow: document.getElementById('prompt-sub-row'),
    masteredCount: document.getElementById('mastered-count'),
    poolTotal: document.getElementById('pool-total'),
    progressFill: document.getElementById('progress-fill'),
    btnOk: document.getElementById('btn-ok'),
    btnNext: document.getElementById('btn-next'),
    feedbackBox: document.getElementById('feedback-box'),
    feedbackText: document.getElementById('feedback-text'),

    // Modals
    resetModal: document.getElementById('reset-modal'),
    btnConfirmReset: document.getElementById('btn-confirm-reset'),
    btnCancelReset: document.getElementById('btn-cancel-reset'),

    completionModal: document.getElementById('completion-modal'),
    completionMessage: document.getElementById('completion-message'),
    btnRestart: document.getElementById('btn-restart'),
    btnOpenSettingsFromModal: document.getElementById('btn-open-settings-from-modal')
  };

  /**
   * Load stored settings from localStorage with fallbacks and migration from v1 minInhabitants
   */
  function loadStoredSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        const tiers = { ...DEFAULT_CATEGORY_TIERS };

        // Migrate legacy minInhabitants if present
        if (parsed.minInhabitants !== undefined && !parsed.categoryTiers) {
          if (parsed.minInhabitants === 50000) tiers.plaats = 1;
          else if (parsed.minInhabitants === 10000) tiers.plaats = 2;
          else if (parsed.minInhabitants === 2500) tiers.plaats = 3;
          else if (parsed.minInhabitants === 0) tiers.plaats = 4;
        }

        if (parsed.categoryTiers && typeof parsed.categoryTiers === 'object') {
          CATEGORIES.forEach(c => {
            const val = parseInt(parsed.categoryTiers[c.id], 10);
            const maxTier = c.id === 'plaats' ? 4 : 3;
            if (val >= 1 && val <= maxTier) {
              tiers[c.id] = val;
            }
          });
        }

        const validCats = Array.isArray(parsed.categories)
          ? parsed.categories.filter(id => CATEGORY_MAP[id])
          : ['plaats'];

        return {
          baseLayer: parsed.baseLayer === 'satellite' ? 'satellite' : 'normal',
          toleranceKm: parsed.toleranceKm === 0 ? 0 : 3,
          categories: validCats.length > 0 ? validCats : ['plaats'],
          categoryTiers: tiers,
          provinces: Array.isArray(parsed.provinces) ? parsed.provinces.filter(p => PROVINCES.includes(p)) : []
        };
      }
    } catch (err) {
      console.warn('Kon instellingen niet lezen uit localStorage:', err);
    }
    return {
      ...DEFAULT_SETTINGS,
      categories: [...DEFAULT_SETTINGS.categories],
      categoryTiers: { ...DEFAULT_CATEGORY_TIERS }
    };
  }

  /**
   * Save active settings to localStorage
   */
  function saveStoredSettings() {
    try {
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
    } catch (err) {
      console.warn('Kon instellingen niet opslaan in localStorage:', err);
    }
  }

  /**
   * Load set of mastered (Beheerst) codes from localStorage
   */
  function loadStoredMastered() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.MASTERED);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          return new Set(list.map(String));
        }
      }
    } catch (err) {
      console.warn('Kon beheerste codes niet lezen uit localStorage:', err);
    }
    return new Set();
  }

  /**
   * Save set of mastered (Beheerst) codes to localStorage
   */
  function saveStoredMastered() {
    try {
      const array = Array.from(state.masteredCodes);
      localStorage.setItem(STORAGE_KEYS.MASTERED, JSON.stringify(array));
    } catch (err) {
      console.warn('Kon beheerste codes niet opslaan in localStorage:', err);
    }
  }

  /**
   * Initialize Leaflet map and base tile layers
   */
  function initMap() {
    // Center of the Netherlands
    const defaultCenter = [52.1326, 5.2913];
    const defaultZoom = 8;

    // Bounding box covering the Netherlands, North Sea, and surrounding countries (BE, LU, DE, FR, UK)
    const regionBounds = L.latLngBounds([48.5, -1.0], [56.0, 11.5]);

    map = L.map('map', {
      center: defaultCenter,
      zoom: defaultZoom,
      minZoom: 6,
      maxZoom: 18,
      maxBounds: regionBounds,
      maxBoundsViscosity: 0.85,
      zoomControl: false
    });

    // Zoom control at bottom-right
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // CartoDB Positron No Labels via Vector GL (works without API key and covers NL + surrounding countries/sea)
    if (typeof L.maplibreGL === 'function' && typeof maplibregl !== 'undefined') {
      normalTileLayer = L.maplibreGL({
        style: 'https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json',
        interactive: false
      });
      if (map.attributionControl) {
        map.attributionControl.addAttribution(
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>'
        );
      }
    } else {
      normalTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri'
      });
    }

    // Esri World Imagery (Blind Satellite layer covering NL, sea, and surrounding countries without white border cutoff)
    const esriWorldLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Kaartgegevens &copy; Esri, Maxar, Earthstar Geographics, Beeldmateriaal.nl'
    });

    satelliteTileLayers = [esriWorldLayer];

    // Apply initial base layer from loaded settings
    if (state.settings.baseLayer === 'satellite') {
      satelliteTileLayers.forEach(l => l.addTo(map));
      state.activeBaseLayer = 'satellite';
      updateLayerToggleUI('satellite');
    } else {
      normalTileLayer.addTo(map);
      state.activeBaseLayer = 'normal';
      updateLayerToggleUI('normal');
    }

    // Click handler on map
    map.on('click', handleMapClick);

    // Prevent map click propagation through custom overlay panels
    if (el.settingsPanel) {
      L.DomEvent.disableClickPropagation(el.settingsPanel);
      L.DomEvent.disableScrollPropagation(el.settingsPanel);
    }
  }

  /**
   * Update layer toggle button active states in both top-right and settings panel
   */
  function updateLayerToggleUI(type) {
    if (el.styleNormalBtn) el.styleNormalBtn.classList.toggle('active', type === 'normal');
    if (el.styleSatBtn) el.styleSatBtn.classList.toggle('active', type === 'satellite');

    if (el.settingsLayerNormal) {
      el.settingsLayerNormal.classList.toggle('active', type === 'normal');
      el.settingsLayerNormal.setAttribute('aria-checked', type === 'normal' ? 'true' : 'false');
    }
    if (el.settingsLayerSat) {
      el.settingsLayerSat.classList.toggle('active', type === 'satellite');
      el.settingsLayerSat.setAttribute('aria-checked', type === 'satellite' ? 'true' : 'false');
    }
  }

  /**
   * Switch between Normal (Positron) and Satellite (Esri World Imagery)
   */
  function setBaseLayer(type) {
    if (type !== 'normal' && type !== 'satellite') return;
    if (type === state.activeBaseLayer) return;

    if (type === 'satellite') {
      map.removeLayer(normalTileLayer);
      satelliteTileLayers.forEach(l => l.addTo(map));
    } else {
      satelliteTileLayers.forEach(l => map.removeLayer(l));
      normalTileLayer.addTo(map);
    }

    state.activeBaseLayer = type;
    state.settings.baseLayer = type;
    saveStoredSettings();
    updateLayerToggleUI(type);
  }

  /**
   * Custom Leaflet Gok Marker icon with animated pulse ring
   */
  function createGokIcon() {
    return L.divIcon({
      className: 'gok-marker-wrapper',
      html: '<div class="gok-marker-pulse"></div><div class="gok-marker-pin"></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 30]
    });
  }

  /**
   * Handle map click when user places or repositions a Gok
   */
  function handleMapClick(e) {
    if (state.isSettingsOpen || state.isResetModalOpen || state.isCompletionModalOpen) return;
    if (state.isFeedbackPhase || !state.currentTarget) return;

    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    state.currentGok = [lat, lng];

    if (!state.gokMarker) {
      state.gokMarker = L.marker([lat, lng], {
        icon: createGokIcon(),
        draggable: true,
        autoPan: false
      }).addTo(map);

      state.gokMarker.on('dragend', function (event) {
        if (state.isFeedbackPhase) return;
        const pos = event.target.getLatLng();
        state.currentGok = [pos.lat, pos.lng];
      });
    } else {
      state.gokMarker.setLatLng([lat, lng]);
    }

    // Enable OK button
    el.btnOk.disabled = false;
  }

  /**
   * Return normalized category id for a GeoFeature
   */
  function getFeatureCategory(f) {
    return (f && f.properties && f.properties.categorie) || 'plaats';
  }

  /**
   * Return difficulty tier (1..4) for a GeoFeature
   */
  function getFeatureTier(f) {
    const p = (f && f.properties) || {};
    if (typeof p.tier === 'number') return p.tier;
    // Default calculation for Woonplaatsen based on inhabitants
    const inh = p.inwoners || 0;
    if (inh > 50000) return 1;
    if (inh > 10000) return 2;
    if (inh > 2500) return 3;
    return 4;
  }

  /**
   * Return array of province names that a GeoFeature belongs to
   */
  function getFeatureProvinces(f) {
    const p = (f && f.properties) || {};
    if (Array.isArray(p.provincies) && p.provincies.length > 0) {
      return p.provincies;
    }
    if (p.provincie) {
      return [p.provincie];
    }
    return [];
  }

  /**
   * Check if feature matches currently selected province filter
   */
  function matchesProvinceFilter(f) {
    const selProvs = state.settings.provinces;
    if (!selProvs || selProvs.length === 0 || selProvs.length === PROVINCES.length) {
      return true;
    }
    if (selProvs.includes('_none_')) {
      return false;
    }
    const featProvs = getFeatureProvinces(f);
    if (featProvs.length === 0) return true;
    return featProvs.some(prov => selProvs.includes(prov));
  }

  /**
   * Check if feature matches its category's selected difficulty tier
   */
  function matchesCategoryTier(f) {
    const cat = getFeatureCategory(f);
    const selectedTier = (state.settings.categoryTiers && state.settings.categoryTiers[cat]) || 2;
    const featTier = getFeatureTier(f);
    return featTier <= selectedTier;
  }

  /**
   * Calculate filtered GeoFeatures matching active categories, category tiers, and provinces
   */
  function getFilteredFeatures() {
    const activeCats = new Set(state.settings.categories || ['plaats']);
    return state.allFeatures.filter(f => {
      const cat = getFeatureCategory(f);
      if (!activeCats.has(cat)) return false;
      if (!matchesCategoryTier(f)) return false;
      if (!matchesProvinceFilter(f)) return false;
      return true;
    });
  }

  /**
   * Rebuild current filtered features, active question pool, and update UI counters
   */
  function rebuildPoolAndUI() {
    state.currentFilteredFeatures = getFilteredFeatures();

    // The questionPool is all features in the filtered set that have not yet been mastered
    state.questionPool = state.currentFilteredFeatures.filter(f => {
      const code = String(f.properties.code || f.properties.id);
      return !state.masteredCodes.has(code);
    });

    updateProgressUI();
    updateCategoriesUI();
    updateSettingsStatsUI();
    updateProvinceCheckboxesCounts();
  }

  /**
   * Update progress counter and bar in top prompt card
   */
  function updateProgressUI() {
    const total = state.currentFilteredFeatures.length;
    const unmastered = state.questionPool.length;
    const mastered = total - unmastered;

    el.masteredCount.textContent = mastered;
    el.poolTotal.textContent = total;
    const pct = total > 0 ? Math.round((mastered / total) * 100) : 0;
    el.progressFill.style.width = pct + '%';
  }

  /**
   * Update category cards, checkboxes, tier buttons, and per-category counts
   */
  function updateCategoriesUI() {
    const activeCats = new Set(state.settings.categories || []);
    const countsByCat = {};
    CATEGORIES.forEach(c => { countsByCat[c.id] = 0; });

    state.allFeatures.forEach(f => {
      const cat = getFeatureCategory(f);
      if (countsByCat[cat] !== undefined && matchesCategoryTier(f) && matchesProvinceFilter(f)) {
        countsByCat[cat]++;
      }
    });

    CATEGORIES.forEach(c => {
      const isEnabled = activeCats.has(c.id);
      const card = document.querySelector(`[data-category-card="${c.id}"]`);
      if (card) {
        card.classList.toggle('active', isEnabled);
      }

      const cb = document.querySelector(`.category-checkbox[data-category="${c.id}"]`);
      if (cb) {
        cb.checked = isEnabled;
      }

      const badge = document.querySelector(`[data-category-count="${c.id}"]`);
      if (badge) {
        badge.textContent = countsByCat[c.id];
      }

      const activeTier = (state.settings.categoryTiers && state.settings.categoryTiers[c.id]) || c.defaultTier;
      const tierButtons = document.querySelectorAll(`.tier-btn[data-category-tier="${c.id}"]`);
      tierButtons.forEach(btn => {
        const t = parseInt(btn.getAttribute('data-tier'), 10);
        const isCurrent = t === activeTier;
        btn.classList.toggle('active', isCurrent);
        btn.setAttribute('aria-checked', isCurrent ? 'true' : 'false');
      });
    });
  }

  /**
   * Update stats card and badges inside Settings flyout
   */
  function updateSettingsStatsUI() {
    const totalInFilter = state.currentFilteredFeatures.length;
    const unmasteredInFilter = state.questionPool.length;
    const masteredInFilter = totalInFilter - unmasteredInFilter;
    const pctInFilter = totalInFilter > 0 ? Math.round((masteredInFilter / totalInFilter) * 100) : 0;

    if (el.statsCurrentMastered) el.statsCurrentMastered.textContent = masteredInFilter;
    if (el.statsCurrentTotal) el.statsCurrentTotal.textContent = totalInFilter;
    if (el.statsCurrentPct) el.statsCurrentPct.textContent = pctInFilter + '%';

    if (el.statsTotalMastered) el.statsTotalMastered.textContent = state.masteredCodes.size;
    if (el.statsGrandTotal) el.statsGrandTotal.textContent = state.allFeatures.length.toLocaleString('nl-NL');

    if (el.inhabitantsBadge) {
      const onlyPlaces = state.settings.categories.length === 1 && state.settings.categories[0] === 'plaats';
      const unit = onlyPlaces
        ? (totalInFilter === 1 ? 'plaats' : 'plaatsen')
        : (totalInFilter === 1 ? 'object' : 'objecten');
      el.inhabitantsBadge.textContent = `${totalInFilter} ${unit}`;
    }
  }

  /**
   * Update province counts next to checkboxes based on active categories and tiers
   */
  function updateProvinceCheckboxesCounts() {
    if (!el.provinceGrid) return;
    const activeCats = new Set(state.settings.categories || []);

    const counts = {};
    PROVINCES.forEach(p => { counts[p] = 0; });

    state.allFeatures.forEach(f => {
      const cat = getFeatureCategory(f);
      if (!activeCats.has(cat)) return;
      if (!matchesCategoryTier(f)) return;

      const provs = getFeatureProvinces(f);
      provs.forEach(p => {
        if (counts[p] !== undefined) counts[p]++;
      });
    });

    PROVINCES.forEach(prov => {
      const badge = el.provinceGrid.querySelector(`[data-prov-count="${prov}"]`);
      if (badge) {
        badge.textContent = `(${counts[prov]})`;
      }
    });
  }

  /**
   * Populate province checkboxes in Settings flyout
   */
  function renderProvinceCheckboxes() {
    if (!el.provinceGrid) return;
    el.provinceGrid.innerHTML = '';

    const selProvs = state.settings.provinces;
    const isAllSelected = selProvs.length === 0 || selProvs.length === PROVINCES.length;

    PROVINCES.forEach(prov => {
      const label = document.createElement('label');
      label.className = 'province-checkbox-label';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = prov;
      checkbox.checked = isAllSelected || selProvs.includes(prov);

      checkbox.addEventListener('change', handleProvinceCheckboxChange);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'province-item-name';
      nameSpan.textContent = prov;

      const countSpan = document.createElement('span');
      countSpan.className = 'province-item-count';
      countSpan.setAttribute('data-prov-count', prov);
      countSpan.textContent = '(0)';

      label.appendChild(checkbox);
      label.appendChild(nameSpan);
      label.appendChild(countSpan);
      el.provinceGrid.appendChild(label);
    });

    updateProvinceCheckboxesCounts();
  }

  /**
   * Handle changes to individual province checkboxes
   */
  function handleProvinceCheckboxChange() {
    const checkboxes = el.provinceGrid.querySelectorAll('input[type="checkbox"]');
    const checkedProvinces = [];
    checkboxes.forEach(cb => {
      if (cb.checked) checkedProvinces.push(cb.value);
    });

    if (checkedProvinces.length === PROVINCES.length || checkedProvinces.length === 0) {
      state.settings.provinces = [];
      if (checkedProvinces.length === 0) {
        checkboxes.forEach(cb => { cb.checked = true; });
      }
    } else {
      state.settings.provinces = checkedProvinces;
    }

    saveStoredSettings();
    rebuildPoolAndUI();
    nextQuestion();
  }

  /**
   * Select all provinces (Heel Nederland)
   */
  function selectAllProvinces() {
    state.settings.provinces = [];
    saveStoredSettings();

    if (el.provinceGrid) {
      el.provinceGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = true;
      });
    }

    rebuildPoolAndUI();
    nextQuestion();
  }

  /**
   * Clear province selection (deselect all)
   */
  function clearAllProvinces() {
    state.settings.provinces = ['_none_'];
    saveStoredSettings();

    if (el.provinceGrid) {
      el.provinceGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
      });
    }

    rebuildPoolAndUI();
    nextQuestion();
  }

  /**
   * Handle category checkbox toggle
   */
  function handleCategoryToggle() {
    const checked = [];
    el.categoryCheckboxes.forEach(cb => {
      if (cb.checked) {
        checked.push(cb.getAttribute('data-category'));
      }
    });

    // Ensure at least one category remains active; fallback to 'plaats' if user unchecks last one
    if (checked.length === 0) {
      checked.push('plaats');
    }

    state.settings.categories = checked;
    saveStoredSettings();
    rebuildPoolAndUI();
    nextQuestion();
  }

  /**
   * Select all 7 categories
   */
  function selectAllCategories() {
    state.settings.categories = CATEGORIES.map(c => c.id);
    saveStoredSettings();
    rebuildPoolAndUI();
    nextQuestion();
  }

  /**
   * Reset categories to Woonplaatsen only
   */
  function selectPlacesOnly() {
    state.settings.categories = ['plaats'];
    saveStoredSettings();
    rebuildPoolAndUI();
    nextQuestion();
  }

  /**
   * Change difficulty tier for a specific category
   */
  function setCategoryTier(categoryId, tierVal) {
    if (!CATEGORY_MAP[categoryId]) return;
    const maxTier = categoryId === 'plaats' ? 4 : 3;
    if (tierVal < 1 || tierVal > maxTier) return;

    if (!state.settings.categoryTiers) {
      state.settings.categoryTiers = { ...DEFAULT_CATEGORY_TIERS };
    }
    state.settings.categoryTiers[categoryId] = tierVal;
    saveStoredSettings();
    rebuildPoolAndUI();
    if (state.settings.categories.includes(categoryId)) {
      nextQuestion();
    }
  }

  /**
   * Update tolerance segmented control UI
   */
  function updateToleranceUI(val) {
    if (!el.toleranceBtns) return;
    el.toleranceBtns.forEach(btn => {
      const tol = parseInt(btn.getAttribute('data-tolerance'), 10);
      const isActive = tol === val;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
    });
  }

  /**
   * Change tolerance setting (0 = precies goed, 3 = binnen 3 km)
   */
  function setTolerance(val) {
    if (val !== 0 && val !== 3) return;
    if (state.settings.toleranceKm === val) return;

    state.settings.toleranceKm = val;
    saveStoredSettings();
    updateToleranceUI(val);
  }

  /**
   * Toggle settings flyout open / close
   */
  function toggleSettings() {
    if (state.isSettingsOpen) {
      closeSettings();
    } else {
      openSettings();
    }
  }

  function openSettings() {
    state.isSettingsOpen = true;
    el.settingsPanel.hidden = false;
    el.settingsBackdrop.hidden = false;
    el.btnSettingsToggle.setAttribute('aria-expanded', 'true');
    updateSettingsStatsUI();
  }

  function closeSettings() {
    state.isSettingsOpen = false;
    el.settingsPanel.hidden = true;
    el.settingsBackdrop.hidden = true;
    el.btnSettingsToggle.setAttribute('aria-expanded', 'false');
  }

  /**
   * Reset confirmation modal handlers
   */
  function openResetModal() {
    state.isResetModalOpen = true;
    el.resetModal.hidden = false;
    el.resetModal.classList.add('active');
  }

  function closeResetModal() {
    state.isResetModalOpen = false;
    el.resetModal.hidden = true;
    el.resetModal.classList.remove('active');
  }

  function confirmResetProgress() {
    state.masteredCodes.clear();
    try {
      localStorage.removeItem(STORAGE_KEYS.MASTERED);
    } catch (err) {
      console.warn('Kon localStorage niet wissen:', err);
    }

    closeResetModal();
    closeSettings();
    rebuildPoolAndUI();
    nextQuestion();
  }

  /**
   * Completion celebration modal handlers
   */
  function showCompletionModal() {
    state.isCompletionModalOpen = true;
    const total = state.currentFilteredFeatures.length;
    if (el.completionMessage) {
      el.completionMessage.innerHTML = `Je hebt alle <strong>${total}</strong> objecten in deze selectie <strong>Beheerst</strong>.`;
    }
    el.completionModal.hidden = false;
    el.completionModal.classList.add('active');
  }

  function closeCompletionModal() {
    state.isCompletionModalOpen = false;
    el.completionModal.hidden = true;
    el.completionModal.classList.remove('active');
  }

  /**
   * Restart session for current selection: resets mastered items within current filter
   */
  function restartSession() {
    closeCompletionModal();
    state.currentFilteredFeatures.forEach(f => {
      const code = String(f.properties.code || f.properties.id);
      state.masteredCodes.delete(code);
    });
    saveStoredMastered();
    rebuildPoolAndUI();
    nextQuestion();
  }

  /**
   * Load TopoJSON datasets (woonplaatsen + extra categories) and start game
   */
  async function loadData() {
    try {
      const [wpResponse, extraResponse] = await Promise.all([
        fetch('data/woonplaatsen.topo.json'),
        fetch('data/extra_features.topo.json').catch(() => null)
      ]);

      if (!wpResponse || !wpResponse.ok) {
        throw new Error('Kon data/woonplaatsen.topo.json niet laden');
      }

      const wpTopo = await wpResponse.json();
      const wpGeojson = topojson.feature(wpTopo, wpTopo.objects.woonplaatsen);
      const wpFeatures = (wpGeojson.features || []).map(f => {
        f.properties = f.properties || {};
        if (!f.properties.categorie) f.properties.categorie = 'plaats';
        if (!f.properties.provincies && f.properties.provincie) {
          f.properties.provincies = [f.properties.provincie];
        }
        f.properties.tier = getFeatureTier(f);
        return f;
      });

      let extraFeatures = [];
      if (extraResponse && extraResponse.ok) {
        const extraTopo = await extraResponse.json();
        Object.keys(extraTopo.objects || {}).forEach(objKey => {
          const extraGeojson = topojson.feature(extraTopo, extraTopo.objects[objKey]);
          if (extraGeojson && Array.isArray(extraGeojson.features)) {
            extraFeatures = extraFeatures.concat(extraGeojson.features);
          }
        });
      }

      state.allFeatures = wpFeatures.concat(extraFeatures);

      renderProvinceCheckboxes();
      updateToleranceUI(state.settings.toleranceKm);
      rebuildPoolAndUI();
      nextQuestion();
    } catch (err) {
      console.error('Fout bij het laden van dataset:', err);
      el.targetName.textContent = 'Fout bij inladen';
      el.targetProvince.textContent = 'fout';
      el.targetDetails.textContent = 'Controleer netwerkverbinding of databestanden in data/';
      el.targetDetails.hidden = false;
    }
  }

  /**
   * Pick next random question from active questionPool
   */
  function nextQuestion() {
    state.isFeedbackPhase = false;

    // Clear previous visual feedback
    if (state.gokMarker) {
      map.removeLayer(state.gokMarker);
      state.gokMarker = null;
    }
    if (state.targetPolygonLayer) {
      map.removeLayer(state.targetPolygonLayer);
      state.targetPolygonLayer = null;
    }
    if (state.targetHighlightLayer) {
      map.removeLayer(state.targetHighlightLayer);
      state.targetHighlightLayer = null;
    }
    if (state.feedbackLineLayer) {
      map.removeLayer(state.feedbackLineLayer);
      state.feedbackLineLayer = null;
    }
    if (state.feedbackLabelLayer) {
      map.removeLayer(state.feedbackLabelLayer);
      state.feedbackLabelLayer = null;
    }

    state.currentGok = null;

    // Hide progress & feedback row before OK is clicked
    if (el.promptSubRow) el.promptSubRow.hidden = true;
    el.feedbackBox.className = 'feedback-box';
    el.feedbackBox.style.display = 'none';

    // Button states: show OK (disabled until pin placed), hide Volgende
    el.btnNext.hidden = true;
    el.btnNext.style.display = 'none';
    el.btnOk.hidden = false;
    el.btnOk.style.display = 'inline-flex';
    el.btnOk.disabled = true;

    // Check if filter has zero objects matching criteria
    if (state.currentFilteredFeatures.length === 0) {
      el.targetName.textContent = 'Geen objecten';
      el.targetProvince.textContent = 'Filter leeg';
      el.targetDetails.textContent = 'Geen objecten gevonden voor deze selectie. Wijzig categorieën of provincies in Instellingen.';
      el.targetDetails.hidden = false;
      return;
    }

    // Check if all objects in current filter are mastered
    if (state.questionPool.length === 0) {
      el.targetName.textContent = 'Selectie voltooid';
      el.targetProvince.textContent = '100% Beheerst';
      el.targetDetails.textContent = 'Alle objecten in deze selectie zijn beheerst. Open het instellingenmenu voor een nieuwe selectie.';
      el.targetDetails.hidden = false;
      if (el.promptSubRow) el.promptSubRow.hidden = false;
      showCompletionModal();
      return;
    }

    // Pick random target from active question pool
    const randomIndex = Math.floor(Math.random() * state.questionPool.length);
    state.currentTarget = state.questionPool[randomIndex];

    const p = state.currentTarget.properties;
    const catId = getFeatureCategory(state.currentTarget);
    const catMeta = CATEGORY_MAP[catId];

    el.targetName.textContent = p.naam;
    el.targetProvince.textContent = p.subcategorie || (catMeta ? catMeta.badge : (p.categorie || 'plaats'));

    // Hide details before OK is clicked
    el.targetDetails.textContent = '';
    el.targetDetails.hidden = true;
  }

  /**
   * Build category-appropriate detail string after player clicks OK
   */
  function formatTargetDetails(feature) {
    const p = feature.properties || {};
    const cat = getFeatureCategory(feature);
    const provs = getFeatureProvinces(feature);
    const provText = provs.length > 0 ? provs.join(', ') : '';

    if (cat === 'plaats') {
      const formattedInhabitants = (p.inwoners || 0).toLocaleString('nl-NL');
      const prefix = provText ? `${provText} · ` : '';
      return `${prefix}Gemeente ${p.gemeente || p.naam} · ${formattedInhabitants} inwoners`;
    }

    const parts = [];
    if (provText) parts.push(provText);
    if (p.plaats) parts.push(p.plaats);
    if (p.details) parts.push(p.details);
    return parts.join(' · ');
  }

  /**
   * Submit player guess and calculate distance to boundary/line
   */
  function submitGuess() {
    if (!state.currentGok || !state.currentTarget || state.isFeedbackPhase) return;

    state.isFeedbackPhase = true;

    // Switch buttons immediately: hide OK, show Volgende
    el.btnOk.hidden = true;
    el.btnOk.style.display = 'none';
    el.btnNext.hidden = false;
    el.btnNext.style.display = 'inline-flex';

    // Reveal details after OK is clicked
    el.targetDetails.textContent = formatTargetDetails(state.currentTarget);
    el.targetDetails.hidden = false;

    // Prevent dragging marker while showing feedback
    if (state.gokMarker && state.gokMarker.dragging) {
      state.gokMarker.dragging.disable();
    }

    // Gok point in [lon, lat] format for TopoGeometry
    const gokPoint = [state.currentGok[1], state.currentGok[0]];
    const geometry = state.currentTarget.geometry;
    const cat = getFeatureCategory(state.currentTarget);
    const isLineOrBuilding = (
      geometry.type === 'LineString' ||
      geometry.type === 'MultiLineString' ||
      geometry.type === 'Point' ||
      cat === 'snelweg' ||
      cat === 'kanaal' ||
      cat === 'rivier' ||
      cat === 'gebouw'
    );

    // Compute shortest distance to boundary or line segment
    const result = TopoGeometry.getDistanceToGeometry(gokPoint, geometry);
    const rawDist = typeof result.rawDistanceKm === 'number' ? result.rawDistanceKm : result.distanceKm;

    // Small click buffer (350m) for lines and buildings in 'Precies goed' mode
    const exactHitBufferKm = isLineOrBuilding ? 0.35 : 0;
    const isDirectHit = result.inside || rawDist <= exactHitBufferKm;
    const distanceKm = isDirectHit ? 0 : result.distanceKm;

    const tolerance = state.settings.toleranceKm;
    const isMastered = tolerance === 0 ? isDirectHit : (isDirectHit || distanceKm <= tolerance);

    // Show target geometry on map
    const polyColor = isMastered ? '#16a34a' : '#ea580c';
    const polyFill = isMastered ? '#22c55e' : '#f97316';
    const isLineGeom = geometry.type === 'LineString' || geometry.type === 'MultiLineString';

    state.targetPolygonLayer = L.geoJSON(state.currentTarget, {
      style: {
        color: polyColor,
        weight: isLineGeom ? 4.5 : 2.5,
        opacity: isLineGeom ? 0.92 : 1,
        fillColor: polyFill,
        fillOpacity: isLineGeom ? 0 : 0.35
      },
      pointToLayer: function (feature, latlng) {
        return L.circleMarker(latlng, {
          radius: 8,
          color: polyColor,
          weight: 2.5,
          fillColor: polyFill,
          fillOpacity: 0.45
        });
      }
    }).addTo(map);

    // For small building footprints, add a subtle pulsing ring at the building center so it is easy to spot
    if (cat === 'gebouw' && state.targetPolygonLayer) {
      const bCenter = state.targetPolygonLayer.getBounds().getCenter();
      state.targetHighlightLayer = L.circleMarker(bCenter, {
        radius: 10,
        color: polyColor,
        weight: 2,
        fillColor: polyFill,
        fillOpacity: 0.25,
        interactive: false
      }).addTo(map);
    }

    // If incorrect, draw dashed line from Gok to nearest point on boundary/line
    if (!isMastered && result.nearestPoint) {
      const gokLatLng = [state.currentGok[0], state.currentGok[1]];
      const nearestLatLng = [result.nearestPoint[1], result.nearestPoint[0]];

      state.feedbackLineLayer = L.polyline([gokLatLng, nearestLatLng], {
        color: '#dc2626',
        weight: 2.5,
        dashArray: '6, 8',
        opacity: 0.85
      }).addTo(map);

      // Add tooltip showing distance on the midpoint of the line
      const midLat = (gokLatLng[0] + nearestLatLng[0]) / 2;
      const midLng = (gokLatLng[1] + nearestLatLng[1]) / 2;
      const distFormatted = distanceKm.toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

      state.feedbackLabelLayer = L.marker([midLat, midLng], {
        interactive: false,
        icon: L.divIcon({
          className: 'dist-label-icon',
          html: `<span class="distance-pill-tooltip">${distFormatted} km ernaast</span>`,
          iconSize: [120, 24],
          iconAnchor: [60, 12]
        })
      }).addTo(map);
    }

    // Camera framing: smoothly fit bounds to show both the gok and the target geometry
    const polyBounds = state.targetPolygonLayer.getBounds();
    const combinedBounds = polyBounds.extend([state.currentGok[0], state.currentGok[1]]);
    map.fitBounds(combinedBounds, {
      padding: [70, 70],
      maxZoom: cat === 'gebouw' ? 14 : 13,
      animate: true,
      duration: 0.6
    });

    // Update feedback box & reveal progress row
    const distStr = distanceKm.toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (isMastered) {
      el.feedbackBox.className = 'feedback-box success';
      if (isDirectHit || distanceKm === 0) {
        el.feedbackText.textContent = `Raak (0,0 km) · Beheerst`;
      } else {
        el.feedbackText.textContent = `Goed · ${distStr} km ernaast`;
      }

      // Mark as mastered and persist in localStorage
      const code = String(state.currentTarget.properties.code || state.currentTarget.properties.id);
      state.masteredCodes.add(code);
      saveStoredMastered();

      // Remove from active question pool
      state.questionPool = state.questionPool.filter(f => String(f.properties.code || f.properties.id) !== code);
      updateProgressUI();
      updateSettingsStatsUI();
    } else {
      el.feedbackBox.className = 'feedback-box incorrect';
      el.feedbackText.textContent = `${distStr} km ernaast`;
    }
    el.feedbackBox.style.display = 'flex';
    if (el.promptSubRow) el.promptSubRow.hidden = false;

    el.btnNext.focus();
  }

  /**
   * Setup UI event listeners
   */
  function setupEventListeners() {
    // Gameplay buttons
    el.btnOk.addEventListener('click', submitGuess);
    el.btnNext.addEventListener('click', nextQuestion);

    // Settings flyout toggling
    el.btnSettingsToggle.addEventListener('click', toggleSettings);
    el.btnSettingsClose.addEventListener('click', closeSettings);
    el.settingsBackdrop.addEventListener('click', closeSettings);

    // Settings: Kaartstijl segmented buttons
    if (el.settingsLayerNormal) el.settingsLayerNormal.addEventListener('click', () => setBaseLayer('normal'));
    if (el.settingsLayerSat) el.settingsLayerSat.addEventListener('click', () => setBaseLayer('satellite'));

    // Settings: Marge / Tolerantie segmented buttons
    if (el.toleranceBtns) {
      el.toleranceBtns.forEach(btn => {
        btn.addEventListener('click', function () {
          const tol = parseInt(this.getAttribute('data-tolerance'), 10);
          setTolerance(tol);
        });
      });
    }

    // Top-right quick style buttons
    el.styleNormalBtn.addEventListener('click', () => setBaseLayer('normal'));
    el.styleSatBtn.addEventListener('click', () => setBaseLayer('satellite'));

    // Settings: Category checkboxes & quick actions
    if (el.categoryCheckboxes) {
      el.categoryCheckboxes.forEach(cb => {
        cb.addEventListener('change', handleCategoryToggle);
      });
    }
    if (el.btnCatAll) el.btnCatAll.addEventListener('click', selectAllCategories);
    if (el.btnCatPlacesOnly) el.btnCatPlacesOnly.addEventListener('click', selectPlacesOnly);

    // Settings: Per-category difficulty tier buttons
    if (el.tierBtns) {
      el.tierBtns.forEach(btn => {
        btn.addEventListener('click', function () {
          const catId = this.getAttribute('data-category-tier');
          const tierVal = parseInt(this.getAttribute('data-tier'), 10);
          setCategoryTier(catId, tierVal);
        });
      });
    }

    // Settings: Province quick actions
    if (el.btnProvAll) el.btnProvAll.addEventListener('click', selectAllProvinces);
    if (el.btnProvClear) el.btnProvClear.addEventListener('click', clearAllProvinces);

    // Settings: Reset progress
    if (el.btnResetProgress) el.btnResetProgress.addEventListener('click', openResetModal);
    if (el.btnConfirmReset) el.btnConfirmReset.addEventListener('click', confirmResetProgress);
    if (el.btnCancelReset) el.btnCancelReset.addEventListener('click', closeResetModal);

    // Completion modal actions
    if (el.btnRestart) el.btnRestart.addEventListener('click', restartSession);
    if (el.btnOpenSettingsFromModal) {
      el.btnOpenSettingsFromModal.addEventListener('click', function () {
        closeCompletionModal();
        openSettings();
      });
    }

    // Keyboard shortcuts
    window.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

      if (e.code === 'Escape') {
        if (state.isResetModalOpen) {
          closeResetModal();
        } else if (state.isCompletionModalOpen) {
          closeCompletionModal();
        } else if (state.isSettingsOpen) {
          closeSettings();
        }
        return;
      }

      if (e.code === 'Enter') {
        if (state.isResetModalOpen || state.isCompletionModalOpen || state.isSettingsOpen) return;
        e.preventDefault();
        if (state.isFeedbackPhase) {
          nextQuestion();
        } else if (!el.btnOk.disabled) {
          submitGuess();
        }
      } else if (e.code === 'Space') {
        if (state.isResetModalOpen || state.isCompletionModalOpen || state.isSettingsOpen) return;
        if (state.isFeedbackPhase) {
          e.preventDefault();
          nextQuestion();
        }
      }
    });
  }

  // Initialize application on DOM ready
  document.addEventListener('DOMContentLoaded', function () {
    state.settings = loadStoredSettings();
    state.masteredCodes = loadStoredMastered();
    initMap();
    setupEventListeners();
    loadData();
  });

})();
