// Apply sentence-style capitalization to headlines
export function sentenceCase(text: string): string {
  if (!text) return text;
  
  // Split into sentences and capitalize first letter of each
  return text
    .toLowerCase()
    .replace(/(^\w|\.\s+\w)/g, (letter) => letter.toUpperCase())
    .trim();
}

// Check if description should be displayed
export function shouldShowDescription(headline: string, description: string): boolean {
  if (!description || description.trim().length === 0) return false;
  
  // Don't show if 3 words or fewer
  const wordCount = description.trim().split(/\s+/).length;
  if (wordCount <= 3) return false;
  
  // Don't show if identical to headline (case-insensitive, ignoring punctuation)
  const normalizedHeadline = headline.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const normalizedDescription = description.toLowerCase().replace(/[^\w\s]/g, '').trim();
  
  if (normalizedHeadline === normalizedDescription) return false;
  
  return true;
}
