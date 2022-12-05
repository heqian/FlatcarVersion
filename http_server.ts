import "https://deno.land/x/dotenv/load.ts";
import { serve } from "https://deno.land/std/http/server.ts";
import * as twitter from "https://deno.land/x/twitter_api_client/mod.ts";
import * as denodb from "https://deno.land/x/denodb/mod.ts";

import { Version } from "./model.ts";

const CHANNELS = ["alpha", "beta", "stable", "lts"];

// Twitter
const twitterAuth = {
  consumerKey: Deno.env.get("TWITTER_CONSUMER_API_KEY") || "",
  consumerSecret: Deno.env.get("TWITTER_CONSUMER_API_SECRET_KEY") || "",
  token: Deno.env.get("TWITTER_ACCESS_TOKEN") || "",
  tokenSecret: Deno.env.get("TWITTER_ACCESS_TOKEN_SECRET") || "",
};

// PostgreSQL
const database = new denodb.Database(
  new denodb.PostgresConnector({
    host: Deno.env.get("POSTGRESQL_HOST") || "",
    username: Deno.env.get("POSTGRESQL_USERNAME") || "",
    password: Deno.env.get("POSTGRESQL_PASSWORD") || "",
    database: Deno.env.get("POSTGRESQL_DATABASE") || "",
  }),
);
database.link([Version]);
await database.sync({ drop: false });

// Get the latest versions from database
async function getLatestVersionsFromDatabase(channels: string[]) {
  return await Promise.all(
    channels.map((channel) =>
      Version.where({ channel: channel }).orderBy("release", "desc")
        .first()
    ),
  );
}

// Get the latest versions from Flatcar API
async function getLatestVersionsOnline(channels: string[]) {
  return await Promise.all(
    channels.map(async (channel) => {
      const response = await fetch(
        `https://www.flatcar.org/releases-json/releases-${channel}.json`,
      );
      return response.json();
    }),
  );
}

// Update the database if new versions are found
async function update(storedVersions: Version[], onlineVersions: any[]) {
  const newVersions: Version[] = [];

  for (let i = 0; i < CHANNELS.length; i++) {
    const latestVersion = storedVersions[i];
    const versions = onlineVersions[i];

    // Online
    const versionNames = Object.keys(versions);
    for (const versionName of versionNames) {
      const versionParts = versionName.split(".");
      if (versionParts.length !== 3) continue;

      const details = versions[versionName];
      const version = {
        channel: details.channel,
        major: parseInt(versionParts[0]),
        minor: parseInt(versionParts[1]),
        patch: parseInt(versionParts[2]),
        release: new Date(details.release_date),
      };

      // Compare which one is newer
      if (
        !latestVersion ||
        !latestVersion.release ||
        version.release.valueOf() > latestVersion.release.valueOf()
      ) {
        // Check if already in database
        const query = await Version.where(version).get();
        if (query.length === 0) {
          // Save new versions to database
          const result = await Version.create(version);
          console.log(
            `Unknown new version saved: ${result.major}.${result.minor}.${result.patch} (${result.channel})`,
          );
          // Update the latest version
          newVersions.push(result);
        } else {
          console.error(
            `It is a known version. Why is it new? ${JSON.stringify(version)}`,
          );
        }
      }
    }
  }

  return newVersions;
}

let status = {};
// Periodically check
setInterval(async () => {
  console.log(`[${new Date().toISOString()}] Version Check`);

  try {
    // Get latest versions
    const storedVersions = await getLatestVersionsFromDatabase(CHANNELS);
    const onlineVersions = await getLatestVersionsOnline(CHANNELS);

    // Compare & update
    const newVersions = await update(storedVersions, onlineVersions);

    // Format tweet content
    newVersions.forEach((newVersion) => {
      let channelName = "Unknown";
      switch (newVersion.channel) {
        case "alpha":
          channelName = "Alpha";
          break;
        case "beta":
          channelName = "Beta";
          break;
        case "stable":
          channelName = "Stable";
          break;
        case "lts":
          channelName = "LTS";
          break;
      }

      const timestamp = newVersion.release?.valueOf() as number;
      const tweet =
        `Channel: ${channelName}\nVersion: ${newVersion.major}.${newVersion.minor}.${newVersion.patch}\nDate: ${
          new Date(timestamp).toISOString()
        }`;

      // Post on Twitter
      twitter
        .statusUpdate(twitterAuth, { status: tweet })
        .then((result) => {
          if (result) console.log(tweet);
        });
    });

    // Update status
    status = storedVersions;
  } catch (error) {
    console.error(error);
  }
}, parseInt(Deno.env.get("INTERVAL_MS") || "60000"));

// HTTP server
const port: number = parseInt(Deno.env.get("PORT") || "80");
await serve((): Response => {
  return new Response(
    JSON.stringify(status),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}, { port: port });
