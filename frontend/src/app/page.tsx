import FeedPageClient from './FeedPageClient'
import { API_BASE } from '@/lib/config'

export default function HomePage() {
  return (
    <FeedPageClient apiBaseUrl={API_BASE} />
  )
}
