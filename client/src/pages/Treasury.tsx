import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { StatusBadge } from "@/components/ui/Badge";
import { useToast } from "@/components/ui/Toast";
import { apiRequest } from "@/lib/queryClient";
import { Landmark, Upload, Check, X, Trash2 } from "lucide-react";

interface Entry { id: number; at: number; companyId: number | null; kind: "income" | "expense"; amountCents: number; source: string; note: string; status: "proposed" | "confirmed" | "rejected"; createdBy: string }
interface Summary { incomeCents: number; expenseCents: number; netCents: number; proposedCount: number; byCompany: { companyId: number | null; incomeCents: number; expenseCents: number }[]; byMonth: { month: string; incomeCents: number; expenseCents: number }[] }
interface TreasuryData { summary: Summary; entries: Entry[]; companies: { id: number; name: string }[] }

const usd = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Tile({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "good" ? "text-risk-low" : tone === "bad" ? "text-risk-high" : ""}`}>{value}</div>
    </Card>
  );
}

export default function Treasury() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery<TreasuryData>({ queryKey: ["/api/treasury"], refetchInterval: 10_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["/api/treasury"] });
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0, 10), companyId: "", kind: "income", amount: "", source: "", note: "" });
  const fileRef = useRef<HTMLInputElement>(null);
  const [importCompany, setImportCompany] = useState("");
  const [importSource, setImportSource] = useState("");

  const add = useMutation({
    mutationFn: () => apiRequest("POST", "/api/treasury/entries", { ...form, companyId: form.companyId ? Number(form.companyId) : null, amount: Number(form.amount) }).then((r) => r.json()),
    onSuccess: () => { setForm({ ...form, amount: "", note: "" }); void refresh(); toast({ title: "Recorded", variant: "success" }); },
    onError: (e: Error) => toast({ title: "Couldn't record", description: e.message, variant: "error" }),
  });
  const decide = useMutation({
    mutationFn: ({ id, status }: { id: number; status: "confirmed" | "rejected" }) => apiRequest("PATCH", `/api/treasury/entries/${id}`, { status }).then((r) => r.json()),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/treasury/entries/${id}`).then((r) => r.json()),
    onSuccess: () => void refresh(),
  });

  async function importFile(file: File) {
    try {
      const csv = await file.text();
      const r = await apiRequest("POST", "/api/treasury/import", { csv, companyId: importCompany ? Number(importCompany) : null, source: importSource || file.name }).then((x) => x.json()) as { imported: number; skipped: number };
      toast({ title: `Imported ${r.imported} entr${r.imported === 1 ? "y" : "ies"}`, description: r.skipped ? `${r.skipped} rows skipped (no date/amount).` : undefined, variant: "success" });
      void refresh();
    } catch (e) {
      toast({ title: "Import failed", description: e instanceof Error ? e.message : String(e), variant: "error" });
    }
  }

  const s = data?.summary;
  const names = new Map((data?.companies ?? []).map((c) => [c.id, c.name] as const));
  const proposed = (data?.entries ?? []).filter((e) => e.status === "proposed");
  const ledger = (data?.entries ?? []).filter((e) => e.status === "confirmed");
  const maxMonth = Math.max(1, ...(s?.byMonth ?? []).map((m) => Math.max(m.incomeCents, m.expenseCents)));

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <PageHeader title="Treasury" description="What the organization has actually earned and spent — only money you entered, imported, or confirmed counts. Nothing here is simulated." />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Earned (confirmed)" value={usd(s?.incomeCents ?? 0)} tone={(s?.incomeCents ?? 0) > 0 ? "good" : undefined} />
        <Tile label="Spent" value={usd(s?.expenseCents ?? 0)} />
        <Tile label="Net" value={usd(s?.netCents ?? 0)} tone={(s?.netCents ?? 0) > 0 ? "good" : (s?.netCents ?? 0) < 0 ? "bad" : undefined} />
        <Tile label="Awaiting your OK" value={String(s?.proposedCount ?? 0)} />
      </div>

      {s && s.incomeCents === 0 && s.expenseCents === 0 && (
        <Card className="flex items-start gap-3 p-4 text-sm text-muted-foreground">
          <Landmark size={18} className="mt-0.5 shrink-0" />
          Nothing has been earned yet. When the store, channels or deals make money, record it below or import the platform's report (Stripe, Shopify, Etsy, YouTube, your bank) — every company's real earnings add up here.
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2 p-4">
          <div className="text-sm font-medium">By company</div>
          {(s?.byCompany ?? []).length === 0 ? <div className="text-xs text-muted-foreground">No confirmed transactions yet.</div> : (
            <table className="w-full text-xs">
              <tbody>
                {s!.byCompany.map((b) => (
                  <tr key={String(b.companyId)} className="border-t border-border">
                    <td className="py-1.5">{b.companyId ? names.get(b.companyId) ?? "?" : "HQ / unassigned"}</td>
                    <td className="py-1.5 text-right text-risk-low tabular-nums">+{usd(b.incomeCents)}</td>
                    <td className="py-1.5 text-right text-muted-foreground tabular-nums">-{usd(b.expenseCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card className="space-y-2 p-4">
          <div className="text-sm font-medium">By month</div>
          {(s?.byMonth ?? []).length === 0 ? <div className="text-xs text-muted-foreground">No history yet.</div> : (
            <div className="flex h-28 items-end gap-2">
              {s!.byMonth.map((m) => (
                <div key={m.month} className="flex flex-1 flex-col items-center gap-1" title={`${m.month}: +${usd(m.incomeCents)} / -${usd(m.expenseCents)}`}>
                  <div className="flex h-24 w-full items-end justify-center gap-0.5">
                    <div className="w-1/2 rounded-t bg-risk-low/80" style={{ height: `${(m.incomeCents / maxMonth) * 100}%` }} />
                    <div className="w-1/2 rounded-t bg-muted-foreground/50" style={{ height: `${(m.expenseCents / maxMonth) * 100}%` }} />
                  </div>
                  <div className="text-[10px] text-muted-foreground">{m.month.slice(5)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="space-y-3 p-4">
        <div className="text-sm font-medium">Record a transaction</div>
        <div className="flex flex-wrap gap-2">
          <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="w-40" />
          <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="w-32"><option value="income">Income</option><option value="expense">Expense</option></Select>
          <Input type="number" min="0" step="0.01" placeholder="Amount (USD)" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="w-36" />
          <Select value={form.companyId} onChange={(e) => setForm({ ...form, companyId: e.target.value })} className="w-48">
            <option value="">HQ / unassigned</option>
            {(data?.companies ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Input placeholder="Source (e.g. Shopify)" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} className="w-40" />
          <Input placeholder="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="min-w-[10rem] flex-1" />
          <Button variant="primary" onClick={() => add.mutate()} disabled={!Number(form.amount) || add.isPending}>Add</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs">
          <span className="text-muted-foreground">Import a platform report (CSV with a date and an amount column):</span>
          <Select value={importCompany} onChange={(e) => setImportCompany(e.target.value)} className="h-8 w-44 text-xs">
            <option value="">HQ / unassigned</option>
            {(data?.companies ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Input placeholder="Source" value={importSource} onChange={(e) => setImportSource(e.target.value)} className="h-8 w-32 text-xs" />
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}><Upload size={12} /> Import CSV</Button>
        </div>
      </Card>

      {proposed.length > 0 && (
        <Card className="space-y-2 p-4">
          <div className="text-sm font-medium">Proposed by agents — confirm only what really happened</div>
          {proposed.map((e) => (
            <div key={e.id} className="flex flex-wrap items-center gap-2 border-t border-border pt-2 text-xs">
              <span className={e.kind === "income" ? "text-risk-low" : ""}>{e.kind === "income" ? "+" : "-"}{usd(e.amountCents)}</span>
              <span>{e.source}</span>
              <span className="text-muted-foreground">{e.companyId ? names.get(e.companyId) : "HQ"} · {e.note} · by {e.createdBy}</span>
              <span className="flex-1" />
              <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: e.id, status: "confirmed" })}><Check size={12} /> Confirm</Button>
              <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: e.id, status: "rejected" })}><X size={12} /> Reject</Button>
            </div>
          ))}
        </Card>
      )}

      <Card className="p-4">
        <div className="mb-2 text-sm font-medium">Ledger</div>
        {ledger.length === 0 ? <div className="text-xs text-muted-foreground">No confirmed transactions yet.</div> : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1">Date</th><th>Company</th><th>Source</th><th>Note</th><th className="text-right">Amount</th><th /></tr></thead>
            <tbody>
              {ledger.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="py-1.5">{new Date(e.at).toLocaleDateString()}</td>
                  <td>{e.companyId ? names.get(e.companyId) ?? "?" : "HQ"}</td>
                  <td>{e.source}</td>
                  <td className="text-muted-foreground">{e.note}</td>
                  <td className={`text-right tabular-nums ${e.kind === "income" ? "text-risk-low" : ""}`}>{e.kind === "income" ? "+" : "-"}{usd(e.amountCents)}</td>
                  <td className="text-right"><button type="button" className="opacity-50 hover:opacity-100" title="Delete" onClick={() => { if (confirm("Delete this ledger entry?")) remove.mutate(e.id); }}><Trash2 size={12} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-2"><StatusBadge status="confirmed" /> <span className="text-[11px] text-muted-foreground">entries only — rejected proposals are kept out of every total.</span></div>
      </Card>
    </div>
  );
}
