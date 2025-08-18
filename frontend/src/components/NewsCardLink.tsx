"use client"

import React, { useEffect, useRef } from 'react'

type NewsCardLinkProps = {
	// Normalized source URL; if null, card is inert
	sourceUrl: string | null
	children: React.ReactNode
	onOpen?: (url: string) => void
	className?: string
} & React.HTMLAttributes<HTMLElement>

function isStandalonePWA(): boolean {
	if (typeof window === 'undefined') return false
	const mm = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || false
	// iOS Safari legacy flag
	const iosStandalone = (typeof navigator !== 'undefined' && (navigator as any).standalone) || false
	return Boolean(mm || iosStandalone)
}

export default function NewsCardLink({ sourceUrl, children, onOpen, className, ...rest }: NewsCardLinkProps) {
	const debugOn = (process.env.NEXT_PUBLIC_NEWS_DEBUG || '').toString() === '1'
	const idRef = useRef<string | null>(null)

	useEffect(() => {
		if (!debugOn) return
		;(window as any).__newsCardMountCount = ((window as any).__newsCardMountCount || 0) + 1
		const count = (window as any).__newsCardMountCount
		if (!idRef.current) {
			const anyRest: any = rest as any
			idRef.current = (anyRest && (anyRest['data-id'] || anyRest['data-testid'])) || null
		}
		if (count <= 5) {
			console.log('news-card-mount', {
				id: idRef.current,
				hasSourceUrl: Boolean(sourceUrl),
				href: sourceUrl || null,
			})
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const handleActivate: React.MouseEventHandler<HTMLElement> = (e) => {
		if (!sourceUrl) return
		const id = idRef.current || (e.currentTarget as HTMLElement).getAttribute('data-id') || '(unknown)'
		if (debugOn) {
			console.log('click-start', { id, href: sourceUrl })
		}
		// Optional analytics hook
		try {
			onOpen?.(sourceUrl)
			const domain = (() => { try { return new URL(sourceUrl).hostname } catch { return '' } })()
			console.info('open_source_clicked', { domain, success: true })
		} catch {}
		const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
		const isiOS = /iPhone|iPad|iPod/i.test(ua)
		if (typeof window !== 'undefined' && isStandalonePWA() && isiOS) {
			const open = window.confirm('Open article in Safari?')
			if (open) {
				window.location.assign(sourceUrl)
				if (debugOn) console.log('click-end', { id, result: 'success' })
			} else {
				if (debugOn) console.log('click-end', { id, result: 'cancel' })
			}
			// For div wrapper, nothing to prevent, but stop here
			return
		}
		// Default desktop/web path: open synchronously in new tab
		if (typeof window !== 'undefined') {
			window.open(sourceUrl, '_blank', 'noopener,noreferrer')
			if (debugOn) console.log('click-end', { id, result: 'success' })
		}
	}

	const onKey: React.KeyboardEventHandler<HTMLElement> = (e) => {
		if (!sourceUrl) return
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault()
			handleActivate(e as unknown as React.MouseEvent<HTMLElement>)
		}
	}

	const role = sourceUrl ? 'link' : 'group'
	const tabIndex = sourceUrl ? 0 : -1
	const ariaDisabled = !sourceUrl
	const computedClassName = className ?? (sourceUrl ? 'cursor-pointer' : 'cursor-not-allowed opacity-80')

	return (
		<div
			role={role}
			tabIndex={tabIndex}
			onClick={sourceUrl ? handleActivate : undefined}
			onKeyDown={sourceUrl ? onKey : undefined}
			aria-disabled={ariaDisabled}
			aria-label={sourceUrl ? 'Open original article' : 'No source available'}
			className={computedClassName}
			{...rest}
		>
			{children}
		</div>
	)
}


