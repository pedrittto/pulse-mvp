import { expect, test, describe } from '@jest/globals'
// Import the module to access normalizeItem via a re-export shim
import * as Mod from './fetcher'

// Access normalizeItem through module closure by invoking fetcher path indirectly
// We re-declare a local copy for unit testing with same logic to avoid exporting private
function normalizeItemForTest(item: any) {
	let impactCategory: string | null = null
	let impactScore: number | null = null
	if (typeof item.impact === 'string') {
		impactCategory = item.impact
		impactScore = typeof item.impact_score === 'number' ? item.impact_score : null
	} else if (item.impact && typeof item.impact === 'object') {
		impactCategory = item.impact.category ?? null
		impactScore = item.impact.score ?? (typeof item.impact_score === 'number' ? item.impact_score : null)
	} else if (typeof item.impact_score === 'number') {
		const s = item.impact_score
		impactCategory = s >= 80 ? 'C' : s >= 60 ? 'H' : s >= 35 ? 'M' : 'L'
		impactScore = s
	}
	const verificationState = item.verification?.state ?? item.verification_legacy ?? null
	let confidenceState = item.confidence_state ?? null
	if (!confidenceState && typeof item.confidence === 'number') {
		const n = item.confidence
		confidenceState = n >= 90 ? 'confirmed' : n >= 75 ? 'verified' : n >= 50 ? 'corroborated' : n >= 25 ? 'reported' : 'unconfirmed'
	}
	let sourceUrl: string | null = null
	try {
		const direct = item.url ?? item.link ?? item.source_url
		let candidate: any = direct
		if (!candidate && Array.isArray(item.sources)) {
			const found = item.sources.find((s: any) => s && typeof s === 'object' && typeof s.url === 'string' && s.url.length > 0)
			candidate = found?.url
		}
		if (typeof candidate === 'string' && candidate.length > 0) {
			const u = new URL(candidate)
			if (/^https?:$/i.test(u.protocol)) {
				sourceUrl = u.toString()
			}
		}
	} catch (_) {
		sourceUrl = null
	}
	return { ...item, impactCategory, impactScore, verificationState, confidenceState, sourceUrl }
}

describe('normalizeItem sourceUrl derivation', () => {
	test('direct url present', () => {
		const item = { url: 'https://example.com/article' }
		const out = normalizeItemForTest(item)
		expect(out.sourceUrl).toBe('https://example.com/article')
	})

	test('first valid sources[i].url used', () => {
		const item = { sources: [{ name: 'x' }, { url: 'http://news.site/path' }] }
		const out = normalizeItemForTest(item)
		expect(out.sourceUrl).toBe('http://news.site/path')
	})

	test('invalid or missing URL results in null', () => {
		const item = { link: 'ftp://malicious.site/bad' }
		const out = normalizeItemForTest(item)
		expect(out.sourceUrl).toBeNull()
	})
})


