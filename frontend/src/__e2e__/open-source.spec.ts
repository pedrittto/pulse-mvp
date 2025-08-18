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
	test('click with URL opens new page; without URL is inert', async ({ page }) => {
		// Stub window.open to capture attempted URL
		await page.addInitScript(() => {
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
		// Locate the card with URL via stable data attributes
		const cardWith = page.locator('[data-testid="news-card"][data-url="https://example.com/article"]').first()
		await expect(cardWith).toBeVisible({ timeout: 15000 })
		await cardWith.click()
		// Assert window.open was called with exact URL
		await expect.poll(async () => page.evaluate(() => (window as any).__opened)).toBe('https://example.com/article')

		// The card without URL should be disabled and not set __opened
		const disabledCard = page.locator('[data-testid="news-card"][data-url=""]').first()
		await expect(disabledCard).toBeVisible()
		await expect(disabledCard).toHaveAttribute('aria-disabled', 'true')
		// ensure no additional open recorded
		await expect.poll(async () => page.evaluate(() => (window as any).__opened)).toBe('https://example.com/article')
	})
})

test.describe('NewsCard open source - iOS PWA standalone', () => {
	// Simulate display-mode: standalone and iOS UA via meta injection
	test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' })

	test('click triggers PWA path (confirm shown) and does not use window.open', async ({ page }) => {
		await page.addInitScript(() => {
			Object.defineProperty(window, 'matchMedia', {
				value: (q: string) => ({ matches: q === '(display-mode: standalone)' }),
			})
			// track confirm usage and prevent navigation
			// @ts-ignore
			window.confirm = (msg?: string) => { (window as any).__confirmCalled = true; return false }
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
		await expect.poll(async () => page.evaluate(() => (window as any).__confirmCalled)).toBe(true)
		await expect.poll(async () => page.evaluate(() => (window as any).__opened)).toBeUndefined()
	})
})


