/** HubSpot owner id -> name, refreshed with each snapshot (see cache.ts). No DB imports, so views stay testable. */
export const ownerNames = new Map<string, string>();
