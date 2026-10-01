import { Route, Switch } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { ToastProvider } from "@/components/ui/Toast";
import { VoiceProvider } from "@/lib/voice";
import { MusicProvider } from "@/lib/music";
import { NotificationsProvider } from "@/lib/notifications";
import { AuthGate } from "@/components/AuthGate";
import { OllamaOnboarding } from "@/components/OllamaOnboarding";
import { AppShell } from "@/components/AppShell";
import Home from "@/pages/Home";
import Generate from "@/pages/Generate";
import Tasks from "@/pages/Tasks";
import Projects from "@/pages/Projects";
import Library from "@/pages/Library";
import MusicLibrary from "@/pages/MusicLibrary";
import Memory from "@/pages/Memory";
import Terminal from "@/pages/Terminal";
import Browser from "@/pages/Browser";
import GodsEye from "@/pages/GodsEye";
import Agents from "@/pages/Agents";
import Team from "@/pages/Team";
import Town from "@/pages/Town";
import Pipelines from "@/pages/Pipelines";
import Treasury from "@/pages/Treasury";
import Store from "@/pages/Store";
import Outbox from "@/pages/Outbox";
import Skills from "@/pages/Skills";
import Approvals from "@/pages/Approvals";
import Audit from "@/pages/Audit";
import Settings from "@/pages/Settings";
import Customize from "@/pages/Customize";
import NotFound from "@/pages/not-found";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthGate>
          <OllamaOnboarding>
            <VoiceProvider>
              <MusicProvider>
                <NotificationsProvider>
                  <AppShell>
                    <Switch>
                      <Route path="/" component={Home} />
                      <Route path="/team" component={Team} />
                      <Route path="/town" component={Town} />
                      <Route path="/pipelines" component={Pipelines} />
                      <Route path="/treasury" component={Treasury} />
                      <Route path="/store" component={Store} />
                      <Route path="/agents" component={Agents} />
                      <Route path="/generate" component={Generate} />
                      <Route path="/tasks" component={Tasks} />
                      <Route path="/projects" component={Projects} />
                      <Route path="/library" component={Library} />
                      <Route path="/music" component={MusicLibrary} />
                      <Route path="/memory" component={Memory} />
                      <Route path="/terminal" component={Terminal} />
                      <Route path="/browser" component={Browser} />
                      <Route path="/godseye" component={GodsEye} />
                      <Route path="/outbox" component={Outbox} />
                      <Route path="/skills" component={Skills} />
                      <Route path="/approvals" component={Approvals} />
                      <Route path="/audit" component={Audit} />
                      <Route path="/settings" component={Settings} />
                      <Route path="/customize" component={Customize} />
                      <Route component={NotFound} />
                    </Switch>
                  </AppShell>
                </NotificationsProvider>
              </MusicProvider>
            </VoiceProvider>
          </OllamaOnboarding>
        </AuthGate>
      </ToastProvider>
    </QueryClientProvider>
  );
}
