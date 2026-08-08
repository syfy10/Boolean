// Single source of truth for the release version.
//
// The version has to appear in six files that no build step keeps in sync, so
// a release used to mean six hand edits and release.yml failing on the seventh.
//
//   node build/set-version.mjs 0.9.72   # write the version everywhere
//   node build/set-version.mjs --check  # verify every file already agrees
//
// --check is what CI runs; it exits non-zero and names the files that drifted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const at = (...parts) => path.join(root, ...parts);

// Each target declares how to read its version and how to rewrite it. `read`
// returns every version it found so a file with two copies (package-lock) is
// still checked as a whole.
const TARGETS = [
  {
    file: "package.json",
    read: (text) => [JSON.parse(text).version],
    write: (text, v) => text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${v}"`)
  },
  {
    file: "package-lock.json",
    read: (text) => {
      const lock = JSON.parse(text);
      return [lock.version, lock.packages?.[""]?.version].filter(Boolean);
    },
    write: (text, v) => {
      const lock = JSON.parse(text);
      lock.version = v;
      if (lock.packages?.[""]) lock.packages[""].version = v;
      return `${JSON.stringify(lock, null, 2)}\n`;
    }
  },
  {
    file: path.join("src", "config.js"),
    read: (text) => [
      text.match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1],
      text.match(/APP_DISPLAY_VERSION\s*=\s*"v([^"]+)"/)?.[1]
    ],
    write: (text, v) => text
      .replace(/(APP_VERSION\s*=\s*)"[^"]*"/, `$1"${v}"`)
      .replace(/(APP_DISPLAY_VERSION\s*=\s*)"[^"]*"/, `$1"v${v}"`)
  },
  {
    file: path.join("shell", "SazShell.csproj"),
    // FileVersion and AssemblyVersion carry a fourth component; compare on the
    // first three so 0.9.71.0 counts as matching 0.9.71.
    read: (text) => [
      text.match(/<Version>([^<]+)<\/Version>/)?.[1],
      text.match(/<FileVersion>([^<]+)<\/FileVersion>/)?.[1],
      text.match(/<AssemblyVersion>([^<]+)<\/AssemblyVersion>/)?.[1]
    ].map((found) => found?.split(".").slice(0, 3).join(".")),
    write: (text, v) => text
      .replace(/<Version>[^<]*<\/Version>/, `<Version>${v}</Version>`)
      .replace(/<FileVersion>[^<]*<\/FileVersion>/, `<FileVersion>${v}.0</FileVersion>`)
      .replace(/<AssemblyVersion>[^<]*<\/AssemblyVersion>/, `<AssemblyVersion>${v}.0</AssemblyVersion>`)
  },
  {
    file: path.join("build", "set-icon.cjs"),
    read: (text) => [
      text.match(/"file-version":\s*"([^"]+)"/)?.[1],
      text.match(/"product-version":\s*"([^"]+)"/)?.[1]
    ],
    write: (text, v) => text
      .replace(/("file-version":\s*)"[^"]*"/, `$1"${v}"`)
      .replace(/("product-version":\s*)"[^"]*"/, `$1"${v}"`)
  },
  {
    file: path.join("build", "installer.iss"),
    read: (text) => [text.match(/#define\s+AppVersion\s+"([^"]+)"/)?.[1]],
    write: (text, v) => text.replace(/(#define\s+AppVersion\s+)"[^"]*"/, `$1"${v}"`)
  }
];

function readAll() {
  return TARGETS.map((target) => {
    const full = at(target.file);
    const text = fs.readFileSync(full, "utf8");
    return { target, full, text, found: target.read(text) };
  });
}

const arg = process.argv[2];

if (!arg || arg === "--help" || arg === "-h") {
  console.error("usage: node build/set-version.mjs <version> | --check");
  process.exit(1);
}

if (arg === "--check") {
  const entries = readAll();
  // package.json is the reference; everything else has to agree with it.
  const expected = entries[0].found[0];
  const drifted = [];
  for (const { target, found } of entries) {
    for (const value of found) {
      if (value !== expected) {
        drifted.push(`${target.file}: found ${value ?? "nothing"}, expected ${expected}`);
      }
    }
  }
  if (drifted.length) {
    console.error(`Version drift against package.json (${expected}):`);
    for (const line of drifted) console.error(`  ${line}`);
    console.error(`\nFix with: node build/set-version.mjs ${expected}`);
    process.exit(1);
  }
  console.log(`version ${expected} is in sync across ${TARGETS.length} files`);
  process.exit(0);
}

if (!/^\d+\.\d+\.\d+$/.test(arg)) {
  console.error(`Not a valid version: ${arg} (expected MAJOR.MINOR.PATCH)`);
  process.exit(1);
}

for (const { target, full, text } of readAll()) {
  const next = target.write(text, arg);
  if (next === text) {
    console.log(`  = ${target.file} (already ${arg})`);
    continue;
  }
  fs.writeFileSync(full, next);
  console.log(`  → ${target.file}`);
}
console.log(`\nversion set to ${arg}. Next: git commit, then git tag v${arg} && git push origin v${arg}`);
