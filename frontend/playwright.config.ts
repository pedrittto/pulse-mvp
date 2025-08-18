import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './src/__e2e__',
	fullyParallel: true,
	retries: 0,
	use: {
		baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
		trace: 'on-first-retry',
		video: 'retain-on-failure'
	},
	webServer: {
		command: 'npm run dev',
		url: 'http://localhost:3000',
		reuseExistingServer: true,
		cwd: __dirname
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'webkit-ios-pwa', use: { ...devices['iPhone 13'], userAgent: devices['iPhone 13'].userAgent } }
	]
});


