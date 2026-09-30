// Generates a small, working project skeleton from a plain-language
// description, using the same local Ollama model the rest of AURORA talks
// to — a single one-shot chat call (no tools, no multi-step loop) asking for
// a strict JSON manifest of files, which the caller then writes to disk.
import { chat, type OllamaMessage } from "./ollama";

export interface GeneratedFile {
  path: string;
  content: string;
}

export class ProjectGenError extends Error {}

const SYSTEM_PROMPT =
  "You are a code generator. Given a project description, respond with ONLY a single JSON object " +
  '(no markdown fences, no commentary) of the exact shape: {"files":[{"path":"relative/file/path.ext","content":"full file contents"}]}\n' +
  "Rules:\n" +
  "- Include every file needed for a minimal, working project (source files, and a README.md, plus " +
  "package.json/requirements.txt/etc. if the stack needs one).\n" +
  "- Keep it a focused, working skeleton — not an exhaustive framework.\n" +
  '- "path" must be a relative path with forward slashes, no ".." segments, no leading slash.\n' +
  '- "content" is the literal file contents as a string.\n' +
  "- Respond with the JSON object and nothing else.";

// The model sometimes wraps its JSON in a ```json fence despite being told
// not to — strip that before parsing rather than failing on it.
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

export async function generateProject(host: string, model: string, description: string): Promise<{ files: GeneratedFile[] }> {
  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: description },
  ];
  const result = await chat(host, model, messages, []);
  const jsonText = extractJson(result.message.content ?? "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ProjectGenError("The model didn't return valid JSON for the project files. Try a more specific description, or a different model.");
  }
  const rawFiles = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).files : undefined;
  if (!Array.isArray(rawFiles)) {
    throw new ProjectGenError("The model's response was missing a files list.");
  }
  const files: GeneratedFile[] = rawFiles
    .filter((f): f is { path: string; content: string } =>
      !!f && typeof f === "object" && typeof (f as any).path === "string" && typeof (f as any).content === "string" && (f as any).path.trim().length > 0)
    .map((f) => ({
      path: f.path.replace(/^[/\\]+/, "").replace(/\.\.[/\\]/g, ""),
      content: f.content,
    }));
  if (files.length === 0) {
    throw new ProjectGenError("The model didn't generate any files.");
  }
  return { files };
}
