import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Plus, Image as ImageIcon, FileText, FolderOpen } from "lucide-react";

export function AttachMenu({ disabled, onPickImage, onPickFile, onPickFolder }: {
  disabled?: boolean;
  onPickImage: () => void;
  onPickFile: () => void;
  onPickFolder: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const items = [
    { label: "Add a photo", icon: ImageIcon, action: onPickImage },
    { label: "Add a file", icon: FileText, action: onPickFile },
    { label: "Add a folder", icon: FolderOpen, action: onPickFolder },
  ];

  return (
    <div className="relative" ref={rootRef}>
      <Button
        variant="outline"
        size="icon"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="self-end h-[38px]"
        title="Attach"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Plus size={16} />
      </Button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 mb-2 w-52 rounded-lg border border-border bg-card shadow-panel py-1.5 z-20">
          {items.map(({ label, icon: Icon, action }) => (
            <button
              key={label}
              role="menuitem"
              onClick={() => { action(); setOpen(false); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-surface transition-colors"
            >
              <Icon size={15} className="text-muted-foreground" /> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
