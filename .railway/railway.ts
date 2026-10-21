import { defineRailway, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const web = service("web", {
    build: "npm run build",
    start: "npm start",
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    // Restarts on failure (Railway's default policy), up to 5 times.
    deploy: {
      restartPolicyMaxRetries: 5,
    },
    env: {
      // SQLite database and per-sheet JSON files live on the volume.
      DATA_DIR: "/data",
      // Railway serves over HTTPS, so session cookies can be Secure.
      SECURE_COOKIES: "1",
      // Self-improvement: app-change jobs run Claude Code in this container, so the image needs git and the
      // dev dependencies (vite, vitest, tsc) to rebuild and verify. GITHUB_TOKEN (contents + pull requests,
      // read/write) is set in the dashboard, not here.
      // Chromium makes PDFs (Download as PDF, server/pdf.ts), found at CHROMIUM_PATH.
      RAILPACK_DEPLOY_APT_PACKAGES: "git chromium",
      CHROMIUM_PATH: "/usr/bin/chromium",
      RAILPACK_PRUNE_DEPS: "false",
      // Off-box copy of every file in Cloudflare R2 (server/backup.ts): R2_BUCKET, R2_ACCESS_KEY_ID,
      // R2_SECRET_ACCESS_KEY and CLOUDFLARE_ACCOUNT_ID are secrets, set in the dashboard, not here.
      // Give in-flight requests a moment to finish when a deploy replaces the container.
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "15",
      // The app lives at docs.freeflow.im; the old sheets.freeflow.im host redirects there.
      APP_URL: "https://docs.freeflow.im",
      LEGACY_HOSTS: "sheets.freeflow.im",
    },
    volumeMounts: {
      "/data": volume("universal-docs-data", { region: "sfo", sizeMB: 5000 }),
    },
    domains: ["docs.freeflow.im", "sheets.freeflow.im"],
    // A volume can only be attached to a single replica.
    replicas: { sfo: 1 },
  });

  return project("universal-docs", {
    resources: [web],
  });
});
