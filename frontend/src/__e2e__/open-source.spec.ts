import { test, expect } from '@playwright/test'

// Helper to mock API via Next proxy rewrite; assumes dev server at :3000 proxying :4000
// For this e2e, we intercept the frontend fetch and serve a synthetic feed array.

const FEED_WITH_URL = [
	{
		id: 'id-has-url',
		headline: 'Card With URL',
		why: 'desc',
		sources: ['https://example.com/source'],
		impact: { category: 'L', level: 'L', score: 40 },
		impact_score: 40,
		confidence_state: 'reported',
		published_at: new Date().toISOString(),
		arrival_at: new Date().toISOString(),
		url: 'https://example.com/article'
	},
	{
		id: 'id-no-url',
		headline: 'Card Without URL',
		why: 'desc',
		sources: ['bloomberg.com'],
		impact: { category: 'L', level: 'L', score: 40 },
		impact_score: 40,
		confidence_state: 'reported',
		published_at: new Date().toISOString(),
		arrival_at: new Date().toISOString()
	}
]

test.describe('NewsCard open source - desktop', () => {
	test('click with URL triggers link behavior; without URL is inert', async ({ page }) => {
		if (test.info().project.name !== 'chromium') {
			test.skip()
		}
		await page.addInitScript(() => {
			// Force runtime debug path in app code
			;(window as any).__NEWS_DEBUG = true
		})
		await page.addInitScript((data) => {
			const payload = JSON.stringify(data);
			const origFetch = window.fetch.bind(window);
			window.fetch = async (input, init) => {
				const url = typeof input === 'string' ? input : input.toString();
				if (url.includes('/api/feed')) {
					return new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
				return origFetch(input, init);
			};
		}, FEED_WITH_URL as any)
		await page.goto('/e2e-demo')
		await page.waitForLoadState('networkidle')
		const cardWith = page.locator('[data-testid="news-card"][data-url="https://example.com/article"]').first()
		await expect(cardWith).toBeVisible({ timeout: 15000 })
		// Verify anchor attributes
		await expect(cardWith).toHaveAttribute('href', 'https://example.com/article')
		await expect(cardWith).toHaveAttribute('target', '_blank')
		await cardWith.click()
		await expect.poll(async () => page.evaluate(() => (window as any).__clicked === true)).toBe(true)

		const disabledCard = page.locator('[data-testid="news-card"][data-url=""]').first()
		await expect(disabledCard).toBeVisible()
		await expect(disabledCard).toHaveAttribute('aria-disabled', 'true')
		await expect(disabledCard).not.toBeFocused()
	})
})

test.describe('NewsCard open source - iOS PWA standalone', () => {
	test('click triggers PWA confirm and no window.open', async ({ page }) => {
		if (test.info().project.name !== 'webkit-ios-pwa') {
			test.skip()
		}
		await page.addInitScript(() => {
			// Force runtime debug path in app code
			;(window as any).__NEWS_DEBUG = true
			// Robust matchMedia stub for display-mode: standalone
			// @ts-ignore
			window.matchMedia = (q: string) => {
				const isStandalone = q === '(display-mode: standalone)'
				return {
					matches: isStandalone,
					media: q,
					onchange: null,
					addListener: () => {},
					removeListener: () => {},
					addEventListener: () => {},
					removeEventListener: () => {},
					dispatchEvent: () => false
				} as any
			}
			// track if open is used erroneously
			// @ts-ignore
			window.open = (url: string) => { (window as any).__opened = url; return null }
		})
		await page.addInitScript((data) => {
			const payload = JSON.stringify(data);
			const origFetch = window.fetch.bind(window);
			window.fetch = async (input, init) => {
				const url = typeof input === 'string' ? input : input.toString();
				if (url.includes('/api/feed')) {
					return new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } });
				}
				return origFetch(input, init);
			};
		}, FEED_WITH_URL as any)
		await page.goto('/e2e-demo')
		await page.waitForLoadState('networkidle')
		const cardWith = page.locator('[data-testid="news-card"][data-url="https://example.com/article"]').first()
		await expect(cardWith).toBeVisible({ timeout: 15000 })
		await cardWith.click()
		await expect.poll(async () => page.evaluate(() => (window as any).__confirmCalled === true)).toBe(true)
		await expect.poll(async () => page.evaluate(() => (window as any).__opened)).toBeUndefined()
	})
})


