import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, setToken } from "@/lib/queryClient";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Lock } from "lucide-react";

interface AuthStatus { pinSet: boolean; authenticated: boolean; }

function Logo() {
  return (
    <svg width="40" height="40" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="auth-mark" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="hsl(var(--primary))" />
          <stop offset="100%" stopColor="hsl(var(--accent))" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="15" stroke="url(#auth-mark)" strokeWidth="1.6" opacity="0.4" />
      <circle cx="16" cy="16" r="8" fill="url(#auth-mark)" />
    </svg>
  );
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { data: status, isLoading } = useQuery<AuthStatus>({ queryKey: ["/api/auth/status"] });
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (isLoading) return null;

  if (status?.authenticated) return <>{children}</>;

  const isSetup = !status?.pinSet;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (isSetup) {
      if (!/^\d{4,12}$/.test(pin)) return setError("PIN must be 4-12 digits.");
      if (pin !== confirmPin) return setError("PINs don't match.");
    }
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", isSetup ? "/api/auth/setup" : "/api/auth/login", { pin });
      const data = await res.json();
      setToken(data.token);
      qc.invalidateQueries({ queryKey: ["/api/auth/status"] });
    } catch (err) {
      setError(isSetup ? "Couldn't set PIN — try again." : "Incorrect PIN.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-6">
          <Logo />
          <div className="text-center">
            <div className="text-lg font-semibold tracking-tight">AURORA</div>
            <div className="text-sm text-muted-foreground mt-1">
              {isSetup ? "Set a PIN to protect this instance" : "Enter your PIN"}
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-card p-5 space-y-4">
          {isSetup && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              This PIN is the only thing standing between anyone with access to this device and AURORA's tools —
              including running commands on this computer. Pick something you'll remember; there's no recovery flow.
            </p>
          )}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Lock size={12} /> PIN
            </label>
            <Input
              type="password"
              inputMode="numeric"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              placeholder="4-12 digits"
              maxLength={12}
            />
          </div>
          {isSetup && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Confirm PIN</label>
              <Input
                type="password"
                inputMode="numeric"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
                placeholder="Re-enter PIN"
                maxLength={12}
              />
            </div>
          )}
          {error && <p className="text-xs text-risk-high">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" disabled={submitting || !pin}>
            {isSetup ? "Set PIN & continue" : "Unlock"}
          </Button>
        </form>
      </div>
    </div>
  );
}
