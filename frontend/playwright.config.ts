import { defineConfig, devices } from '@playwright/test';

const serverMode = process.env.PLAYWRIGHT_SERVER_MODE || 'dev';
const webServer = serverMode === 'prod'
	? {
		command: 'npm run build && npm run start:local',
		url: 'http://localhost:3000',
		reuseExistingServer: true,
		cwd: __dirname
	}
	: {
		command: 'npm run dev',
		url: 'http://localhost:3000',
		reuseExistingServer: true,
		cwd: __dirname
	};

export default defineConfig({
	testDir: './src/__e2e__',
	fullyParallel: true,
	retries: 0,
	use: {
		baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000',
		trace: 'on-first-retry',
		video: 'retain-on-failure'
	},
	webServer,
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'webkit-ios-pwa', use: { ...devices['iPhone 13'], userAgent: devices['iPhone 13'].userAgent } }
	]
});


