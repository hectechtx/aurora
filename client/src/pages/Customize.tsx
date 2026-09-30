import { useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import { THEMES, getStoredThemeId, setTheme, getContrast, setContrast, getCodeFont, setCodeFont } from "@/lib/theme";
import { Check, Palette, Contrast, Type } from "lucide-react";

export default function Customize() {
  const [active, setActive] = useState(getStoredThemeId());
  const [contrast, setContrastState] = useState(getContrast());
  const [font, setFontState] = useState(getCodeFont());

  function pick(id: string) {
    setTheme(id);
    setActive(id);
  }

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6 overflow-y-auto h-screen">
      <PageHeader title="Customize" description="Make AURORA yours — pick an accent theme. It applies instantly across every tab and is remembered on this machine." />

      <Card className="p-5 space-y-4">
        <h3 className="text-sm font-medium flex items-center gap-1.5"><Palette size={15} /> Accent theme</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => pick(t.id)}
              className={cn(
                "relative rounded-lg border p-3 text-left transition-all",
                active === t.id ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/50",
              )}
            >
              <div className="h-12 w-full rounded-md" style={{ background: t.swatch }} />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-sm font-medium">{t.name}</span>
                {active === t.id && <Check size={15} className="text-primary" />}
              </div>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground/70">
          The living-galaxy background and every accent, button, and highlight recolor to match your choice.
        </p>
      </Card>

      <Card className="p-5 space-y-4">
        <h3 className="text-sm font-medium flex items-center gap-1.5"><Contrast size={15} /> Appearance</h3>
        <label className="flex items-center justify-between gap-4 cursor-pointer">
          <div>
            <div className="text-sm">High-contrast dark</div>
            <div className="text-xs text-muted-foreground">A darker, near-black background for maximum contrast.</div>
          </div>
          <button
            role="switch"
            aria-checked={contrast}
            onClick={() => { const next = !contrast; setContrast(next); setContrastState(next); }}
            className={cn("relative h-6 w-11 rounded-full transition-colors shrink-0", contrast ? "bg-primary" : "bg-muted")}
          >
            <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform", contrast ? "translate-x-5" : "translate-x-0.5")} />
          </button>
        </label>
        <div className="space-y-1.5">
          <label className="text-sm flex items-center gap-1.5"><Type size={14} /> Code font</label>
          <p className="text-xs text-muted-foreground">A custom monospace font for code and the terminal (must be installed on this machine).</p>
          <Input
            value={font}
            onChange={(e) => { setFontState(e.target.value); setCodeFont(e.target.value); }}
            placeholder="e.g. Cascadia Code, Fira Code"
            className="max-w-xs font-mono"
          />
        </div>
      </Card>
    </div>
  );
}
