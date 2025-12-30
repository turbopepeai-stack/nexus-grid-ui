import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "Nexus Analyt",
        short_name: "Nexus",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#0b0f1a",
        theme_color: "#0b0f1a",
        icons: [
          {
            src: "/public/pwa-192.png",
            sizes: "192x192",
            type: "image/png"
          },
          {
            src: "/public/pwa-512.png",
            sizes: "512x512",
            type: "image/png"
          }
        ]
      }
    })
  ]
});
