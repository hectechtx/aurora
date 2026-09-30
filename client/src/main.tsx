import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyStoredTheme } from "./lib/theme";

// Apply the saved accent theme before first paint so there's no flash.
applyStoredTheme();

createRoot(document.getElementById("root")!).render(<App />);
