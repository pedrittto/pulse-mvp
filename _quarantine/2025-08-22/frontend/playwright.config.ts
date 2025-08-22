import { defineConfig, devices } from '@playwright/test';

const serverMode = process.env.PLAYWRIGHT_SERVER_MODE || 'dev';
const TEST_PORT = process.env.PLAYWRIGHT_PORT || '3100';
const TEST_URL = `http://localhost:${TEST_PORT}`;

const webServer = serverMode === 'prod'
	? {
		command: `npm run build && npx next start -p ${TEST_PORT}`,
		url: TEST_URL,
		reuseExistingServer: false,
		cwd: __dirname,
		env: { NEXT_PUBLIC_NEWS_DEBUG: '1', ...process.env }
	}
	: {
		command: `npx next dev -p ${TEST_PORT}`,
		url: TEST_URL,
		reuseExistingServer: false,
		cwd: __dirname,
		env: { NEXT_PUBLIC_NEWS_DEBUG: '1', ...process.env }
	};

export default defineConfig({
	testDir: './src/__e2e__',
	fullyParallel: true,
	retries: 0,
	use: {
		baseURL: TEST_URL,
		trace: 'on-first-retry',
		video: 'retain-on-failure'
	},
	webServer,
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'webkit-ios-pwa', use: { ...devices['iPhone 13'], userAgent: devices['iPhone 13'].userAgent } }
	]
});


