import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { TimeProvider } from '@/lib/timeContext'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Pulse - Financial News Feed',
  description: 'Real-time financial news and market updates',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <TimeProvider>
          {children}
        </TimeProvider>
      </body>
    </html>
  )
}
