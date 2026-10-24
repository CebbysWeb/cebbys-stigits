import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results/artifacts',
  webServer: { command: 'npm run build && npx vite preview --port 4173', port: 4173, reuseExistingServer: true },
})
