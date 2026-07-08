import { Route, Switch } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { ToastProvider } from "@/components/ui/Toast";
import { VoiceProvider } from "@/lib/voice";
import { AppShell } from "@/components/AppShell";
import Tasks from "@/pages/Tasks";
import Library from "@/pages/Library";
import Memory from "@/pages/Memory";
import Terminal from "@/pages/Terminal";
import Agents from "@/pages/Agents";
import Outbox from "@/pages/Outbox";
import Skills from "@/pages/Skills";
import Approvals from "@/pages/Approvals";
import Audit from "@/pages/Audit";
import Settings from "@/pages/Settings";
import NotFound from "@/pages/not-found";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <VoiceProvider>
          <AppShell>
            <Switch>
              <Route path="/" component={Tasks} />
              <Route path="/library" component={Library} />
              <Route path="/memory" component={Memory} />
              <Route path="/terminal" component={Terminal} />
              <Route path="/agents" component={Agents} />
              <Route path="/outbox" component={Outbox} />
              <Route path="/skills" component={Skills} />
              <Route path="/approvals" component={Approvals} />
              <Route path="/audit" component={Audit} />
              <Route path="/settings" component={Settings} />
              <Route component={NotFound} />
            </Switch>
          </AppShell>
        </VoiceProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
