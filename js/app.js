/**
 * Topografie Trainer (maps.meijssen.com)
 * Core gameplay logic and Leaflet integration for Ticket #5
 */

(function () {
  'use strict';

  // Game state
  const state = {
    allFeatures: [],        // All 2,503 GeoFeatures loaded from dataset
    questionPool: [],       // Active Vraagpool for current session (e.g. >10k inhabitants)
    masteredCodes: new Set(), // Set of mastered (Beheerst) woonplaatscodes in current session
    currentTarget: null,    // Currently active Woonplaats GeoFeature
    currentGok: null,       // Current player guess: [lat, lon]
    gokMarker: null,        // Leaflet marker for Gok
    targetPolygonLayer: null, // Leaflet GeoJSON layer for showing target polygon
    feedbackLineLayer: null,  // Leaflet polyline for dashed distance line
    activeBaseLayer: 'normal', // 'normal' | 'satellite'
    isFeedbackPhase: false  // true when showing results before 'Volgende' is clicked
  };

  // Leaflet map instance and tile layers
  let map = null;
  let normalTileLayer = null;
  let satelliteTileLayers = [];

  // DOM Elements
  const el = {
    targetName: document.getElementById('target-name'),
    targetProvince: document.getElementById('target-province'),
    targetDetails: document.getElementById('target-details'),
    masteredCount: document.getElementById('mastered-count'),
    poolTotal: document.getElementById('pool-total'),
    progressFill: document.getElementById('progress-fill'),
    btnOk: document.getElementById('btn-ok'),
    btnNext: document.getElementById('btn-next'),
    feedbackBox: document.getElementById('feedback-box'),
    feedbackText: document.getElementById('feedback-text'),
    styleNormalBtn: document.getElementById('style-normal'),
    styleSatBtn: document.getElementById('style-sat'),
    completionModal: document.getElementById('completion-modal'),
    btnRestart: document.getElementById('btn-restart')
  };

  /**
   * Initialize Leaflet map and base tile layers
   */
  function initMap() {
    // Center of the Netherlands
    const defaultCenter = [52.1326, 5.2913];
    const defaultZoom = 8;

    map = L.map('map', {
      center: defaultCenter,
      zoom: defaultZoom,
      minZoom: 7,
      maxZoom: 18,
      zoomControl: false
    });

    // Zoom control at bottom-right
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // CartoDB Positron No Labels (Normal blind map)
    normalTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>'
    });

    // PDOK Luchtfoto Actueel Ortho 25cm (Blind Satellite layer)
    const pdokSatLayer = L.tileLayer('https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_ortho25/EPSG:3857/{z}/{x}/{y}.jpeg', {
      maxZoom: 19,
      attribution: 'Kaartgegevens &copy; <a href="https://www.pdok.nl" target="_blank" rel="noopener">PDOK</a> / Beeldmateriaal.nl'
    });

    // Esri World Imagery fallback for international context
    const esriWorldLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri'
    });

    satelliteTileLayers = [esriWorldLayer, pdokSatLayer];

    // Add normal layer by default
    normalTileLayer.addTo(map);

    // Click handler on map
    map.on('click', handleMapClick);
  }

  /**
   * Switch between Normal (Positron) and Satellite (PDOK Ortho)
   */
  function setBaseLayer(type) {
    if (type === state.activeBaseLayer) return;

    if (type === 'satellite') {
      map.removeLayer(normalTileLayer);
      satelliteTileLayers.forEach(l => l.addTo(map));
      state.activeBaseLayer = 'satellite';
      el.styleSatBtn.classList.add('active');
      el.styleNormalBtn.classList.remove('active');
    } else {
      satelliteTileLayers.forEach(l => map.removeLayer(l));
      normalTileLayer.addTo(map);
      state.activeBaseLayer = 'normal';
      el.styleNormalBtn.classList.add('active');
      el.styleSatBtn.classList.remove('active');
    }
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
   * Load dataset and initialize question pool
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

      // Filter default preset: > 10.000 inwoners (standard quiz preset, 334 places)
      // Any places with >10,000 inhabitants
      const defaultPool = state.allFeatures.filter(f => (f.properties.inwoners || 0) > 10000);
      state.questionPool = defaultPool.length > 0 ? defaultPool : state.allFeatures;

      updateProgressUI();
      nextQuestion();
    } catch (err) {
      console.error('Fout bij het laden van dataset:', err);
      el.targetName.textContent = 'Fout bij inladen';
      el.targetProvince.textContent = err.message;
    }
  }

  /**
   * Update progress counter and bar in UI
   */
  function updateProgressUI() {
    const total = state.questionPool.length + state.masteredCodes.size;
    const mastered = state.masteredCodes.size;
    el.masteredCount.textContent = mastered;
    el.poolTotal.textContent = total;
    const pct = total > 0 ? Math.round((mastered / total) * 100) : 0;
    el.progressFill.style.width = pct + '%';
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

    state.currentGok = null;

    // Hide feedback box
    el.feedbackBox.className = 'feedback-box';
    el.feedbackBox.style.display = 'none';

    // Button states
    el.btnNext.style.display = 'none';
    el.btnOk.style.display = 'inline-flex';
    el.btnOk.disabled = true;

    // Check if pool is finished
    if (state.questionPool.length === 0) {
      showCompletionModal();
      return;
    }

    // Pick random target from pool
    const randomIndex = Math.floor(Math.random() * state.questionPool.length);
    state.currentTarget = state.questionPool[randomIndex];

    const p = state.currentTarget.properties;
    el.targetName.textContent = p.naam;
    el.targetProvince.textContent = p.provincie || 'Nederland';
    
    const formattedInhabitants = (p.inwoners || 0).toLocaleString('nl-NL');
    el.targetDetails.textContent = `Gemeente ${p.gemeente || p.naam} • ${formattedInhabitants} inwoners`;
  }

  /**
   * Submit player guess and calculate distance to boundary
   */
  function submitGuess() {
    if (!state.currentGok || !state.currentTarget || state.isFeedbackPhase) return;

    state.isFeedbackPhase = true;

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
    const isMastered = result.inside || distanceKm <= 3.0;

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

    // If incorrect (> 3km), draw dashed line from Gok to nearest point on polygon boundary
    if (!isMastered && result.nearestPoint) {
      const gokLatLng = [state.currentGok[0], state.currentGok[1]];
      const nearestLatLng = [result.nearestPoint[1], result.nearestPoint[0]];

      state.feedbackLineLayer = L.polyline([gokLatLng, nearestLatLng], {
        color: '#dc2626',
        weight: 3,
        dashArray: '6, 8',
        opacity: 0.85
      }).addTo(map);

      // Add tooltip showing distance on the midpoint of the line
      const midLat = (gokLatLng[0] + nearestLatLng[0]) / 2;
      const midLng = (gokLatLng[1] + nearestLatLng[1]) / 2;
      const distFormatted = distanceKm.toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

      const distMarker = L.marker([midLat, midLng], {
        icon: L.divIcon({
          className: 'dist-label-icon',
          html: `<span class="distance-pill-tooltip">${distFormatted} km</span>`,
          iconSize: [80, 24],
          iconAnchor: [40, 12]
        })
      });
      state.feedbackLineLayer.addLayer(distMarker);
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

    // Update feedback box
    const distStr = distanceKm.toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (isMastered) {
      el.feedbackBox.className = 'feedback-box success';
      if (result.inside || distanceKm === 0) {
        el.feedbackText.textContent = `🎯 Precies raak! (0,0 km). Woonplaats beheerst!`;
      } else {
        el.feedbackText.textContent = `✓ Goed! Slechts ${distStr} km van de grens (toegestaan: ≤ 3 km).`;
      }

      // Mark as mastered and remove from question pool
      const code = state.currentTarget.properties.code || state.currentTarget.properties.id;
      state.masteredCodes.add(code);
      state.questionPool = state.questionPool.filter(f => (f.properties.code || f.properties.id) !== code);
      updateProgressUI();
    } else {
      el.feedbackBox.className = 'feedback-box incorrect';
      el.feedbackText.textContent = `✗ Helaas! Foutafstand: ${distStr} km van de grens. Blijft in de vraagpool.`;
    }
    el.feedbackBox.style.display = 'flex';

    // Switch buttons: hide OK, show Volgende
    el.btnOk.style.display = 'none';
    el.btnNext.style.display = 'inline-flex';
    el.btnNext.focus();
  }

  /**
   * Display completion celebration modal
   */
  function showCompletionModal() {
    el.completionModal.classList.add('active');
  }

  /**
   * Restart session / reset pool
   */
  function restartSession() {
    el.completionModal.classList.remove('active');
    state.masteredCodes.clear();
    const defaultPool = state.allFeatures.filter(f => (f.properties.inwoners || 0) > 10000);
    state.questionPool = defaultPool.length > 0 ? defaultPool : [...state.allFeatures];
    updateProgressUI();
    nextQuestion();
  }

  /**
   * Setup UI and keyboard event listeners
   */
  function setupEventListeners() {
    el.btnOk.addEventListener('click', submitGuess);
    el.btnNext.addEventListener('click', nextQuestion);
    el.btnRestart.addEventListener('click', restartSession);

    // Kaartlaag wisselen
    el.styleNormalBtn.addEventListener('click', () => setBaseLayer('normal'));
    el.styleSatBtn.addEventListener('click', () => setBaseLayer('satellite'));

    // Keyboard shortcuts:
    // Enter: OK (when placing guess) or Next (when in feedback phase)
    // Space: Next (when in feedback phase)
    window.addEventListener('keydown', function (e) {
      // Don't trigger if focus is on an input or button
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

      if (e.code === 'Enter') {
        e.preventDefault();
        if (state.isFeedbackPhase) {
          nextQuestion();
        } else if (!el.btnOk.disabled) {
          submitGuess();
        }
      } else if (e.code === 'Space') {
        if (state.isFeedbackPhase) {
          e.preventDefault();
          nextQuestion();
        }
      }
    });
  }

  // Initialize application on DOM ready
  document.addEventListener('DOMContentLoaded', function () {
    initMap();
    setupEventListeners();
    loadData();
  });

})();
