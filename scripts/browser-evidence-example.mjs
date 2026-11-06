export default {
  server: {
    command: "bun",
    args: ["run", "dev"],
    cwd: ".",
    readinessUrl: "http://127.0.0.1:{port}/health",
    env: {},
  },
  async journey(page, evidence) {
    await page.goto(`http://127.0.0.1:${process.env.PORT}`);
    await page.getByRole("heading", { name: "Example journey" }).waitFor();
    await evidence.screenshotElement("example-surface", "main");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByText("Completed").waitFor();
    await page.waitForTimeout(30_000); // Replace with a real reading pause in an actual journey.
  },
};
