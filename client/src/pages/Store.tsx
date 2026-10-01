import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { AuthedImage } from "@/components/ui/AuthedImage";
import { useToast } from "@/components/ui/Toast";
import { apiRequest, getToken } from "@/lib/queryClient";
import { Download, Globe, ShoppingBag, Trash2 } from "lucide-react";

interface Product { id: number; name: string; description: string; priceCents: number; category: string; tags: string[]; imagePath: string | null; buyUrl: string; status: "draft" | "ready" | "listed"; createdBy: string; createdAt: number }

function ProductCard({ p }: { p: Product }) {
  const qc = useQueryClient();
  const [buyUrl, setBuyUrl] = useState(p.buyUrl);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiRequest("PATCH", `/api/store/products/${p.id}`, body).then((r) => r.json()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/store/products"] }),
  });
  const remove = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/store/products/${p.id}`).then((r) => r.json()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/store/products"] }),
  });
  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="aspect-square bg-surface">
        {p.imagePath ? <AuthedImage src={`/creations/${p.imagePath}`} alt={p.name} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-muted-foreground"><ShoppingBag size={28} /></div>}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm font-medium leading-tight">{p.name}</div>
          <div className="text-sm tabular-nums">${(p.priceCents / 100).toFixed(2)}</div>
        </div>
        <p className="line-clamp-3 text-xs text-muted-foreground">{p.description}</p>
        <div className="text-[10px] text-muted-foreground">{p.category}{p.tags.length ? ` · ${p.tags.slice(0, 4).join(", ")}` : ""} · by {p.createdBy}</div>
        <div className="mt-auto flex items-center gap-1.5">
          <Select value={p.status} onChange={(e) => save.mutate({ status: e.target.value })} className="h-8 w-24 text-xs">
            <option value="draft">Draft</option><option value="ready">Ready</option><option value="listed">Listed</option>
          </Select>
          <Input value={buyUrl} onChange={(e) => setBuyUrl(e.target.value)} onBlur={() => buyUrl !== p.buyUrl && save.mutate({ buyUrl })}
            placeholder="Buy link (Stripe/Shopify/Etsy)" className="h-8 flex-1 text-xs" />
          <button type="button" className="opacity-50 hover:opacity-100" title="Delete" onClick={() => { if (confirm(`Delete "${p.name}"?`)) remove.mutate(); }}><Trash2 size={13} /></button>
        </div>
      </div>
    </Card>
  );
}

export default function Store() {
  const { toast } = useToast();
  const { data: products = [] } = useQuery<Product[]>({ queryKey: ["/api/store/products"], refetchInterval: 10_000 });

  async function downloadCsv() {
    const r = await fetch("/api/store/shopify.csv", { headers: { Authorization: `Bearer ${getToken() ?? ""}` } });
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url; a.download = "aurora-goods-shopify.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  async function exportSite() {
    const r = await apiRequest("POST", "/api/store/export-site").then((x) => x.json()) as { dir: string };
    toast({ title: "Storefront exported", description: r.dir, variant: "success" });
  }

  const ready = products.filter((p) => p.status !== "draft").length;
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader title="Store" description="AURORA Goods' catalog — designed, priced and written by the store team. You open the store and payments; they keep it stocked." />
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void downloadCsv()} disabled={products.length === 0}><Download size={14} /> Shopify CSV</Button>
          <Button variant="primary" onClick={() => void exportSite()} disabled={ready === 0}><Globe size={14} /> Export storefront</Button>
        </div>
      </div>

      <Card className="p-4 text-xs leading-relaxed text-muted-foreground">
        <div className="mb-1 text-sm font-medium text-foreground">Going live (one-time, done by you)</div>
        1. Open a store: <b>Shopify</b> (import the CSV above — Admin → Products → Import) or a print-on-demand shop like <b>Printify/Printful</b> connected to Shopify or Etsy.
        &nbsp;2. Or skip the platform: create a <b>Stripe Payment Link</b> per product, paste it as the buy link, and host the exported storefront anywhere (e.g. drag the folder onto Netlify Drop).
        &nbsp;3. When sales come in, record them (or import the report) in the <b>Treasury</b> — that's where real revenue is tracked.
      </Card>

      {products.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
          <ShoppingBag size={22} />
          No products yet — the "Goods: Daily Product Drop" pipeline adds new ones every day.
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {products.map((p) => <ProductCard key={p.id} p={p} />)}
        </div>
      )}
    </div>
  );
}
