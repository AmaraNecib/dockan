import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * bun test preload for apps/web unit tests: registers a happy-dom window so
 * hooks and components under test see real DOM globals (see bunfig.toml).
 * Registered once per test process; tests stay isolated by clearing body.
 */
GlobalRegistrator.register();
