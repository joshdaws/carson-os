import { Component, type ReactNode } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { DashboardPage } from "./pages/Dashboard";
import { HouseholdPage } from "./pages/Household";
import { ConstitutionPage } from "./pages/Constitution";
import { TasksPage } from "./pages/Tasks";
import { StaffDetailPage } from "./pages/StaffDetail";
import { ConversationsPage } from "./pages/Conversations";
import { SettingsPage } from "./pages/Settings";
import { OnboardingPage } from "./pages/Onboarding";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: "2rem",
          fontFamily: "ui-monospace, monospace",
          background: "#1a1f2e",
          color: "#e8dfd0",
          minHeight: "100vh",
        }}>
          <h2 style={{ color: "#c0392b", marginBottom: "1rem" }}>
            Something broke
          </h2>
          <pre style={{
            background: "#111",
            padding: "1rem",
            borderRadius: "6px",
            overflow: "auto",
            fontSize: "13px",
            whiteSpace: "pre-wrap",
          }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1rem",
              background: "#8b6f4e",
              color: "#fff",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/household" element={<HouseholdPage />} />
          <Route path="/constitution" element={<ConstitutionPage />} />
          {/* <Route path="/tasks" element={<TasksPage />} /> — hidden until delegation MVP */}
          <Route path="/staff/:staffId" element={<StaffDetailPage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}
