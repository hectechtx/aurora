import { PageHeader } from "@/components/ui/PageHeader";
import { LivingTown } from "@/components/LivingTown";

export default function Town() {
  return (
    <div className="space-y-3 p-4 sm:p-6">
      <PageHeader
        title="Town"
        description="Their town, live: commuting, desk work, lunch at the café, evenings at the theater, park, rec center, arcade and studio — time off here really lifts their morale. Scroll to zoom, drag to pan, click someone to follow them."
      />
      <LivingTown height="calc(100vh - 150px)" />
    </div>
  );
}
