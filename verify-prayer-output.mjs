#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const filePath = process.argv[2];
if (!filePath) {
  throw new Error("Provide the result JSON file path.");
}

const result = JSON.parse(await readFile(filePath, "utf8"));
const times = result.fallback?.times?.twentyFourHour ?? result.data;
const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const values = Object.values(times ?? {});

if (!result.succeeded || values.length === 0 || values.some((value) => typeof value !== "string" || !validTime.test(value))) {
  throw new Error("The result does not contain a successful, complete 24-hour prayer-time payload.");
}

console.log(
  JSON.stringify(
    {
      source: result.source,
      city: result.fallback?.location?.city ?? null,
      date: result.fallback?.date ?? result.data?.date ?? null,
      coordinates: result.fallback?.location ?? null,
      times,
    },
    null,
    2,
  ),
);
