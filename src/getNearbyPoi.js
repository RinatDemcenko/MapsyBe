import axios from "axios";
import dotenv from "dotenv";
import { simplify } from "simplify-geojson";
dotenv.config({ path: ".env" });

/**
 * Determines if a point lies within a polygon
 * @param {Array} point - [x, y] coordinates of the point
 * @param {Array} polygon - Array of [x, y] coordinates forming the polygon
 * @returns {boolean} - True if point is inside polygon, false otherwise
 */
export function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

/**
 * Categorizes a POI (Point of Interest) into predefined categories and adds it to the corresponding array
 * @param {Object} poi - Point of Interest object
 * @param {Array} poiCategories - Categories associated with the POI
 * @param {Object} appendTo - Object containing arrays for each category
 */
export function sortByCategory(poi, poiCategories, appendTo) {
  if (poiCategories.includes("commercial.supermarket")) {
    poi.properties.categories.push("supermarket");
    appendTo.supermarket.push(poi);
  } else if (poiCategories.includes("healthcare.pharmacy")) {
    poi.properties.categories.push("pharmacy");
    appendTo.pharmacy.push(poi);
  } else if (poiCategories.includes("catering.restaurant")) {
    poi.properties.categories.push("restaurant");
    appendTo.restaurant.push(poi);
  } else if (poiCategories.includes("catering.fast_food")) {
    poi.properties.categories.push("fastfood");
    appendTo.fastfood.push(poi);
  } else if (poiCategories.includes("accommodation.hotel")) {
    poi.properties.categories.push("hotel");
    appendTo.hotel.push(poi);
  }
}

/**
 * Fetches nearby places within a 5km radius and filters them based on walking distance isochrone
 * @param {number} lat - Latitude of the center point
 * @param {number} lon - Longitude of the center point
 * @returns {Object} - Sorted POIs by category within walking distance
 */
export async function getNearbyPlaces(lat, lon) {
  // Initialize object to store categorized POIs
  const sortedPOI = {
    supermarket: [],
    pharmacy: [],
    restaurant: [],
    fastfood: [],
    hotel: [],
  };

  // Fetch POIs from Geoapify API within 3km radius
  const geoApifyPOIRes = await axios.get(
    `https://api.geoapify.com/v2/places?` +
      `categories=commercial.supermarket,healthcare.pharmacy,catering.restaurant,` +
      `catering.fast_food,accommodation.hotel&` +
      `filter=circle:${lon},${lat},5000&` +
      `bias=proximity:${lon},${lat}&` +
      `limit=60&` +
      `apiKey=${process.env.GEOAPIFY_PLACES_KEY}`
  );

  // Check if API limit is not exceeded
  if (!geoApifyPOIRes.data.features) {
    return geoApifyPOIRes.data;
  }

  // Get 30-minute walking distance polygon from Mapbox Isochrone API
  let IsochronePolygon = [];
  try {
    const mapboxIsochroneRes = await axios.get(
      `https://api.mapbox.com/isochrone/v1/mapbox/walking/${lon}%2C${lat}?contours_minutes=30&polygons=true&denoise=1&generalize=300&access_token=${process.env.MAPBOX_ACCESS_TOKEN}`
    );
    const mapboxIsochrone = mapboxIsochroneRes.data.features[0];
    IsochronePolygon = mapboxIsochrone.geometry.coordinates[0];
  } catch (error) {
    console.error("Error getting mapbox isochrone:", error);
    return {
      error: "Error getting mb isochrone:" + error,
    };
  }


  // Filter POIs to only include those within walking distance
  const filteredPOI = geoApifyPOIRes.data.features.filter((poi) =>
    pointInPolygon(poi.geometry.coordinates, IsochronePolygon)
  );

  // Categorize filtered POIs
  filteredPOI.forEach((poi) => {
    sortByCategory(poi, poi.properties.categories, sortedPOI);
  });
  return sortedPOI;
}

