# Pulse Frontend

A Next.js application for displaying real-time news feeds with auto-refresh functionality.

## Features

- **Auto-refresh**: News feed automatically updates every 60 seconds (configurable)
- **Background updates**: No page reloads or UI flicker during refresh
- **Real-time data**: Uses SWR for efficient data fetching and caching
- **Responsive design**: Works on desktop and mobile devices

## Environment Variables

### `NEXT_PUBLIC_FEED_REFRESH_MS` (optional)
- **Default**: `60000` (60 seconds)
- **Description**: Controls how often the news feed automatically refreshes in milliseconds
- **Example**: `30000` for 30-second refresh intervals

### `NEXT_PUBLIC_API_BASE_URL` (optional)
- **Default**: `/api` (uses Next.js API proxy)
- **Description**: Base URL for the backend API
- **Example**: `http://localhost:4000` for direct backend connection

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm start
```

## Auto-refresh Implementation

The feed uses SWR's `refreshInterval` feature to automatically fetch new data in the background:

- **No page reloads**: Updates happen seamlessly in the background
- **No UI flicker**: Uses `keepPreviousData` to maintain smooth transitions
- **Scroll position preserved**: User's scroll position is maintained during updates
- **Visual feedback**: Refresh button shows loading state during updates
- **Configurable timing**: Refresh interval can be adjusted via environment variable

## Architecture

- **`useFeed` hook**: Centralized data fetching with auto-refresh logic
- **SWR integration**: Leverages SWR for caching, revalidation, and background updates
- **Error handling**: Graceful error states with retry functionality
- **Performance optimized**: Efficient re-rendering and minimal network requests
