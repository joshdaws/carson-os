import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DashboardPage } from "./pages/Dashboard";
import { FamilyPage } from "./pages/Family";
import { ConstitutionPage } from "./pages/Constitution";
import { ConversationsPage } from "./pages/Conversations";
import { AgentDetailPage } from "./pages/AgentDetail";
import { BudgetPage } from "./pages/Budget";
import { SettingsPage } from "./pages/Settings";
import { OnboardingPage } from "./pages/Onboarding";

export function App() {
  return (
    <Routes>
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/family" element={<FamilyPage />} />
        <Route path="/constitution" element={<ConstitutionPage />} />
        <Route path="/conversations" element={<ConversationsPage />} />
        <Route path="/agents/:agentId" element={<AgentDetailPage />} />
        <Route path="/budget" element={<BudgetPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
