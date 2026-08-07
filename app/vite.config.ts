import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [
        "icon.svg",
        "favicon.svg",
        "icon-192.png",
        "icon-512.png",
        "icon-512-maskable.png",
        "apple-touch-icon.png",
      ],
      manifest: {
        name: "Brand Studio",
        short_name: "Brand Studio",
        description:
          "Speak on your phone, post everywhere. Say an idea out loud and get ready-to-post content for X, Facebook, TikTok, Snapchat and Instagram — written in your voice.",
        id: "/",
        theme_color: "#06080f",
        background_color: "#06080f",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
        // Lets other apps (camera, editors, AI tools) share text/links INTO Brand Studio.
        share_target: {
          action: "/capture",
          method: "GET",
          params: { title: "title", text: "text", url: "url" },
        },
      },
      workbox: {
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api/],
        // Prefer network for the shell so viewport / zoom meta updates aren't stuck on an old cache.
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: {
              cacheName: "pages",
              networkTimeoutSeconds: 3,
            },
          },
        ],
      },
    }),
  ],
});
