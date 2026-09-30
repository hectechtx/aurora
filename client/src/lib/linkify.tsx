const URL_SPLIT_RE = /(https?:\/\/[^\s<>"')]+)/g;
const URL_TEST_RE = /^https?:\/\//;

/** Renders plain text with any http(s) URLs turned into real clickable links — used so tool results and replies (web_fetch/web_search output, saved-file paths, etc.) aren't just inert text. */
export function linkify(text: string): React.ReactNode[] {
  return text.split(URL_SPLIT_RE).map((part, i) =>
    URL_TEST_RE.test(part)
      ? <a key={i} href={part} target="_blank" rel="noreferrer" className="text-accent underline decoration-accent/40 hover:decoration-accent break-all">{part}</a>
      : <span key={i}>{part}</span>
  );
}
