import "https://deno.land/x/dotenv/load.ts";
import { serve } from "https://deno.land/std/http/server.ts";
import * as twitter from "https://deno.land/x/twitter_api_client/mod.ts";
import { Cron } from "https://deno.land/x/croner/src/croner.js";
import { default as Mastodon } from "npm:mastodon";

const CHANNELS = ["alpha", "beta", "stable", "lts"];
const TIMEOUT_MS = parseInt(Deno.env.get("TIMEOUT_MS") || "600000"); // 10 minutes

interface Version {
  channel: string;
  major: number;
  minor: number;
  patch: number;
  release: Date;
}

// Twitter
const twitterAuth = {
  consumerKey: Deno.env.get("TWITTER_CONSUMER_API_KEY") || "",
  consumerSecret: Deno.env.get("TWITTER_CONSUMER_API_SECRET_KEY") || "",
  token: Deno.env.get("TWITTER_ACCESS_TOKEN") || "",
  tokenSecret: Deno.env.get("TWITTER_ACCESS_TOKEN_SECRET") || "",
};

// Mastodon
const mastodon = new Mastodon({
  access_token: Deno.env.get("MASTODON_ACCESS_TOKEN") || "",
  api_url: Deno.env.get("MASTODON_API_URL") || "",
});

// ThisDB
const thisdb = {
  apiKey: Deno.env.get("THISDB_API_KEY") || "",
  bucket: Deno.env.get("THISDB_BUCKET") || "",
};

// Get the latest versions from database
async function getLatestVersionsFromDatabase(channels: string[]) {
  return await Promise.all(
    channels.map(async (channel) => {
      const response = await fetch(
        `https://api.thisdb.com/v1/${thisdb.bucket}/${channel}`,
        {
          headers: {
            "X-Api-Key": thisdb.apiKey,
          },
          method: "GET",
        },
      );

      return response.json();
    }),
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
    const versions = onlineVersions[i];
    let latestVersion = storedVersions[i];

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

      if (version.release.valueOf() > latestVersion.release.valueOf()) {
        latestVersion = version;
      }
    }

    // Delete, create, and check
    await fetch(
      `https://api.thisdb.com/v1/${thisdb.bucket}/${latestVersion.channel}`,
      {
        headers: {
          "X-Api-Key": thisdb.apiKey,
        },
        method: "DELETE",
      },
    );
    await fetch(
      `https://api.thisdb.com/v1/${thisdb.bucket}/${latestVersion.channel}`,
      {
        headers: {
          "X-Api-Key": thisdb.apiKey,
        },
        method: "POST",
        body: JSON.stringify(latestVersion),
      },
    );
    const check = await fetch(
      `https://api.thisdb.com/v1/${thisdb.bucket}/${latestVersion.channel}`,
      {
        headers: {
          "X-Api-Key": thisdb.apiKey,
        },
        method: "GET",
      },
    ).then((response) => response.json());

    if (JSON.stringify(check) === JSON.stringify(latestVersion)) {
      if (JSON.stringify(latestVersion) !== JSON.stringify(storedVersions[i])) {
        console.log(
          `New version saved: ${latestVersion.major}.${latestVersion.minor}.${latestVersion.patch} (${latestVersion.channel})`,
        );
        // Post to Twitter
        newVersions.push(latestVersion);
      }
    } else {
      console.error(
        "ThisDB didn't update:\n",
        `\t${JSON.stringify(latestVersion)} (expeccted)\n`,
        `\t${JSON.stringify(check)} (returned)`,
      );
    }
  }

  return newVersions;
}

let lastCheckTimestamp = Date.now();
// Periodically check
new Cron(Deno.env.get("CRON") || "0 * * * * *", async () => {
  console.log(`[${new Date().toISOString()}] Version Check`);

  try {
    // Get latest versions
    const onlineVersions = await getLatestVersionsOnline(CHANNELS);
    const storedVersions = (await getLatestVersionsFromDatabase(CHANNELS))
      .map((version) => {
        version.release = new Date(version.release);
        return version;
      });

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
          if (result) console.log(`Tweet: ${tweet}`);
        });

      // Post to Mastodon
      mastodon
        .post("statuses", { status: tweet })
        .then((response: any) => {
          if (response) console.log(`Toot: ${tweet}`);
        });
    });

    // Update status
    lastCheckTimestamp = Date.now();
  } catch (error) {
    console.error(error);
  }
});

// HTTP server
const port: number = parseInt(Deno.env.get("PORT") || "8080");
await serve((): Response => {
  return new Response(
    new Date(lastCheckTimestamp).toUTCString(),
    {
      status: (Date.now() - lastCheckTimestamp > TIMEOUT_MS) ? 503 : 200,
    },
  );
}, { port: port });
