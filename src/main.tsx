import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Async coaching: the vanilla "Send to coach" widget (shared with the hub's
// strength pages) lives in /public. Inject it at runtime so every RoxLive
// athlete can send a clip to the coach. async=false preserves order
// (review-client must define window.RoxReview before review-submit runs).
["review-client.js", "review-submit.js"].forEach((f) => {
  const s = document.createElement("script");
  s.src = import.meta.env.BASE_URL + f;
  s.async = false;
  document.body.appendChild(s);
});
