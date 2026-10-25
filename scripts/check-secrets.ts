#!/usr/bin/env tsx
/**
 * Lightweight repository secret check used by CI.
 *
 * This is a guardrail, not a replacement for GitHub secret scanning or gitleaks.
 * It intentionally reports only the file, line and rule so the value is never echoed
 * into CI logs.
 */
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const ROOT = process.cwd();
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".woff",
  ".woff2",
]);

interface Rule {
  name: string;
  pattern: RegExp;
  allow?: (line: string) => boolean;
}

const RULES: Rule[] = [
  { name: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{20,}/ },
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    name: "github-token",
    pattern: /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/,
  },
  { name: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  {
    name: "hardcoded-credential",
    pattern: /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["'`]([^"'`\n]{8,})["'`]/i,
    allow: (line) =>
      /process\.env|import\.meta\.env|example|placeholder|your[-_]|replace|<[^>]+>|\.\.\.|redacted/i.test(
        line,
      ),
  },
];

function isGitRepo(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function gitFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(relative(ROOT, full));
  }
  return files;
}

async function main(): Promise<void> {
  const files = isGitRepo() ? gitFiles() : await walk(ROOT);
  const findings: Array<{ file: string; line: number; rule: string }> = [];

  for (const file of files) {
    if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    if (file === "pnpm-lock.yaml" || file === "scripts/check-secrets.ts") continue;

    let content: string;
    try {
      content = await readFile(join(ROOT, file), "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const rule of RULES) {
        if (!rule.pattern.test(line)) continue;
        if (rule.allow?.(line)) continue;
        findings.push({ file, line: index + 1, rule: rule.name });
      }
    }
  }

  if (findings.length === 0) {
    console.log(`secret check: clean (${files.length} files scanned)`);
    return;
  }

  for (const finding of findings) {
    console.error(`secret check: ${finding.file}:${finding.line} [${finding.rule}]`);
  }
  console.error(`secret check: ${findings.length} finding(s)`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
