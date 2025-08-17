import { NextRequest, NextResponse } from 'next/server';

// Normalization function to handle both flat and nested shapes
function normalizeItem(item: any) {
  // Handle impact field - can be string (flat) or object (nested)
  let impactCategory: string | null = null;
  let impactScore: number | null = null;
  
  if (typeof item.impact === 'string') {
    // Flat shape: impact: "L", impact_score: 43
    impactCategory = item.impact;
    impactScore = item.impact_score ?? null;
  } else if (item.impact && typeof item.impact === 'object') {
    // Nested shape: impact: { category: "L", score: 43 }
    impactCategory = item.impact.category ?? null;
    impactScore = item.impact.score ?? null;
  }
  
  // Handle verification field
  const verificationState = item.verification?.state ?? null;

  // Handle new confidence_state field
  const confidenceState = item.confidence_state ?? null;
  
  // Return normalized item with both original and normalized fields
  return {
    ...item,
    // Normalized fields for consistent UI consumption
    impactCategory,
    impactScore,
    verificationState,
    confidenceState,
    // Keep original fields for backward compatibility
    impact: item.impact,
    impact_score: item.impact_score,
    verification: item.verification,
    confidence_state: item.confidence_state
  };
}

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

    // Normalize each item to handle both flat and nested shapes
    const normalizedItems = items.map(normalizeItem);

    // Optional: reduce noisy logs in production

    return NextResponse.json(normalizedItems);
  } catch (error) {
    console.error('API route error:', error);
    return NextResponse.json([], { status: 500 });
  }
}
