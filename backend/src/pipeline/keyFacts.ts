/**
 * Key Facts Extraction Module
 * Extracts concrete facts from text with priority: percent → money → count → date → place
 */

export type Fact = 
  | { type: 'percent'; value: string }
  | { type: 'money'; currency: string; value: string }
  | { type: 'count'; value: string; unit?: string }
  | { type: 'date'; value: string }
  | { type: 'place'; value: string };

/**
 * Normalize numbers: replace , with ., remove . thousands separators
 */
function normalizeNumber(text: string): string {
  return text
    .replace(/,/g, '.') // Replace commas with dots
    .replace(/\.(?=\d{3}\b)/g, ''); // Remove dots that are thousands separators
}

/**
 * Extract key fact from text with priority: percent → money → count → date → place
 */
export function extractKeyFact(text: string): Fact | null {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const normalizedText = normalizeNumber(text);

  // 1. PERCENT - highest priority
  const percentMatch = normalizedText.match(/(?:\+|-)?\d+(?:\.\d+)?\s?%/);
  if (percentMatch) {
    return {
      type: 'percent',
      value: percentMatch[0]
    };
  }

  // 2. MONEY - second priority
  const moneyPatterns = [
    /\$[\d,.]+(?:[mbk]|.*?billion|.*?million|.*?thousand)?/gi, // USD with suffixes
    /€[\d,.]+(?:[mbk]|.*?billion|.*?million|.*?thousand)?/gi,  // EUR with suffixes
    /£[\d,.]+(?:[mbk]|.*?billion|.*?million|.*?thousand)?/gi,  // GBP with suffixes
    /[\d,.]+(?:[mbk]|.*?billion|.*?million|.*?thousand)?\s*(?:dollars?|euros?|pounds?|pln)/gi // Written currencies
  ];

  for (const pattern of moneyPatterns) {
    const match = normalizedText.match(pattern);
    if (match) {
      const value = match[0];
      let currency = 'USD';
      
      if (value.includes('€') || value.toLowerCase().includes('euro')) {
        currency = 'EUR';
      } else if (value.includes('£') || value.toLowerCase().includes('pound')) {
        currency = 'GBP';
      } else if (value.toLowerCase().includes('pln')) {
        currency = 'PLN';
      }

      // Extract the full value including suffix
      const fullValue = value.replace(/[€£$]/g, '').trim();
      
      return {
        type: 'money',
        currency,
        value: fullValue
      };
    }
  }

  // 3. COUNT - third priority
  const countPatterns = [
    /\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*(jobs?|employees?|workers?|people|users?|customers?|shares?|units?|items?|products?|companies?|stores?|locations?|sites?|plants?|facilities?|offices?|branches?|outlets?|centers?|hospitals?|schools?|universities?|colleges?|students?|patients?|clients?|accounts?|transactions?|orders?|sales?|revenue|profit|loss|debt|loan|investment|fund|grant|contract|deal|merger|acquisition|partnership|alliance|agreement|license|patent|trademark|copyright|asset|property|building|house|apartment|room|floor|level|stage|phase|step|round|cycle|period|month|year|week|day|hour|minute|second|time|attempt|try|test|trial|experiment|study|research|analysis|report|document|file|record|entry|log|note|comment|review|rating|score|point|mark|grade|level|rank|position|place|spot|location|area|region|zone|district|neighborhood|community|city|town|village|country|state|province|county|district|region|continent|world|planet|universe|galaxy|star|planet|moon|asteroid|comet|meteor|satellite|spacecraft|rocket|missile|bomb|weapon|gun|rifle|pistol|knife|sword|shield|armor|helmet|vest|uniform|clothing|shirt|pants|dress|skirt|jacket|coat|sweater|sweatshirt|hoodie|t-shirt|polo|blouse|tie|scarf|hat|cap|helmet|glasses|sunglasses|watch|jewelry|ring|necklace|bracelet|earring|piercing|tattoo|mark|scar|wound|injury|disease|illness|symptom|condition|disorder|syndrome|infection|virus|bacteria|germ|parasite|fungus|mold|yeast|enzyme|hormone|vitamin|mineral|protein|carbohydrate|fat|sugar|salt|spice|herb|plant|tree|flower|grass|weed|mushroom|algae|moss|lichen|fern|palm|cactus|succulent|vine|bush|shrub|hedge|fence|wall|gate|door|window|roof|floor|ceiling|stairs|elevator|escalator|ramp|bridge|tunnel|road|street|highway|freeway|expressway|parkway|drive|avenue|boulevard|lane|alley|path|trail|track|rail|railroad|train|subway|metro|bus|car|truck|van|suv|sedan|coupe|convertible|wagon|hatchback|pickup|minivan|motorcycle|bicycle|scooter|skateboard|rollerblade|skis|snowboard|surfboard|kayak|canoe|boat|ship|yacht|ferry|cruise|airplane|helicopter|jet|rocket|missile|drone|uav|satellite|probe|rover|lander|orbiter|shuttle|station|base|camp|outpost|colony|settlement|village|town|city|metropolis|megalopolis|capital|seat|headquarters|office|building|tower|skyscraper|mansion|palace|castle|fort|fortress|bunker|shelter|refuge|sanctuary|temple|church|mosque|synagogue|shrine|altar|statue|monument|memorial|grave|tomb|cemetery|mausoleum|pyramid|obelisk|pillar|column|arch|gate|door|window|mirror|glass|crystal|diamond|gem|stone|rock|mineral|metal|iron|steel|aluminum|copper|bronze|brass|silver|gold|platinum|titanium|tungsten|nickel|zinc|lead|tin|mercury|uranium|plutonium|radium|cesium|strontium|iodine|carbon|nitrogen|oxygen|hydrogen|helium|neon|argon|krypton|xenon|radon|chlorine|fluorine|bromine|sulfur|phosphorus|silicon|boron|lithium|sodium|potassium|calcium|magnesium|barium|beryllium|scandium|vanadium|chromium|manganese|cobalt|molybdenum|ruthenium|rhodium|palladium|osmium|iridium|rhenium|hafnium|tantalum|niobium|zirconium|yttrium|lanthanum|cerium|praseodymium|neodymium|promethium|samarium|europium|gadolinium|terbium|dysprosium|holmium|erbium|thulium|ytterbium|lutetium|actinium|thorium|protactinium|neptunium|americium|curium|berkelium|californium|einsteinium|fermium|mendelevium|nobelium|lawrencium|rutherfordium|dubnium|seaborgium|bohrium|hassium|meitnerium|darmstadtium|roentgenium|copernicium|nihonium|flerovium|moscovium|livermorium|tennessine|oganesson)\b/gi,
    /\b(\d+(?:,\d{3})*(?:\.\d+)?)\b/ // Generic number
  ];

  for (const pattern of countPatterns) {
    const match = normalizedText.match(pattern);
    if (match) {
      const value = match[1] || match[0];
      const unit = match[2] || undefined;
      
      return {
        type: 'count',
        value,
        unit
      };
    }
  }

  // 4. DATE - fourth priority
  const datePatterns = [
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?\b/gi,
    /\b\d{4}-\d{2}-\d{2}\b/, // ISO date
    /\b\d{1,2}\/\d{1,2}\/\d{4}\b/, // MM/DD/YYYY
    /\b\d{1,2}-\d{1,2}-\d{4}\b/ // MM-DD-YYYY
  ];

  for (const pattern of datePatterns) {
    const match = normalizedText.match(pattern);
    if (match) {
      return {
        type: 'date',
        value: match[0]
      };
    }
  }

  // 5. PLACE - lowest priority
  const places = [
    'US', 'USA', 'United States', 'America',
    'EU', 'European Union', 'Europe',
    'China', 'Japan', 'UK', 'United Kingdom', 'Britain',
    'Germany', 'France', 'Italy', 'Spain', 'Netherlands',
    'Switzerland', 'Sweden', 'Norway', 'Denmark', 'Finland',
    'Poland', 'Iceland', 'Canada', 'Australia', 'India',
    'Brazil', 'Mexico', 'Argentina', 'Chile', 'Peru',
    'Colombia', 'Venezuela', 'Ecuador', 'Bolivia', 'Paraguay',
    'Uruguay', 'Guyana', 'Suriname', 'French Guiana',
    'Singapore', 'Hong Kong', 'South Korea', 'Taiwan',
    'Thailand', 'Vietnam', 'Malaysia', 'Indonesia', 'Philippines',
    'New Zealand', 'South Africa', 'Nigeria', 'Kenya', 'Egypt',
    'Morocco', 'Algeria', 'Tunisia', 'Libya', 'Sudan',
    'Ethiopia', 'Somalia', 'Djibouti', 'Eritrea', 'Uganda',
    'Tanzania', 'Rwanda', 'Burundi', 'Congo', 'Gabon',
    'Cameroon', 'Central African Republic', 'Chad', 'Niger',
    'Mali', 'Burkina Faso', 'Senegal', 'Gambia', 'Guinea-Bissau',
    'Guinea', 'Sierra Leone', 'Liberia', 'Ivory Coast', 'Ghana',
    'Togo', 'Benin', 'Mauritania', 'Western Sahara', 'Angola',
    'Zambia', 'Zimbabwe', 'Botswana', 'Namibia', 'Lesotho',
    'Eswatini', 'Mozambique', 'Madagascar', 'Comoros', 'Mauritius',
    'Seychelles', 'Russia', 'Ukraine', 'Belarus', 'Moldova',
    'Romania', 'Bulgaria', 'Serbia', 'Croatia', 'Slovenia',
    'Slovakia', 'Czech Republic', 'Austria', 'Hungary', 'Greece',
    'Turkey', 'Cyprus', 'Malta', 'Portugal', 'Ireland',
    'Iceland', 'Greenland', 'Faroes', 'Svalbard', 'Jan Mayen'
  ];

  for (const place of places) {
    if (normalizedText.toLowerCase().includes(place.toLowerCase())) {
      return {
        type: 'place',
        value: place
      };
    }
  }

  return null;
}
