#!/usr/bin/env node
// Fails when the resolved bindings of [env.production] drift from the top-level
// configuration.
//
// Why this exists: a named wrangler environment inherits nothing, so every
// binding is duplicated in wrangler.toml. Duplication silently rots — someone
// adds a KV namespace or a var at the top level, `wrangler dev` and the tests
// pick it up, and production deploys without it. The failure surfaces at
// runtime as an undefined binding, in the environment where it matters most.
//
// Rather than parse TOML (which would re-implement wrangler's own inheritance
// and defaulting rules, and drift from them), this asks wrangler to resolve
// both configurations and compares what it reports.

import { execFileSync } from "node:child_process";

// The route is expected to differ: it lives only under [env.production] so that
// a bare `wrangler deploy` cannot reach the live domain.
const NOISE =
  /^$|wrangler \d|^---|WARNING|out-of-date|Please update|npm install|After installation|Total Upload|Your worker has access|dry-run: exiting|^\s*$/i;

function bindings(args) {
  let out;
  try {
    out = execFileSync(
      "npx",
      ["wrangler", "deploy", "--dry-run", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 },
    );
  } catch (err) {
    // A build/config error in either configuration is itself a drift failure:
    // report wrangler's own diagnostics instead of a confusing empty diff.
    const detail = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    console.error(
      `wrangler failed to resolve \`${args.join(" ") || "<top level>"}\`:\n${detail}`,
    );
    process.exit(1);
  }
  return out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => !NOISE.test(l));
}

const top = bindings([]);
const prod = bindings(["--env", "production"]);

// Guard against the comparison passing vacuously if wrangler's output format
// changes and the filter strips everything.
if (top.length === 0 || prod.length === 0) {
  console.error(
    "check-env-parity: resolved no bindings — wrangler output format likely changed.",
  );
  process.exit(1);
}

const missing = top.filter((l) => !prod.includes(l));
const extra = prod.filter((l) => !top.includes(l));

if (missing.length === 0 && extra.length === 0) {
  console.log(`env.production matches the top level (${top.length} lines).`);
  process.exit(0);
}

console.error("wrangler.toml drift between top level and [env.production]:\n");
for (const l of missing) console.error(`  missing from production: ${l}`);
for (const l of extra) console.error(`  only in production:      ${l}`);
console.error(
  "\nA named environment inherits nothing. Mirror the change into [env.production].",
);
process.exit(1);
