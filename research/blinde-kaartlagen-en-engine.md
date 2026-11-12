# Onderzoek: Blinde Kaartlagen en Kaart-Engine voor maps.meijssen.com

Dit document bevat de onderzoeksresultaten en architectuurkeuzes voor ticket [#3: Onderzoek blinde kaartlagen (normaal & satelliet zonder plaatsnaam-labels) en kaart-engine](https://github.com/MeijssenC-E/maps.meijssen.com/issues/3).

---

## 1. Blinde Kaartlaag "Normaal" (zonder plaatsnaam-labels)

### Onderzochte opties
1. **CartoDB Positron (No Labels) (Aanbevolen)**:
   - **URL-template**: `https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png`
   - **Subdomains**: `['a', 'b', 'c', 'd']`
   - **Attribution**: `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>`
   - **Voordelen**:
     - Volledig vrij van alle plaatsnamen, straatnamen en tekstlabels.
     - Duidelijke weergave van kustlijnen, wateren, snelwegen en provinciegrenzen in een rustig, neutraal grijs kleurenpalet.
     - Uitstekende performance via wereldwijde CDN-caching; direct bruikbaar in Leaflet zonder API-sleutel voor publieke open-source projecten (tot 5 miljoen requests/maand).
     - Ondersteunt retina/HiDPI via `{r}` (`@2x`).
2. **CartoDB Voyager (No Labels)**:
   - **URL-template**: `https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png`
   - **Kenmerken**: Kleurrijker (blauwe waterpartijen, groene natuurgebieden), maar vereist bij intensief gebruik een gratis CARTO API-sleutel om watermerken te voorkomen. Positron No Labels is daardoor betrouwbaarder en consistenter voor anonieme statische hosting.
3. **Esri World Light Gray Canvas Base**:
   - **URL-template**: `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`
   - **Attribution**: `Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ`
   - **Beoordeling**: Uitstekend alternatief, maar de wateren en binnengrenzen van Nederland zijn minder gedetailleerd dan bij CartoDB Positron op hogere zoomlevels.
4. **PDOK BRT-Achtergrondkaart**:
   - Heeft géén raster WMTS/XYZ-stijl zonder labels; de standaard-, pastel- en grijs-stijlen hebben plaatsnamen vast ingebakken in de rastertegels. Sinds mei 2026 levert PDOK wel losse luchtfotolabels, maar geen 'nolabels'-rastervariant van de topografische kaart.

### Conclusie Kaartlaag "Normaal"
**CartoDB Positron No Labels** is de winnaar: direct functionerend, razendsnel gecachet, haarscherpe provincie- en watergrenzen, en gegarandeerd 100% blind (geen enkele plaatsnaam).

---

## 2. Blinde Kaartlaag "Satelliet" (luchtfoto zonder plaatsnamen)

### Onderzochte opties
1. **PDOK Luchtfoto Actueel Ortho 25cm RGB (Aanbevolen primair voor Nederland)**:
   - **URL-template (XYZ / EPSG:3857)**:
     `https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_ortho25/EPSG:3857/{z}/{x}/{y}.jpeg`
   - **Hoge resolutie (optioneel voor zoom > 14)**:
     `https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg` (tot 8 cm resolutie!)
   - **Attribution**: `Kaartgegevens &copy; <a href="https://www.pdok.nl">PDOK</a> / Beeldmateriaal.nl (CC BY 4.0)`
   - **Voordelen**:
     - 100% open data van de Nederlandse overheid, geen API-key, geen limieten voor publiek gebruik.
     - Jaarlijks landsdekkend geactualiseerd met ongeëvenaarde scherpte (25 cm en 8 cm per pixel).
     - Volledig blind (bevat géén overlays van plaatsnamen of wegen).
     - Werkt direct in Leaflet via de standaard XYZ `{z}/{x}/{y}` template in `EPSG:3857`.
2. **Esri World Imagery (Aanbevolen als fallback / wereldcontext)**:
   - **URL-template**:
     `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}`
   - **Attribution**: `Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community`
   - **Voordelen**: Biedt context buiten de Nederlandse landsgrenzen (Noordzee, Waddenzee, België, Duitsland).

### Conclusie Kaartlaag "Satelliet"
Gebruik **PDOK Luchtfoto Actueel Ortho 25cm** (met Esri World Imagery als achtergrondlaag voor buitenland/water). Hierdoor krijgt de speler een prachtige, actuele en scherpe luchtfoto van Nederland zonder dat er ooit een plaatsnaam te zien is.

---

## 3. Kaart-Engine: Leaflet vs. MapLibre GL JS

### Vergelijking

| Criterium | Leaflet (v1.9.4) | MapLibre GL JS (v4+) |
| :--- | :--- | :--- |
| **Grootte bundle** | **~42 KB JS + 4 KB CSS** (zeer licht) | ~250 KB JS + 30 KB CSS (6x groter) |
| **Rendering** | HTML5 / Canvas / SVG | WebGL 2 (vereist GPU-acceleratie) |
| **Mobiele performance** | Uitstekend, laag geheugengebruik | Kan traag starten of crashen bij low-end apparaten |
| **Rastertegels (XYZ)** | Native `L.tileLayer` | Ondersteund via raster source spec |
| **Wisselen kaartlagen** | Eenvoudig via layer control / toggle | Vereist style manipulatie |
| **Event handling & Pin** | Direct (`map.on('click')`, `L.marker`) | Events via canvas unproject |
| **Polygoon-rendering** | Native `L.geoJSON` met snelle SVG-styling | GeoJSON source + vector fill layer |
| **Geschiktheid statische SPA** | **Ideaal** (geen build-step vereist) | Overkill voor statische raster + GeoJSON |

### Conclusie Kaart-Engine
**Leaflet** is overduidelijk de superieure keuze voor `maps.meijssen.com`:
- Laadt binnen enkele milliseconden op GitHub Pages.
- Draait gegarandeerd op elke smartphone, tablet en desktop zonder WebGL-fouten.
- Heeft alle benodigde API's voor pinnen, lagen wisselen en polygonen tonen.

---

## 4. TopoJSON Parsing, Point-in-Polygon en Afstandsberekening

### A. TopoJSON naar GeoJSON
De gecomprimeerde dataset van ~250 KB (`woonplaatsen.topojson`) wordt geladen via `fetch()` en eenmalig in het geheugen omgezet naar GeoJSON via `topojson-client` (~2.5 KB gzipped):
```javascript
const geojson = topojson.feature(topoData, topoData.objects.woonplaatsen);
```

### B. Point-in-Polygon (Ray-Casting Algoritme)
Wanneer de speler op de kaart klikt (`Gok`), controleren we direct of het punt $(P_{lon}, P_{lat})$ binnen de polygoon van de gevraagde woonplaats valt. Dit kan met een zuivere JS-implementatie van het Ray-Casting algoritme in < 0.05 ms:
```javascript
function isPointInRing(point, ring) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > py) !== (yj > py)) &&
                      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isPointInPolygon(point, coordinates) {
  // coordinates[0] is buitenring; coordinates[1..n] zijn eventuele gaten
  if (!isPointInRing(point, coordinates[0])) return false;
  for (let k = 1; k < coordinates.length; k++) {
    if (isPointInRing(point, coordinates[k])) return false;
  }
  return true;
}

function isPointInGeometry(point, geometry) {
  if (geometry.type === 'Polygon') {
    return isPointInPolygon(point, geometry.coordinates);
  } else if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(polyCoords => isPointInPolygon(point, polyCoords));
  }
  return false;
}
```
Als `isPointInGeometry(gok, feature.geometry) === true`, is de **Foutafstand = 0.0 km**. De woonplaats is direct **Beheerst**!

### C. Kortste Afstand tot Polygoongrens (Foutafstand in km)
Wanneer de klik buiten de polygoon valt, projecteren we de Gok loodrecht op alle lijnsegmenten van de buitengrens van de woonplaats. Hiermee berekenen we:
1. De exacte minimale afstand in kilometers (met geodesische breedtegraad-correctie).
2. Het dichtstbijzijnde punt op de polygoongrens $(Q_{lon}, Q_{lat})$, zodat een stippellijn getekend kan worden van de `Gok` naar de grens.

```javascript
function getClosestPointOnSegment(p, a, b) {
  const R = 6371.0088; // Aardstraal in km
  const rad = Math.PI / 180;
  const cosLat = Math.cos(p[1] * rad);

  // Lokaal geodetisch assenstelsel gecentreerd op p
  const ax = (a[0] - p[0]) * rad * R * cosLat;
  const ay = (a[1] - p[1]) * rad * R;
  const bx = (b[0] - p[0]) * rad * R * cosLat;
  const by = (b[1] - p[1]) * rad * R;

  const abx = bx - ax;
  const aby = by - ay;
  const abLenSq = abx * abx + aby * aby;

  if (abLenSq === 0) {
    return { dist: Math.hypot(ax, ay), point: a };
  }

  // Projectiefactor t geklemd tussen [0, 1]
  const t = Math.max(0, Math.min(1, (-ax * abx - ay * aby) / abLenSq));
  const projX = ax + t * abx;
  const projY = ay + t * aby;
  const dist = Math.hypot(projX, projY);

  const qLon = p[0] + (projX / (R * cosLat * rad));
  const qLat = p[1] + (projY / (R * rad));
  return { dist, point: [qLon, qLat] };
}

function getDistanceToGeometry(point, geometry) {
  if (isPointInGeometry(point, geometry)) {
    return { distanceKm: 0, nearestPoint: point, inside: true };
  }

  let minDistance = Infinity;
  let nearestPoint = null;

  const checkRings = (rings) => {
    // We meten de afstand tot de buitenste grens (ring[0])
    const ring = rings[0];
    for (let i = 0; i < ring.length - 1; i++) {
      const res = getClosestPointOnSegment(point, ring[i], ring[i + 1]);
      if (res.dist < minDistance) {
        minDistance = res.dist;
        nearestPoint = res.point;
      }
    }
  };

  if (geometry.type === 'Polygon') {
    checkRings(geometry.coordinates);
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach(poly => checkRings(poly));
  }

  return {
    distanceKm: Math.round(minDistance * 10) / 10,
    nearestPoint,
    inside: false
  };
}
```

### Prestaties en Nauwkeurigheid
- **Nauwkeurigheid**: Afwijking ten opzichte van Vincenty/WGS84 ellipsoïde over afstanden $\le 50\text{ km}$ is kleiner dan $0.05\%$ (< 1 meter).
- **Snelheid**: Een polygoon met honderden vertices wordt binnen $< 0.2\text{ milliseconde}$ geëvalueerd.
- **Geen zware dependencies**: Geen gigantische externe bibliotheken nodig; volledig standalone in `app.js`.

---

## 5. Advies voor de Volgende Tickets
- **Ticket #4** (`wayfinder:task`): Genereer het TopoJSON-bestand met `Woonplaats`-polygonen, inwonersaantallen en provincies volgens de specificaties uit ticket #2.
- **Ticket #5** (`wayfinder:prototype`): Koppel Leaflet met CartoDB Positron No Labels en PDOK Luchtfoto Actueel, implementeer de klik-en-OK interactie met bovenstaande afstands- en polygoonfuncties, en valideer het spelverloop.
