export default {
  servers: [
    {
      name: "api",
      command: "bun",
      args: ["src/main.ts"],
      cwd: "apps/api",
      readinessUrl: "http://127.0.0.1:{port}/api/vault/status",
    },
    {
      name: "web",
      command: "bun",
      args: ["run", "dev"],
      cwd: "apps/web",
      readinessUrl: "http://127.0.0.1:{port}/",
    },
  ],
  async setup(page, runtime) {
    await page.goto(runtime.urls.web);
    // Authenticate here if the selected journey needs a signed-in user.
    // This page is not recorded.
  },
  async journey(page, evidence, runtime) {
    await page.goto(runtime.urls.web);
    // Put the product's useful actions and assertions here. Keep this segment
    // naturally between 30 and 45 seconds; do not add idle waits for duration.
    await evidence.screenshotElement("dokan-screen", "main");
  },
};
