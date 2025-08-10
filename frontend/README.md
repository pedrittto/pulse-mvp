# Pulse Frontend - Stage A

A minimal Next.js application that displays a real-time financial news feed.

## Features

- Server-side rendering with 60-second revalidation
- Clean, responsive UI with Tailwind CSS
- Loading, error, and empty states
- Real-time refresh functionality
- Displays news items with confidence scores, impact levels, and ticker symbols

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create environment file:
   ```bash
   cp env.example .env.local
   ```

3. Update `.env.local` with your API URL (defaults to `http://localhost:4000`):
   ```
   NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
   NEXT_PUBLIC_USE_MOCKS=false
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Manual Test

1. Ensure your backend is running on `http://localhost:4000`
2. Open `http://localhost:3000`
3. Verify that news items render with:
   - Time format [HH:MM]
   - Confidence percentage
   - Impact level (Low/Medium/High)
   - Headlines and descriptions
   - Source domains
   - Ticker symbols
4. Test the Refresh button in the top bar
5. Test error state by stopping the backend
6. Test empty state when no items are available

## Project Structure

```
src/
├── app/
│   ├── globals.css      # Tailwind CSS imports
│   ├── layout.tsx       # Root layout
│   └── page.tsx         # Main feed page (server component)
├── components/
│   ├── FeedItem.tsx     # Individual news item component
│   └── Topbar.tsx       # Header with refresh button
├── lib/
│   └── config.ts        # API configuration
└── types/
    └── index.ts         # TypeScript type definitions
```

## API Integration

The app fetches data from `${NEXT_PUBLIC_API_BASE_URL}/feed?limit=20` and expects a response in this format:

```json
{
  "items": [
    {
      "id": "string",
      "thread_id": "string",
      "headline": "string",
      "why": "string",
      "sources": ["string"],
      "tickers": ["string"],
      "published_at": "ISO string",
      "ingested_at": "ISO string",
      "impact": "L" | "M" | "H",
      "confidence": 0-100,
      "primary_entity": "string"
    }
  ],
  "total": 0
}
```
