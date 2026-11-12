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

  // Storage keys for browser persistence
  const STORAGE_KEYS = {
    SETTINGS: 'topotrainer_settings_v1',
    MASTERED: 'topotrainer_mastered_v1'
  };

  const DEFAULT_SETTINGS = {
    baseLayer: 'normal',   // 'normal' | 'satellite'
    toleranceKm: 3,        // 0 (precies goed) | 3 (binnen 3 km)
    minInhabitants: 10000, // 50000 | 10000 | 2500 | 0
    provinces: []          // string[] (empty means all provinces / Heel Nederland)
  };

  // Game state
  const state = {
    allFeatures: [],              // All 2,503 GeoFeatures loaded from dataset
    currentFilteredFeatures: [],  // Subset of GeoFeatures matching active settings filters
    questionPool: [],             // Active Vraagpool (filtered features minus Beheerst)
    masteredCodes: new Set(),     // Set of mastered (Beheerst) woonplaatscodes from localStorage
    settings: { ...DEFAULT_SETTINGS },
    isSettingsOpen: false,
    isResetModalOpen: false,
    isCompletionModalOpen: false,
    currentTarget: null,          // Currently active Woonplaats GeoFeature
    currentGok: null,             // Current player guess: [lat, lon]
    gokMarker: null,              // Leaflet marker for Gok
    targetPolygonLayer: null,     // Leaflet GeoJSON layer for showing target polygon
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
    presetBtns: document.querySelectorAll('.preset-btn'),
    btnProvAll: document.getElementById('btn-prov-all'),
    btnProvClear: document.getElementById('btn-prov-clear'),
    provinceGrid: document.getElementById('province-grid'),

    // Settings stats & actions
    statsCurrentMastered: document.getElementById('stats-current-mastered'),
    statsCurrentTotal: document.getElementById('stats-current-total'),
    statsCurrentPct: document.getElementById('stats-current-pct'),
    statsTotalMastered: document.getElementById('stats-total-mastered'),
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
   * Load stored settings from localStorage with fallbacks
   */
  function loadStoredSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          baseLayer: parsed.baseLayer === 'satellite' ? 'satellite' : 'normal',
          toleranceKm: parsed.toleranceKm === 0 ? 0 : 3,
          minInhabitants: [50000, 10000, 2500, 0].includes(parsed.minInhabitants) ? parsed.minInhabitants : 10000,
          provinces: Array.isArray(parsed.provinces) ? parsed.provinces.filter(p => PROVINCES.includes(p)) : []
        };
      }
    } catch (err) {
      console.warn('Kon instellingen niet lezen uit localStorage:', err);
    }
    return { ...DEFAULT_SETTINGS };
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
   * Switch between Normal (Positron) and Satellite (PDOK Ortho)
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
   * Calculate filtered GeoFeatures matching active settings filters
   */
  function getFilteredFeatures() {
    const minInh = state.settings.minInhabitants;
    const selProvs = state.settings.provinces;
    const hasProvFilter = selProvs && selProvs.length > 0 && selProvs.length < PROVINCES.length;

    return state.allFeatures.filter(f => {
      const p = f.properties;
      const inh = p.inwoners || 0;

      // Inhabitant preset check (> N)
      if (minInh > 0 && inh <= minInh) return false;

      // Province filter check
      if (hasProvFilter && !selProvs.includes(p.provincie)) return false;

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
    updateSettingsStatsUI();
    updateProvinceCheckboxesCounts();
  }

  /**
   * Update progress counter and bar in top prompt card
   */
  function updateProgressUI() {
    const total = state.currentFilteredFeatures.length;
    const unmastered = state.questionPool.length;
    const mastered = total - unmastered; // Mastered within this filter set

    el.masteredCount.textContent = mastered;
    el.poolTotal.textContent = total;
    const pct = total > 0 ? Math.round((mastered / total) * 100) : 0;
    el.progressFill.style.width = pct + '%';
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

    // Total mastered across the complete 2,503 dataset
    if (el.statsTotalMastered) el.statsTotalMastered.textContent = state.masteredCodes.size;

    if (el.inhabitantsBadge) {
      el.inhabitantsBadge.textContent = `${totalInFilter} ${totalInFilter === 1 ? 'plaats' : 'plaatsen'}`;
    }
  }

  /**
   * Update province counts next to checkboxes based on active population preset
   */
  function updateProvinceCheckboxesCounts() {
    if (!el.provinceGrid) return;
    const minInh = state.settings.minInhabitants;

    // Count places per province matching minInhabitants
    const counts = {};
    PROVINCES.forEach(p => { counts[p] = 0; });
    state.allFeatures.forEach(f => {
      const p = f.properties.provincie;
      const inh = f.properties.inwoners || 0;
      if (minInh === 0 || inh > minInh) {
        if (counts[p] !== undefined) counts[p]++;
      }
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
      // If all or none are checked, treat as Heel Nederland
      state.settings.provinces = [];
      if (checkedProvinces.length === 0) {
        // If user unchecked everything, visually keep checkboxes checked for Heel Nederland
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
    // If cleared, user can check specific provinces
    state.settings.provinces = ['_none_']; // temporary marker indicating explicit empty selection
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
   * Update active inhabitant preset buttons UI
   */
  function updateInhabitantsPresetUI(val) {
    el.presetBtns.forEach(btn => {
      const inh = parseInt(btn.getAttribute('data-inhabitants'), 10);
      const isActive = inh === val;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
    });
  }

  /**
   * Change minimum inhabitants preset
   */
  function setMinInhabitants(val) {
    if (![50000, 10000, 2500, 0].includes(val)) return;
    if (state.settings.minInhabitants === val) return;

    state.settings.minInhabitants = val;
    saveStoredSettings();
    updateInhabitantsPresetUI(val);
    rebuildPoolAndUI();
    nextQuestion();
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
      el.completionMessage.innerHTML = `Je hebt alle <strong>${total}</strong> woonplaatsen in deze selectie <strong>Beheerst</strong>.<br>Alle gokken vielen binnen de polygoon of binnen de 3 km tolerantiegrens.`;
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
   * Restart session for current selection: resets mastered places within current filter
   */
  function restartSession() {
    closeCompletionModal();
    // Remove mastered codes that are in the current filter, or reset all if heel Nederland
    state.currentFilteredFeatures.forEach(f => {
      const code = String(f.properties.code || f.properties.id);
      state.masteredCodes.delete(code);
    });
    saveStoredMastered();
    rebuildPoolAndUI();
    nextQuestion();
  }

  /**
   * Load TopoJSON dataset and start game
   */
  async function loadData() {
    try {
      const response = await fetch('data/woonplaatsen.topo.json');
      if (!response.ok) {
        throw new Error('Kon data/woonplaatsen.topo.json niet laden: HTTP ' + response.status);
      }
      const topoData = await response.json();
      const geojson = topojson.feature(topoData, topoData.objects.woonplaatsen);
      state.allFeatures = geojson.features;

      renderProvinceCheckboxes();
      updateToleranceUI(state.settings.toleranceKm);
      updateInhabitantsPresetUI(state.settings.minInhabitants);
      rebuildPoolAndUI();
      nextQuestion();
    } catch (err) {
      console.error('Fout bij het laden van dataset:', err);
      el.targetName.textContent = 'Fout bij inladen';
      el.targetProvince.textContent = 'fout';
      el.targetDetails.textContent = 'Controleer netwerkverbinding of data/woonplaatsen.topo.json';
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

    // Check if filter has zero places matching criteria
    if (state.currentFilteredFeatures.length === 0) {
      el.targetName.textContent = 'Geen woonplaatsen';
      el.targetProvince.textContent = 'Filter leeg';
      el.targetDetails.textContent = 'Geen woonplaatsen gevonden voor deze selectie. Wijzig inwoners of provincies in Instellingen.';
      el.targetDetails.hidden = false;
      return;
    }

    // Check if all places in current filter are mastered
    if (state.questionPool.length === 0) {
      el.targetName.textContent = 'Selectie voltooid';
      el.targetProvince.textContent = '100% Beheerst';
      el.targetDetails.textContent = 'Alle woonplaatsen in deze selectie zijn beheerst. Open het instellingenmenu voor een nieuwe selectie.';
      el.targetDetails.hidden = false;
      if (el.promptSubRow) el.promptSubRow.hidden = false;
      showCompletionModal();
      return;
    }

    // Pick random target from active question pool
    const randomIndex = Math.floor(Math.random() * state.questionPool.length);
    state.currentTarget = state.questionPool[randomIndex];

    const p = state.currentTarget.properties;
    el.targetName.textContent = p.naam;
    el.targetProvince.textContent = p.categorie || 'plaats';

    // Hide provincie, gemeente and inwoners before OK is clicked
    el.targetDetails.textContent = '';
    el.targetDetails.hidden = true;
  }

  /**
   * Submit player guess and calculate distance to boundary
   */
  function submitGuess() {
    if (!state.currentGok || !state.currentTarget || state.isFeedbackPhase) return;

    state.isFeedbackPhase = true;

    // Switch buttons immediately: hide OK, show Volgende
    el.btnOk.hidden = true;
    el.btnOk.style.display = 'none';
    el.btnNext.hidden = false;
    el.btnNext.style.display = 'inline-flex';

    // Reveal provincie, gemeente and inwoners after OK is clicked
    const p = state.currentTarget.properties;
    const formattedInhabitants = (p.inwoners || 0).toLocaleString('nl-NL');
    const provText = p.provincie ? `${p.provincie} · ` : '';
    el.targetDetails.textContent = `${provText}Gemeente ${p.gemeente || p.naam} · ${formattedInhabitants} inwoners`;
    el.targetDetails.hidden = false;

    // Prevent dragging marker while showing feedback
    if (state.gokMarker && state.gokMarker.dragging) {
      state.gokMarker.dragging.disable();
    }

    // Gok point in [lon, lat] format for TopoGeometry
    const gokPoint = [state.currentGok[1], state.currentGok[0]];
    const geometry = state.currentTarget.geometry;

    // Compute shortest distance to boundary
    const result = TopoGeometry.getDistanceToGeometry(gokPoint, geometry);
    const distanceKm = result.distanceKm;
    const tolerance = state.settings.toleranceKm;
    const isMastered = tolerance === 0 ? result.inside : (result.inside || distanceKm <= tolerance);

    // Show target polygon on map
    const polyColor = isMastered ? '#16a34a' : '#ea580c';
    const polyFill = isMastered ? '#22c55e' : '#f97316';

    state.targetPolygonLayer = L.geoJSON(state.currentTarget, {
      style: {
        color: polyColor,
        weight: 2.5,
        fillColor: polyFill,
        fillOpacity: 0.35
      }
    }).addTo(map);

    // If incorrect, draw dashed line from Gok to nearest point on polygon boundary
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

    // Camera framing: smoothly fit bounds to show both the gok and the full target polygon
    const polyBounds = state.targetPolygonLayer.getBounds();
    const combinedBounds = polyBounds.extend([state.currentGok[0], state.currentGok[1]]);
    map.fitBounds(combinedBounds, {
      padding: [70, 70],
      maxZoom: 13,
      animate: true,
      duration: 0.6
    });

    // Update feedback box & reveal progress row
    const distStr = distanceKm.toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (isMastered) {
      el.feedbackBox.className = 'feedback-box success';
      if (result.inside || distanceKm === 0) {
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

    // Settings: Inhabitants presets
    el.presetBtns.forEach(btn => {
      btn.addEventListener('click', function () {
        const inh = parseInt(this.getAttribute('data-inhabitants'), 10);
        setMinInhabitants(inh);
      });
    });

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
      // Don't trigger shortcuts if focus is inside an input
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
