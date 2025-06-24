import express from "express";
import rateLimit from "express-rate-limit";
import redis from "redis";
import dotenv from "dotenv";
import cors from "cors";
import requestIp from "request-ip";
import { getNearbyPlaces } from "./src/getNearbyPoi.js";
import { MongoClient, ServerApiVersion } from "mongodb";
dotenv.config({ path: ".env" });

//redis and mongodb clients
const redisClient = redis.createClient({
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
  },
});

redisClient
  .connect()
  .then(() => {
    console.log("Redis connected");
  })
  .catch((err) => {
    console.log(err);
  });

const mongoClient = new MongoClient(process.env.MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
mongoClient
  .connect()
  .then(() => {
    console.log("MongoDB connected");
  })
  .catch((err) => {
    console.log(err);
  });

const app = express();
app.use(express.json());

// only allow requests from frontend part
app.use(
  cors({
    origin: "https://mapsy-theta.vercel.app",
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100, // max 100 requests from one ip per hour
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

app.get("/", (req, res) => {
  res.send("Server is alive");
});

// functions to check and increment hourly unique request count(max 5 non-cached requests per hour)
async function checkUniqueRequestLimit(ip) {
  const uniqueKey = `unique-requests-${ip}`;
  const currentCount = await redisClient.get(uniqueKey);

  if (currentCount && parseInt(currentCount) >= 5) {
    return false;
  }

  return true;
}

async function incrementUniqueRequestCount(ip) {
  const uniqueKey = `unique-requests-${ip}`;
  const currentCount = await redisClient.get(uniqueKey);

  if (currentCount) {
    await redisClient.incr(uniqueKey);
  } else {
    await redisClient.set(uniqueKey, 1, { EX: 60 * 60 }); // 1h
  }
}

function roundCord(coord, precision) {
  return parseFloat(coord.toFixed(precision));
}

//* main route
app.get("/nearby-places", async (req, res) => {
  const ip = requestIp.getClientIp(req);
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const roundedLat = roundCord(lat, 3);
  const roundedLon = roundCord(lon, 3);
  //? no need to check if lat/lon are valid, they're not user input

  //! 2 layer cache to minimize api key usage
  const cacheKey = `nearby-${roundedLat}-${roundedLon}`;

  // check redis cache
  const cachedData = await redisClient.get(cacheKey);
  if (cachedData) {
    console.log("Cache hit");
    res.json(JSON.parse(cachedData));
    return;
  }

  // check mongodb only if there is no data in redis
  const mongodbCacheCollection = mongoClient
    .db("PlacesData")
    .collection("savedPlaces");
  const mdbData = await mongodbCacheCollection.findOne({
    generalCoordinates: [roundedLat, roundedLon],
  });
  if (mdbData) {
    console.log("MongoDB hit");
    await redisClient.set(cacheKey, JSON.stringify(mdbData), {
      EX: 60 * 60 * 6, // set redis cache for quick access
    });
    res.json(mdbData);
    return;
  }

  try {
    // check unique request limit only if there is no cache
    console.log("Cache miss - checking unique request limit");
    const canMakeUniqueRequest = await checkUniqueRequestLimit(ip);

    if (!canMakeUniqueRequest) {
      return res.status(429).json({
        error:
          "Too many unique location requests. Maximum 5 new locations per hour.",
        code: "UNIQUE_REQUESTS_LIMIT_EXCEEDED",
      });
    }

    // increment unique request count
    await incrementUniqueRequestCount(ip);

    // get pois
    const sortedPoi = await getNearbyPlaces(lat, lon);
    if (sortedPoi.error) {
      return res.status(500).json({
        error: sortedPoi.error,
        code: "API_CREDITS_EXCEEDED",
      });
    }
    const nearbyPlaces = {
      forCoordinates: [lat, lon],
      requestedBy: ip,
      POIbyCategory: sortedPoi,
    };

    // save to redis cache
    await redisClient.set(cacheKey, JSON.stringify(nearbyPlaces), {
      EX: 60 * 60 * 6, // expires in 6 hours
    });

    // save to mongodb
    const generalizedPlaces = { ...nearbyPlaces };
    generalizedPlaces.generalCoordinates = [roundedLat, roundedLon];
    await mongodbCacheCollection.insertOne({
      ...generalizedPlaces,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000), // expires in 4 days
    });
    res.json(nearbyPlaces);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});
