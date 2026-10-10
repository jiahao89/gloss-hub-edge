/**
 * Robust RFC 4180-compliant CSV parser.
 * Properly handles quoted fields, commas inside quotes, escaped double quotes (""), and line breaks.
 * @param {string} text - The raw CSV string.
 * @returns {string[][]} Array of rows, where each row is an array of string values.
 */
export function parseCSV(text) {
  const result = [];
  let row = [''];
  let inQuotes = false;
  
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    
    if (c === '"') {
      if (inQuotes && next === '"') {
        // Escaped double quote inside quotes -> "" represents a single "
        row[row.length - 1] += '"';
        i++; // skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      // Cell delimiter
      row.push('');
    } else if ((c === '\r' || c === '\n') && !inQuotes) {
      // Row delimiter
      if (c === '\r' && next === '\n') {
        i++; // skip \n in \r\n
      }
      result.push(row);
      row = [''];
    } else {
      // Regular character
      row[row.length - 1] += c;
    }
  }
  
  // Push the final row if it has content
  if (row.length > 1 || row[0] !== '') {
    result.push(row);
  }
  
  return result;
}

/**
 * Finds the index of a column in headers using exact matches and fallback fuzzy keyword matches.
 * @param {string[]} headers - The CSV headers.
 * @param {string[]} exactMatches - Array of strings for exact matching.
 * @param {string[]} fuzzyKeywords - Array of substrings for fuzzy matching (case-insensitive).
 * @returns {number} The index of the matched header, or -1 if not found.
 */
export function fuzzyFindIndex(headers, exactMatches, fuzzyKeywords) {
  // 1. Exact match (case-insensitive, ignore surrounding whitespace)
  //    e.g. header "CN" must match exact keyword "cn"
  for (const match of exactMatches) {
    const target = match.trim().toLowerCase();
    const idx = headers.findIndex(h => (h || '').trim().toLowerCase() === target);
    if (idx !== -1) return idx;
  }
  // 2. Fuzzy match
  return headers.findIndex(h => {
    const lowerH = (h || '').toLowerCase();
    return fuzzyKeywords.some(kw => lowerH.includes(kw.toLowerCase()));
  });
}

/**
 * Converts a 2D array of rows to a CSV string.
 * Automatically wraps cells containing commas, quotes, or newlines in double quotes.
 * Prepends the UTF-8 Byte Order Mark (BOM) \ufeff for Excel compatibility.
 * @param {string[]} headers - The headers for the CSV file.
 * @param {string[][]} dataRows - The rows of data.
 * @returns {string} The formatted CSV string with UTF-8 BOM.
 */
export function arrayToCSV(headers, dataRows) {
  const escapeField = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [
    headers.map(escapeField).join(',')
  ];
  
  dataRows.forEach(row => {
    lines.push(row.map(escapeField).join(','));
  });

  return '\ufeff' + lines.join('\r\n');
}
