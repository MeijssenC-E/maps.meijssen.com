/**
 * Geometry and geodesic distance calculations for Topografie Trainer
 * (maps.meijssen.com)
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TopoGeometry = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const R = 6371.0088; // Earth mean radius in kilometers (IUGG WGS84)
  const RAD = Math.PI / 180;

  /**
   * Ray-Casting algorithm for point in polygon ring
   * point: [lon, lat]
   * ring: array of [lon, lat]
   */
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

  /**
   * Checks if point [lon, lat] is inside a polygon with optional holes
   * coordinates: [outerRing, ...holeRings]
   */
  function isPointInPolygon(point, coordinates) {
    if (!coordinates || coordinates.length === 0) return false;
    // coordinates[0] is outer ring
    if (!isPointInRing(point, coordinates[0])) return false;
    // coordinates[1..n] are holes
    for (let k = 1; k < coordinates.length; k++) {
      if (isPointInRing(point, coordinates[k])) return false;
    }
    return true;
  }

  /**
   * Checks if point [lon, lat] is inside a GeoJSON Polygon, MultiPolygon, or GeometryCollection
   */
  function isPointInGeometry(point, geometry) {
    if (!geometry) return false;
    if (geometry.type === 'Polygon') {
      return isPointInPolygon(point, geometry.coordinates);
    } else if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.some(polyCoords => isPointInPolygon(point, polyCoords));
    } else if (geometry.type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
      return geometry.geometries.some(g => isPointInGeometry(point, g));
    }
    return false;
  }

  /**
   * Projects point p [lon, lat] onto segment a-b [lon, lat] using local equirectangular
   * projection centered at p, which is extremely accurate (< 0.05% error) for distances <= 500 km.
   * Returns { dist: number (km), point: [lon, lat] }
   */
  function getClosestPointOnSegment(p, a, b) {
    const cosLat = Math.cos(p[1] * RAD);

    const ax = (a[0] - p[0]) * RAD * R * cosLat;
    const ay = (a[1] - p[1]) * RAD * R;
    const bx = (b[0] - p[0]) * RAD * R * cosLat;
    const by = (b[1] - p[1]) * RAD * R;

    const abx = bx - ax;
    const aby = by - ay;
    const abLenSq = abx * abx + aby * aby;

    if (abLenSq === 0) {
      return { dist: Math.hypot(ax, ay), point: a };
    }

    // Projection factor t clamped to [0, 1]
    const t = Math.max(0, Math.min(1, (-ax * abx - ay * aby) / abLenSq));
    const projX = ax + t * abx;
    const projY = ay + t * aby;
    const dist = Math.hypot(projX, projY);

    const qLon = p[0] + (projX / (R * cosLat * RAD));
    const qLat = p[1] + (projY / (R * RAD));
    return { dist, point: [qLon, qLat] };
  }

  /**
   * Calculates the shortest distance (Foutafstand) in kilometers from point [lon, lat]
   * to the boundary or segments of geometry (Polygon, MultiPolygon, LineString, MultiLineString, Point).
   * If point is inside a polygon geometry, distance is 0 km.
   * Returns {
   *   distanceKm: number,
   *   rawDistanceKm: number,
   *   nearestPoint: [lon, lat],
   *   inside: boolean
   * }
   */
  function getDistanceToGeometry(point, geometry) {
    if (!geometry) {
      return {
        distanceKm: 0,
        rawDistanceKm: 0,
        nearestPoint: [point[0], point[1]],
        inside: false
      };
    }

    if (isPointInGeometry(point, geometry)) {
      return {
        distanceKm: 0,
        rawDistanceKm: 0,
        nearestPoint: [point[0], point[1]],
        inside: true
      };
    }

    let minDistance = Infinity;
    let nearestPoint = null;

    const checkLineCoords = (coords) => {
      if (!coords || coords.length === 0) return;
      if (coords.length === 1) {
        const res = getClosestPointOnSegment(point, coords[0], coords[0]);
        if (res.dist < minDistance) {
          minDistance = res.dist;
          nearestPoint = res.point;
        }
        return;
      }
      for (let i = 0; i < coords.length - 1; i++) {
        const res = getClosestPointOnSegment(point, coords[i], coords[i + 1]);
        if (res.dist < minDistance) {
          minDistance = res.dist;
          nearestPoint = res.point;
        }
      }
    };

    const checkPolygonRings = (rings) => {
      if (!rings || rings.length === 0) return;
      for (let r = 0; r < rings.length; r++) {
        checkLineCoords(rings[r]);
      }
    };

    const inspectGeom = (geom) => {
      if (!geom) return;
      if (geom.type === 'Polygon') {
        checkPolygonRings(geom.coordinates);
      } else if (geom.type === 'MultiPolygon') {
        geom.coordinates.forEach(rings => checkPolygonRings(rings));
      } else if (geom.type === 'LineString') {
        checkLineCoords(geom.coordinates);
      } else if (geom.type === 'MultiLineString') {
        geom.coordinates.forEach(line => checkLineCoords(line));
      } else if (geom.type === 'Point') {
        checkLineCoords([geom.coordinates]);
      } else if (geom.type === 'MultiPoint') {
        geom.coordinates.forEach(pt => checkLineCoords([pt]));
      } else if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
        geom.geometries.forEach(g => inspectGeom(g));
      }
    };

    inspectGeom(geometry);

    if (!Number.isFinite(minDistance)) {
      minDistance = 0;
    }

    return {
      distanceKm: Math.round(minDistance * 10) / 10,
      rawDistanceKm: minDistance,
      nearestPoint: nearestPoint || point,
      inside: false
    };
  }

  /**
   * Calculates standard Haversine distance between two points in km
   */
  function haversineDistance(p1, p2) {
    const lat1 = p1[1] * RAD;
    const lat2 = p2[1] * RAD;
    const dLat = (p2[1] - p1[1]) * RAD;
    const dLon = (p2[0] - p1[0]) * RAD;

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  return {
    isPointInRing,
    isPointInPolygon,
    isPointInGeometry,
    getClosestPointOnSegment,
    getDistanceToGeometry,
    haversineDistance
  };
}));
