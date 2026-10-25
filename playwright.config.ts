import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results/artifacts',
  // Tests are independent pages, so they all run side by side.
  fullyParallel: true,
  workers: 6,
  webServer: { command: 'npm run build && npx vite preview --port 4173', port: 4173, reuseExistingServer: false },
})
