import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { TimeProvider } from '@/lib/timeContext'
import Image from 'next/image'
import Link from 'next/link'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Pulse',
  description: 'Market-moving news, fast.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={`bg-neutral-950 text-neutral-100 antialiased selection:bg-neutral-800 ${inter.className}`}>
        <header className="sticky top-0 z-50 border-b border-neutral-900/60 bg-neutral-950/80 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/60">
          <div className="mx-auto max-w-4xl px-4 py-3 flex items-center gap-2">
            <Link href="/" className="inline-flex items-center gap-2">
              <img src="/pulse-logo.png" width={24} height={24} alt="Pulse" className="rounded" />
              <span className="text-sm font-semibold text-neutral-300">Pulse</span>
            </Link>
          </div>
        </header>
        <main className="mx-auto max-w-4xl px-4 py-6">
          <TimeProvider>
            {children}
          </TimeProvider>
        </main>
      </body>
    </html>
  )
}
