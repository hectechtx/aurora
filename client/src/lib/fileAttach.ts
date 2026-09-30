// Client-side reading for "Add a file" / "Add a folder" — unlike images
// (which go through the Library + see_image tool since a vision model has to
// look at them), plain text/code files just get read here and folded
// straight into the chat message as context. No server round-trip needed.

export interface AttachedFile {
  id: string;
  name: string;
  content: string;
  truncated: boolean;
}

// Skip anything that's obviously not going to read as meaningful text —
// binary assets, lockfiles, build output, VCS internals. Folder picks in
// particular would otherwise happily try to read node_modules or .git.
const SKIP_DIR_SEGMENTS = new Set(["node_modules", ".git", ".next", ".cache", "dist", "build", "release", "__pycache__", ".venv", "venv"]);
const SKIP_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
  "mp3", "mp4", "wav", "ogg", "webm", "avi", "mov",
  "zip", "tar", "gz", "7z", "rar", "exe", "dll", "so", "dylib", "bin",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "woff", "woff2", "ttf", "eot", "otf",
  "pyc", "class", "o", "node",
]);

const MAX_FILE_CHARS = 50_000;
const MAX_TOTAL_CHARS = 100_000;
const MAX_FILES = 40;
const NULL_CHAR = String.fromCharCode(0);

function shouldSkip(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (segments.some((s) => SKIP_DIR_SEGMENTS.has(s))) return true;
  const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
  return SKIP_EXTENSIONS.has(ext);
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("couldn't read file"));
    reader.readAsText(file);
  });
}

// A crude but effective binary-content check: real text files essentially
// never contain a null byte. Catches images/archives that slip through by
// extension (e.g. an extensionless binary) without needing a MIME sniff.
function looksBinary(text: string): boolean {
  return text.slice(0, 4000).includes(NULL_CHAR);
}

export interface ReadFilesResult {
  files: AttachedFile[];
  skipped: string[];
}

/** Reads a FileList (from a single-file input or a `webkitdirectory` folder pick) into text attachments, applying size/count caps and skipping non-text files. */
export async function readFilesForAttachment(fileList: FileList): Promise<ReadFilesResult> {
  const files: AttachedFile[] = [];
  const skipped: string[] = [];
  let totalChars = 0;

  for (const file of Array.from(fileList)) {
    if (files.length >= MAX_FILES) { skipped.push(`${file.name} (too many files, kept first ${MAX_FILES})`); continue; }
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (shouldSkip(relativePath)) { skipped.push(relativePath); continue; }
    if (totalChars >= MAX_TOTAL_CHARS) { skipped.push(`${relativePath} (total attachment size limit reached)`); continue; }

    let text: string;
    try {
      text = await readAsText(file);
    } catch {
      skipped.push(`${relativePath} (couldn't read)`);
      continue;
    }
    if (looksBinary(text)) { skipped.push(`${relativePath} (looks binary)`); continue; }

    let truncated = false;
    if (text.length > MAX_FILE_CHARS) { text = text.slice(0, MAX_FILE_CHARS); truncated = true; }
    if (totalChars + text.length > MAX_TOTAL_CHARS) {
      text = text.slice(0, MAX_TOTAL_CHARS - totalChars);
      truncated = true;
    }
    totalChars += text.length;

    files.push({ id: `${relativePath}-${file.lastModified}-${file.size}`, name: relativePath, content: text, truncated });
  }

  return { files, skipped };
}

/** Formats attached files as a clearly-delimited block to fold into the outgoing chat message. */
export function formatAttachedFiles(files: AttachedFile[]): string {
  if (files.length === 0) return "";
  return files.map((f) =>
    `\n\n--- Attached file: ${f.name}${f.truncated ? " (truncated)" : ""} ---\n${f.content}\n--- end file ---`
  ).join("");
}
