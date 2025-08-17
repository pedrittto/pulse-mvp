import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const backendUrl = 'http://localhost:4000/feed';
    
    // Forward all query parameters to the backend
    const backendUrlWithParams = new URL(backendUrl);
    searchParams.forEach((value, key) => {
      backendUrlWithParams.searchParams.set(key, value);
    });

    const response = await fetch(backendUrlWithParams.toString(), {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Backend responded with ${response.status}`);
    }

    const data = await response.json();

    // Normalize the response to always return a plain array
    let items: any[] = [];
    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object' && Array.isArray(data.items)) {
      items = data.items;
    }

    return NextResponse.json(items);
  } catch (error) {
    console.error('API route error:', error);
    return NextResponse.json([], { status: 500 });
  }
}
