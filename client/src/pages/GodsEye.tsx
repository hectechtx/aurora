import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { Eye, RotateCw } from "lucide-react";

// God's Eye View (github.com/bilawalsidhu/gods-eye-view) — a photorealistic 3D
// globe of live PUBLIC open-source intelligence: aircraft (ADS-B), ships (AIS),
// satellites, earthquakes, wildfires. It's its own app with its own server, so
// AURORA doesn't bundle it — this page is just a door to it, embedded via the
// same Electron webview the Browser page uses.
//
// Deliberately NOT auto-started (the owner's choice): it's a heavy WebGL globe
// that would compete with the AI backends for the 8GB GPU if left always-on.
// So "server not running" is a normal, expected state and this page explains
// how to start it rather than treating it as an error.
const GODSEYE_URL = "http://localhost:4173";

interface GodsEyeStatus { live: boolean; url: string }

export default function GodsEye() {
  const isElectron = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
  const { data, refetch, isFetching } = useQuery<GodsEyeStatus>({
    queryKey: ["/api/godseye/status"],
    refetchInterval: 5000,
  });

  if (!isElectron) {
    return (
      <div className="p-8 max-w-3xl mx-auto h-screen flex items-center justify-center">
        <EmptyState
          icon={Eye}
          title="Only available in the installed desktop app"
          description="God's Eye renders a 3D globe through Electron's page surface, which isn't available in a regular browser tab."
        />
      </div>
    );
  }

  if (!data?.live) {
    return (
      <div className="p-8 max-w-2xl mx-auto h-screen flex items-center justify-center">
        <div className="space-y-4 text-center">
          <EmptyState
            icon={Eye}
            title="God's Eye isn't running"
            description="It's a separate local app — a live globe of public open-source intelligence (aircraft, ships, satellites, earthquakes, fires). Start its server, then it appears here."
          />
          <div className="rounded-md border border-border bg-surface/50 p-4 text-left space-y-2">
            <p className="text-xs text-muted-foreground">Start it from a terminal:</p>
            <code className="block text-xs font-mono text-accent break-all">
              cd F:\Claude\gods-eye-view &amp;&amp; npm run dev
            </code>
            <p className="text-xs text-muted-foreground leading-relaxed">
              It runs with no API keys on free Esri imagery. Optional keys (for the Google 3D globe and more) are pasted into
              God's Eye's own settings — not here.
            </p>
          </div>
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RotateCw size={14} className={isFetching ? "animate-spin" : ""} /> Check again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="border-b border-border px-6 py-4">
        <PageHeader
          title="God's Eye"
          description="A live 3D globe of public open-source intelligence — running locally, nothing leaves this machine."
        />
      </div>
      <div className="flex-1 min-h-0">
        <webview ref={undefined as never} src={GODSEYE_URL} className="w-full h-full" allowpopups="true" />
      </div>
    </div>
  );
}
