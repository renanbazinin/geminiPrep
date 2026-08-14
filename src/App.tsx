import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { AppProvider } from "./contexts/AppContext";
import { ConfigProvider } from "./contexts/ConfigContext";
import { TestLanguageProvider } from "./contexts/TestLanguageContext";
import { ChatPage } from "./pages/ChatPage";
import { CachePage } from "./pages/CachePage";
import { RegionsPage } from "./pages/RegionsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TestsPage } from "./pages/TestsPage";

export function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <ConfigProvider>
          <TestLanguageProvider>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<ChatPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="tests" element={<TestsPage />} />
                <Route path="tests/regions" element={<RegionsPage />} />
                <Route path="tests/cache" element={<CachePage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </TestLanguageProvider>
        </ConfigProvider>
      </AppProvider>
    </BrowserRouter>
  );
}
