// One-time (re-runnable) pass that assigns a "category" field to every
// bundled starter skill's skill.json, keyword-matched against its directory
// name. Idempotent — re-running just overwrites the category with the same
// result, so it's safe to run again after adding new starter skills.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "starter-skills");

const RULES = [
  { category: "Video & Film", keywords: [
    "fps", "frame-timing", "render-time", "shot-list", "call-sheet", "storyboard",
    "episode-runtime", "lip-sync", "keyframe", "crew-rate", "production-budget",
    "countdown-milestone", "video-filesize", "aspect-ratio",
  ] },
  { category: "Design & Visual", keywords: [
    "color-palette", "color-format", "color-blindness", "contrast-checker", "typography-scale",
    "grid-column", "spacing-scale", "golden-ratio", "favicon", "logo-clear-space", "mockup-dimension",
    "css-gradient", "dpi-print", "cmyk-gamut", "easing-curve",
  ] },
  { category: "Writing & Editing", keywords: [
    "word-counter", "readability", "passive-voice", "cliche", "punctuation", "sentence-length",
    "sentence-starter", "dialogue-formatter", "rhyme-finder", "lorem-ipsum", "story-outline",
    "redline-summary", "word-repetition", "word-frequency", "duplicate-text", "text-diff-summary",
    "consistency-checker", "reading-time", "adverb-finder", "citation-formatter",
  ] },
  { category: "Marketing & Social", keywords: [
    "hashtag", "engagement-rate", "utm-link", "best-post-time", "caption-length",
    "content-calendar", "sponsorship-rate", "slug-generator",
  ] },
  { category: "Business & Finance", keywords: [
    "break-even", "budget-variance", "cash-flow", "roi-calculator", "loan-amortization",
    "pricing-tier", "tax-bracket", "runway-calculator", "hiring-plan", "invoice-generator",
    "finance-calculator", "quarterly-goals", "swot-analysis", "mission-statement", "elevator-pitch",
    "business-name", "board-deck", "event-budget", "expense-categorizer", "okr-progress",
    "decision-matrix", "stakeholder-map", "task-priority-matrix", "meeting-minutes",
    "meeting-scheduler", "critical-path", "project-timeline", "release-schedule",
  ] },
  { category: "Legal & Compliance", keywords: [
    "nda-clause", "legal-citation", "legal-deadline", "contract-clause", "defined-terms",
    "retention-schedule", "citation-index",
  ] },
  { category: "Developer Tools", keywords: [
    "json-tools", "regex-tester", "sql-formatter", "env-file-validator", "hash-generator",
    "uuid-generator", "base64-tools", "http-status-lookup", "semver-comparator", "cron-expression",
    "diff-checker", "unit-converter", "date-calculator", "text-metadata", "file-naming-audit",
    "version-label", "recurring-schedule", "archive-manifest", "asset-filename", "text-case-converter",
  ] },
];

function categoryFor(id) {
  for (const rule of RULES) {
    if (rule.keywords.some((k) => id.includes(k))) return rule.category;
  }
  return "General";
}

let changed = 0;
const counts = {};
for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(ROOT, entry.name, "skill.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const category = categoryFor(entry.name);
  counts[category] = (counts[category] ?? 0) + 1;
  if (manifest.category !== category) {
    manifest.category = category;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    changed++;
  }
}
console.log(`Updated ${changed} skill.json files.`);
console.log(counts);
