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
	const idRef = useRef<string | null>(null)

	useEffect(() => {
		const envDebug = (process.env.NEXT_PUBLIC_NEWS_DEBUG || '').toString() === '1'
		const runtimeDebug = typeof window !== 'undefined' && (window as any).__NEWS_DEBUG === true
		const debugOn = envDebug || runtimeDebug
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

	const handleClick: React.MouseEventHandler<HTMLAnchorElement> = (e) => {
		if (!sourceUrl) return
		const envDebug = (process.env.NEXT_PUBLIC_NEWS_DEBUG || '').toString() === '1'
		const runtimeDebug = typeof window !== 'undefined' && (window as any).__NEWS_DEBUG === true
		const debugOn = envDebug || runtimeDebug
		const id = idRef.current || (e.currentTarget as HTMLElement).getAttribute('data-id') || '(unknown)'
		if (debugOn) {
			;(window as any).__clicked = true
			console.log('click-start', { id, href: sourceUrl })
		}
		try {
			onOpen?.(sourceUrl)
			const domain = (() => { try { return new URL(sourceUrl).hostname } catch { return '' } })()
			console.info('open_source_clicked', { domain, success: true })
		} catch {}
		const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
		const isiOS = /iPhone|iPad|iPod/i.test(ua)
		if (typeof window !== 'undefined' && isStandalonePWA() && isiOS) {
			// Prevent default anchor behavior; use same-view navigation for PWA
			e.preventDefault()
			const proceed = window.confirm('Open article in Safari?')
			;(window as any).__confirmCalled = true
			if (proceed) {
				window.location.assign(sourceUrl)
				if (debugOn) console.log('click-end', { id, result: 'success', mode: 'pwa' })
			} else {
				if (debugOn) console.log('click-end', { id, result: 'cancel', mode: 'pwa' })
			}
			return
		}
		// Desktop/web
		if (debugOn) {
			// For test determinism, open via window.open and prevent default
			e.preventDefault()
			;(window as any).__opened = sourceUrl
			window.open(sourceUrl, '_blank', 'noopener,noreferrer')
			console.log('click-end', { id, result: 'success', mode: 'desktop-debug' })
			return
		}
		// Let anchor default behavior open in new tab (supports middle/ctrl/cmd click)
		if (debugOn) console.log('click-end', { id, result: 'success', mode: 'desktop' })
	}

	const role = sourceUrl ? undefined : 'group'
	const tabIndex = sourceUrl ? undefined : -1
	const ariaDisabled = !sourceUrl
	const computedClassName = className ?? (sourceUrl ? 'cursor-pointer' : 'cursor-not-allowed opacity-80')

	if (sourceUrl) {
		return (
			<a
				href={sourceUrl}
				target="_blank"
				rel="noopener noreferrer"
				onClick={handleClick}
				aria-disabled={ariaDisabled}
				aria-label={'Open original article'}
				className={computedClassName}
				{...rest}
			>
				{children}
			</a>
		)
	}

	return (
		<div
			role={role}
			tabIndex={tabIndex}
			aria-disabled={ariaDisabled}
			aria-label={'No source available'}
			className={computedClassName}
			{...rest}
		>
			{children}
		</div>
	)
}


