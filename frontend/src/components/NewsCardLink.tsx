import React from 'react'

type NewsCardLinkProps = {
	// Normalized source URL; if null, card is inert
	sourceUrl: string | null
	children: React.ReactNode
	onOpen?: (url: string) => void
	className?: string
} & React.HTMLAttributes<HTMLDivElement>

function isStandalonePWA(): boolean {
	if (typeof window === 'undefined') return false
	const mm = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || false
	// iOS Safari legacy flag
	const iosStandalone = (typeof navigator !== 'undefined' && (navigator as any).standalone) || false
	return Boolean(mm || iosStandalone)
}

export default function NewsCardLink({ sourceUrl, children, onOpen, className, ...rest }: NewsCardLinkProps) {
	const handleActivate: React.MouseEventHandler<HTMLDivElement> = (e) => {
		if (!sourceUrl) return
		// Optional analytics hook
		try {
			onOpen?.(sourceUrl)
			const domain = (() => { try { return new URL(sourceUrl).hostname } catch { return '' } })()
			console.info('open_source_clicked', { domain, success: true })
		} catch {}
		const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
		const isiOS = /iPhone|iPad|iPod/i.test(ua)
		if (typeof window !== 'undefined' && isStandalonePWA() && isiOS) {
			// Minimal confirmation sheet; replace with app modal system if needed
			const open = window.confirm('Open article in Safari?')
			if (open) {
				window.location.assign(sourceUrl)
			}
			return
		}
		// Default: open in new tab with security flags
		if (typeof window !== 'undefined') {
			window.open(sourceUrl, '_blank', 'noopener,noreferrer')
		}
	}

	const onKey: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
		if (!sourceUrl) return
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault()
			handleActivate(e as unknown as React.MouseEvent<HTMLDivElement>)
		}
	}

	const role = sourceUrl ? 'link' : 'group'
	const tabIndex = sourceUrl ? 0 : -1
	const ariaDisabled = !sourceUrl

	return (
		<div
			role={role}
			tabIndex={tabIndex}
			onClick={sourceUrl ? handleActivate : undefined}
			onKeyDown={sourceUrl ? onKey : undefined}
			aria-disabled={ariaDisabled}
			aria-label={sourceUrl ? 'Open original article' : 'No source available'}
			className={className ?? (sourceUrl ? 'cursor-pointer' : 'cursor-not-allowed opacity-80')}
			{...rest}
		>
			{children}
		</div>
	)
}


