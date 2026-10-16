#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

/**
 * Public-interface client for Haqybat Al-Momen / hmomen.com prayer data.
 * It retries the public documented endpoint, then calculates a clearly marked
 * fallback using the same public PrayTimes configuration seen in hmomen.com.
 * It intentionally never uses client-side keys.
 * Read TECHNICAL_WALKTHROUGH_AR.md for a complete Arabic explanation of the
 * request flow, the retry policy, every calculation stage, and the JSON schema.
 *
 * Examples:
 *   node fetch-hmomen-prayer.mjs --search "النجف"
 *   node fetch-hmomen-prayer.mjs --prayer --city-id 65
 *   node fetch-hmomen-prayer.mjs --prayer --timezone +3 --long 44.2594504 --lati 32.0218391
 *   node fetch-hmomen-prayer.mjs --prayer --city-id 65 --retry-forever --no-fallback
 */

const GEO_BASE = "https://hmomen.com/api/geolocation";
const PRAYER_ENDPOINT = "https://hq.alkafeel.net/Api/init/init.php";
const REQUIRED_OFFICIAL_TIME_FIELDS = [
  "fajir",
  "sunrise",
  "doher",
  "sunset",
  "maghrib",
];

const METHOD_PARAMS = {
  Jafari: { fajr: 18, isha: 14, maghrib: 4, midnight: "Jafari" },
  Tehran: { fajr: 17.7, isha: 14, maghrib: 4.5, midnight: "Jafari" },
  Karachi: { fajr: 18, isha: 18, maghrib: "0 min", midnight: "Standard" },
  Makkah: {
    fajr: 18.5,
    isha: "90 min",
    maghrib: "0 min",
    midnight: "Standard",
  },
  Egypt: { fajr: 19.5, isha: 17.5, maghrib: "0 min", midnight: "Standard" },
  ISNA: { fajr: 15, isha: 15, maghrib: "0 min", midnight: "Standard" },
  MWL: { fajr: 18, isha: 17, maghrib: "0 min", midnight: "Standard" },
};

const CLIENT_BASELINE_SETTINGS = {
  imsak: "10 min",
  dhuhr: "0 min",
  asr: "Standard",
  highLats: "NightMiddle",
};

function readFlag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readPositiveInteger(name, fallback, minimum = 1) {
  const value = Number.parseInt(readFlag(name) ?? "", 10);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function readNumber(name) {
  const value = Number(readFlag(name));
  return Number.isFinite(value) ? value : undefined;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function usage() {
  console.error(
    "Usage: --search <city> | --city-id <id> | --country <code> | --countries | --prayer [--city-id <id> | --timezone <offset> --long <longitude> --lati <latitude>] [--date YYYY-MM-DD] [--method Jafari] [--retries 3] [--delay-ms 2000] [--retry-forever --no-fallback] [--output result.json]",
  );
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" },
    ...options,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return {
    url: url.toString(),
    status: response.status,
    ok: response.ok,
    responseBytes: Buffer.byteLength(text),
    data,
  };
}

function hasPrayerPayload(result) {
  return Boolean(
    result.ok &&
      result.data &&
      typeof result.data === "object" &&
      REQUIRED_OFFICIAL_TIME_FIELDS.every(
        (field) =>
          typeof result.data[field] === "string" && result.data[field].trim(),
      ),
  );
}

function fix(value, range) {
  let result = value - range * Math.floor(value / range);
  return result < 0 ? result + range : result;
}

const math = {
  sin: (degrees) => Math.sin((degrees * Math.PI) / 180),
  cos: (degrees) => Math.cos((degrees * Math.PI) / 180),
  tan: (degrees) => Math.tan((degrees * Math.PI) / 180),
  arcsin: (value) => (Math.asin(value) * 180) / Math.PI,
  arccos: (value) => (Math.acos(value) * 180) / Math.PI,
  arctan2: (y, x) => (Math.atan2(y, x) * 180) / Math.PI,
  arccot: (value) => (Math.atan(1 / value) * 180) / Math.PI,
  fixAngle: (value) => fix(value, 360),
  fixHour: (value) => fix(value, 24),
  timeDiff: (time1, time2) => fix(time2 - time1, 24),
};

function julianDate(year, month, day) {
  let adjustedYear = year;
  let adjustedMonth = month;
  if (adjustedMonth <= 2) {
    adjustedYear -= 1;
    adjustedMonth += 12;
  }
  const a = Math.floor(adjustedYear / 100);
  return (
    Math.floor(365.25 * (adjustedYear + 4716)) +
    Math.floor(30.6001 * (adjustedMonth + 1)) +
    day +
    (2 - a + Math.floor(a / 4)) -
    1524.5
  );
}

function parseDate(value, timezoneHours = 0) {
  if (!value) {
    const current = new Date(Date.now() + timezoneHours * 60 * 60 * 1000);
    const year = current.getUTCFullYear();
    const month = current.getUTCMonth() + 1;
    const day = current.getUTCDate();
    return {
      year,
      month,
      day,
      iso: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("--date must use YYYY-MM-DD.");
  const [, year, month, day] = match;
  const safeDate = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  if (
    safeDate.getUTCFullYear() !== Number(year) ||
    safeDate.getUTCMonth() !== Number(month) - 1 ||
    safeDate.getUTCDate() !== Number(day)
  ) {
    throw new Error("--date is not a valid calendar date.");
  }
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    iso: value,
  };
}

function evaluate(value) {
  return Number.parseFloat(String(value));
}

function isMinutes(value) {
  return typeof value === "string" && value.includes("min");
}

function format24(time) {
  if (!Number.isFinite(time)) return "-----";
  const adjusted = math.fixHour(time + 0.5 / 60);
  const hours = Math.floor(adjusted);
  const minutes = Math.floor((adjusted - hours) * 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function format12(time) {
  if (!Number.isFinite(time)) return "-----";
  const adjusted = math.fixHour(time + 0.5 / 60);
  const hours = Math.floor(adjusted);
  const minutes = Math.floor((adjusted - hours) * 60);
  return `${((hours + 11) % 12) + 1}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
}

function calculateHmomenClientTimes({
  date,
  latitude,
  longitude,
  timezone,
  method,
}) {
  const methodParams = METHOD_PARAMS[method];
  if (!methodParams)
    throw new Error(
      `Unknown --method. Use one of: ${Object.keys(METHOD_PARAMS).join(", ")}.`,
    );

  const settings = { ...CLIENT_BASELINE_SETTINGS, ...methodParams };
  const jDate =
    julianDate(date.year, date.month, date.day) - longitude / (15 * 24);

  function sunPosition(julian) {
    const d = julian - 2451545.0;
    const g = math.fixAngle(357.529 + 0.98560028 * d);
    const q = math.fixAngle(280.459 + 0.98564736 * d);
    const l = math.fixAngle(q + 1.915 * math.sin(g) + 0.02 * math.sin(2 * g));
    const e = 23.439 - 0.00000036 * d;
    const rightAscension =
      math.arctan2(math.cos(e) * math.sin(l), math.cos(l)) / 15;
    return {
      declination: math.arcsin(math.sin(e) * math.sin(l)),
      equation: q / 15 - math.fixHour(rightAscension),
    };
  }

  function midDay(time) {
    return math.fixHour(12 - sunPosition(jDate + time).equation);
  }

  function sunAngleTime(angle, time, direction) {
    const declination = sunPosition(jDate + time).declination;
    const noon = midDay(time);
    const hours =
      (1 / 15) *
      math.arccos(
        (-math.sin(angle) - math.sin(declination) * math.sin(latitude)) /
          (math.cos(declination) * math.cos(latitude)),
      );
    return noon + (direction === "ccw" ? -hours : hours);
  }

  function asrTime(factor, time) {
    const declination = sunPosition(jDate + time).declination;
    const angle = -math.arccot(
      factor + math.tan(Math.abs(latitude - declination)),
    );
    return sunAngleTime(angle, time);
  }

  function dayPortion(times) {
    return Object.fromEntries(
      Object.entries(times).map(([key, time]) => [key, time / 24]),
    );
  }

  function computePrayerTimes(times) {
    const time = dayPortion(times);
    const riseSetAngle = 0.833;
    return {
      imsak: sunAngleTime(evaluate(settings.imsak), time.imsak, "ccw"),
      fajr: sunAngleTime(evaluate(settings.fajr), time.fajr, "ccw"),
      sunrise: sunAngleTime(riseSetAngle, time.sunrise, "ccw"),
      dhuhr: midDay(time.dhuhr),
      asr: asrTime(settings.asr === "Hanafi" ? 2 : 1, time.asr),
      sunset: sunAngleTime(riseSetAngle, time.sunset),
      maghrib: sunAngleTime(evaluate(settings.maghrib), time.maghrib),
      isha: sunAngleTime(evaluate(settings.isha), time.isha),
    };
  }

  function nightPortion(angle, night) {
    if (settings.highLats === "AngleBased") return (angle / 60) * night;
    if (settings.highLats === "OneSeventh") return night / 7;
    return night / 2;
  }

  function adjustHighLatitudeTime(time, base, angle, night, direction) {
    const portion = nightPortion(angle, night);
    const difference =
      direction === "ccw"
        ? math.timeDiff(time, base)
        : math.timeDiff(base, time);
    if (!Number.isFinite(time) || difference > portion)
      return base + (direction === "ccw" ? -portion : portion);
    return time;
  }

  function adjustHighLatitudes(times) {
    const night = math.timeDiff(times.sunset, times.sunrise);
    return {
      ...times,
      imsak: adjustHighLatitudeTime(
        times.imsak,
        times.sunrise,
        evaluate(settings.imsak),
        night,
        "ccw",
      ),
      fajr: adjustHighLatitudeTime(
        times.fajr,
        times.sunrise,
        evaluate(settings.fajr),
        night,
        "ccw",
      ),
      isha: adjustHighLatitudeTime(
        times.isha,
        times.sunset,
        evaluate(settings.isha),
        night,
      ),
      maghrib: adjustHighLatitudeTime(
        times.maghrib,
        times.sunset,
        evaluate(settings.maghrib),
        night,
      ),
    };
  }

  let times = {
    imsak: 5,
    fajr: 5,
    sunrise: 6,
    dhuhr: 12,
    asr: 13,
    sunset: 18,
    maghrib: 18,
    isha: 18,
  };
  times = computePrayerTimes(times);
  times = Object.fromEntries(
    Object.entries(times).map(([key, time]) => [
      key,
      time + timezone - longitude / 15,
    ]),
  );
  times = adjustHighLatitudes(times);
  if (isMinutes(settings.imsak))
    times.imsak = times.fajr - evaluate(settings.imsak) / 60;
  if (isMinutes(settings.maghrib))
    times.maghrib = times.sunset + evaluate(settings.maghrib) / 60;
  if (isMinutes(settings.isha))
    times.isha = times.maghrib + evaluate(settings.isha) / 60;
  times.dhuhr += evaluate(settings.dhuhr) / 60;
  times.midnight =
    settings.midnight === "Jafari"
      ? times.sunset + math.timeDiff(times.sunset, times.fajr) / 2
      : times.sunset + math.timeDiff(times.sunset, times.sunrise) / 2;

  return {
    twentyFourHour: Object.fromEntries(
      Object.entries(times).map(([key, time]) => [key, format24(time)]),
    ),
    twelveHour: Object.fromEntries(
      Object.entries(times).map(([key, time]) => [key, format12(time)]),
    ),
  };
}

async function resolvePrayerInput() {
  const cityId = readFlag("city-id");
  if (cityId) {
    const cityResult = await fetchJson(
      `${GEO_BASE}/city/${encodeURIComponent(cityId)}`,
    );
    if (!cityResult.ok || !cityResult.data?.city)
      throw new Error(`Unable to resolve city ID ${cityId}.`);
    const city = cityResult.data.city;
    return {
      timezone: Number(city.timezone_offset) / 3600000,
      longitude: Number(city.longitude),
      latitude: Number(city.latitude),
      city,
    };
  }

  const timezone = readNumber("timezone");
  const longitude = readNumber("long");
  const latitude = readNumber("lati");
  if (
    timezone === undefined ||
    longitude === undefined ||
    latitude === undefined
  ) {
    throw new Error(
      "Prayer requests require --city-id or --timezone, --long, and --lati.",
    );
  }
  return { timezone, longitude, latitude, city: null };
}

async function fetchPrayerWithRetry(url, fallback) {
  const retryForever = hasFlag("retry-forever");
  const retries = readPositiveInteger("retries", 3, 0);
  const initialDelayMs = Math.max(
    readPositiveInteger("delay-ms", 2000, 500),
    500,
  );
  const attempts = [];
  let attempt = 0;

  while (retryForever || attempt <= retries) {
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = await fetchJson(url);
    } catch (error) {
      result = {
        url: url.toString(),
        status: null,
        ok: false,
        responseBytes: 0,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    attempts.push({
      attempt: attempt + 1,
      startedAt,
      status: result.status,
      responseBytes: result.responseBytes,
      receivedPrayerPayload: hasPrayerPayload(result),
      error: result.error,
    });

    if (hasPrayerPayload(result)) {
      return {
        ...result,
        succeeded: true,
        source: "documented-haqybat-al-momen-json-api",
        attempts,
        retryPolicy: { retryForever, retries, initialDelayMs },
        schema: [
          "fajir",
          "sunrise",
          "doher",
          "sunset",
          "maghrib",
          "date",
          "powerdby",
        ],
      };
    }

    if (!retryForever && attempt >= retries) {
      if (fallback) {
        return {
          succeeded: true,
          source: "hmomen-current-web-client-compatible-local-calculation",
          documentedApi: { ...result, attempts },
          fallback,
          retryPolicy: { retryForever, retries, initialDelayMs },
          note: "The documented endpoint did not provide a payload, so times were calculated locally with the current hmomen public-client parameters. This is not a direct API payload.",
        };
      }
      return {
        ...result,
        succeeded: false,
        attempts,
        retryPolicy: { retryForever, retries, initialDelayMs },
        schema: [
          "fajir",
          "sunrise",
          "doher",
          "sunset",
          "maghrib",
          "date",
          "powerdby",
        ],
        note: "No prayer-time payload was received before the retry limit. Use --retry-forever --no-fallback only if you want to wait exclusively for the documented endpoint.",
      };
    }

    const delayMs =
      Math.min(initialDelayMs * 2 ** Math.min(attempt, 5), 120000) +
      Math.floor(Math.random() * 750);
    await sleep(delayMs);
    attempt += 1;
  }

  throw new Error("Unexpected retry loop exit.");
}

async function emit(result) {
  const output = JSON.stringify(result, null, 2);
  const outputPath = readFlag("output");
  if (outputPath) await writeFile(outputPath, `${output}\n`, "utf8");
  console.log(output);
}

async function main() {
  if (hasFlag("countries")) return fetchJson(`${GEO_BASE}/countries`);

  const country = readFlag("country");
  if (country)
    return fetchJson(`${GEO_BASE}/countries/${encodeURIComponent(country)}`);

  const search = readFlag("search");
  if (search) {
    const body = new FormData();
    body.set("query", search);
    return fetchJson(`${GEO_BASE}/search`, { method: "POST", body });
  }

  if (hasFlag("prayer")) {
    const input = await resolvePrayerInput();
    const date = parseDate(readFlag("date"), input.timezone);
    const method = readFlag("method") ?? "Jafari";
    const url = new URL(PRAYER_ENDPOINT);
    url.searchParams.set("v", "jsonPrayerTimes");
    url.searchParams.set("timezone", String(input.timezone));
    url.searchParams.set("long", String(input.longitude));
    url.searchParams.set("lati", String(input.latitude));
    const fallback = hasFlag("no-fallback")
      ? null
      : {
          method,
          date: date.iso,
          location: {
            city: input.city?.city ?? null,
            country: input.city?.country_name ?? null,
            latitude: input.latitude,
            longitude: input.longitude,
            timezoneHours: input.timezone,
          },
          settings: { ...CLIENT_BASELINE_SETTINGS, ...METHOD_PARAMS[method] },
          times: calculateHmomenClientTimes({
            date,
            latitude: input.latitude,
            longitude: input.longitude,
            timezone: input.timezone,
            method,
          }),
        };
    return fetchPrayerWithRetry(url, fallback);
  }

  const cityId = readFlag("city-id");
  if (cityId)
    return fetchJson(`${GEO_BASE}/city/${encodeURIComponent(cityId)}`);

  usage();
  process.exitCode = 2;
  return null;
}

main()
  .then((result) => {
    if (result) return emit(result);
  })
  .catch((error) => {
    console.error(
      JSON.stringify(
        { error: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
