// Bash-grader body for the review-lens eval: exit 0 pass, 1 fail. Reads the
// lens output from EVAL_OUTPUT_FILE and the expectation from EVAL_EXPECT_KIND
// and EVAL_EXPECT_ACCEPT ("path:from-to,path:from-to").

import { readFileSync } from "node:fs";

export interface Finding {
  location?: unknown;
  severity?: unknown;
  confidence?: unknown;
}

export interface Range {
  file: string;
  from: number;
  to: number;
}

// Reviewers cite lines several off the real one, so the file has to match and
// the line only has to land near the seeded span. Line accuracy is not graded.
const LINE_SLACK = 10;
// The triage node downstream keeps only these severities, at this confidence.
const BLOCKING = new Set(["CRITICAL", "HIGH"]);
const BLOCKING_CONFIDENCE = 80;

export function parseFindings(text: string): Finding[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { findings?: unknown };
    return Array.isArray(value.findings) ? (value.findings as Finding[]) : null;
  } catch {
    return null;
  }
}

export function parseAccept(spec: string): Range[] {
  return spec
    .split(",")
    .filter((part) => part.trim() !== "")
    .map((part) => {
      const match = /^(.+):(\d+)-(\d+)$/.exec(part.trim());
      if (!match) throw new Error(`bad accept range: ${part}`);
      return { file: match[1] as string, from: Number(match[2]), to: Number(match[3]) };
    });
}

export function parseLocation(location: unknown): Range | null {
  if (typeof location !== "string") return null;
  const match = /([\w./-]+\.[A-Za-z]+):(\d+)(?:\s*-\s*(\d+))?/.exec(location);
  if (!match) return null;
  const from = Number(match[2]);
  return {
    file: (match[1] as string).replace(/^(\.\/|[ab]\/)/, ""),
    from,
    to: match[3] !== undefined ? Number(match[3]) : from,
  };
}

function blocking(finding: Finding): boolean {
  return typeof finding.severity === "string" && BLOCKING.has(finding.severity.toUpperCase());
}

function hits(finding: Finding, accept: readonly Range[]): boolean {
  const at = parseLocation(finding.location);
  if (at === null) return false;
  return accept.some(
    (range) =>
      range.file === at.file &&
      at.from <= range.to + LINE_SLACK &&
      at.to >= range.from - LINE_SLACK,
  );
}

export function grade(
  output: string,
  kind: string,
  accept: readonly Range[],
): { pass: boolean; detail: string } {
  const findings = parseFindings(output);
  if (findings === null) return { pass: false, detail: "output is not a findings object" };
  if (kind === "bug") {
    const found = findings.find((f) => blocking(f) && hits(f, accept));
    if (found) return { pass: true, detail: `seeded bug found at ${String(found.location)}` };
    const where = findings.map((f) => `${String(f.severity)} ${String(f.location)}`).join("; ");
    return { pass: false, detail: `seeded bug missed (findings: ${where || "none"})` };
  }
  const noise = findings.filter(
    (f) => blocking(f) && typeof f.confidence === "number" && f.confidence >= BLOCKING_CONFIDENCE,
  );
  if (noise.length === 0) return { pass: true, detail: "no blocking finding on a clean diff" };
  const where = noise.map((f) => `${String(f.severity)} ${String(f.location)}`).join("; ");
  return { pass: false, detail: `blocking finding on a clean diff: ${where}` };
}

if (import.meta.main) {
  const file = process.env.EVAL_OUTPUT_FILE;
  const kind = process.env.EVAL_EXPECT_KIND;
  if (!file || (kind !== "bug" && kind !== "clean")) {
    console.error("EVAL_OUTPUT_FILE and EVAL_EXPECT_KIND (bug|clean) are required");
    process.exit(2);
  }
  const result = grade(
    readFileSync(file, "utf8"),
    kind,
    parseAccept(process.env.EVAL_EXPECT_ACCEPT ?? ""),
  );
  console.error(result.detail);
  process.exit(result.pass ? 0 : 1);
}
