/**
 * Utility to format tool results (especially JSON) as markdown
 * Arrays of objects become markdown tables
 * Nested objects/arrays become code blocks
 */

export function formatToolResult(result: string): string {
  try {
    // Try to parse as JSON
    const parsed = JSON.parse(result);
    return jsonToMarkdown(parsed);
  } catch {
    // Not JSON, return as-is
    return result;
  }
}

function jsonToMarkdown(data: unknown, depth: number = 0): string {
  // Handle arrays of objects - convert to markdown table
  if (Array.isArray(data) && data.length > 0) {
    const firstItem = data[0];
    
    // If it's an array of objects, render as table
    if (typeof firstItem === 'object' && firstItem !== null && !Array.isArray(firstItem)) {
      return arrayOfObjectsToTable(data as Record<string, unknown>[]);
    }
    
    // Array of primitives or mixed - render as code block
    return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  }
  
  // Single object - check for array properties that should be rendered as tables
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    
    // Common array property names to check
    const arrayProps = ['vms', 'items', 'data', 'results', 'records', 'list', 'entries', 'tasks', 'templates'];
    
    for (const prop of arrayProps) {
      if (prop in obj && Array.isArray(obj[prop]) && obj[prop].length > 0) {
        const arr = obj[prop] as unknown[];
        const firstItem = arr[0];
        
        // If it's an array of objects, render as table
        if (typeof firstItem === 'object' && firstItem !== null && !Array.isArray(firstItem)) {
          let output = '';
          
          // Add any scalar properties at the top (like count, total, etc.)
          const scalarProps = Object.entries(obj)
            .filter(([key, val]) => key !== prop && (val === null || typeof val !== 'object'))
            .map(([key, val]) => `**${key}**: ${val}`);
          
          if (scalarProps.length > 0) {
            output += scalarProps.join(' | ') + '\n\n';
          }
          
          output += arrayOfObjectsToTable(arr as Record<string, unknown>[]);
          return output;
        }
      }
    }
    
    // No special array properties found - render as code block
    return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  }
  
  // Primitive - return as string
  return String(data);
}

function arrayOfObjectsToTable(objects: Record<string, unknown>[]): string {
  if (objects.length === 0) return 'Empty result';
  
  // Get all unique keys from all objects
  const allKeys = new Set<string>();
  objects.forEach(obj => {
    Object.keys(obj).forEach(key => allKeys.add(key));
  });
  
  const keys = Array.from(allKeys);
  const maxKeysToShow = 8; // Limit columns for readability
  
  // If too many columns, prioritize important ones
  let columnsToShow = keys;
  if (keys.length > maxKeysToShow) {
    // Prioritize: name, status, powered_on, ip, href, owner, state, count
    const priority = ['name', 'status', 'powered_on', 'ip', 'href', 'owner', 'state', 'count', 'id', 'type'];
    const prioritized = priority.filter(k => keys.includes(k));
    const remaining = keys.filter(k => !prioritized.includes(k));
    columnsToShow = [...prioritized.slice(0, maxKeysToShow - 1), ...remaining.slice(0, 1)];
  }
  
  // Create header
  const header = '| ' + columnsToShow.join(' | ') + ' |';
  const separator = '| ' + columnsToShow.map(() => '---').join(' | ') + ' |';
  
  // Create rows
  const rows = objects.map(obj => {
    const cells = columnsToShow.map(key => {
      const value = obj[key];
      const stringVal = formatCellValue(value);
      // Escape pipe chars and truncate long values
      return stringVal.replace(/\|/g, '\\|').substring(0, 100);
    });
    return '| ' + cells.join(' | ') + ' |';
  });
  
  return `${header}\n${separator}\n${rows.join('\n')}`;
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  
  if (typeof value === 'boolean') {
    return value ? '✅ true' : '❌ false';
  }
  
  if (typeof value === 'object') {
    // For objects/arrays in cells, just show [object] or count
    if (Array.isArray(value)) {
      return `[Array: ${value.length}]`;
    }
    return '[Object]';
  }
  
  if (typeof value === 'string') {
    // Truncate very long strings
    return value.length > 50 ? value.substring(0, 47) + '...' : value;
  }
  
  return String(value);
}
